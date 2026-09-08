import { db } from './db.js';
import { accoda } from './outbox.js';
import { generaCodice, ErroreDominio, trovaOCreaPaziente, telefonoValido, emailValida } from './prenotazioni.js';
import { dataValida, oggiISO, aggiungiGiorni, trovaAmbulatorio, slotDisponibili, GIORNI_PRENOTABILI } from './orari.js';
import { emailAttesaRegistrata, emailPostoLibero } from './mailer.js';

/**
 * Lista d'attesa: chi non trova posto lascia il contatto e viene avvisato
 * quando qualcuno annulla.
 *
 * L'avviso va a tutti gli iscritti di quel giorno, non solo al primo: un solo
 * avvisato che non legge l'email terrebbe il posto bloccato fino alla scadenza.
 * Chi prenota per primo se lo prende, ed e' esattamente come funziona il resto
 * del sito.
 */

const SELECT_COMPLETO = `
  SELECT l.*,
         a.nome     AS ambulatorio_nome,
         pa.nome    AS paziente_nome,
         pa.cognome AS paziente_cognome,
         pa.telefono AS paziente_telefono,
         pa.email    AS paziente_email
    FROM lista_attesa l
    JOIN ambulatori a  ON a.id  = l.ambulatorio_id
    JOIN pazienti   pa ON pa.id = l.paziente_id
`;

const dettaglio = (id) => db.prepare(`${SELECT_COMPLETO} WHERE l.id = ?`).get(id);

export function iscrivi(dati) {
  const nome = String(dati.nome || '').trim().slice(0, 60);
  const cognome = String(dati.cognome || '').trim().slice(0, 60);
  const problema = String(dati.problema || '').trim().slice(0, 500);
  const email = String(dati.email || '').trim().toLowerCase();

  if (nome.length < 2) throw new ErroreDominio('Inserisci un nome valido.');
  if (cognome.length < 2) throw new ErroreDominio('Inserisci un cognome valido.');
  if (!telefonoValido(dati.telefono)) throw new ErroreDominio('Inserisci un numero di telefono valido.');
  // Qui l'email non e' facoltativa: e' l'unico modo per avvisare del posto libero.
  if (!emailValida(email)) throw new ErroreDominio("Serve un'email valida per poterti avvisare.");
  if (problema.length < 3) throw new ErroreDominio('Descrivi brevemente il motivo della visita.');

  if (!dataValida(dati.data)) throw new ErroreDominio('Data non valida.');
  const oggi = oggiISO();
  if (dati.data < oggi) throw new ErroreDominio('Non è possibile mettersi in attesa per un giorno passato.');
  if (dati.data > aggiungiGiorni(oggi, GIORNI_PRENOTABILI)) {
    throw new ErroreDominio(`Si può richiedere al massimo ${GIORNI_PRENOTABILI} giorni in anticipo.`);
  }

  const ambulatorio = trovaAmbulatorio(dati.ambulatorio_id);
  if (!ambulatorio) throw new ErroreDominio('Ambulatorio non valido.');

  if (slotDisponibili(dati.data, ambulatorio.id).some((s) => s.disponibile)) {
    throw new ErroreDominio('Quel giorno ha ancora orari liberi: puoi prenotare subito.');
  }

  const transazione = db.transaction(() => {
    const paziente = trovaOCreaPaziente(
      { nome, cognome, email, telefono: dati.telefono, pazienteId: dati.pazienteId },
      { contesto: 'una iscrizione alla lista d\'attesa' });

    const gia = db.prepare(
      `SELECT codice FROM lista_attesa
        WHERE paziente_id = ? AND data = ? AND ambulatorio_id = ? AND stato = 'in_attesa'`
    ).get(paziente.id, dati.data, ambulatorio.id);
    if (gia) throw new ErroreDominio(`Sei già in lista per quel giorno (codice ${gia.codice}).`);

    const codice = generaCodice('ATT');
    const info = db.prepare(`
      INSERT INTO lista_attesa (codice, ambulatorio_id, data, paziente_id, problema, creata_il)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(codice, ambulatorio.id, dati.data, paziente.id, problema, new Date().toISOString());

    const voce = dettaglio(info.lastInsertRowid);
    accoda('email', emailAttesaRegistrata(voce));
    return voce;
  });

  return transazione();
}

/**
 * Chiamata quando una prenotazione viene annullata: avvisa chi aspettava
 * quel giorno. Ogni voce viene avvisata una volta sola.
 */
export function avvisaPerPostoLibero({ data, ambulatorio_id }) {
  const inAttesa = db.prepare(
    `${SELECT_COMPLETO} WHERE l.data = ? AND l.ambulatorio_id = ? AND l.stato = 'in_attesa'
      ORDER BY l.id`
  ).all(data, ambulatorio_id);

  if (!inAttesa.length) return 0;

  const slot = slotDisponibili(data, ambulatorio_id).find((s) => s.disponibile);
  if (!slot) return 0;

  const adesso = new Date().toISOString();
  const segna = db.prepare(`UPDATE lista_attesa SET stato = 'avvisato', avvisato_il = ? WHERE id = ?`);

  for (const voce of inAttesa) {
    accoda('email', emailPostoLibero(voce, slot));
    segna.run(adesso, voce.id);
  }
  return inAttesa.length;
}

export function elencoAdmin({ stato = 'in_attesa' } = {}) {
  const filtro = stato ? 'WHERE l.stato = ?' : '';
  const par = stato ? [stato] : [];
  return {
    attese: db.prepare(`${SELECT_COMPLETO} ${filtro} ORDER BY l.data, l.id`).all(...par)
  };
}

export function chiudi(codice) {
  const info = db.prepare(`UPDATE lista_attesa SET stato = 'chiusa' WHERE codice = ?`)
    .run(String(codice || '').trim().toUpperCase());
  if (!info.changes) throw new ErroreDominio('Voce non trovata.', 404);
  return { chiusa: true };
}

/** Le voci per giorni ormai passati non servono piu' a nessuno. */
export function pulisciScadute() {
  return db.prepare(`DELETE FROM lista_attesa WHERE data < ?`).run(oggiISO()).changes;
}
