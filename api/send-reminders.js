// api/send-reminders.js — rappel quotidien "remplis ton journal"
//
// Appelé toutes les heures par le cron Vercel (voir vercel.json). À chaque
// passage, on ne notifie que les personnes dont il est 20 h EN HEURE LOCALE et
// qui n'ont pas encore enregistré leur journée. Un rappel envoyé à 20 h UTC
// tomberait à 21 h à Paris et à midi à Los Angeles : le fuseau stocké dans
// user_settings est la seule référence correcte.

import { createClient } from '@supabase/supabase-js';
import { sendNotification } from './_webpush.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REMINDER_HOUR = 20;

const VAPID = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: 'mailto:contact@my-watt-up.vercel.app',
};

// Heure et date locales d'un fuseau IANA, sans dépendance externe.
function localParts(timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('fr-CA', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) % 24 };
  } catch (_) {
    return null; // fuseau invalide en base : on ignore plutôt que de spammer
  }
}

export default async function handler(req, res) {
  // Le cron Vercel envoie CRON_SECRET en Authorization. Sans ce contrôle,
  // n'importe qui pourrait déclencher une salve de notifications.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (secret && auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Non autorisé.' });
  }

  if (!VAPID.publicKey || !VAPID.privateKey) {
    return res.status(500).json({ error: 'VAPID_PUBLIC_KEY ou VAPID_PRIVATE_KEY manquante sur Vercel.' });
  }

  try {
    const { data: settings, error } = await supabaseAdmin
      .from('user_settings')
      .select('user_id, timezone, daily_reminder, push_notifications')
      .eq('daily_reminder', true)
      .eq('push_notifications', true);

    if (error) throw error;

    // 1) On ne garde que ceux dont il est 20 h chez eux.
    const due = [];
    for (const s of settings || []) {
      const local = localParts(s.timezone || 'Europe/Paris');
      if (local && local.hour === REMINDER_HOUR) due.push({ userId: s.user_id, date: local.date });
    }
    if (!due.length) return res.status(200).json({ checked: (settings || []).length, sent: 0 });

    // 2) On retire ceux qui ont déjà rempli leur journée : le rappel doit être
    //    inutile pour celui qui a fait le travail, sinon il est désactivé.
    const { data: logs } = await supabaseAdmin
      .from('daily_logs')
      .select('user_id, log_date')
      .in('user_id', due.map(d => d.userId))
      .in('log_date', [...new Set(due.map(d => d.date))]);

    const done = new Set((logs || []).map(l => `${l.user_id}|${l.log_date}`));
    const targets = due.filter(d => !done.has(`${d.userId}|${d.date}`));
    if (!targets.length) return res.status(200).json({ checked: due.length, sent: 0 });

    // 3) Envoi.
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth')
      .in('user_id', targets.map(t => t.userId));

    const payload = JSON.stringify({
      title: 'Ta journée MyWattUp',
      body: "Deux minutes pour enregistrer ta nuit et ta séance — c'est ce qui fait ton score.",
      url: '/#journal',
      tag: 'daily-reminder',
    });

    let sent = 0;
    const dead = [];

    await Promise.all((subs || []).map(async (sub) => {
      try {
        await sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          VAPID
        );
        sent++;
      } catch (err) {
        // 404 / 410 : l'abonnement n'existe plus côté navigateur. On le supprime,
        // sinon la table se remplit d'endpoints morts qu'on réessaie chaque jour.
        if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.id);
        else console.error('push échoué', sub.id, err.statusCode, err.body);
      }
    }));

    if (dead.length) {
      await supabaseAdmin.from('push_subscriptions').delete().in('id', dead);
    }

    return res.status(200).json({ checked: due.length, targets: targets.length, sent, cleaned: dead.length });
  } catch (err) {
    console.error('send-reminders', err);
    return res.status(500).json({ error: 'Envoi des rappels impossible.' });
  }
}
