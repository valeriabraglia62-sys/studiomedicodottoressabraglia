import { db } from './db.js';
import { oggiISO, aggiungiGiorni, formattaDataEstesa } from './orari.js';
import * as medicine from './medicine.js';
import * as prenotazioni from './prenotazioni.js';
import * as moduli from './moduli.js';

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
  { id: 'moduli', nome: 'Da confermare', parole: ['modul', 'da confermare', 'google'] },
  { id: 'prenotazioni', nome: 'Prenotazioni', parole: ['prenotazion', 'agenda', 'appuntament'] },
  { id: 'medicine', nome: 'Medicinali', parole: ['medicin', 'farmac', 'ricett'] },
  { id: 'specialistiche', nome: 'Visite specialistiche', parole: ['specialist'] },
  { id: 'esami', nome: 'Esami del sangue', parole: ['esami', 'esame', 'analisi', 'sangue'] },
  { id: 'email', nome: 'Email ricevute', parole: ['email', 'mail', 'posta', 'casella'] },
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
  const daVedere = n.medicine + n.specialistiche + n.esami + n.moduli + n.email;

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
    email: conta(`SELECT COUNT(*) n FROM richieste_email WHERE stato = 'nuova'`),
    moduli: moduli.daConfermare(),
    pazienti: conta('SELECT COUNT(*) n FROM pazienti')
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
    `📝 Richieste dai Moduli da confermare: ${n.moduli}`,
    `✉️ Email da leggere: ${n.email}`
  ];
  return risposta(`**Come va oggi**\n\n${righe.join('\n')}`);
}

/** Solo cio' che aspetta una risposta, con il bottone per andarci. */
function daVedere() {
  const n = numeri();
  const code = [
    { n: n.moduli, testo: 'dai Moduli Google da confermare', scheda: 'moduli' },
    { n: n.medicine, testo: 'di medicinali', scheda: 'medicine' },
    { n: n.specialistiche, testo: 'di visite specialistiche', scheda: 'specialistiche' },
    { n: n.esami, testo: 'di esami del sangue', scheda: 'esami' },
    { n: n.email, testo: 'email da leggere', scheda: 'email' }
  ].filter((c) => c.n > 0);

  if (!code.length) return risposta('Non c\'è niente da vedere: sei in pari. 🎉');

  return {
    testo: `Ti aspettano:\n\n${code.map((c) => `• ${c.n} ${c.testo}`).join('\n')}`,
    azioni: code.map((c) => ({ id: `apri ${c.scheda}`, etichetta: `Apri ${c.testo}` }))
      .concat(AZIONI_BASE.slice(3)),
    vai: null
  };
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
    SELECT p.nome, p.cognome, p.telefono,
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

  const elenco = righe.map((r) =>
    `• ${r.nome} ${r.cognome} — ${r.telefono || 'nessun telefono'}` +
    ` (${plurale(r.visite, 'visita', 'visite')})` +
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
    '• "apri i medicinali" — ti porto sulla scheda giusta\n\n' +
    'Per registrare una richiesta mentre sei al telefono, usa "Al telefono" qui sopra: ' +
    'sono le stesse domande che vede il paziente.');
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
  if (contiene(t, 'email', 'mail', 'posta')) {
    return risposta(`Email da leggere: ${n.email}.`);
  }
  if (contiene(t, 'modul')) {
    return risposta(`Richieste dai Moduli Google da confermare: ${n.moduli}.`);
  }
  if (contiene(t, 'pazient', 'person', 'anagrafic')) {
    return risposta(`In archivio ci sono ${n.pazienti} pazienti.`);
  }

  return riepilogo();
}
