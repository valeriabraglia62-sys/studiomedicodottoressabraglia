import crypto from 'crypto';
import { db } from './db.js';
import { config } from './config.js';
import { clientFogli } from './sheets.js';
import { listaAmbulatori, dataValida } from './orari.js';
import { ErroreDominio, generaCodice, creaPrenotazione } from './prenotazioni.js';
import { creaRichiesta } from './medicine.js';

/**
 * Moduli Google: la porta che resta aperta quando il sito e' spento.
 *
 * Il sito vive sul computer dello studio e non e' acceso sempre. I computer di
 * Google invece si': il paziente compila il modulo a qualsiasi ora e Google
 * scrive la riga nel foglio delle risposte. Quando il sito si riaccende legge
 * le righe nuove, le parcheggia e le mette sulla scrivania di chi apre.
 *
 * Regola che governa tutto il file: **in ingresso non si scarta mai niente**.
 * Una riga incomprensibile o incompleta viene salvata comunque, integrale, e
 * verra' sistemata a mano al momento della conferma. Rifiutarla qui vorrebbe
 * dire perdere una richiesta, e quello non puo' succedere.
 */

// ---- Lettura delle colonne ------------------------------------------------

/** Toglie accenti, maiuscole e punteggiatura: le domande le scrive una persona. */
const normalizza = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Le intestazioni del foglio sono le domande del modulo, scritte in italiano
 * da chi ha creato il modulo. Invece di pretendere parole esatte le cerchiamo
 * per pezzi, cosi' "Il tuo numero di telefono" e "Telefono" funzionano uguale.
 */
const CAMPI = {
  cognome: ['cognome'],
  nome: ['nome'],
  telefono: ['telefono', 'cellulare', 'numero'],
  email: ['email', 'mail', 'posta elettronica'],
  data: ['giorno', 'data'],
  ora: ['ora', 'orario'],
  ambulatorio: ['ambulatorio', 'studio', 'sede', 'dove'],
  motivo: ['motivo', 'problema', 'disturbo', 'sintomo', 'ragione'],
  // Un campo solo per tutti e tre i tipi di richiesta, perche' nel foglio e'
  // sempre "la casella dove il paziente ha scritto cosa gli serve". Le parole
  // sono quelle dei tre moduli: "Quali esami del sangue le servono",
  // "Di quale visita specialistica ha bisogno", "Quali medicinali".
  // "visita" da sola resta fuori di proposito: comparirebbe anche nel modulo
  // delle prenotazioni e si mangerebbe la colonna del motivo.
  farmaci: ['medicin', 'farmac', 'ricett', 'prescriz', 'esami', 'esame', 'analisi', 'specialist'],
  note: ['note', 'aggiungere', 'altro']
};

/**
 * I tipi di modulo, e cosa diventa una riga quando la si conferma.
 *
 * Le prenotazioni fanno storia a se': portano giorno e ora e diventano una
 * visita in agenda. Gli altri tre sono la stessa richiesta con parole diverse,
 * e il tipo si porta dietro solo il nome giusto da dare a cio' che nasce.
 */
export const TIPI_MODULO = {
  prenotazione: { richiesta: null },
  medicina: { richiesta: 'medicina' },
  specialistica: { richiesta: 'specialistica' },
  esami: { richiesta: 'esami' }
};

/**
 * Associa a ogni campo l'indice della colonna che lo contiene.
 *
 * "cognome" viene cercato prima di "nome" di proposito: la domanda "Cognome"
 * contiene la parola "nome" solo per chi legge a pezzi, e senza quest'ordine
 * il cognome finirebbe nel nome di tutti i pazienti.
 */
export function mappaColonne(intestazioni) {
  const testate = intestazioni.map(normalizza);
  const mappa = {};
  const presi = new Set();

  for (const [campo, parole] of Object.entries(CAMPI)) {
    for (let i = 0; i < testate.length; i++) {
      if (presi.has(i)) continue;
      if (parole.some((p) => testate[i].includes(p))) {
        mappa[campo] = i;
        presi.add(i);
        break;
      }
    }
  }
  return mappa;
}

/** Accetta sia 2026-08-12 sia 12/08/2026: Google cambia formato secondo la lingua. */
export function leggiData(valore) {
  const t = String(valore ?? '').trim();
  if (!t) return null;

  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return dataValida(iso[0]) ? iso[0] : null;

  const ita = t.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
  if (ita) {
    const s = `${ita[3]}-${ita[2].padStart(2, '0')}-${ita[1].padStart(2, '0')}`;
    return dataValida(s) ? s : null;
  }
  return null;
}

/** "10:30", "10.30", "10,30" e "ore 10:30" indicano tutti le dieci e mezza. */
export function leggiOra(valore) {
  const m = String(valore ?? '').match(/(\d{1,2})[:.,](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Riconosce l'ambulatorio dal nome del paese, comunque sia stato scritto. */
export function leggiAmbulatorio(valore) {
  const t = normalizza(valore);
  if (!t) return null;
  for (const a of listaAmbulatori()) {
    const parole = normalizza(a.nome).split(' ').filter((p) => p.length > 3 && p !== 'ambulatorio');
    if (parole.some((p) => t.includes(p))) return a.id;
  }
  return null;
}

const testo = (v, max) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  return s || null;
};

// ---- Parcheggio -----------------------------------------------------------

/**
 * Impronta della riga.
 *
 * Serve a non registrare due volte la stessa risposta quando il foglio viene
 * riletto. Si basa sul contenuto e non sul numero di riga, cosi' regge anche
 * se qualcuno riordina o cancella righe nel foglio a mano.
 */
export const chiaveRiga = (tipo, riga) =>
  `${tipo}:${crypto.createHash('sha256').update(riga.map((c) => String(c ?? '')).join('')).digest('hex').slice(0, 32)}`;

const stmtGiaVista = db.prepare('SELECT 1 FROM richieste_modulo WHERE chiave = ?');

/**
 * Trasforma le righe del foglio in richieste parcheggiate.
 *
 * Sta separata dalla lettura di Google apposta: cosi' si puo' verificare tutto
 * il comportamento senza collegarsi a internet.
 */
export function importaRighe(tipo, righe) {
  if (!Object.hasOwn(TIPI_MODULO, tipo)) throw new ErroreDominio('Tipo di modulo non valido.');
  if (!righe?.length) return { nuove: 0, gia_viste: 0 };

  const [intestazioni, ...risposte] = righe;
  const col = mappaColonne(intestazioni || []);
  const adesso = new Date().toISOString();

  let nuove = 0;
  let giaViste = 0;

  const inserisci = db.prepare(`
    INSERT INTO richieste_modulo
      (codice, chiave, tipo, nome, cognome, telefono, email,
       data_chiesta, ora_chiesta, ambulatorio_id, testo, note, riga_json, ricevuta_il)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transazione = db.transaction(() => {
    for (const riga of risposte) {
      // Una riga tutta vuota e' solo spazio in fondo al foglio, non una richiesta.
      if (!riga?.some((c) => String(c ?? '').trim())) continue;

      const chiave = chiaveRiga(tipo, riga);
      if (stmtGiaVista.get(chiave)) { giaViste++; continue; }

      const prendi = (campo) => (col[campo] === undefined ? null : riga[col[campo]]);

      // Nome e cognome possono stare nella stessa casella: succede sia quando
      // il modulo fa una domanda sola ("Nome e cognome"), sia quando il
      // paziente scrive tutto insieme. In quel caso si divide sul primo spazio.
      let nome = testo(prendi('nome'), 60);
      let cognome = testo(prendi('cognome'), 60);
      const unico = (!nome || !cognome) ? (nome || cognome) : null;
      if (unico?.includes(' ')) {
        const parti = unico.split(' ');
        nome = parti[0];
        cognome = parti.slice(1).join(' ');
      }

      inserisci.run(
        generaCodice('MOD'),
        chiave,
        tipo,
        nome,
        cognome,
        testo(String(prendi('telefono') ?? '').replace(/[\s.\-()]/g, ''), 20),
        testo(prendi('email'), 120)?.toLowerCase() ?? null,
        leggiData(prendi('data')),
        leggiOra(prendi('ora')),
        leggiAmbulatorio(prendi('ambulatorio')),
        testo(tipo === 'prenotazione' ? prendi('motivo') : prendi('farmaci'), 1500),
        testo(prendi('note'), 500),
        // La riga originale si conserva sempre: se la lettura delle colonne
        // sbaglia, il dato vero e' ancora qui e si recupera a mano.
        JSON.stringify({ intestazioni, riga }),
        adesso
      );
      nuove++;
    }
  });

  transazione();
  return { nuove, gia_viste: giaViste };
}

// ---- Scrivania di chi apre lo studio --------------------------------------

const SELECT_COMPLETO = `
  SELECT m.*, a.nome AS ambulatorio_nome
    FROM richieste_modulo m
    LEFT JOIN ambulatori a ON a.id = m.ambulatorio_id
`;

export const perCodice = (codice) =>
  db.prepare(`${SELECT_COMPLETO} WHERE m.codice = ?`).get(String(codice || '').trim().toUpperCase());

export function elenco({ stato = 'nuova', tipo, pagina = 1, perPagina = 50 } = {}) {
  const dove = [];
  const par = [];
  if (stato) { dove.push('m.stato = ?'); par.push(stato); }
  if (tipo) { dove.push('m.tipo = ?'); par.push(tipo); }

  const filtro = dove.length ? `WHERE ${dove.join(' AND ')}` : '';
  const totale = db.prepare(`SELECT COUNT(*) AS n FROM richieste_modulo m ${filtro}`).get(...par).n;
  const limite = Math.min(Math.max(Number(perPagina) || 50, 1), 200);
  const offset = (Math.max(Number(pagina) || 1, 1) - 1) * limite;

  return {
    richieste: db.prepare(`${SELECT_COMPLETO} ${filtro} ORDER BY m.ricevuta_il ASC LIMIT ? OFFSET ?`)
      .all(...par, limite, offset),
    totale,
    pagina: Number(pagina) || 1,
    pagine: Math.ceil(totale / limite) || 1
  };
}

export const daConfermare = () =>
  db.prepare("SELECT COUNT(*) AS n FROM richieste_modulo WHERE stato = 'nuova'").get().n;

/**
 * Conferma la richiesta parcheggiata e la trasforma in una prenotazione vera.
 *
 * I dati arrivano dal pannello, non dalla riga del foglio: chi conferma li vede
 * gia' compilati e puo' correggerli. E' il punto in cui una richiesta scritta
 * male dal paziente viene raddrizzata da una persona, invece di essere buttata.
 *
 * Se lo slot risulta occupato l'errore torna indietro e la richiesta resta
 * parcheggiata: si sceglie un altro orario e si riprova.
 */
export function conferma(codice, correzioni = {}, chiConferma = null) {
  const m = perCodice(codice);
  if (!m) throw new ErroreDominio('Richiesta non trovata.', 404);
  if (m.stato !== 'nuova') throw new ErroreDominio('Questa richiesta è già stata gestita.');

  const d = {
    nome: correzioni.nome ?? m.nome,
    cognome: correzioni.cognome ?? m.cognome,
    telefono: correzioni.telefono ?? m.telefono,
    email: correzioni.email ?? m.email,
    origine: 'modulo'
  };

  // creaPrenotazione e creaRichiesta validano per conto loro: se qualcosa non
  // va l'errore esce di qui e la richiesta resta dov'e', in attesa.
  const generata = m.tipo === 'prenotazione'
    ? creaPrenotazione({
      ...d,
      data: correzioni.data ?? m.data_chiesta,
      ora_inizio: correzioni.ora_inizio ?? m.ora_chiesta,
      ambulatorio_id: correzioni.ambulatorio_id ?? m.ambulatorio_id,
      problema: correzioni.problema ?? m.testo
    })
    : creaRichiesta({
      ...d,
      // Senza questo il modulo degli esami genererebbe una richiesta di
      // medicinali: stessa riga, ma finita nella scheda sbagliata e con
      // l'email sbagliata addosso.
      tipo: TIPI_MODULO[m.tipo]?.richiesta || 'medicina',
      farmaci: correzioni.farmaci ?? m.testo,
      note: correzioni.note ?? m.note,
      ambulatorio_id: correzioni.ambulatorio_id ?? m.ambulatorio_id
    });

  db.prepare(
    "UPDATE richieste_modulo SET stato = 'confermata', collegata_a = ?, gestita_il = ?, gestita_da = ? WHERE id = ?"
  ).run(generata.codice, new Date().toISOString(), chiConferma || null, m.id);

  return { richiesta: perCodice(m.codice), generata };
}

/** Scarta la richiesta, ma la lascia scritta: si vede sempre cosa era arrivato. */
export function rifiuta(codice, motivo, chiRifiuta = null) {
  const m = perCodice(codice);
  if (!m) throw new ErroreDominio('Richiesta non trovata.', 404);
  if (m.stato !== 'nuova') throw new ErroreDominio('Questa richiesta è già stata gestita.');

  db.prepare(
    "UPDATE richieste_modulo SET stato = 'rifiutata', motivo_rifiuto = ?, gestita_il = ?, gestita_da = ? WHERE id = ?"
  ).run(testo(motivo, 300), new Date().toISOString(), chiRifiuta || null, m.id);

  return perCodice(m.codice);
}

// ---- Lettura periodica dei fogli ------------------------------------------

let inCorso = false;
let timer = null;
let ultimoEsito = { mai_eseguito: true };

// Come per la casella di posta: se Google accetta la connessione e poi tace,
// senza un limite la lettura resterebbe appesa per sempre e non ripartirebbe.
const TEMPO_MASSIMO_MS = 60_000;

async function leggiFoglio(tipo) {
  const foglio = config.moduli.fogli[tipo];
  if (!foglio.id) return { nuove: 0, gia_viste: 0, saltato: 'non configurato' };

  const sheets = await clientFogli();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: foglio.id,
    range: `${foglio.scheda}!A:Z`
  });

  return importaRighe(tipo, res.data.values || []);
}

export async function controllaModuli() {
  if (inCorso) return { saltato: true };
  if (!config.moduli.enabled) {
    ultimoEsito = { ok: false, motivo: 'lettura dei Moduli disattivata (GOOGLE_MODULI_ENABLED=false)' };
    return ultimoEsito;
  }
  if (!config.moduli.ready) {
    ultimoEsito = { ok: false, motivo: 'Moduli non configurati (mancano gli ID dei fogli o il file credenziali)' };
    return ultimoEsito;
  }

  inCorso = true;
  let scadenza;
  const limite = new Promise((_, rifiutaPromessa) => {
    scadenza = setTimeout(() => rifiutaPromessa(new Error('Google non ha risposto entro 60 secondi')), TEMPO_MASSIMO_MS);
  });

  try {
    const lavoro = (async () => {
      let nuove = 0;
      for (const tipo of Object.keys(TIPI_MODULO)) {
        const esito = await leggiFoglio(tipo);
        nuove += esito.nuove || 0;
      }
      return nuove;
    })();

    const nuove = await Promise.race([lavoro, limite]);
    ultimoEsito = { ok: true, nuove, in_attesa: daConfermare(), quando: new Date().toISOString() };
  } catch (err) {
    console.error('[moduli] errore lettura:', err.message);
    ultimoEsito = { ok: false, motivo: err.message, quando: new Date().toISOString() };
  } finally {
    clearTimeout(scadenza);
    inCorso = false;
  }

  return ultimoEsito;
}

export const statoModuli = () => ({ ...ultimoEsito, attivo: Boolean(timer) });

export function avviaLetturaModuli() {
  if (timer || !config.moduli.enabled) return;
  const giro = () => controllaModuli().catch((e) => console.error('[moduli]', e));
  timer = setInterval(giro, config.moduli.intervalSeconds * 1000);
  timer.unref?.();
  // Subito, senza aspettare il primo intervallo: all'accensione ci sono le
  // richieste arrivate durante la notte, ed e' proprio il momento di leggerle.
  giro();
  console.log(`[moduli] lettura dei Moduli Google attiva ogni ${config.moduli.intervalSeconds}s`);
}

export function fermaLetturaModuli() {
  if (timer) clearInterval(timer);
  timer = null;
}
