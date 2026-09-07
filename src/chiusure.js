import { db } from './db.js';
import { ErroreDominio } from './prenotazioni.js';
import { dataValida, trovaAmbulatorio, oggiISO } from './orari.js';

/**
 * Ferie, festivi e chiusure straordinarie.
 * Una chiusura senza ambulatorio vale per tutto lo studio.
 */

export function elenco() {
  return db.prepare(`
    SELECT c.*, a.nome AS ambulatorio_nome
      FROM chiusure c
      LEFT JOIN ambulatori a ON a.id = c.ambulatorio_id
     ORDER BY c.dal DESC
  `).all().map((c) => ({ ...c, passata: c.al < oggiISO() }));
}

const oraValida = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));

export function aggiungi({ dal, al, ambulatorio_id, motivo, ora_inizio, ora_fine }) {
  if (!dataValida(dal)) throw new ErroreDominio('Data di inizio non valida.');
  const fine = al || dal;
  if (!dataValida(fine)) throw new ErroreDominio('Data di fine non valida.');
  if (fine < dal) throw new ErroreDominio('La data di fine è precedente a quella di inizio.');

  // Fascia oraria facoltativa: se c'è, vale per ogni giorno dell'intervallo.
  // Vuota = l'intera giornata, com'era prima.
  let oraDa = null;
  let oraA = null;
  if (ora_inizio || ora_fine) {
    if (!oraValida(ora_inizio) || !oraValida(ora_fine)) {
      throw new ErroreDominio('Orario non valido: usa il formato HH:MM.');
    }
    if (ora_fine <= ora_inizio) throw new ErroreDominio('L\'ora di fine deve essere dopo quella di inizio.');
    oraDa = ora_inizio;
    oraA = ora_fine;
  }

  const ambulatorioId = ambulatorio_id ? Number(ambulatorio_id) : null;
  if (ambulatorioId && !trovaAmbulatorio(ambulatorioId)) {
    throw new ErroreDominio('Ambulatorio non valido.');
  }

  const info = db.prepare(
    'INSERT INTO chiusure (ambulatorio_id, dal, al, motivo, ora_inizio, ora_fine, creata_il) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(ambulatorioId, dal, fine, String(motivo || '').trim().slice(0, 120) || null,
    oraDa, oraA, new Date().toISOString());

  return { chiusura: db.prepare('SELECT * FROM chiusure WHERE id = ?').get(info.lastInsertRowid),
    prenotazioni_da_avvisare: prenotazioniColpite(dal, fine, ambulatorioId, oraDa, oraA) };
}

export function rimuovi(id) {
  const info = db.prepare('DELETE FROM chiusure WHERE id = ?').run(Number(id));
  if (!info.changes) throw new ErroreDominio('Chiusura non trovata.', 404);
  return { rimossa: true };
}

/**
 * Prenotazioni gia' confermate che cadono dentro la chiusura appena creata.
 * Non le annulla da sola: e' una decisione che spetta allo studio, ma vederle
 * subito evita di scoprire il conflitto il giorno stesso.
 */
export function prenotazioniColpite(dal, al, ambulatorioId = null, oraDa = null, oraA = null) {
  const clausole = ["p.stato = 'confermata'", 'p.data BETWEEN ? AND ?'];
  const par = [dal, al];
  if (ambulatorioId) { clausole.push('p.ambulatorio_id = ?'); par.push(ambulatorioId); }
  // Con una fascia oraria contano gli appuntamenti che si SOVRAPPONGONO, non
  // solo quelli che iniziano dentro: una visita 10:15-10:30 e' colpita da una
  // chiusura 10:20-11:00. Stessa formula di slotBloccatoDaChiusura.
  if (oraDa && oraA) { clausole.push('p.ora_inizio < ? AND p.ora_fine > ?'); par.push(oraA, oraDa); }

  return db.prepare(`
    SELECT p.codice, p.data, p.ora_inizio, pa.nome, pa.cognome, pa.telefono, a.nome AS ambulatorio_nome
      FROM prenotazioni p
      JOIN pazienti pa ON pa.id = p.paziente_id
      JOIN ambulatori a ON a.id = p.ambulatorio_id
     WHERE ${clausole.join(' AND ')}
     ORDER BY p.data, p.ora_inizio
  `).all(...par);
}
