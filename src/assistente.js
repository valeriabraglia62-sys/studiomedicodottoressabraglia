import { db } from './db.js';
import { oggiISO, aggiungiGiorni, formattaDataEstesa, dataValida } from './orari.js';
import * as medicine from './medicine.js';
import * as prenotazioni from './prenotazioni.js';
import * as attesa from './attesa.js';
import * as chiusure from './chiusure.js';

/**
 * L'assistente del pannello: risponde a chi lavora, non ai pazienti.
 *
 * E' deterministico come il chatbot dei pazienti, e per lo stesso motivo, che
 * qui pesa anche di piu': le risposte contengono numeri veri su persone vere.
 * Un modello linguistico che "quasi sempre" conta giusto, alla domanda "quante
 * prenotazioni ho oggi" darebbe una risposta credibile e sbagliata, e nessuno
 * se ne accorgerebbe. Ogni numero qui dentro esce da una query, oppure non
 * esce affatto.
 *
 * Non tiene memoria della conversazione: ogni domanda si spiega da sola. Il
 * chatbot dei pazienti ha bisogno dei passi perche' raccoglie un dato alla
 * volta; qui invece si chiede una cosa e si ottiene, e uno stato da mantenere
 * sarebbe solo un altro posto dove sbagliare.
 */

const norm = (t) => String(t || '').trim().toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '');

const contiene = (t, ...parole) => parole.some((p) => norm(t).includes(p));

const conta = (sql, ...par) => db.prepare(sql).get(...par).n;

/**
 * Il motivo della visita e' un dato clinico: la segreteria fa funzionare lo
 * studio senza bisogno di sapere perche' uno viene. E' la stessa regola che
 * vale nelle altre schermate del pannello, e vale anche qui: un assistente che
 * la aggirasse sarebbe la scorciatoia con cui il dato riservato esce comunque.
 */
const MOTIVO_NASCOSTO = '— riservato al medico —';
const soloMedico = (utente) => utente?.ruolo === 'admin';

/** Le schede del pannello, con le parole per chiamarle a voce. */
const SCHEDE = [
  { id: 'riepilogo', nome: 'Oggi', parole: ['oggi', 'riepilog', 'cruscott'] },
  { id: 'prenotazioni', nome: 'Prenotazioni', parole: ['prenotazion', 'agenda', 'appuntament', 'da confermare'] },
  { id: 'medicine', nome: 'Medicinali', parole: ['medicin', 'farmac', 'ricett'] },
  { id: 'specialistiche', nome: 'Visite specialistiche', parole: ['specialist'] },
  { id: 'esami', nome: 'Esami del sangue', parole: ['esami', 'esame', 'analisi', 'sangue'] },
  { id: 'pazienti', nome: 'Pazienti', parole: ['pazient', 'anagrafic', 'fascicol'] },
  { id: 'sistema', nome: 'Stato del sistema', parole: ['sistema', 'stato del', 'backup', 'copia'] }
];

const AZIONI_BASE = [
  { id: 'come va oggi', etichetta: '📊 Come va oggi' },
  { id: 'chi viene oggi', etichetta: '📅 Chi viene oggi' },
  { id: 'cosa devo vedere', etichetta: '📥 Cosa devo vedere' },
  { id: 'aiuto', etichetta: '❓ Cosa sai fare' }
];

const risposta = (testo, extra = {}) => ({ testo, azioni: AZIONI_BASE, vai: null, ...extra });

/** Il saluto: dice subito la cosa piu' urgente, senza farsela chiedere. */
export function benvenuto(utente) {
  const n = numeri();
  const daVedere = n.medicine + n.specialistiche + n.esami + n.daConfermare;

  const apertura = daVedere === 0
    ? 'Non c\'è niente in sospeso: tutto evaso.'
    : `Ci sono ${daVedere} cose che aspettano te.`;

  return risposta(
    `Ciao${utente?.nome ? ' ' + utente.nome : ''}. ${apertura}\n\n` +
    `Chiedimi pure: "quante prenotazioni ho oggi", "cerca Rossi", "apri i medicinali", ` +
    `oppure incolla un codice e te lo trovo.`);
}

/** Tutti i conteggi in un colpo solo: li usano piu' risposte diverse. */
function numeri() {
  const oggi = oggiISO();
  const perTipo = (tipo) => conta(
    `SELECT COUNT(*) n FROM richieste_medicine WHERE stato = 'nuova' AND tipo = ?`, tipo);

  return {
    oggi: conta(`SELECT COUNT(*) n FROM prenotazioni WHERE data = ? AND stato = 'confermata'`, oggi),
    domani: conta(`SELECT COUNT(*) n FROM prenotazioni WHERE data = ? AND stato = 'confermata'`,
      aggiungiGiorni(oggi, 1)),
    future: conta(`SELECT COUNT(*) n FROM prenotazioni WHERE data > ? AND stato = 'confermata'`, oggi),
    medicine: perTipo('medicina'),
    specialistiche: perTipo('specialistica'),
    esami: perTipo('esami'),
    // Le richieste di visita arrivate dal sito che lo studio non ha ancora
    // confermato o rifiutato. Stanno nella scheda Prenotazioni, filtro
    // "Da confermare".
    daConfermare: conta("SELECT COUNT(*) n FROM prenotazioni WHERE stato = 'in_attesa'"),
    pazienti: conta('SELECT COUNT(*) n FROM pazienti WHERE dimesso_il IS NULL')
  };
}

const plurale = (n, uno, tanti) => `${n} ${n === 1 ? uno : tanti}`;

function riepilogo() {
  const n = numeri();
  const righe = [
    `📅 Oggi: ${plurale(n.oggi, 'visita', 'visite')}${n.domani ? `, domani ${n.domani}` : ''}`,
    `💊 Medicinali da vedere: ${n.medicine}`,
    `🩺 Visite specialistiche da vedere: ${n.specialistiche}`,
    `🧪 Esami da vedere: ${n.esami}`,
    `📝 Richieste di visita da confermare: ${n.daConfermare}`
  ];
  return risposta(`**Come va oggi**\n\n${righe.join('\n')}`);
}

/**
 * Solo cio' che aspetta una risposta, con il bottone per andarci.
 *
 * I tre posti dove si lavora tutti i giorni — da confermare, prenotazioni,
 * medicinali — hanno il loro bottone sempre, anche quando il conto e' a zero:
 * "cosa devo vedere" e' il punto da cui si parte la mattina, e da li' si deve
 * poter aprire l'agenda anche quando non c'e' niente di arretrato.
 */
function daVedere() {
  const n = numeri();
  const code = [
    { n: n.daConfermare, testo: 'richieste di visita da confermare', scheda: 'prenotazioni' },
    { n: n.medicine, testo: 'di medicinali', scheda: 'medicine' },
    { n: n.specialistiche, testo: 'di visite specialistiche', scheda: 'specialistiche' },
    { n: n.esami, testo: 'di esami del sangue', scheda: 'esami' }
  ].filter((c) => c.n > 0);

  const sempre = [
    { scheda: 'prenotazioni', etichetta: '📅 Prenotazioni' },
    { scheda: 'medicine', etichetta: '💊 Medicinali' }
  ].map((s) => ({ id: `apri ${s.scheda}`, etichetta: s.etichetta }));

  // Anche le code che non sono fra i tre fissi meritano il loro bottone, se
  // hanno qualcosa dentro: altrimenti si legge "2 di esami" e poi tocca
  // cercarsi la scheda a mano.
  const altre = code
    .filter((c) => !sempre.some((s) => s.id === `apri ${c.scheda}`))
    .map((c) => ({ id: `apri ${c.scheda}`, etichetta: `Apri ${c.testo}` }));

  const testo = code.length
    ? `Ti aspettano:\n\n${code.map((c) => `• ${c.n} ${c.testo}`).join('\n')}`
    : 'Non c\'è niente da vedere: sei in pari. 🎉';

  return { testo, azioni: [...sempre, ...altre], vai: null };
}

/** L'agenda di un giorno, in chiaro per il medico e senza motivo per gli altri. */
function agenda(giorno, utente) {
  const righe = db.prepare(`
    SELECT p.ora_inizio, p.problema, a.nome AS ambulatorio, pa.nome, pa.cognome, pa.telefono
      FROM prenotazioni p
      JOIN ambulatori a ON a.id = p.ambulatorio_id
      JOIN pazienti pa ON pa.id = p.paziente_id
     WHERE p.data = ? AND p.stato = 'confermata'
     ORDER BY p.ora_inizio
  `).all(giorno);

  const quando = giorno === oggiISO() ? 'oggi' : formattaDataEstesa(giorno);

  if (!righe.length) return risposta(`Nessuna visita ${quando}.`);

  const elenco = righe.map((r) => {
    const motivo = soloMedico(utente) ? (r.problema || '') : MOTIVO_NASCOSTO;
    return `• ${r.ora_inizio} — ${r.nome} ${r.cognome} (${r.ambulatorio})` +
      (motivo ? `\n   ${motivo}` : '');
  }).join('\n');

  return {
    testo: `**${plurale(righe.length, 'visita', 'visite')} ${quando}**\n\n${elenco}`,
    azioni: [{ id: 'apri prenotazioni', etichetta: 'Apri le prenotazioni' }, ...AZIONI_BASE.slice(2)],
    vai: null
  };
}

/**
 * La ricerca di un paziente non restituisce il fascicolo: restituisce chi ha
 * trovato e apre la scheda giusta. Il fascicolo e' riservato al medico, e
 * lasciarne uscire i pezzi da qui sarebbe un modo di aggirare quel controllo
 * senza che si veda.
 */
function cercaPaziente(chi) {
  const come = `%${chi}%`;
  const righe = db.prepare(`
    SELECT p.nome, p.cognome, p.telefono, p.dimesso_il,
           (SELECT COUNT(*) FROM prenotazioni WHERE paziente_id = p.id) AS visite,
           (SELECT group_concat(farmaco, ' · ') FROM (
              SELECT farmaco FROM medicine_abituali
               WHERE paziente_id = p.id ORDER BY ultima_volta DESC LIMIT 3
            )) AS medicine
      FROM pazienti p
     WHERE p.nome LIKE ? OR p.cognome LIKE ? OR p.telefono LIKE ? OR p.email LIKE ?
     ORDER BY p.cognome, p.nome LIMIT 8
  `).all(come, come, come, come);

  // Anche quando non trova niente porta sui pazienti con la ricerca gia'
  // scritta: chi ha sbagliato una lettera e' a un tasto dal correggerla, invece
  // che a un vicolo cieco.
  if (!righe.length) {
    return {
      testo: `Non ho trovato nessuno che somigli a "${chi}". Ti apro i pazienti, ` +
        'prova a cambiare qualche lettera.',
      azioni: AZIONI_BASE,
      vai: { scheda: 'pazienti', cerca: chi }
    };
  }

  // Chi e' stato dimesso compare lo stesso, ma detto: al telefono la domanda e'
  // "questo signore e' nostro?", e la risposta utile e' "c'e' stato, adesso no",
  // non il silenzio di chi non lo trova.
  const elenco = righe.map((r) =>
    `• ${r.nome} ${r.cognome} — ${r.telefono || 'nessun telefono'}` +
    ` (${plurale(r.visite, 'visita', 'visite')})` +
    (r.dimesso_il ? ' · non più assistito' : '') +
    (r.medicine ? `\n   💊 ${r.medicine}` : '')).join('\n');

  // Niente bottone "apri i pazienti" fra le azioni: il pannello ne disegna gia'
  // uno suo sotto la risposta, perche' sa anche mettere la ricerca nel campo
  // giusto. Due bottoni che portano nello stesso posto sono solo un dubbio.
  return {
    testo: `**${plurale(righe.length, 'persona trovata', 'persone trovate')}**\n\n${elenco}`,
    azioni: AZIONI_BASE,
    vai: { scheda: 'pazienti', cerca: chi }
  };
}

const NOME_TIPO = {
  medicina: 'Richiesta di medicinali',
  specialistica: 'Visita specialistica',
  esami: 'Esami del sangue'
};

/** Un codice incollato: si dice cos'e' e a che punto sta. */
function cercaCodice(codice, utente) {
  const su = codice.toUpperCase();

  if (su.startsWith('PRE')) {
    const p = prenotazioni.perCodice(su);
    if (!p) return risposta(`Il codice ${su} non risulta fra le prenotazioni.`);
    const motivo = soloMedico(utente) ? p.problema : MOTIVO_NASCOSTO;
    return {
      testo: `**${su} — appuntamento**\n\n` +
        `👤 ${p.paziente_nome} ${p.paziente_cognome}\n📞 ${p.paziente_telefono || 'nessun telefono'}\n` +
        `📅 ${formattaDataEstesa(p.data)} alle ${p.ora_inizio}\n` +
        `🏥 ${p.ambulatorio_nome}\n📌 Stato: ${p.stato}` +
        (motivo ? `\n📝 ${motivo}` : ''),
      azioni: AZIONI_BASE,
      vai: { scheda: 'prenotazioni', cerca: su }
    };
  }

  const r = medicine.perCodice(su);
  if (!r) return risposta(`Il codice ${su} non risulta fra le richieste.`);

  const scheda = { medicina: 'medicine', specialistica: 'specialistiche', esami: 'esami' }[r.tipo];
  const allegati = medicine.allegatiDi(r.id).length;

  return {
    testo: `**${su} — ${NOME_TIPO[r.tipo] || 'richiesta'}**\n\n` +
      `👤 ${r.nome} ${r.cognome}\n📞 ${r.telefono}\n` +
      `📋 ${r.farmaci}\n📌 Stato: ${medicine.ETICHETTE_STATO[r.stato] || r.stato}` +
      (r.numero_ricetta ? `\n🔢 Ricetta: ${r.numero_ricetta}` : '') +
      (allegati ? `\n📎 ${plurale(allegati, 'allegato', 'allegati')}` : ''),
    azioni: AZIONI_BASE,
    vai: { scheda, cerca: su }
  };
}

function aiuto() {
  return risposta(
    '**Cosa so fare**\n\n' +
    '• "come va oggi" — i numeri del giorno\n' +
    '• "cosa devo vedere" — solo cio\' che aspetta una risposta\n' +
    '• "chi viene oggi" oppure "chi viene domani" — l\'agenda\n' +
    '• "quante prenotazioni ho oggi", "quanti esami da vedere" — un numero solo\n' +
    '• "cerca Rossi" — trova una persona e apre i pazienti\n' +
    '• "PRE-1234-ABCD" — incolla un codice e ti dico cos\'è e a che punto sta\n' +
    '• "annulla PRE-1234-ABCD" — annullo l\'appuntamento (con conferma; il paziente riceve l\'email)\n' +
    '• "blocca il 15/10" oppure "blocca domani dalle 10:30 alle 12" — chiudo le prenotazioni per quel giorno o quella fascia (con conferma)\n' +
    '• "che chiusure ci sono" — l\'elenco dei giorni e delle fasce bloccate\n' +
    '• "apri i medicinali" — ti porto sulla scheda giusta\n\n' +
    'Per registrare una richiesta mentre sei al telefono, usa "Al telefono" qui sopra: ' +
    'sono le stesse domande che vede il paziente.');
}

/**
 * L'unica azione che modifica qualcosa. Due passaggi: senza "conferma" mostra
 * l'appuntamento e chiede di ripetere il comando con "conferma" davanti; con
 * "conferma" annulla per davvero, riusando la stessa strada del pannello
 * (email al paziente, posto liberato, lista d'attesa avvisata).
 */
function annullaAppuntamento(codice, confermato, utente) {
  const p = prenotazioni.perCodice(codice);
  if (!p) return risposta(`Il codice ${codice} non risulta fra le prenotazioni.`);
  if (p.stato !== 'confermata') {
    return risposta(`${codice} non si può annullare: risulta già "${p.stato}".`);
  }

  const chi = `${p.paziente_nome} ${p.paziente_cognome}`;
  const quando = `${formattaDataEstesa(p.data)} alle ${p.ora_inizio}`;

  if (!confermato) {
    segnaAttesaConferma(utente, 'annulla', codice);
    return {
      testo: `Confermi l'annullamento di **${codice}**?\n\n` +
        `👤 ${chi}\n📅 ${quando}\n🏥 ${p.ambulatorio_nome}\n\n` +
        `Scrivi **conferma annulla ${codice}** per procedere. ` +
        `Il paziente riceverà l'email di annullamento e il posto tornerà libero.`,
      azioni: AZIONI_BASE,
      vai: null
    };
  }

  if (!consumaAttesaConferma(utente, 'annulla', codice)) {
    return risposta(
      `Prima scrivimi **annulla ${codice}** per vedere di che appuntamento si tratta, ` +
      'poi conferma. (Se l\'avevi già chiesto, sono passati più di 5 minuti: richiedilo.)');
  }

  try {
    const aggiornata = prenotazioni.annullaPrenotazione(codice, { da: 'admin', chi: utente?.email || null });
    const avvisati = attesa.avvisaPerPostoLibero(aggiornata);
    return risposta(
      `Fatto: ${codice} annullata. ${chi} riceve l'email di annullamento e ${quando} ` +
      `è di nuovo prenotabile.` + (avvisati ? `\nHo avvisato ${avvisati} in lista d'attesa.` : ''),
      { vai: { scheda: 'prenotazioni', cerca: codice } });
  } catch (err) {
    return risposta(`Non sono riuscito ad annullare ${codice}: ${err.message}`);
  }
}

// ---- Conferme a due passi ---------------------------------------------------
//
// L'assistente non tiene memoria della conversazione, ma per le azioni che
// cambiano dati (annullare, bloccare) la conferma dev'essere reale: non basta
// che il testo contenga "conferma", altrimenti un input precompilato salterebbe
// l'anteprima. Il primo passo lascia qui un gettone per (utente, azione,
// parametri), valido pochi minuti; il secondo passo lo consuma.

const CONFERME_TTL_MS = 5 * 60 * 1000;
const conferme = new Map();
setInterval(() => {
  const ora = Date.now();
  for (const [k, scad] of conferme) if (scad < ora) conferme.delete(k);
}, 60_000).unref?.();

const chiaveConferma = (utente, azione, parametri) =>
  `${utente?.email || '?'} ${azione} ${norm(parametri)}`;
const segnaAttesaConferma = (utente, azione, parametri) =>
  conferme.set(chiaveConferma(utente, azione, parametri), Date.now() + CONFERME_TTL_MS);
function consumaAttesaConferma(utente, azione, parametri) {
  const k = chiaveConferma(utente, azione, parametri);
  const scad = conferme.get(k);
  conferme.delete(k);
  return Boolean(scad) && scad > Date.now();
}

// ---- Chiusure dell'ambulatorio ------------------------------------------------

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** Una data da testo libero, deterministica: se non e' chiara torna null. */
function leggiData(txt) {
  const t = norm(txt);
  if (/\bdopodomani\b/.test(t)) return aggiungiGiorni(oggiISO(), 2);
  if (/\bdomani\b/.test(t)) return aggiungiGiorni(oggiISO(), 1);
  if (/\boggi\b/.test(t)) return oggiISO();

  const annoCorrente = Number(oggiISO().slice(0, 4));
  const componi = (g, mese, anno) => {
    if (mese < 1 || mese > 12 || g < 1 || g > 31) return null;
    let iso = `${anno}-${String(mese).padStart(2, '0')}-${String(g).padStart(2, '0')}`;
    if (!dataValida(iso)) return null;
    // Una data senza anno che risulta gia' passata si intende l'anno prossimo.
    if (iso < oggiISO()) iso = `${anno + 1}-${String(mese).padStart(2, '0')}-${String(g).padStart(2, '0')}`;
    return dataValida(iso) ? iso : null;
  };

  let m = t.match(/\b(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?\b/);
  if (m) {
    let anno = m[3] ? Number(m[3]) : annoCorrente;
    if (anno < 100) anno += 2000;
    return componi(Number(m[1]), Number(m[2]), anno);
  }
  m = t.match(new RegExp(`\\b(\\d{1,2})\\s+(${MESI.join('|')})\\b`));
  if (m) return componi(Number(m[1]), MESI.indexOf(m[2]) + 1, annoCorrente);
  return null;
}

/** Un intervallo di giorni: "dal X al Y", oppure un giorno solo. */
function leggiIntervallo(t) {
  const partiAl = t.split(/\b(?:al|fino al|fino a)\b/i);
  const dal = leggiData(partiAl[0]);
  if (!dal) return null;
  const al = partiAl[1] ? (leggiData(partiAl[1]) || dal) : dal;
  return { dal, al: al < dal ? dal : al };
}

/** Una fascia oraria: "dalle 10 alle 12", "10:30-12:00", "mattina", "pomeriggio". */
function leggiFascia(t) {
  const n = norm(t);
  let m = n.match(/dalle\s+(\d{1,2})(?:[:.](\d{2}))?\s+alle\s+(\d{1,2})(?:[:.](\d{2}))?/)
    || n.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*[-–a]\s*(\d{1,2})(?:[:.](\d{2}))?\b/);
  if (m) {
    const oi = `${String(Number(m[1])).padStart(2, '0')}:${m[2] || '00'}`;
    const of = `${String(Number(m[3])).padStart(2, '0')}:${m[4] || '00'}`;
    return of > oi ? { ora_inizio: oi, ora_fine: of } : null;
  }
  if (/\bmattina\b/.test(n)) return { ora_inizio: '08:00', ora_fine: '13:00' };
  if (/\bpomeriggio\b/.test(n)) return { ora_inizio: '13:00', ora_fine: '20:00' };
  return {};   // nessuna fascia = tutto il giorno
}

function leggiAmbulatorio(t) {
  const n = norm(t);
  for (const a of db.prepare('SELECT id, nome FROM ambulatori WHERE attivo = 1').all()) {
    const parola = norm(a.nome).replace(/^ambulatorio di\s+/, '');
    if (parola && n.includes(parola)) return a;
  }
  return null;
}

const descriviChiusura = (c) => {
  const giorni = c.dal === c.al ? formattaDataEstesa(c.dal) : `${formattaDataEstesa(c.dal)} → ${formattaDataEstesa(c.al)}`;
  const fascia = c.ora_inizio ? `, dalle ${c.ora_inizio} alle ${c.ora_fine}` : ' (tutto il giorno)';
  const dove = c.ambulatorio_nome ? ` — ${c.ambulatorio_nome}` : '';
  return `${giorni}${fascia}${dove}${c.motivo ? ` · ${c.motivo}` : ''}`;
};

/**
 * Blocca le prenotazioni per un giorno o una fascia. Come l'annullamento:
 * due passaggi, e senza "conferma" mostra solo cosa ha capito.
 */
function bloccaPrenotazioni(t, confermato, utente) {
  const intervallo = leggiIntervallo(t);
  if (!intervallo) {
    return risposta(
      'Non ho capito il giorno. Prova con "blocca il 15/10", "blocca domani", ' +
      '"blocca dal 20/10 al 25/10", oppure aggiungi una fascia: ' +
      '"blocca il 15/10 dalle 10:30 alle 12:00".',
      { vai: { scheda: 'chiusure', cerca: '' } });
  }
  const fascia = leggiFascia(t);
  if (fascia === null) return risposta('La fascia oraria non è chiara: scrivila come "dalle 10:30 alle 12:00".');

  const amb = leggiAmbulatorio(t);
  const motivoMatch = norm(t).match(/\b(?:per|motivo:?)\s+(.{2,60})$/);
  const motivo = motivoMatch ? motivoMatch[1].trim() : '';

  const riepilogoTxt = descriviChiusura({
    dal: intervallo.dal, al: intervallo.al,
    ora_inizio: fascia.ora_inizio, ora_fine: fascia.ora_fine,
    ambulatorio_nome: amb?.nome || '', motivo
  });

  if (!confermato) {
    segnaAttesaConferma(utente, 'blocca', t);
    return {
      testo: `Blocco le prenotazioni per:\n\n**${riepilogoTxt}**\n\n` +
        `Scrivi **conferma blocca ${t.replace(/^\s*blocca\s+/i, '')}** per procedere. ` +
        'Gli slot spariscono subito dal sito; le prenotazioni già confermate NON vengono annullate.',
      azioni: AZIONI_BASE,
      vai: null
    };
  }

  if (!consumaAttesaConferma(utente, 'blocca', t)) {
    return risposta(
      'Prima scrivimi il comando **senza "conferma"** per vedere cosa ho capito ' +
      '(data, fascia, motivo), poi conferma la stessa riga.');
  }

  try {
    const esito = chiusure.aggiungi({
      dal: intervallo.dal, al: intervallo.al,
      ambulatorio_id: amb?.id || null, motivo,
      ora_inizio: fascia.ora_inizio || null, ora_fine: fascia.ora_fine || null
    });
    const colpite = esito.prenotazioni_da_avvisare || [];
    let msg = `Fatto: ${riepilogoTxt}.`;
    if (colpite.length) {
      msg += `\n\n⚠️ Ci sono ${colpite.length} prenotazioni confermate in quel periodo, da avvisare a mano:\n` +
        colpite.map((p) => `• ${p.data} ${p.ora_inizio} — ${p.nome} ${p.cognome} (${p.telefono}) · ${p.codice}`).join('\n');
    }
    return risposta(msg, { vai: { scheda: 'chiusure', cerca: '' } });
  } catch (err) {
    return risposta(`Non sono riuscito a creare la chiusura: ${err.message}`);
  }
}

function elencoChiusure() {
  const righe = chiusure.elenco().filter((c) => !c.passata);
  if (!righe.length) {
    return risposta('Non c\'è nessuna chiusura futura impostata.',
      { vai: { scheda: 'chiusure', cerca: '' } });
  }
  return risposta(
    `**Chiusure impostate**\n\n${righe.map((c) => `• ${descriviChiusura(c)}`).join('\n')}\n\n` +
    'Per toglierne una usa la scheda Chiusure.',
    { vai: { scheda: 'chiusure', cerca: '' } });
}

/**
 * La domanda, e cosa ne esce.
 *
 * L'ordine dei controlli conta, come nel chatbot dei pazienti: il codice si
 * cerca per primo perche' e' inequivocabile, e "cerca" viene prima delle
 * parole delle schede, altrimenti "cerca Esposito" aprirebbe gli esami.
 */
export function assiste(domanda, utente) {
  const t = String(domanda || '').trim();
  if (!t) return benvenuto(utente);

  // Annullamento di un appuntamento: e' l'unica azione che l'assistente
  // esegue, e per questo chiede sempre una conferma esplicita — un "annulla"
  // battuto in fretta non deve cancellare la visita di nessuno.
  const annulla = t.match(
    /^\s*(conferma\s+)?(?:annulla|annullare|cancella|cancellare|disdici|disdire|elimina)\s+(?:la\s+)?(?:prenotazione\s+|visita\s+|l['’]appuntamento\s+)?(PRE-[A-Z0-9]{4}-[A-Z0-9]{4})\b/i);
  if (annulla) return annullaAppuntamento(annulla[2].toUpperCase(), Boolean(annulla[1]), utente);

  // Chiusure: "che chiusure ci sono" elenca; "blocca il 15/10 ..." ne crea una
  // (con conferma, come l'annullamento). "blocca" da solo non fa niente di male:
  // senza una data leggiIntervallo torna null e si spiega come si scrive.
  if (contiene(t, 'chiusur', 'giorni bloccat', 'ferie impostat')
    && contiene(t, 'quali', 'che ', 'elenc', 'lista', 'ci sono', 'vedere le')) {
    return elencoChiusure();
  }
  const blocca = t.match(/^\s*(conferma\s+)?(?:blocca|bloccare|chiudi|chiudere)\b(.*)$/i);
  if (blocca && (contiene(t, 'blocc', 'chiud')) && !/PRE-[A-Z0-9]{4}/i.test(t)) {
    return bloccaPrenotazioni(blocca[2].trim(), Boolean(blocca[1]), utente);
  }

  const codice = t.match(/\b(PRE|MED|SPE|ESA)-[A-Z0-9]{4}-[A-Z0-9]{4}\b/i);
  if (codice) return cercaCodice(codice[0], utente);

  if (contiene(t, 'aiuto', 'cosa sai fare', 'cosa puoi fare', 'come funzion')) return aiuto();

  const ricerca = t.match(/^\s*(?:cerca|trova|cerc[ah]mi|chi e'|chi è)\s+(.{2,})$/i);
  if (ricerca) return cercaPaziente(ricerca[1].trim());

  if (contiene(t, 'devo vedere', 'da vedere', 'in sospeso', 'da evadere', 'cosa manca')) {
    return daVedere();
  }

  if (contiene(t, 'chi viene', 'chi c\'e', 'chi ce', 'agenda')) {
    return agenda(contiene(t, 'domani') ? aggiungiGiorni(oggiISO(), 1) : oggiISO(), utente);
  }

  if (contiene(t, 'come va', 'riepilog', 'situazione', 'come siamo')) return riepilogo();

  // Un numero solo: si guarda di cosa si sta parlando e si risponde con quello.
  if (contiene(t, 'quant')) return quantiSono(t);

  const scheda = SCHEDE.find((s) => contiene(t, ...s.parole));
  if (scheda) {
    return {
      testo: `Ti porto su **${scheda.nome}**.`,
      azioni: AZIONI_BASE,
      vai: { scheda: scheda.id, cerca: '' }
    };
  }

  return risposta(
    'Non ho capito. Prova con "come va oggi", "cosa devo vedere", "cerca" seguito da un ' +
    'cognome, oppure incolla un codice. Scrivi "aiuto" per l\'elenco completo.');
}

/** "Quante prenotazioni ho oggi", "quanti esami da vedere": un numero e basta. */
function quantiSono(t) {
  const n = numeri();

  if (contiene(t, 'prenotazion', 'visite', 'appuntament')) {
    if (contiene(t, 'domani')) return risposta(`Domani ci sono ${plurale(n.domani, 'visita', 'visite')}.`);
    return risposta(`Oggi ci sono ${plurale(n.oggi, 'visita', 'visite')}` +
      `, e ${plurale(n.future, 'visita', 'visite')} nei giorni successivi.`);
  }
  if (contiene(t, 'specialist')) {
    return risposta(`Visite specialistiche da vedere: ${n.specialistiche}.`);
  }
  if (contiene(t, 'esami', 'esame', 'analisi', 'sangue')) {
    return risposta(`Esami del sangue da vedere: ${n.esami}.`);
  }
  if (contiene(t, 'medicin', 'farmac', 'ricett')) {
    return risposta(`Richieste di medicinali da vedere: ${n.medicine}.`);
  }
  if (contiene(t, 'confermare', 'in attesa', 'richiest')) {
    return risposta(`Richieste di visita da confermare: ${n.daConfermare}. ` +
      'Le trovi nella scheda Prenotazioni, filtro "Da confermare": da lì le confermi, ' +
      'le modifichi o le annulli.');
  }
  if (contiene(t, 'pazient', 'person', 'anagrafic')) {
    return risposta(`In archivio ci sono ${n.pazienti} pazienti.`);
  }

  return riepilogo();
}
