/**
 * Manda una notifica di prova a tutti i dispositivi iscritti con una certa
 * email, per verificare sul momento se arriva davvero — senza aspettare un
 * evento vero (prenotazione, richiesta...). Non passa dall'app: legge le
 * chiavi e il database da solo, come controllo-salute.mjs, per non far
 * girare migrazioni ne' altro.
 *
 *   node strumenti/server/prova-notifica.mjs <email>
 *
 * <email> e' quella dell'account da testare (es. quella dello staff che
 * dice di non ricevere le notifiche). Manda a TUTTI i dispositivi iscritti
 * con quell'email, cosi' si vede quale endpoint funziona e quale no.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import webpush from 'web-push';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const env = {};
try {
  for (const riga of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = riga.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch { /* senza .env non si va da nessuna parte */ }

const email = process.argv[2];
if (!email) {
  console.error('Uso: node strumenti/server/prova-notifica.mjs <email>');
  process.exit(1);
}

if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
  console.error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY mancanti nel .env: le notifiche sono spente.');
  process.exit(1);
}

webpush.setVapidDetails(
  `mailto:${env.NOTIFY_EMAIL || env.ADMIN_EMAIL || 'info@example.it'}`,
  env.VAPID_PUBLIC_KEY,
  env.VAPID_PRIVATE_KEY
);

const FILE_DB = env.DB_FILE
  ? path.resolve(ROOT, env.DB_FILE)
  : path.join(ROOT, 'data', 'medstudent.sqlite');
const db = new Database(FILE_DB, { readonly: true, fileMustExist: true });

const dispositivi = db.prepare(`
  SELECT i.* FROM iscrizioni_notifiche i
  JOIN utenti u ON u.id = i.utente_id
  WHERE u.email = ?
`).all(email);

if (!dispositivi.length) {
  console.log(`Nessun dispositivo iscritto per ${email}.`);
  process.exit(0);
}

console.log(`${dispositivi.length} dispositivo/i per ${email}, mando la prova...\n`);

for (const d of dispositivi) {
  const targa = d.endpoint.slice(-16);
  try {
    await webpush.sendNotification(
      { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
      JSON.stringify({
        titolo: 'Prova notifica',
        corpo: `Test delle ${new Date().toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome' })}`,
        url: '/'
      })
    );
    console.log(`OK   ...${targa}  (iscritto il ${d.creato_il})`);
  } catch (err) {
    console.log(`ERR  ...${targa}  (iscritto il ${d.creato_il})  -> ${err.statusCode || ''} ${err.message}`);
  }
}
