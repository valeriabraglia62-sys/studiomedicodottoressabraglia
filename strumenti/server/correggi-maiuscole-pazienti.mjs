/**
 * Correzione una tantum: mette nome e cognome dei pazienti in "Maiuscola
 * Iniziale" (stessa regola usata ora ad ogni registrazione/modifica), per chi
 * si era registrato scrivendo tutto minuscolo o tutto maiuscolo prima di
 * questa correzione. Aggiorna sia la scheda paziente sia l'account di accesso
 * collegato, se c'e'.
 *
 *   node strumenti/server/correggi-maiuscole-pazienti.mjs
 *
 * Idempotente: si puo' rilanciare senza rischi, chi e' gia' a posto non
 * cambia.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const db = new Database(path.join(ROOT, 'data', 'medstudent.sqlite'));

// Stessa regola di capitalizzaNome in src/prenotazioni.js: ricopiata qui
// invece che importata, per non far girare le migrazioni di tutta l'app solo
// per questa correzione una tantum.
const capitalizza = (v) => String(v ?? '').trim().replace(/\s+/g, ' ')
  .toLowerCase()
  .replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());

const pazienti = db.prepare('SELECT id, nome, cognome FROM pazienti').all();

const aggiornaPaziente = db.prepare('UPDATE pazienti SET nome = ?, cognome = ? WHERE id = ?');
const aggiornaUtente = db.prepare(
  "UPDATE utenti SET nome = ? WHERE paziente_id = ? AND ruolo = 'paziente'"
);

let cambiati = 0;

db.transaction(() => {
  for (const p of pazienti) {
    const nome = capitalizza(p.nome);
    const cognome = capitalizza(p.cognome);
    if (nome === p.nome && cognome === p.cognome) continue;

    console.log(`#${p.id}  "${p.nome} ${p.cognome}"  ->  "${nome} ${cognome}"`);
    aggiornaPaziente.run(nome, cognome, p.id);
    aggiornaUtente.run(`${nome} ${cognome}`, p.id);
    cambiati++;
  }
})();

console.log(`\nPazienti controllati: ${pazienti.length}`);
console.log(`Nomi corretti: ${cambiati}`);
