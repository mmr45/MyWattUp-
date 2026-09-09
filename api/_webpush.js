// api/_webpush.js — Web Push sans aucune dépendance npm.
//
// Implémente RFC 8291 (chiffrement aes128gcm) et RFC 8292 (VAPID) avec le seul
// module crypto de Node. Évite d'ajouter web-push au package.json : une
// dépendance de moins à installer, à mettre à jour et à auditer.

import crypto from 'node:crypto';

// --- HKDF (RFC 5869), version courte : un seul bloc suffit ici -------------
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function hkdf(salt, ikm, info, length) {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

// --- Chiffrement du corps (RFC 8291) --------------------------------------
function encryptPayload(payload, uaPublicB64, authSecretB64) {
  const uaPublic = Buffer.from(uaPublicB64, 'base64url');
  const authSecret = Buffer.from(authSecretB64, 'base64url');

  // Paire éphémère du serveur, régénérée à chaque notification.
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const salt = crypto.randomBytes(16);

  // IKM dérivée du secret partagé et des deux clés publiques.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'), uaPublic, asPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // Enregistrement unique : le corps se termine par le délimiteur 0x02.
  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // En-tête : salt(16) | recordSize(4) | idLen(1) | clé publique(65)
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, ciphertext]);
}

// --- Jeton VAPID (RFC 8292) -----------------------------------------------
function vapidToken(audience, subject, publicKeyB64, privateKeyB64) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ typ: 'JWT', alg: 'ES256' });
  const body = b64({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  });

  const pub = Buffer.from(publicKeyB64, 'base64url');
  const key = crypto.createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
      d: privateKeyB64,
    },
    format: 'jwk',
  });

  // La signature JWT doit être au format brut r||s, pas en DER.
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${body}`), {
    key, dsaEncoding: 'ieee-p1363',
  });

  return `${header}.${body}.${signature.toString('base64url')}`;
}

/**
 * Envoie une notification push.
 * @throws {Error} avec .statusCode pour permettre le nettoyage des 404/410.
 */
export async function sendNotification(subscription, payload, options) {
  const { publicKey, privateKey, subject, ttl = 43200 } = options;
  const audience = new URL(subscription.endpoint).origin;

  const body = encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttl),
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Content-Length': String(body.length),
      Authorization: `vapid t=${vapidToken(audience, subject, publicKey, privateKey)}, k=${publicKey}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`push ${response.status} : ${text.slice(0, 200)}`);
    err.statusCode = response.status;
    throw err;
  }
  return true;
}
