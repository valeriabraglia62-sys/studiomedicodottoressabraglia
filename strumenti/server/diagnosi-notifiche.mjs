/**
 * Diagnosi delle notifiche push: mostra chi e' iscritto adesso, con quale
 * account e da quando — utile per capire se un'iscrizione manca, e' doppia,
 * o e' rimasta agganciata all'account sbagliato.
 *
 *   node strumenti/server/diagnosi-notifiche.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const db = new Database(path.join(ROOT, 'data', 'medstudent.sqlite'));

const righe = db.prepare(`
  SELECT i.id, i.utente_id, u.email, u.ruolo, u.attivo, i.creato_il,
         substr(i.endpoint, -16) AS fine_endpoint
    FROM iscrizioni_notifiche i
    LEFT JOIN utenti u ON u.id = i.utente_id
   ORDER BY i.creato_il DESC
`).all();

if (!righe.length) {
  console.log('Nessuna iscrizione alle notifiche nel database.');
} else {
  console.log(`${righe.length} iscrizioni:\n`);
  for (const r of righe) {
    console.log(
      `#${r.id}  ${r.email || '(utente non trovato)'} (${r.ruolo || '?'}, attivo=${r.attivo})  ` +
      `...${r.fine_endpoint}  iscritto il ${r.creato_il}`
    );
  }
}
