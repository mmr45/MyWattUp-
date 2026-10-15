// supabase/functions/send-reminders/index.ts
//
// Envoie 3 types de rappels push, selon le paramètre ?type= dans l'URL :
//
//   - journal   -> "Tu n'as pas encore rempli ton journal aujourd'hui"
//                  (appelé une fois en soirée, ex. 20h heure locale de chaque user)
//   - bedtime   -> "C'est presque l'heure de te coucher"
//                  (appelé toutes les heures ; calcule l'heure de coucher moyenne
//                   de chaque utilisateur sur ses 14 derniers jours et envoie
//                   ~30 min avant)
//   - quality   -> "Ton sommeil se dégrade depuis 3 jours"
//                  (appelé une fois par jour ; regarde les 3 derniers
//                   sleep_quality)
//
// Toutes les requêtes utilisent la Service Role Key (jamais exposée au client).

import { createClient } from 'npm:@supabase/supabase-js@2';
import webPush from 'npm:web-push@3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:contact@mywattup.app';

webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

// Envoie une notification à tous les abonnements d'un utilisateur.
// Supprime automatiquement les abonnements expirés/invalides (statut 404/410).
async function sendToUser(userId: string, payload: { title: string; body: string; tag: string }) {
  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (error || !subs || subs.length === 0) return;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify(payload)
        );
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          // Abonnement expiré ou révoqué côté navigateur : on le nettoie.
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        } else {
          console.error(`Push échoué pour ${userId}:`, err?.message || err);
        }
      }
    })
  );
}

// ---------------------------------------------------------------
// 1. Rappel de journal non rempli
// ---------------------------------------------------------------
async function runJournalReminder() {
  const today = todayISO();

  const { data: users, error } = await supabase
    .from('user_settings')
    .select('user_id')
    .eq('push_notifications', true)
    .eq('daily_reminder', true);

  if (error || !users) {
    console.error('Erreur récupération des users (journal):', error?.message);
    return { sent: 0 };
  }

  const { data: loggedToday } = await supabase
    .from('daily_logs')
    .select('user_id')
    .eq('log_date', today);

  const loggedSet = new Set((loggedToday || []).map((r) => r.user_id));
  const targets = users.filter((u) => !loggedSet.has(u.user_id));

  await Promise.all(
    targets.map((u) =>
      sendToUser(u.user_id, {
        title: 'MyWattUp',
        body: "Tu n'as pas encore rempli ton journal du jour. Deux minutes suffisent.",
        tag: 'journal-reminder',
      })
    )
  );

  return { sent: targets.length };
}

// ---------------------------------------------------------------
// 2. Rappel de coucher personnalisé
// ---------------------------------------------------------------
function avgBedtimeMinutes(times: string[]): number | null {
  if (times.length === 0) return null;
  // Convertit chaque "HH:MM:SS" en minutes depuis minuit. Les heures de
  // coucher après minuit (00:xx, 01:xx...) sont décalées de +24h pour que
  // la moyenne circulaire ne soit pas faussée (23h + 01h ne doit pas donner ~midi).
  const minutes = times.map((t) => {
    const [h, m] = t.split(':').map(Number);
    const mins = h * 60 + m;
    return mins < 12 * 60 ? mins + 24 * 60 : mins;
  });
  const avg = minutes.reduce((a, b) => a + b, 0) / minutes.length;
  return avg % (24 * 60);
}

async function runBedtimeReminder() {
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const fromDate = fourteenDaysAgo.toISOString().split('T')[0];

  const { data: users, error } = await supabase
    .from('user_settings')
    .select('user_id, timezone')
    .eq('push_notifications', true);

  if (error || !users) {
    console.error('Erreur récupération des users (bedtime):', error?.message);
    return { sent: 0 };
  }

  let sentCount = 0;

  await Promise.all(
    users.map(async (u) => {
      const { data: logs } = await supabase
        .from('daily_logs')
        .select('bedtime')
        .eq('user_id', u.user_id)
        .gte('log_date', fromDate)
        .not('bedtime', 'is', null);

      const times = (logs || []).map((l) => l.bedtime as string).filter(Boolean);
      if (times.length < 3) return; // pas assez d'historique pour être pertinent

      const avgMinutes = avgBedtimeMinutes(times);
      if (avgMinutes == null) return;

      const targetMinutes = (avgMinutes - 30 + 24 * 60) % (24 * 60);
      const tz = u.timezone || 'Europe/Paris';
      const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const nowMinutes = nowLocal.getHours() * 60 + nowLocal.getMinutes();

      // Cette fonction tourne une fois par heure : on envoie si l'heure
      // cible tombe dans l'heure en cours (fenêtre de 60 min).
      const diff = Math.min(
        Math.abs(nowMinutes - targetMinutes),
        24 * 60 - Math.abs(nowMinutes - targetMinutes)
      );
      if (diff > 30) return;

      sentCount += 1;
      return sendToUser(u.user_id, {
        title: 'MyWattUp',
        body: "C'est presque l'heure de te coucher pour respecter ton rythme habituel.",
        tag: 'bedtime-reminder',
      });
    })
  );

  return { sent: sentCount };
}

// ---------------------------------------------------------------
// 3. Alerte dégradation de la qualité de sommeil
// ---------------------------------------------------------------
async function runQualityAlert() {
  const { data: users, error } = await supabase
    .from('user_settings')
    .select('user_id, last_quality_alert_date')
    .eq('push_notifications', true);

  if (error || !users) {
    console.error('Erreur récupération des users (quality):', error?.message);
    return { sent: 0 };
  }

  const today = todayISO();
  let sentCount = 0;

  await Promise.all(
    users.map(async (u) => {
      if (u.last_quality_alert_date === today) return; // déjà alerté aujourd'hui

      const { data: logs } = await supabase
        .from('daily_logs')
        .select('log_date, sleep_quality')
        .eq('user_id', u.user_id)
        .order('log_date', { ascending: false })
        .limit(3);

      if (!logs || logs.length < 3) return;
      const allBad = logs.every((l) => l.sleep_quality === 'mauvaise');
      if (!allBad) return;

      sentCount += 1;
      await sendToUser(u.user_id, {
        title: 'MyWattUp',
        body: 'Ta qualité de sommeil est notée mauvaise depuis 3 jours. Un point sur ton rythme de coucher pourrait aider.',
        tag: 'quality-alert',
      });

      await supabase
        .from('user_settings')
        .update({ last_quality_alert_date: today })
        .eq('user_id', u.user_id);
    })
  );

  return { sent: sentCount };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const type = url.searchParams.get('type');

  let result: { sent: number };
  switch (type) {
    case 'journal':
      result = await runJournalReminder();
      break;
    case 'bedtime':
      result = await runBedtimeReminder();
      break;
    case 'quality':
      result = await runQualityAlert();
      break;
    default:
      return new Response(JSON.stringify({ error: "Paramètre 'type' invalide. Utilise journal, bedtime ou quality." }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  return new Response(JSON.stringify({ type, ...result }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
