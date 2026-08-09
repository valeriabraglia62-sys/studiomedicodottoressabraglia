import { db } from './db.js';
import { oggiISO, aggiungiGiorni, NOMI_MESI, NOMI_GIORNI } from './orari.js';

/** Numeri dello studio: quanto lavoro, quando, e quanto viene disdetto. */
export function riepilogo({ mesi = 6 } = {}) {
  const oggi = oggiISO();
  const dal = aggiungiGiorni(oggi, -Math.max(1, Math.min(Number(mesi) || 6, 24)) * 30);

  const perMese = db.prepare(`
    SELECT substr(data, 1, 7) AS mese,
           COUNT(*) AS totale,
           SUM(stato = 'confermata') AS confermate,
           SUM(stato = 'annullata')  AS annullate
      FROM prenotazioni WHERE data >= ?
     GROUP BY mese ORDER BY mese
  `).all(dal).map((r) => {
    const [anno, m] = r.mese.split('-');
    return { ...r, etichetta: `${NOMI_MESI[Number(m) - 1]} ${anno}` };
  });

  const perAmbulatorio = db.prepare(`
    SELECT a.nome, COUNT(*) AS totale
      FROM prenotazioni p JOIN ambulatori a ON a.id = p.ambulatorio_id
     WHERE p.data >= ? AND p.stato = 'confermata'
     GROUP BY a.id ORDER BY totale DESC
  `).all(dal);

  const perOra = db.prepare(`
    SELECT substr(ora_inizio, 1, 2) AS ora, COUNT(*) AS totale
      FROM prenotazioni WHERE data >= ? AND stato = 'confermata'
     GROUP BY ora ORDER BY totale DESC LIMIT 5
  `).all(dal).map((r) => ({ ...r, etichetta: `${r.ora}:00 — ${r.ora}:59` }));

  const perGiorno = db.prepare(`
    SELECT CAST(strftime('%w', data) AS INTEGER) AS giorno, COUNT(*) AS totale
      FROM prenotazioni WHERE data >= ? AND stato = 'confermata'
     GROUP BY giorno ORDER BY totale DESC
  `).all(dal).map((r) => ({ ...r, etichetta: NOMI_GIORNI[r.giorno] }));

  const tot = db.prepare(`
    SELECT COUNT(*) AS totale, SUM(stato = 'annullata') AS annullate
      FROM prenotazioni WHERE data >= ?
  `).get(dal);

  return {
    dal,
    totale: tot.totale,
    annullate: tot.annullate || 0,
    tasso_annullamento: tot.totale ? Math.round((tot.annullate || 0) * 1000 / tot.totale) / 10 : 0,
    per_mese: perMese,
    per_ambulatorio: perAmbulatorio,
    ore_piu_richieste: perOra,
    giorni_piu_richiesti: perGiorno,
    medicine: db.prepare(`
      SELECT stato, COUNT(*) AS totale FROM richieste_medicine
       WHERE creata_il >= ? GROUP BY stato
    `).all(`${dal}T00:00:00.000Z`),
    nuovi_pazienti: db.prepare('SELECT COUNT(*) AS n FROM pazienti WHERE creato_il >= ?')
      .get(`${dal}T00:00:00.000Z`).n
  };
}

const ESCAPE_CSV = /^[=+\-@\t\r]/;

/**
 * Una cella che inizia con = o + viene interpretata come formula da Excel:
 * l'apostrofo la rende testo. Senza questo un cognome tipo "-Rossi" diventa
 * un errore di calcolo, e un testo scelto ad arte diventa una formula eseguita.
 */
function cella(valore) {
  let s = String(valore ?? '');
  if (ESCAPE_CSV.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** CSV con punto e virgola e BOM: e' il formato che Excel italiano apre senza chiedere nulla. */
export function esportaPrenotazioni({ dal, al } = {}) {
  const dove = [];
  const par = [];
  if (dal) { dove.push('p.data >= ?'); par.push(dal); }
  if (al) { dove.push('p.data <= ?'); par.push(al); }
  const filtro = dove.length ? `WHERE ${dove.join(' AND ')}` : '';

  const righe = db.prepare(`
    SELECT p.codice, p.data, p.ora_inizio, p.ora_fine, a.nome AS ambulatorio,
           pa.cognome, pa.nome, pa.telefono, pa.email, p.problema, p.stato,
           p.origine, p.creata_il
      FROM prenotazioni p
      JOIN ambulatori a ON a.id = p.ambulatorio_id
      JOIN pazienti pa ON pa.id = p.paziente_id
      ${filtro}
     ORDER BY p.data, p.ora_inizio
  `).all(...par);

  const intestazioni = ['Codice', 'Data', 'Ora inizio', 'Ora fine', 'Ambulatorio', 'Cognome',
    'Nome', 'Telefono', 'Email', 'Motivo', 'Stato', 'Origine', 'Registrata il'];

  const corpo = righe.map((r) => Object.values(r).map(cella).join(';')).join('\r\n');
  return `﻿${intestazioni.map(cella).join(';')}\r\n${corpo}\r\n`;
}

export function esportaMedicine({ dal, al } = {}) {
  const dove = [];
  const par = [];
  if (dal) { dove.push('creata_il >= ?'); par.push(`${dal}T00:00:00.000Z`); }
  if (al) { dove.push('creata_il <= ?'); par.push(`${al}T23:59:59.999Z`); }
  const filtro = dove.length ? `WHERE ${dove.join(' AND ')}` : '';

  const righe = db.prepare(`
    SELECT codice, cognome, nome, telefono, email, farmaci, note, stato, origine, creata_il
      FROM richieste_medicine ${filtro} ORDER BY creata_il
  `).all(...par);

  const intestazioni = ['Codice', 'Cognome', 'Nome', 'Telefono', 'Email', 'Medicinali',
    'Note', 'Stato', 'Origine', 'Ricevuta il'];

  const corpo = righe.map((r) => Object.values(r).map(cella).join(';')).join('\r\n');
  return `﻿${intestazioni.map(cella).join(';')}\r\n${corpo}\r\n`;
}
