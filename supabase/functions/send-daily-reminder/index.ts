// supabase/functions/send-daily-reminder/index.ts
//
// Edge Function envoyée quotidiennement via un Cron Trigger Supabase.
// Version avec signature VAPID native (Web Crypto), pour contourner un bug
// de compatibilité entre la librairie "web-push" (npm) sous Deno et le
// service push d'Apple (qui exige un format de signature JWT plus strict
// que Google/FCM — d'où l'erreur "403 BadJwtToken" observée uniquement
// sur les appareils Apple).

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:contact@mywattup.app";

// ---------- Utils base64url ----------
function base64urlToUint8Array(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stringToBase64url(str: string): string {
  return uint8ArrayToBase64url(new TextEncoder().encode(str));
}

// ---------- Importe la clé privée VAPID au format Web Crypto (JWK) ----------
async function importVapidPrivateKey(): Promise<CryptoKey> {
  const publicKeyBytes = base64urlToUint8Array(VAPID_PUBLIC_KEY); // 65 bytes: 0x04 || X(32) || Y(32)
  const privateKeyBytes = base64urlToUint8Array(VAPID_PRIVATE_KEY); // 32 bytes

  const x = publicKeyBytes.slice(1, 33);
  const y = publicKeyBytes.slice(33, 65);

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: uint8ArrayToBase64url(x),
    y: uint8ArrayToBase64url(y),
    d: uint8ArrayToBase64url(privateKeyBytes),
    ext: true,
  };

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

// ---------- Importe la clé publique VAPID pour auto-vérification (diagnostic) ----------
async function importVapidPublicKey(): Promise<CryptoKey> {
  const publicKeyBytes = base64urlToUint8Array(VAPID_PUBLIC_KEY);
  return crypto.subtle.importKey(
    "raw",
    publicKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

// ---------- Construit l'en-tête VAPID (JWT signé en ES256 "raw", conforme RFC 8292) ----------
async function buildVapidAuthHeader(
  endpoint: string,
  privateCryptoKey: CryptoKey,
  publicCryptoKey: CryptoKey
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12h
    sub: VAPID_SUBJECT,
  };

  const headerB64 = stringToBase64url(JSON.stringify(header));
  const payloadB64 = stringToBase64url(JSON.stringify(payload));
  const unsignedToken = `${headerB64}.${payloadB64}`;
  const unsignedBytes = new TextEncoder().encode(unsignedToken);

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateCryptoKey,
    unsignedBytes
  );
  const sigBytes = new Uint8Array(signature);
  const sigB64 = uint8ArrayToBase64url(sigBytes);

  // Diagnostic : on re-vérifie nous-mêmes la signature qu'on vient de produire,
  // pour savoir si le problème vient de notre paire de clés/format, ou d'ailleurs.
  const selfVerified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicCryptoKey,
    signature,
    unsignedBytes
  );
  console.log(
    `[VAPID DEBUG] aud=${audience} sigLength=${sigBytes.length} selfVerified=${selfVerified} headerB64=${headerB64} payloadB64=${payloadB64}`
  );

  const jwt = `${unsignedToken}.${sigB64}`;
  return `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`;
}

Deno.serve(async (_req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 1) Qui veut recevoir le rappel quotidien ?
  const { data: settingsRows, error: settingsError } = await supabase
    .from("user_settings")
    .select("user_id")
    .eq("daily_reminder", true)
    .eq("push_notifications", true);

  if (settingsError) {
    console.error("Erreur lecture user_settings:", settingsError.message);
    return new Response(JSON.stringify({ error: settingsError.message }), { status: 500 });
  }

  if (!settingsRows || settingsRows.length === 0) {
    return new Response(JSON.stringify({ sent: 0, message: "Aucun utilisateur à notifier." }), { status: 200 });
  }

  const candidateUserIds = settingsRows.map((r) => r.user_id);

  // 1bis) On ne notifie que ceux qui n'ont PAS encore rempli leur journal
  //       aujourd'hui — sinon la notif ment ("tu n'as pas rempli ton
  //       journal" alors que si).
  const today = new Date().toISOString().split("T")[0];
  const { data: filledLogs, error: logsError } = await supabase
    .from("daily_logs")
    .select("user_id")
    .eq("log_date", today)
    .in("user_id", candidateUserIds);

  if (logsError) {
    console.error("Erreur lecture daily_logs:", logsError.message);
    return new Response(JSON.stringify({ error: logsError.message }), { status: 500 });
  }

  const alreadyFilledIds = new Set((filledLogs ?? []).map((r) => r.user_id));
  const userIds = candidateUserIds.filter((id) => !alreadyFilledIds.has(id));

  if (userIds.length === 0) {
    return new Response(
      JSON.stringify({ sent: 0, message: "Tout le monde a déjà rempli son journal aujourd'hui." }),
      { status: 200 }
    );
  }

  // 2) Récupérer tous leurs abonnements push (un utilisateur peut avoir
  //    plusieurs appareils)
  const { data: subscriptions, error: subsError } = await supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (subsError) {
    console.error("Erreur lecture push_subscriptions:", subsError.message);
    return new Response(JSON.stringify({ error: subsError.message }), { status: 500 });
  }

  const payloadText = JSON.stringify({
    title: "MyWattUp",
    body: "Ton journal du jour n'a pas été rempli — prends 30 secondes pour le compléter.",
    url: "/#journal",
    tag: "daily-reminder",
  });

  const privateCryptoKey = await importVapidPrivateKey();
  const publicCryptoKey = await importVapidPublicKey();

  let sent = 0;
  let failed = 0;
  const staleSubscriptionIds: string[] = [];

  await Promise.all(
    (subscriptions ?? []).map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };

      try {
        // web-push chiffre le contenu (RFC 8291) et construit les headers
        // standards ; on remplace ensuite l'Authorization par notre JWT
        // signé nativement — seul point qui posait problème avec Apple.
        const requestDetails = webpush.generateRequestDetails(pushSubscription, payloadText);
        const vapidAuth = await buildVapidAuthHeader(sub.endpoint, privateCryptoKey, publicCryptoKey);

        const res = await fetch(requestDetails.endpoint, {
          method: requestDetails.method,
          headers: { ...requestDetails.headers, Authorization: vapidAuth },
          body: requestDetails.body,
        });

        if (res.ok) {
          sent++;
        } else {
          failed++;
          const bodyText = await res.text().catch(() => "");
          // 404/410 = l'abonnement n'est plus valide (désinstallé, expiré...) -> nettoyage
          if (res.status === 404 || res.status === 410) {
            staleSubscriptionIds.push(sub.id);
          } else {
            console.error(`Échec envoi vers ${sub.endpoint}: statusCode=${res.status} body=${bodyText}`);
          }
        }
      } catch (err) {
        failed++;
        console.error(`Erreur envoi vers ${sub.endpoint}:`, err.message || err);
      }
    })
  );

  if (staleSubscriptionIds.length > 0) {
    await supabase.from("push_subscriptions").delete().in("id", staleSubscriptionIds);
  }

  return new Response(
    JSON.stringify({ sent, failed, cleaned_up: staleSubscriptionIds.length, skipped_already_filled: alreadyFilledIds.size }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
