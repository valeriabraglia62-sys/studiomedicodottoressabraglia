import { db } from './db.js';

/**
 * Coda di consegna verso i servizi esterni (email, Foglio Google).
 *
 * Regola fondamentale: la riga di outbox viene scritta nella STESSA transazione
 * del dato a cui si riferisce. O si salvano entrambi o nessuno dei due. Cosi' e'
 * impossibile che una prenotazione esista senza che qualcuno provi a notificarla,
 * e viceversa. Se Gmail o Google Sheets sono irraggiungibili la riga resta in
 * attesa e viene ritentata finche' non passa: la richiesta non si perde.
 */

const gestori = new Map();
const ATTESE_MINUTI = [1, 2, 5, 15, 30, 60];
const SOGLIA_ALLARME = 5;

export function registraGestore(tipo, fn) {
  gestori.set(tipo, fn);
}

const stmtAccoda = db.prepare(`
  INSERT INTO outbox (tipo, payload, prossimo_tentativo, creato_il)
  VALUES (?, ?, ?, ?)
`);

/** Da chiamare dentro una transazione, insieme alla scrittura del dato. */
export function accoda(tipo, payload) {
  const ora = new Date().toISOString();
  return stmtAccoda.run(tipo, JSON.stringify(payload), ora, ora).lastInsertRowid;
}

const stmtDaLavorare = db.prepare(`
  SELECT id, tipo, payload, tentativi FROM outbox
   WHERE stato = 'in_attesa' AND prossimo_tentativo <= ?
   ORDER BY id
   LIMIT 20
`);

const stmtCompletato = db.prepare(
  `UPDATE outbox SET stato = 'completato', completato_il = ?, ultimo_errore = NULL WHERE id = ?`
);

const stmtRiprova = db.prepare(
  `UPDATE outbox SET tentativi = ?, ultimo_errore = ?, prossimo_tentativo = ? WHERE id = ?`
);

const stmtScartato = db.prepare(
  `UPDATE outbox SET stato = 'scartato', ultimo_errore = ?, completato_il = ? WHERE id = ?`
);

let inCorso = false;

export async function elaboraCoda() {
  if (inCorso) return { elaborati: 0 };
  inCorso = true;
  let elaborati = 0;

  try {
    const righe = stmtDaLavorare.all(new Date().toISOString());

    for (const riga of righe) {
      const gestore = gestori.get(riga.tipo);

      if (!gestore) {
        // Nessun gestore registrato: il tipo non esiste piu'. Inutile ritentare.
        stmtScartato.run(`Nessun gestore per il tipo "${riga.tipo}"`, new Date().toISOString(), riga.id);
        continue;
      }

      try {
        const esito = await gestore(JSON.parse(riga.payload));

        // Il gestore puo' segnalare "non ora": la riga resta in attesa senza
        // contare come errore (es. Foglio Google non ancora configurato).
        if (esito && esito.rimanda) {
          const attesa = esito.minuti ?? 5;
          stmtRiprova.run(riga.tentativi, esito.motivo || 'in attesa di configurazione',
            new Date(Date.now() + attesa * 60000).toISOString(), riga.id);
          continue;
        }

        stmtCompletato.run(new Date().toISOString(), riga.id);
        elaborati++;
      } catch (err) {
        const tentativi = riga.tentativi + 1;
        const attesa = ATTESE_MINUTI[Math.min(tentativi - 1, ATTESE_MINUTI.length - 1)];
        stmtRiprova.run(tentativi, String(err?.message || err).slice(0, 500),
          new Date(Date.now() + attesa * 60000).toISOString(), riga.id);

        if (tentativi === SOGLIA_ALLARME) {
          console.error(`[outbox] "${riga.tipo}" #${riga.id} fallito ${tentativi} volte: ${err?.message}`);
        }
      }
    }
  } finally {
    inCorso = false;
  }

  return { elaborati };
}

export function statoCoda() {
  const c = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE stato = 'in_attesa')                            AS in_attesa,
      COUNT(*) FILTER (WHERE stato = 'in_attesa' AND tentativi >= ?)         AS in_difficolta,
      COUNT(*) FILTER (WHERE stato = 'scartato')                             AS scartati
    FROM outbox
  `).get(SOGLIA_ALLARME);

  return {
    in_attesa: c.in_attesa,
    in_difficolta: c.in_difficolta,
    scartati: c.scartati,
    problemi: db.prepare(`
      SELECT id, tipo, tentativi, ultimo_errore, creato_il FROM outbox
       WHERE stato = 'in_attesa' AND tentativi >= ?
       ORDER BY id LIMIT 20
    `).all(SOGLIA_ALLARME)
  };
}

/** Rimette in coda tutto subito, es. dopo aver configurato il Foglio Google. */
export function riprovaTutto() {
  return db.prepare(
    `UPDATE outbox SET prossimo_tentativo = ?, tentativi = 0
      WHERE stato IN ('in_attesa', 'scartato')`
  ).run(new Date().toISOString()).changes;
}

let timer = null;

export function avviaWorker(intervalloSecondi = 30) {
  if (timer) return;
  const tick = () => elaboraCoda().catch((e) => console.error('[outbox] errore worker:', e));
  timer = setInterval(tick, intervalloSecondi * 1000);
  timer.unref?.();
  tick();
}

export function fermaWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
