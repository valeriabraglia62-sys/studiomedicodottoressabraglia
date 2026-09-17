/**
 * Invio una tantum: manda la guida per i pazienti a chi ha gia' un account
 * sul sito, non solo a chi lo crea da ora in poi. Non tocca nessuna
 * credenziale, e' solo l'allegato che prima non c'era ancora.
 *
 *   node strumenti/server/manda-guida-pazienti.mjs
 *
 * Mette le email in coda (stessa tabella outbox di tutte le altre): partono
 * al prossimo giro di invio del servizio, non subito da questo script.
 * Rilanciarlo manda la guida una seconda volta a tutti: va eseguito una
 * volta sola.
 */
import { db } from '../../src/db.js';
import { config } from '../../src/config.js';
import { accoda } from '../../src/outbox.js';
import { emailGuidaPaziente } from '../../src/mailer.js';

const basePubblica = config.pubblico.url || `http://localhost:${config.port}`;

// Solo chi puo' davvero accedere: un account non ancora verificato non
// riceverebbe niente di utile, e chi ha una scheda senza login non ha
// nessuna email a cui scrivere.
const pazienti = db.prepare(`
  SELECT nome, email FROM utenti WHERE ruolo = 'paziente' AND attivo = 1 AND email_verificata = 1
`).all();

for (const p of pazienti) {
  accoda('email', {
    ...emailGuidaPaziente({ to: p.email, nome: p.nome, url: basePubblica }),
    allegaGuida: 'pazienti'
  });
  console.log(`In coda per ${p.nome || p.email} <${p.email}>`);
}

console.log(`\nPazienti avvisati: ${pazienti.length}`);
