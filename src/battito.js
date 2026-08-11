/**
 * Il battito del server, e l'avviso di quando si e' fermato.
 *
 * Il problema che risolve: se questa macchina si spegne di notte — corrente
 * andata, aggiornamento di Windows, coperchio chiuso da qualcuno — la mattina
 * il sito e' tornato su e non resta traccia di niente. Nessuno sa che per sei
 * ore i pazienti hanno trovato una pagina che non si apriva, e quindi nessuno
 * va a controllare cosa e' successo in quelle sei ore.
 *
 * Come funziona: finche' il server gira scrive l'ora, ogni minuto. Alla
 * riaccensione guarda l'ultima ora scritta. Se e' vecchia, vuol dire che in
 * mezzo c'e' stato un buco, e lo scrive allo studio.
 *
 * Il conto e' volutamente prudente in un verso solo: un buco piu' corto della
 * soglia non viene segnalato, perche' un riavvio del servizio dura pochi secondi
 * e avvisare a ogni riavvio insegnerebbe solo a ignorare gli avvisi.
 */
import { db } from './db.js';
import { accoda } from './outbox.js';
import { emailSitoTornato } from './mailer.js';

const CHIAVE = 'ultimo_battito';
const OGNI_MS = 60_000;

// Sotto questa soglia si tace. Cinque minuti coprono un riavvio del servizio,
// un aggiornamento, una disconnessione breve della rete: cose che capitano e
// che non sono notizie.
const SOGLIA_MINUTI = 5;

db.exec(`
  CREATE TABLE IF NOT EXISTS segnali (
    chiave  TEXT PRIMARY KEY,
    valore  TEXT NOT NULL
  )
`);

const stmtLeggi = db.prepare('SELECT valore FROM segnali WHERE chiave = ?');
const stmtScrivi = db.prepare(
  'INSERT INTO segnali (chiave, valore) VALUES (?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore'
);

let timer = null;

const scriviBattito = () => stmtScrivi.run(CHIAVE, new Date().toISOString());

/**
 * Guarda se fra l'ultimo battito e adesso c'e' un buco, e lo racconta.
 *
 * Va chiamata prima di far ripartire il battito, altrimenti il buco lo si
 * cancella con le proprie mani un istante prima di misurarlo.
 */
function segnalaAssenza() {
  const riga = stmtLeggi.get(CHIAVE);
  if (!riga) return null;

  const ultimo = new Date(riga.valore);
  const minuti = Math.round((Date.now() - ultimo.getTime()) / 60000);
  if (!Number.isFinite(minuti) || minuti < SOGLIA_MINUTI) return null;

  const avviso = { spentoDa: ultimo.toISOString(), tornatoIl: new Date().toISOString(), minuti };
  accoda('email', emailSitoTornato(avviso));
  console.log(`[battito] il sito e' stato irraggiungibile per circa ${minuti} minuti`);
  return avviso;
}

export function avviaBattito() {
  if (timer) return null;

  const assenza = segnalaAssenza();

  scriviBattito();
  timer = setInterval(scriviBattito, OGNI_MS);
  timer.unref?.();

  return assenza;
}

export function fermaBattito() {
  if (timer) clearInterval(timer);
  timer = null;
  // Un'ultima scrittura prima di spegnersi: cosi' una chiusura ordinata non
  // viene scambiata per un'interruzione, e il buco misurato parte da adesso.
  scriviBattito();
}

/** Da quanto il sito e' in piedi, per il pannello. */
export const ultimoBattito = () => stmtLeggi.get(CHIAVE)?.valore || null;
