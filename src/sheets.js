import { config } from './config.js';
import { registraGestore } from './outbox.js';
import { formattaDataEstesa } from './orari.js';

/**
 * Sincronizzazione con il Foglio Google.
 *
 * Il database resta la fonte di verita': il foglio ne e' uno specchio.
 * Se il foglio non e' configurato o Google non risponde, il gestore chiede di
 * rimandare e la riga resta in coda. Appena la configurazione c'e', tutto lo
 * storico arretrato viene sincronizzato senza perdere nulla.
 */

const SCHEDE = {
  prenotazione: {
    titolo: 'Prenotazioni',
    intestazioni: ['Codice', 'Stato', 'Data', 'Giorno', 'Ora inizio', 'Ora fine', 'Ambulatorio',
      'Paziente', 'Telefono', 'Email', 'Motivo', 'Origine', 'Creata il', 'Annullata il', 'Annullata da'],
    riga: (p) => [
      p.codice, p.stato, p.data, formattaDataEstesa(p.data), p.ora_inizio, p.ora_fine,
      p.ambulatorio_nome, `${p.paziente_nome} ${p.paziente_cognome}`, p.paziente_telefono || '',
      p.paziente_email || '', p.problema, p.origine, p.creata_il,
      p.annullata_il || '', p.annullata_da || ''
    ]
  },
  medicina: {
    titolo: 'Richieste medicinali',
    intestazioni: ['Codice', 'Stato', 'Paziente', 'Telefono', 'Email', 'Medicinali',
      'Note', 'Ambulatorio', 'Origine', 'Creata il', 'Aggiornata il'],
    riga: (r) => [
      r.codice, r.stato, `${r.nome} ${r.cognome}`, r.telefono || '', r.email || '',
      r.farmaci, r.note || '', r.ambulatorio_nome || '', r.origine, r.creata_il, r.aggiornata_il || ''
    ]
  }
};

let clientPromise = null;

/**
 * googleapis si carica al primo uso, non all'avvio.
 *
 * E' la libreria piu' pesante del progetto (oltre 1800 file) e teneva fermo
 * l'avvio del server per minuti, anche con il foglio Google disattivato.
 * Caricandola qui, il sito parte subito e il costo si paga una volta sola.
 */
function client() {
  if (!clientPromise) {
    clientPromise = import('googleapis').then(({ google }) => {
      const auth = new google.auth.GoogleAuth({
        keyFile: config.sheets.credentialsFile,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      return google.sheets({ version: 'v4', auth });
    }).catch((err) => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

const schedeVerificate = new Set();

/** Crea la scheda e la riga di intestazione se mancano. */
async function assicuraScheda(sheets, scheda) {
  if (schedeVerificate.has(scheda.titolo)) return;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  const esiste = meta.data.sheets.some((s) => s.properties.title === scheda.titolo);

  if (!esiste) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheets.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: scheda.titolo } } }] }
    });
  }

  const prima = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${scheda.titolo}!A1:Z1`
  });

  if (!prima.data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.sheetId,
      range: `${scheda.titolo}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [scheda.intestazioni] }
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheets.sheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId: await idScheda(sheets, scheda.titolo), startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.05, green: 0.43, blue: 0.43 }
              }
            },
            fields: 'userEnteredFormat(textFormat,backgroundColor)'
          }
        }]
      }
    });
  }

  schedeVerificate.add(scheda.titolo);
}

async function idScheda(sheets, titolo) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  return meta.data.sheets.find((s) => s.properties.title === titolo)?.properties.sheetId;
}

/** Numero di riga (1-based) del record con questo codice, oppure null. */
async function trovaRiga(sheets, titolo, codice) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${titolo}!A:A`
  });
  const colonna = res.data.values || [];
  for (let i = 1; i < colonna.length; i++) {
    if (colonna[i][0] === codice) return i + 1;
  }
  return null;
}

async function sincronizza(tipoScheda, dati) {
  if (!config.sheets.enabled) {
    return { rimanda: true, motivo: 'sincronizzazione Foglio Google disattivata', minuti: 60 };
  }
  if (!config.sheets.ready) {
    return { rimanda: true, motivo: 'Foglio Google non configurato (manca ID o file credenziali)', minuti: 15 };
  }

  const scheda = SCHEDE[tipoScheda];
  const sheets = await client();
  await assicuraScheda(sheets, scheda);

  const valori = scheda.riga(dati);
  const rigaEsistente = await trovaRiga(sheets, scheda.titolo, dati.codice);

  if (rigaEsistente) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.sheetId,
      range: `${scheda.titolo}!A${rigaEsistente}`,
      valueInputOption: 'RAW',
      requestBody: { values: [valori] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.sheets.sheetId,
      range: `${scheda.titolo}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [valori] }
    });
  }
}

registraGestore('sheet_prenotazione', (payload) => sincronizza('prenotazione', payload));
registraGestore('sheet_medicina', (payload) => sincronizza('medicina', payload));

export async function verificaFoglio() {
  if (!config.sheets.enabled) return { ok: false, motivo: 'disattivata in .env (GOOGLE_SHEETS_ENABLED=false)' };
  if (!config.sheets.sheetId) return { ok: false, motivo: 'manca GOOGLE_SHEET_ID in .env' };
  if (!config.sheets.ready) return { ok: false, motivo: `file credenziali non trovato: ${config.sheets.credentialsFile}` };
  try {
    const sheets = await client();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
    return { ok: true, titolo: meta.data.properties.title };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}
