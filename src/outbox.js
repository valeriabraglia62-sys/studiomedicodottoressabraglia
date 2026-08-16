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

/**
 * Come si compone l'avviso "questa notifica non riesce a partire".
 *
 * Lo passa il mailer, invece di essere importato da qui, perche' e' il mailer a
 * registrarsi come gestore della coda: importarlo da questa parte chiuderebbe
 * il giro e i due moduli non si caricherebbero piu'.
 */
let componiAvvisoDifficolta = null;
export function impostaAvvisoDifficolta(fn) {
  componiAvvisoDifficolta = fn;
}

/**
 * Avvisa lo studio che una consegna continua a fallire.
 *
 * Prima qui c'era solo una riga di console, che su una macchina senza nessuno
 * davanti non la legge mai nessuno: il paziente non sapeva che la sua ricetta
 * era pronta, e lo studio non sapeva che il paziente non lo sapeva.
 *
 * L'avviso e' a sua volta una email in coda. Se a essere rotto e' proprio
 * l'invio, aspettera' insieme alle altre e partira' quando l'invio torna: e'
 * il momento in cui serve, perche' e' allora che si scopre cosa e' rimasto
 * indietro. Il contrassegno serve a non avvisare del fallimento di un avviso,
 * che sarebbe un giro senza fine.
 */
function avvisaDifficolta(riga, errore) {
  if (!componiAvvisoDifficolta) return;

  let payload = {};
  try { payload = JSON.parse(riga.payload); } catch { /* payload illeggibile */ }
  if (payload.avvisoInterno) return;

  accoda('email', {
    ...componiAvvisoDifficolta({
      tipo: riga.tipo,
      tentativi: riga.tentativi + 1,
      errore: String(errore?.message || errore).slice(0, 300),
      destinatario: payload.to || null
    }),
    avvisoInterno: true
  });
}

const stmtAccoda = db.prepare(`
  INSERT INTO outbox (tipo, payload, prossimo_tentativo, creato_il)
  VALUES (?, ?, ?, ?)
`);

/**
 * Da chiamare dentro una transazione, insieme alla scrittura del dato.
 *
 * fraMinuti serve a chi deve aspettare qualcosa che arriva subito dopo — una
 * foto che il paziente sta caricando in quel momento. La riga e' comunque
 * scritta ora, insieme al dato: il ritardo riguarda solo quando parte, quindi
 * la garanzia "o si salvano entrambi o nessuno dei due" resta intatta.
 */
export function accoda(tipo, payload, { fraMinuti = 0 } = {}) {
  const ora = new Date().toISOString();
  const quando = fraMinuti > 0
    ? new Date(Date.now() + fraMinuti * 60000).toISOString()
    : ora;
  return stmtAccoda.run(tipo, JSON.stringify(payload), quando, ora).lastInsertRowid;
}

/**
 * C'e' ancora un'email ferma in coda che porterà gli allegati di questa richiesta?
 *
 * Se sì, chi carica un file adesso non deve fare niente: quella email li
 * raccoglierà da sola quando parte. Se no, l'avviso e' gia' arrivato allo studio
 * senza la foto, e va mandato un secondo messaggio.
 */
export const avvisoAncoraInCoda = (richiestaId) => !!db.prepare(`
  SELECT 1 FROM outbox
   WHERE tipo = 'email' AND stato = 'in_attesa'
     AND json_extract(payload, '$.allegatiDi') = ?
   LIMIT 1
`).get(richiestaId);

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
          avvisaDifficolta(riga, err);
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
