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

export function aggiungi({ dal, al, ambulatorio_id, motivo }) {
  if (!dataValida(dal)) throw new ErroreDominio('Data di inizio non valida.');
  const fine = al || dal;
  if (!dataValida(fine)) throw new ErroreDominio('Data di fine non valida.');
  if (fine < dal) throw new ErroreDominio('La data di fine è precedente a quella di inizio.');

  const ambulatorioId = ambulatorio_id ? Number(ambulatorio_id) : null;
  if (ambulatorioId && !trovaAmbulatorio(ambulatorioId)) {
    throw new ErroreDominio('Ambulatorio non valido.');
  }

  const info = db.prepare(
    'INSERT INTO chiusure (ambulatorio_id, dal, al, motivo, creata_il) VALUES (?, ?, ?, ?, ?)'
  ).run(ambulatorioId, dal, fine, String(motivo || '').trim().slice(0, 120) || null,
    new Date().toISOString());

  return { chiusura: db.prepare('SELECT * FROM chiusure WHERE id = ?').get(info.lastInsertRowid),
    prenotazioni_da_avvisare: prenotazioniColpite(dal, fine, ambulatorioId) };
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
export function prenotazioniColpite(dal, al, ambulatorioId = null) {
  const filtroAmb = ambulatorioId ? 'AND p.ambulatorio_id = ?' : '';
  const par = ambulatorioId ? [dal, al, ambulatorioId] : [dal, al];

  return db.prepare(`
    SELECT p.codice, p.data, p.ora_inizio, pa.nome, pa.cognome, pa.telefono, a.nome AS ambulatorio_nome
      FROM prenotazioni p
      JOIN pazienti pa ON pa.id = p.paziente_id
      JOIN ambulatori a ON a.id = p.ambulatorio_id
     WHERE p.stato = 'confermata' AND p.data BETWEEN ? AND ? ${filtroAmb}
     ORDER BY p.data, p.ora_inizio
  `).all(...par);
}
