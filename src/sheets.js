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
  ...schedaRichiesta('medicina', 'Richieste medicinali', 'Medicinali', 'Numero ricetta'),
  ...schedaRichiesta('specialistica', 'Visite specialistiche', 'Visita richiesta', 'Numero impegnativa (NRE)'),
  ...schedaRichiesta('esami', 'Esami del sangue', 'Esami richiesti', 'Numero impegnativa (NRE)')
};

/**
 * Le tre richieste hanno lo stesso foglio con parole diverse.
 *
 * Cambia il nome della colonna in cui finisce cio' che il paziente ha chiesto —
 * "Medicinali", "Visita richiesta", "Esami richiesti" — e cambia come si chiama
 * il numero che lo studio scrive dopo: per i farmaci e' il numero della ricetta,
 * per le altre due l'NRE dell'impegnativa. Il resto e' identico, e deve
 * restarlo: un domani si aggiunge una colonna qui e la prendono tutti e tre.
 */
/** Le colonne, esposte perche' una prova possa controllarne l'ordine. */
export const SCHEDE_PROVA = SCHEDE;

function schedaRichiesta(tipo, titolo, colonnaChiesto, colonnaNumero) {
  return {
    [tipo]: {
      titolo,
      // Il numero sta in fondo e non vicino allo stato, dove starebbe meglio.
      // Il foglio dei medicinali esiste gia' e ha centinaia di righe scritte con
      // le colonne di prima: infilarne una in mezzo sposterebbe di un posto
      // tutto quello che viene dopo, e da domani "Origine" finirebbe sotto
      // l'intestazione sbagliata mentre le righe vecchie restano dov'erano.
      // In fondo invece le vecchie hanno solo una cella vuota in piu'.
      intestazioni: ['Codice', 'Stato', 'Paziente', 'Telefono', 'Email', colonnaChiesto,
        'Note', 'Ambulatorio', 'Origine', 'Creata il', 'Aggiornata il', colonnaNumero],
      riga: (r) => [
        r.codice, r.stato, `${r.nome} ${r.cognome}`, r.telefono || '', r.email || '',
        r.farmaci, r.note || '', r.ambulatorio_nome || '', r.origine, r.creata_il,
        r.aggiornata_il || '', r.numero_ricetta || ''
      ]
    }
  };
}

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

/**
 * Lo stesso collegamento a Google, riusato da chi deve solo leggere
 * (i Moduli). Una connessione sola invece di due, e la libreria pesante
 * continua a caricarsi una volta soltanto.
 */
export const clientFogli = () => client();

const schedeVerificate = new Set();

/** Crea la scheda e la riga di intestazione se mancano. */
async function assicuraScheda(sheets, scheda, foglio) {
  const marcatore = `${foglio}/${scheda.titolo}`;
  if (schedeVerificate.has(marcatore)) return;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: foglio });
  const esiste = meta.data.sheets.some((s) => s.properties.title === scheda.titolo);

  if (!esiste) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: foglio,
      requestBody: { requests: [{ addSheet: { properties: { title: scheda.titolo } } }] }
    });
  }

  const prima = await sheets.spreadsheets.values.get({
    spreadsheetId: foglio,
    range: `${scheda.titolo}!A1:Z1`
  });

  /**
   * L'intestazione si riscrive anche quando c'e' gia' ma non corrisponde.
   *
   * Prima si scriveva solo alla creazione della scheda, e una colonna aggiunta
   * dopo restava senza nome per sempre: nel foglio dei medicinali il numero
   * della ricetta sarebbe comparso sotto una casella vuota, e chi guarda non
   * avrebbe avuto modo di sapere cos'e' quella colonna.
   *
   * Si tocca solo la riga 1. Le righe dei dati non si spostano di un millimetro,
   * ed e' il motivo per cui le colonne nuove vanno aggiunte in fondo.
   */
  const attuali = prima.data.values?.[0] || [];
  const daScrivere = attuali.length === 0
    || scheda.intestazioni.some((nome, i) => attuali[i] !== nome);

  if (daScrivere) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: foglio,
      range: `${scheda.titolo}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [scheda.intestazioni] }
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: foglio,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId: await idScheda(sheets, scheda.titolo, foglio), startRowIndex: 0, endRowIndex: 1 },
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

  schedeVerificate.add(marcatore);
}

async function idScheda(sheets, titolo, foglio) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: foglio });
  return meta.data.sheets.find((s) => s.properties.title === titolo)?.properties.sheetId;
}

/** Numero di riga (1-based) del record con questo codice, oppure null. */
async function trovaRiga(sheets, titolo, codice, foglio) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: foglio,
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
  const foglio = config.sheets.fogli[tipoScheda];

  // Un foglio non ancora creato non e' un errore: e' una cosa che manca. La
  // riga resta in coda e parte da sola il giorno che si aggiunge l'ID nel .env,
  // senza contare come tentativo fallito e senza far scattare nessun allarme.
  if (!foglio) {
    return {
      rimanda: true,
      motivo: `foglio "${scheda.titolo}" non ancora configurato nel .env`,
      minuti: 60
    };
  }

  const sheets = await client();
  await assicuraScheda(sheets, scheda, foglio);

  const valori = scheda.riga(dati);
  const rigaEsistente = await trovaRiga(sheets, scheda.titolo, dati.codice, foglio);

  if (rigaEsistente) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: foglio,
      range: `${scheda.titolo}!A${rigaEsistente}`,
      valueInputOption: 'RAW',
      requestBody: { values: [valori] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: foglio,
      range: `${scheda.titolo}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [valori] }
    });
  }
}

registraGestore('sheet_prenotazione', (payload) => sincronizza('prenotazione', payload));

// Un gestore per tipo di richiesta, cosi' ognuna va sul suo foglio. Il nome
// della coda contiene il tipo: le righe gia' in coda come 'sheet_medicina'
// restano valide e finiscono dove sono sempre finite.
for (const tipo of ['medicina', 'specialistica', 'esami']) {
  registraGestore(`sheet_${tipo}`, (payload) => sincronizza(tipo, payload));
}

/**
 * Controlla che entrambi i fogli siano raggiungibili.
 *
 * Se ne manca uno solo, dirlo subito all'avvio evita di scoprirlo giorni dopo
 * trovando meta' dei dati sincronizzati e l'altra meta' ferma in coda.
 */
export async function verificaFoglio() {
  if (!config.sheets.enabled) return { ok: false, motivo: 'disattivata in .env (GOOGLE_SHEETS_ENABLED=false)' };
  if (!config.sheets.fogli.prenotazione) return { ok: false, motivo: 'manca GOOGLE_SHEET_ID_PRENOTAZIONI in .env' };
  if (!config.sheets.fogli.medicina) return { ok: false, motivo: 'manca GOOGLE_SHEET_ID_MEDICINE in .env' };
  if (!config.sheets.ready) return { ok: false, motivo: `file credenziali non trovato: ${config.sheets.credentialsFile}` };

  const etichette = {
    prenotazione: 'visite', medicina: 'medicinali',
    specialistica: 'specialistiche', esami: 'esami'
  };

  try {
    const sheets = await client();
    const titoli = [];
    const mancanti = [];

    for (const [tipo, foglio] of Object.entries(config.sheets.fogli)) {
      // Specialistiche ed esami possono non avere ancora il loro foglio: si dice
      // quali mancano invece di far comparire un errore rosso su tutto quanto,
      // che farebbe pensare a un guasto dove c'e' solo una cosa da creare.
      if (!foglio) { mancanti.push(etichette[tipo]); continue; }
      try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: foglio });
        titoli.push(`${etichette[tipo]}: ${meta.data.properties.title}`);
      } catch (err) {
        return { ok: false, motivo: `foglio ${etichette[tipo]} non raggiungibile — ${err.message}` };
      }
    }

    if (mancanti.length) {
      titoli.push(`da creare: ${mancanti.join(', ')} (le righe restano in coda)`);
    }
    return { ok: true, titolo: titoli.join(' | ') };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}
