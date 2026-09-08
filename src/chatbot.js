import crypto from 'crypto';
import { db } from './db.js';
import { config } from './config.js';
import {
  listaAmbulatori, trovaAmbulatorio, slotDisponibili, formattaDataEstesa,
  oggiISO, aggiungiGiorni, orariAmbulatorio, NOMI_GIORNI, GIORNI_PRENOTABILI, dataValida
} from './orari.js';
import {
  creaPrenotazione, annullaPrenotazione, perCodice, ErroreDominio,
  telefonoValido, emailValida
} from './prenotazioni.js';
import { creaRichiesta } from './medicine.js';

/**
 * Chatbot deterministico: nessun modello linguistico, quindi non puo' inventare
 * informazioni mediche. Lo stato della conversazione e' salvato nel database,
 * non in memoria: riaprendo la pagina si riprende esattamente dal punto in cui
 * si era rimasti, e un riavvio del server non azzera nulla.
 */

const STATO_INIZIALE = { flusso: 'menu', passo: null, dati: {} };
const SCADENZA_ORE = 72;

export function creaSessione() {
  const id = crypto.randomBytes(16).toString('base64url');
  const ora = new Date().toISOString();
  db.prepare(
    'INSERT INTO chat_sessioni (id, stato_json, creata_il, ultima_attivita) VALUES (?, ?, ?, ?)'
  ).run(id, JSON.stringify(STATO_INIZIALE), ora, ora);
  return id;
}

function leggiSessione(id) {
  if (!id) return null;
  const s = db.prepare('SELECT * FROM chat_sessioni WHERE id = ?').get(id);
  if (!s) return null;
  const scaduta = Date.now() - Date.parse(s.ultima_attivita) > SCADENZA_ORE * 3600000;
  if (scaduta) {
    db.transaction(() => {
      db.prepare('DELETE FROM chat_messaggi WHERE sessione_id = ?').run(id);
      db.prepare('DELETE FROM chat_sessioni WHERE id = ?').run(id);
    })();
    return null;
  }
  return { ...s, stato: JSON.parse(s.stato_json || '{}') };
}

function salvaStato(id, stato) {
  db.prepare('UPDATE chat_sessioni SET stato_json = ?, ultima_attivita = ? WHERE id = ?')
    .run(JSON.stringify(stato), new Date().toISOString(), id);
}

function registraMessaggio(sessioneId, ruolo, testo) {
  db.prepare('INSERT INTO chat_messaggi (sessione_id, ruolo, testo, creato_il) VALUES (?, ?, ?, ?)')
    .run(sessioneId, ruolo, testo, new Date().toISOString());
}

export function cronologia(sessioneId, limite = 100) {
  return db.prepare(
    'SELECT ruolo, testo, creato_il FROM chat_messaggi WHERE sessione_id = ? ORDER BY id DESC LIMIT ?'
  ).all(sessioneId, limite).reverse();
}

// ---- Interpretazione dell'input ------------------------------------------

const norm = (t) => String(t || '').trim().toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '');

const contiene = (t, ...parole) => parole.some((p) => norm(t).includes(p));

/** Riconosce "oggi", "domani", "10/08", "10-08-2026", "2026-08-10". */
function interpretaData(testo) {
  const t = norm(testo);
  const oggi = oggiISO();

  if (contiene(t, 'oggi')) return oggi;
  if (contiene(t, 'domani')) return aggiungiGiorni(oggi, 1);
  if (contiene(t, 'dopodomani')) return aggiungiGiorni(oggi, 2);

  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];

  const ita = t.match(/(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?/);
  if (ita) {
    const g = ita[1].padStart(2, '0');
    const m = ita[2].padStart(2, '0');
    let a = ita[3] ? Number(ita[3]) : Number(oggi.slice(0, 4));
    if (a < 100) a += 2000;
    const candidata = `${a}-${m}-${g}`;
    if (!dataValida(candidata)) return null;
    // Senza anno esplicito, una data gia' passata si riferisce all'anno prossimo.
    return (!ita[3] && candidata < oggi) ? `${a + 1}-${m}-${g}` : candidata;
  }

  // Nome del giorno: prossima occorrenza.
  const indice = NOMI_GIORNI.findIndex((g) => contiene(t, norm(g)));
  if (indice >= 0) {
    for (let i = 1; i <= 7; i++) {
      const d = aggiungiGiorni(oggi, i);
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === indice) return d;
    }
  }
  return null;
}

const interpretaOra = (t) => {
  const m = String(t).match(/(\d{1,2})[:.](\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

const interpretaAmbulatorio = (t) => {
  if (contiene(t, 'arceto')) return 1;
  if (contiene(t, 'casalgrande')) return 2;
  const n = String(t).trim();
  if (n === '1') return 1;
  if (n === '2') return 2;
  return null;
};

const affermativo = (t) => contiene(t, 'si', 'sì', 'confermo', 'conferma', 'ok', 'va bene', 'certo', 'procedi');

// ---- Risposte riutilizzabili ---------------------------------------------

const MENU = {
  testo: 'Come posso aiutarti?',
  azioni: [
    { id: 'prenota', etichetta: '📅 Prenota una visita' },
    { id: 'medicine', etichetta: '💊 Richiedi medicinali' },
    { id: 'specialistica', etichetta: '🩺 Visita specialistica' },
    { id: 'esami', etichetta: '🧪 Esami del sangue' },
    { id: 'stato', etichetta: '🔍 Controlla o annulla' },
    { id: 'info', etichetta: 'ℹ️ Orari e contatti' }
  ]
};

/**
 * Le tre richieste che il chatbot sa raccogliere.
 *
 * Il giro di domande e' lo stesso — cosa ti serve, come ti chiami, telefono,
 * email, conferma — e cambiano solo le parole. Tenerlo in un posto solo evita
 * che fra sei mesi il flusso dei medicinali chieda l'email e quello degli esami
 * se la dimentichi.
 *
 * Dove c'e' allegati: true, alla fine del giro si offre di caricare la foto
 * della prescrizione. Sono gli stessi due tipi che hanno il campo file sul
 * sito: chi parla col chatbot non deve uscire, cercare il modulo giusto e
 * ridigitare tutto solo perche' ha una foto da mandare.
 */
const RICHIESTE_CHAT = {
  medicine: {
    tipo: 'medicina',
    icona: '💊',
    parole: ['medicin', 'farmac', 'ricett', 'pastigl'],
    domanda: 'Quali medicinali ti servono? Elencali pure tutti in un messaggio.',
    riChiedi: 'Scrivi il nome dei medicinali che ti servono.',
    etichettaCampo: 'Medicinali',
    chiusura: 'Lo studio la prenderà in carico e ti avviseremo quando la ricetta è pronta.'
  },
  specialistica: {
    tipo: 'specialistica',
    icona: '🩺',
    parole: ['specialist', 'cardiolog', 'ortoped', 'dermatolog', 'oculist', 'impegnativ'],
    domanda: 'Di quale visita specialistica hai bisogno? Scrivimi pure con parole tue.',
    riChiedi: 'Scrivi di quale visita hai bisogno.',
    etichettaCampo: 'Visita',
    chiusura: 'Il medico la guarderà e ti risponderemo per email.',
    allegati: true
  },
  esami: {
    tipo: 'esami',
    icona: '🧪',
    parole: ['esami', 'esame', 'sangue', 'analisi', 'prelievo', 'emocromo'],
    domanda: 'Quali esami ti servono? Elencali pure tutti in un messaggio.',
    riChiedi: 'Scrivi quali esami ti servono.',
    etichettaCampo: 'Esami',
    chiusura: 'Il medico la guarderà e ti risponderemo per email.',
    allegati: true
  }
};

/**
 * L'ordine delle domande, e cosa resta valido quando si torna su una risposta.
 *
 * Serve perche' sbagliare a scrivere il telefono alla quinta domanda non deve
 * costare tutta la conversazione da capo: prima l'unica via d'uscita era
 * "ricomincia", che butta via anche le sette risposte giuste.
 *
 * "dipende" e' la parte che non si puo' indovinare a occhio: cambiare
 * ambulatorio rende senza senso il giorno gia' scelto, e cambiare giorno rende
 * senza senso l'orario. Quelle risposte vanno rifatte, non conservate — un
 * orario libero ad Arceto non lo e' per forza a Casalgrande, e confermare su
 * quello vecchio vorrebbe dire scrivere in agenda un appuntamento che non
 * esiste. Il nome e il telefono invece non dipendono da niente.
 */
const FLUSSI = {
  prenota: {
    passi: ['ambulatorio', 'data', 'ora', 'nome', 'telefono', 'email', 'problema', 'conferma'],
    campi: {
      ambulatorio: ['ambulatorio_id'], data: ['data'], ora: ['ora_inizio'],
      nome: ['nome', 'cognome'], telefono: ['telefono'], email: ['email'], problema: ['problema']
    },
    dipende: { ambulatorio: ['data', 'ora'], data: ['ora'] },
    etichette: {
      ambulatorio: 'Ambulatorio', data: 'Giorno', ora: 'Orario', nome: 'Nome',
      telefono: 'Telefono', email: 'Email', problema: 'Motivo'
    }
  },
  richiesta: {
    passi: ['farmaci', 'nome', 'telefono', 'email', 'conferma'],
    campi: {
      farmaci: ['farmaci'], nome: ['nome', 'cognome'], telefono: ['telefono'], email: ['email']
    },
    dipende: {},
    // "farmaci" cambia nome secondo il tipo di richiesta: lo mette c.etichettaCampo.
    etichette: { nome: 'Nome', telefono: 'Telefono', email: 'Email' }
  }
};

const INDIETRO = { id: 'indietro', etichetta: '⬅️ Indietro' };

/** I modi in cui si chiede di tornare alla domanda precedente, scritti per intero. */
const COMANDI_INDIETRO = new Set([
  'indietro', 'torna indietro', 'precedente', 'domanda precedente', 'un passo indietro'
]);

const BOTTONI_CONFERMA = [
  { id: 'conferma', etichetta: '✅ Confermo' },
  { id: 'correggi', etichetta: '✏️ Correggi un dato' },
  { id: 'ricomincia', etichetta: '🔄 Ricomincia' }
];

/** Il nome dello schema per questo flusso: le tre richieste ne condividono uno. */
const schemaDi = (flusso) => (flusso === 'prenota' ? 'prenota' : 'richiesta');

/** Il bottone per tornare indietro, tranne che sulla prima domanda. */
const navigazione = (stato) =>
  (FLUSSI[schemaDi(stato.flusso)].passi.indexOf(stato.passo) > 0 ? [INDIETRO] : []);

/**
 * Cancella la risposta a un passo e quelle che da lei dipendevano.
 *
 * Restituisce i passi dipendenti che aveva senso azzerare: chi chiama lo usa
 * per sapere se puo' riportare il paziente dritto al riepilogo o se deve
 * rifargli qualche domanda.
 */
function azzera(stato, passo) {
  const schema = FLUSSI[schemaDi(stato.flusso)];
  const travolti = (schema.dipende[passo] || []).filter(
    (p) => (schema.campi[p] || []).some((campo) => stato.dati[campo] !== undefined)
  );

  for (const p of [passo, ...(schema.dipende[passo] || [])]) {
    for (const campo of schema.campi[p] || []) delete stato.dati[campo];
  }
  return travolti;
}

/** La domanda del passo in cui ci si trova adesso, per il flusso in corso. */
const domanda = (stato, c) =>
  (stato.flusso === 'prenota' ? domandaPrenota(stato) : domandaRichiesta(stato, c));

/**
 * Va alla domanda successiva — o torna al riepilogo, se si stava correggendo.
 *
 * Chi si accorge di aver sbagliato il telefono vuole cambiare il telefono, non
 * ridettare anche email e motivo della visita.
 */
function prosegui(stato, c) {
  const { passi } = FLUSSI[schemaDi(stato.flusso)];
  if (stato.correzione) {
    delete stato.correzione;
    stato.passo = 'conferma';
  } else {
    stato.passo = passi[passi.indexOf(stato.passo) + 1];
  }
  return domanda(stato, c);
}

/** L'elenco dei dati correggibili, uno per bottone. */
function bottoniCorreggi(stato, c) {
  const schema = FLUSSI[schemaDi(stato.flusso)];
  return schema.passi
    .filter((p) => p !== 'conferma')
    .map((p) => ({ id: `campo:${p}`, etichetta: `✏️ ${schema.etichette[p] || c?.etichettaCampo || 'Richiesta'}` }));
}

/**
 * I comandi di navigazione, validi dentro qualunque flusso.
 *
 * Restituisce null quando il messaggio non e' uno di questi: il flusso continua
 * per la sua strada.
 */
function navigaSePossibile(stato, t, c) {
  const schema = FLUSSI[schemaDi(stato.flusso)];

  // Confronto esatto, non "contiene": il motivo della visita e' testo libero, e
  // "non riesco a piegarmi indietro" e' una frase che un paziente scrive
  // davvero. Interpretarla come un comando gli cancellerebbe la risposta.
  if (COMANDI_INDIETRO.has(norm(t))) {
    const i = schema.passi.indexOf(stato.passo);
    if (i <= 0) {
      Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
      return risposta(MENU.testo, MENU.azioni);
    }
    delete stato.correzione;
    stato.passo = schema.passi[i - 1];
    azzera(stato, stato.passo);
    return domanda(stato, c);
  }

  if (stato.passo === 'conferma' && (t === 'correggi' || contiene(t, 'correg', 'modific', 'cambia'))) {
    return risposta('Quale dato vuoi cambiare?', [...bottoniCorreggi(stato, c), INDIETRO]);
  }

  if (t.startsWith('campo:')) {
    const passo = t.slice(6);
    if (!schema.campi[passo]) return domanda(stato, c);
    stato.passo = passo;
    // Se cambiando questo dato ne saltano altri non si puo' tornare dritti al
    // riepilogo: quelle domande vanno rifatte per forza.
    const travolti = azzera(stato, passo);
    if (travolti.length) delete stato.correzione;
    else stato.correzione = true;
    return domanda(stato, c);
  }

  return null;
}

const risposta = (testo, azioni = [], extra = {}) => ({ testo, azioni, ...extra });

function testoOrari() {
  const righe = listaAmbulatori().map((a) => {
    const orari = orariAmbulatorio(a.id);
    const giorni = [1, 2, 3, 4, 5]
      .map((g) => `  · ${NOMI_GIORNI[g]}: ${orari[g] ? `${orari[g].inizio}–${orari[g].fine}` : 'chiuso'}`)
      .join('\n');
    return `**${a.nome}**\n📍 ${a.indirizzo}\n📞 ${a.telefono}\n${giorni}`;
  });
  return righe.join('\n\n');
}

function proponiGiorni(ambulatorioId, quanti = 6) {
  const oggi = oggiISO();
  const azioni = [];
  for (let i = 0; i <= GIORNI_PRENOTABILI && azioni.length < quanti; i++) {
    const d = aggiungiGiorni(oggi, i);
    if (slotDisponibili(d, ambulatorioId).some((s) => s.disponibile)) {
      azioni.push({ id: `data:${d}`, etichetta: formattaDataEstesa(d) });
    }
  }
  return azioni;
}

// ---- Motore ---------------------------------------------------------------

function gestisci(stato, testo) {
  const t = String(testo || '').trim();

  // Comandi sempre disponibili, in qualunque punto della conversazione.
  //
  // "torna indietro" stava qui e voleva dire ricomincia: chi lo scriveva per
  // correggere l'ultima risposta si ritrovava da capo. Adesso e' un passo solo
  // all'indietro, e lo gestisce il flusso che sa a che punto e' arrivato.
  if (contiene(t, 'ricomincia', 'menu', 'annulla tutto')) {
    Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
    return risposta('Ricominciamo da capo. ' + MENU.testo, MENU.azioni);
  }
  if (contiene(t, 'aiuto', 'help')) {
    return risposta(
      'Posso aiutarti a prenotare una visita, richiedere medicinali, una visita specialistica ' +
      'o gli esami del sangue, oppure a controllare una prenotazione che hai già.\n\n' +
      'Per specialistiche ed esami, alla fine puoi allegare la foto della richiesta dello specialista.\n\n' +
      'Se sbagli una risposta puoi scrivere "indietro" per rifarla, senza ricominciare tutto. ' +
      'Scrivi "menu" per tornare al punto di partenza.', MENU.azioni);
  }

  switch (stato.flusso) {
    case 'menu': return gestisciMenu(stato, t);
    case 'prenota': return gestisciPrenota(stato, t);
    case 'medicine':
    case 'specialistica':
    case 'esami':
      return gestisciRichiesta(stato, t, RICHIESTE_CHAT[stato.flusso]);
    case 'stato': return gestisciStato(stato, t);
    default:
      Object.assign(stato, { ...STATO_INIZIALE });
      return risposta(MENU.testo, MENU.azioni);
  }
}

function gestisciMenu(stato, t) {
  // Un bottone premuto vale piu' di qualunque parola: l'ha scelto lui.
  if (t === 'prenota') {
    Object.assign(stato, { flusso: 'prenota', passo: 'ambulatorio', dati: {} });
    return domandaPrenota(stato);
  }

  /**
   * Le richieste si riconoscono PRIMA della prenotazione, e l'ordine e' la
   * cosa importante di questa funzione.
   *
   * Prima veniva controllata per prima la parola "visita", e si portava via
   * tutto: chi scriveva "avrei bisogno di una visita dal cardiologo" finiva a
   * scegliere l'ambulatorio per un appuntamento dalla dottoressa, che non e'
   * quello che aveva chiesto. Le parole delle richieste sono piu' specifiche —
   * cardiologo, esami, ricetta — quindi vanno guardate prima di quelle
   * generiche.
   */
  for (const [chiave, c] of Object.entries(RICHIESTE_CHAT)) {
    if (t === chiave || contiene(t, ...c.parole)) {
      Object.assign(stato, { flusso: chiave, passo: 'farmaci', dati: {} });
      return domandaRichiesta(stato, c);
    }
  }

  if (contiene(t, 'prenot', 'visita', 'appuntamento')) {
    Object.assign(stato, { flusso: 'prenota', passo: 'ambulatorio', dati: {} });
    return domandaPrenota(stato);
  }
  if (t === 'stato' || contiene(t, 'stato', 'controll', 'verific', 'disdet', 'annull', 'codice')) {
    stato.flusso = 'stato';
    stato.passo = 'codice';
    return risposta('Indicami il codice che hai ricevuto via email (per esempio PRE-A1B2-C3D4).');
  }
  if (t === 'info' || contiene(t, 'orari', 'contatt', 'telefono', 'indirizz', 'dove')) {
    return risposta(`${testoOrari()}\n\nPosso aiutarti con altro?`, MENU.azioni);
  }
  return risposta(`Non sono sicuro di aver capito. ${MENU.testo}`, MENU.azioni);
}

const scegliAmbulatorio = () => listaAmbulatori().map(
  (a) => ({ id: `amb:${a.id}`, etichetta: a.nome.replace('Ambulatorio di ', '') })
);

/**
 * Cosa chiede il chatbot a ogni passo della prenotazione.
 *
 * Scritta una volta sola e usata sia andando avanti sia tornando indietro: se
 * la domanda vivesse dentro il passo che la precede, correggere una risposta
 * vorrebbe dire riscriverla una seconda volta qui, e prima o poi le due
 * versioni direbbero cose diverse.
 */
function domandaPrenota(stato) {
  const d = stato.dati;
  const nav = navigazione(stato);

  switch (stato.passo) {
    case 'ambulatorio':
      return risposta(
        'In quale ambulatorio? Ricorda: **puoi prenotare solo in quello di residenza**.',
        [...scegliAmbulatorio(), ...nav]);

    case 'data': {
      const amb = trovaAmbulatorio(d.ambulatorio_id);
      const giorni = proponiGiorni(d.ambulatorio_id);
      if (!giorni.length) {
        return risposta(
          `Al momento non ci sono posti liberi presso ${amb.nome} nei prossimi ${GIORNI_PRENOTABILI} giorni. `
          + `Prova con l'altro ambulatorio o chiama lo ${amb.telefono}.`,
          [...nav, ...MENU.azioni]);
      }
      return risposta(`${amb.nome}. Per quale giorno?`, [...giorni, ...nav]);
    }

    case 'ora': {
      const liberi = slotDisponibili(d.data, d.ambulatorio_id).filter((s) => s.disponibile);
      // Il giorno puo' essersi riempito mentre il paziente rispondeva alle
      // domande successive: si torna a sceglierlo invece di mostrare il vuoto.
      if (!liberi.length) {
        stato.passo = 'data';
        azzera(stato, 'data');
        return domandaPrenota(stato);
      }
      return risposta(`Orari liberi per ${formattaDataEstesa(d.data)}:`, [
        ...liberi.slice(0, 12).map((s) => ({ id: `ora:${s.ora_inizio}`, etichetta: s.ora_inizio })),
        ...nav
      ]);
    }

    case 'nome': return risposta('Come ti chiami? (nome e cognome)', nav);
    case 'telefono': return risposta('Qual è il tuo numero di telefono?', nav);

    // L'email non si puo' saltare: la conferma, l'eventuale spostamento e
    // l'annullamento viaggiano tutti di li'.
    case 'email': return risposta('Qual è la tua email? Ti mandiamo lì la conferma con il codice.', nav);
    case 'problema': return risposta('Qual è il motivo della visita?', nav);

    case 'conferma': {
      const amb = trovaAmbulatorio(d.ambulatorio_id);
      return risposta(
        'Controlla che sia tutto giusto:\n\n' +
        `👤 ${d.nome} ${d.cognome}\n📞 ${d.telefono}\n✉️ ${d.email}\n` +
        `🏥 ${amb.nome}\n📅 ${formattaDataEstesa(d.data)}\n🕐 ${d.ora_inizio}\n📝 ${d.problema}\n\nConfermo?`,
        BOTTONI_CONFERMA);
    }

    default:
      stato.passo = 'ambulatorio';
      return domandaPrenota(stato);
  }
}

function gestisciPrenota(stato, t) {
  const d = stato.dati;

  const navigato = navigaSePossibile(stato, t);
  if (navigato) return navigato;

  switch (stato.passo) {
    case 'ambulatorio': {
      const id = t.startsWith('amb:') ? Number(t.slice(4)) : interpretaAmbulatorio(t);
      const amb = id ? trovaAmbulatorio(id) : null;
      if (!amb) {
        return risposta('Scegli uno dei due ambulatori:', [...scegliAmbulatorio(), ...navigazione(stato)]);
      }
      d.ambulatorio_id = amb.id;
      return prosegui(stato);
    }

    case 'data': {
      const data = t.startsWith('data:') ? t.slice(5) : interpretaData(t);
      if (!data || !dataValida(data)) {
        return risposta('Non ho capito la data. Puoi scrivere "domani", "15/09" oppure sceglierne una:',
          [...proponiGiorni(d.ambulatorio_id), ...navigazione(stato)]);
      }
      const liberi = slotDisponibili(data, d.ambulatorio_id).filter((s) => s.disponibile);
      if (!liberi.length) {
        return risposta(`Nessun posto libero ${formattaDataEstesa(data)}. Scegli un altro giorno:`,
          [...proponiGiorni(d.ambulatorio_id), ...navigazione(stato)]);
      }
      d.data = data;
      return prosegui(stato);
    }

    case 'ora': {
      const ora = t.startsWith('ora:') ? t.slice(4) : interpretaOra(t);
      const liberi = slotDisponibili(d.data, d.ambulatorio_id).filter((s) => s.disponibile);
      if (!ora || !liberi.some((s) => s.ora_inizio === ora)) {
        return risposta('Quell\'orario non è disponibile. Scegline uno tra questi:', [
          ...liberi.slice(0, 12).map((s) => ({ id: `ora:${s.ora_inizio}`, etichetta: s.ora_inizio })),
          ...navigazione(stato)
        ]);
      }
      d.ora_inizio = ora;
      return prosegui(stato);
    }

    case 'nome': {
      const parti = t.split(/\s+/).filter(Boolean);
      if (parti.length < 2) {
        return risposta('Scrivi sia il nome che il cognome, per favore.', navigazione(stato));
      }
      d.nome = parti[0];
      d.cognome = parti.slice(1).join(' ');
      return prosegui(stato);
    }

    case 'telefono': {
      if (!telefonoValido(t)) {
        return risposta('Il numero non sembra valido. Riprova (esempio: 3331234567).', navigazione(stato));
      }
      d.telefono = t.replace(/[\s.\-()]/g, '');
      return prosegui(stato);
    }

    case 'email': {
      if (!emailValida(t)) {
        return risposta('L\'email non sembra valida: riprova (esempio: nome@esempio.it).', navigazione(stato));
      }
      d.email = t.trim().toLowerCase();
      return prosegui(stato);
    }

    case 'problema': {
      if (t.length < 3) {
        return risposta('Descrivi brevemente il motivo, anche poche parole vanno bene.', navigazione(stato));
      }
      d.problema = t;
      return prosegui(stato);
    }

    case 'conferma': {
      if (!affermativo(t) && t !== 'conferma') {
        return risposta('Dimmi "confermo" per completare, oppure correggi un dato.', BOTTONI_CONFERMA);
      }
      try {
        const p = creaPrenotazione({ ...d, origine: 'chatbot' });
        Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
        return risposta(
          `✅ Richiesta inviata!\n\n**Codice: ${p.codice}**\n` +
          `${formattaDataEstesa(p.data)} alle ${p.ora_inizio}\n${p.ambulatorio_nome}\n${p.ambulatorio_indirizzo}\n\n` +
          `Non è ancora confermata: lo studio la conferma a breve e ti arriva una email. ` +
          `Conserva il codice: ti serve per controllarla o ritirarla.`,
          MENU.azioni, { prenotazione: p.codice });
      } catch (err) {
        if (err instanceof ErroreDominio) {
          // Qualcun altro ha preso l'orario nel frattempo: si riparte dal
          // giorno, non da capo, cosi' nome e telefono restano scritti.
          stato.passo = 'data';
          azzera(stato, 'data');
          const richiesta = domandaPrenota(stato);
          return { ...richiesta, testo: `${err.message}\n\n${richiesta.testo}` };
        }
        throw err;
      }
    }

    default:
      return domandaPrenota(stato);
  }
}

/** Le domande delle tre richieste: cambiano le parole, non l'ordine. */
function domandaRichiesta(stato, c) {
  const d = stato.dati;
  const nav = navigazione(stato);

  switch (stato.passo) {
    case 'farmaci': return risposta(c.domanda, nav);
    case 'nome': return risposta('Come ti chiami? (nome e cognome)', nav);
    case 'telefono': return risposta('Qual è il tuo numero di telefono?', nav);

    // Il medico risponde sempre per iscritto — confermata, rifiutata o
    // cambiata — quindi l'indirizzo serve per forza.
    case 'email': return risposta('Qual è la tua email? Ti scriviamo lì la risposta del medico.', nav);

    case 'conferma':
      return risposta(
        `Controlla che sia tutto giusto:\n\n👤 ${d.nome} ${d.cognome}\n📞 ${d.telefono}\n` +
        `✉️ ${d.email}\n${c.icona} ${d.farmaci}\n\nConfermo?`,
        BOTTONI_CONFERMA);

    default:
      stato.passo = 'farmaci';
      return domandaRichiesta(stato, c);
  }
}

function gestisciRichiesta(stato, t, c) {
  const d = stato.dati;

  const navigato = navigaSePossibile(stato, t, c);
  if (navigato) return navigato;

  switch (stato.passo) {
    case 'farmaci':
      if (t.length < 2) return risposta(c.riChiedi, navigazione(stato));
      d.farmaci = t;
      return prosegui(stato, c);

    case 'nome': {
      const parti = t.split(/\s+/).filter(Boolean);
      if (parti.length < 2) {
        return risposta('Scrivi sia il nome che il cognome, per favore.', navigazione(stato));
      }
      d.nome = parti[0];
      d.cognome = parti.slice(1).join(' ');
      return prosegui(stato, c);
    }

    case 'telefono':
      if (!telefonoValido(t)) {
        return risposta('Il numero non sembra valido. Riprova (esempio: 3331234567).', navigazione(stato));
      }
      d.telefono = t.replace(/[\s.\-()]/g, '');
      return prosegui(stato, c);

    case 'email': {
      if (!emailValida(t)) {
        return risposta('L\'email non sembra valida: riprova (esempio: nome@esempio.it).', navigazione(stato));
      }
      d.email = t.trim().toLowerCase();
      return prosegui(stato, c);
    }

    case 'conferma': {
      if (!affermativo(t) && t !== 'conferma') {
        return risposta('Dimmi "confermo" per inviare, oppure correggi un dato.', BOTTONI_CONFERMA);
      }
      const r = creaRichiesta({ ...d, tipo: c.tipo, origine: 'chatbot' });
      Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });

      // La foto si chiede dopo, non prima: a questo punto la richiesta esiste e
      // ha un codice, quindi l'allegato ha dove attaccarsi. Chiederla prima
      // avrebbe voluto dire tenersi un file in mano senza sapere ancora se la
      // richiesta sarebbe andata a buon fine.
      const extra = { richiesta: r.codice };
      if (c.allegati) extra.allegaA = r.codice;

      return risposta(
        `✅ Richiesta registrata!\n\n**Codice: ${r.codice}**\n${c.icona} ${r.farmaci}\n\n` +
        `${c.chiusura}` +
        (c.allegati ? '\n\nSe hai la richiesta dello specialista, allegane la foto qui sotto.' : ''),
        MENU.azioni, extra);
    }

    default:
      return domandaRichiesta(stato, c);
  }
}

function gestisciStato(stato, t) {
  if (stato.passo === 'codice') {
    const codice = t.trim().toUpperCase();
    const p = perCodice(codice);

    if (!p) {
      return risposta('Non trovo nessuna prenotazione con questo codice. Controlla l\'email di conferma.',
        [{ id: 'menu', etichetta: 'Torna al menu' }]);
    }

    stato.dati = { codice: p.codice };
    stato.passo = 'azione';

    const etichettaStato = {
      annullata: '❌ Annullata',
      rifiutata: '❌ Non accolta dallo studio',
      in_attesa: '⏳ In attesa di conferma'
    }[p.stato] || '✅ Confermata';
    const chiusa = p.stato === 'annullata' || p.stato === 'rifiutata';
    return risposta(
      `${etichettaStato}\n\n📅 ${formattaDataEstesa(p.data)}\n🕐 ${p.ora_inizio}\n🏥 ${p.ambulatorio_nome}\n` +
      `👤 ${p.paziente_nome} ${p.paziente_cognome}\n📝 ${p.problema}`,
      chiusa
        ? [{ id: 'menu', etichetta: 'Torna al menu' }]
        : [{ id: 'disdici', etichetta: p.stato === 'in_attesa' ? '❌ Ritira la richiesta' : '❌ Annulla la prenotazione' },
          { id: 'menu', etichetta: 'Va bene così' }]);
  }

  if (stato.passo === 'azione') {
    if (t === 'disdici' || contiene(t, 'annull', 'disdic', 'cancell')) {
      try {
        const p = annullaPrenotazione(stato.dati.codice, { da: 'paziente' });
        Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
        return risposta(
          `Prenotazione annullata.\n\n${formattaDataEstesa(p.data)} alle ${p.ora_inizio} — ${p.ambulatorio_nome}\n\n` +
          `Il posto è tornato disponibile per altri pazienti.`, MENU.azioni);
      } catch (err) {
        if (err instanceof ErroreDominio) {
          Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
          return risposta(err.message, MENU.azioni);
        }
        throw err;
      }
    }
    Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
    return risposta(MENU.testo, MENU.azioni);
  }

  stato.passo = 'codice';
  return risposta('Indicami il codice della prenotazione.');
}

/** Punto d'ingresso: riceve un messaggio, restituisce la risposta e persiste tutto. */
export function messaggio(sessioneId, testo, etichetta = '') {
  let sessione = leggiSessione(sessioneId);
  if (!sessione) {
    sessioneId = creaSessione();
    sessione = leggiSessione(sessioneId);
  }

  const stato = sessione.stato;
  // Nella cronologia va cio' che l'utente ha visto ("📅 Prenota una visita"),
  // non l'identificativo tecnico del pulsante ("prenota") che guida il flusso.
  registraMessaggio(sessioneId, 'utente', String(etichetta || testo || '').slice(0, 1000));

  let esito;
  try {
    esito = gestisci(stato, testo);
  } catch (err) {
    console.error('[chatbot] errore:', err);
    Object.assign(stato, { ...STATO_INIZIALE });
    esito = risposta(
      'Mi dispiace, si è verificato un problema. Riproviamo dall\'inizio.\n\n' +
      'Se il problema persiste puoi chiamare direttamente l\'ambulatorio.', MENU.azioni);
  }

  salvaStato(sessioneId, stato);
  registraMessaggio(sessioneId, 'bot', esito.testo);

  return { sessioneId, ...esito };
}

export function benvenuto(sessioneId) {
  const sessione = leggiSessione(sessioneId);
  if (sessione) {
    const storico = cronologia(sessioneId);
    if (storico.length) {
      return { sessioneId, cronologia: storico, azioni: MENU.azioni, ripresa: true };
    }
  }
  const id = sessione ? sessioneId : creaSessione();
  const testo = `Ciao! Sono l'assistente dello ${config.nomeStudio}.\n\n` + MENU.testo;
  registraMessaggio(id, 'bot', testo);
  return { sessioneId: id, cronologia: cronologia(id), azioni: MENU.azioni, ripresa: false };
}

export function pulisciChatVecchie(giorni = 3) {
  const limite = new Date(Date.now() - giorni * 86400000).toISOString();
  return db.prepare('DELETE FROM chat_sessioni WHERE ultima_attivita < ?').run(limite).changes;
}
