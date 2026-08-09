import { db } from './db.js';
import { accoda } from './outbox.js';
import { dettaglio, minutiAllAppuntamento } from './prenotazioni.js';
import { emailPromemoriaPaziente } from './mailer.js';

/**
 * Promemoria al paziente il giorno prima della visita.
 *
 * La colonna promemoria_il segna quando e' stato accodato: e' cio' che impedisce
 * di inviarlo due volte anche se il server viene riavviato di continuo.
 */

const ANTICIPO_MINUTI = 24 * 60;
const FINESTRA_MINUTI = 30;

const stmtCandidate = db.prepare(`
  SELECT id FROM prenotazioni
   WHERE stato = 'confermata'
     AND promemoria_il IS NULL
     AND data BETWEEN ? AND ?
`);

export function inviaPromemoriaDovuti() {
  const oggi = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const candidate = stmtCandidate.all(iso(oggi), iso(new Date(oggi.getTime() + 2 * 86400000)));

  let inviati = 0;

  const segna = db.transaction((prenotazione) => {
    accoda('email', emailPromemoriaPaziente(prenotazione));
    db.prepare('UPDATE prenotazioni SET promemoria_il = ? WHERE id = ?')
      .run(new Date().toISOString(), prenotazione.id);
  });

  for (const { id } of candidate) {
    const p = dettaglio(id);
    if (!p?.paziente_email) continue;

    const mancanti = minutiAllAppuntamento(p);
    // Solo chi rientra nella finestra: troppo presto non serve, troppo tardi
    // sarebbe inutile (e per le prenotazioni last-minute non ha senso).
    if (mancanti > ANTICIPO_MINUTI || mancanti < ANTICIPO_MINUTI - FINESTRA_MINUTI) continue;

    segna(p);
    inviati++;
  }

  return inviati;
}

let timer = null;

export function avviaPromemoria() {
  if (timer) return;
  const tick = () => {
    try {
      const n = inviaPromemoriaDovuti();
      if (n) console.log(`[promemoria] ${n} promemoria messi in coda`);
    } catch (err) {
      console.error('[promemoria]', err);
    }
  };
  timer = setInterval(tick, FINESTRA_MINUTI * 60000);
  timer.unref?.();
  tick();
}

export function fermaPromemoria() {
  if (timer) clearInterval(timer);
  timer = null;
}
