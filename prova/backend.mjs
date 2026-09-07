/**
 * Verifica del backend su un database usa e getta.
 *
 * Il caso che conta davvero e' l'ultimo: trecento pazienti che scelgono lo
 * stesso identico orario nello stesso istante. Deve passarne esattamente uno.
 *
 *   node prova/backend.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RADICE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Fuori da data/: quella cartella e' ristretta con ACL (solo il servizio vi
// scrive) e un terminale normale non potrebbe crearci il database di prova.
const CARTELLA_PROVA = path.join(RADICE, '.prove-tmp');
fs.mkdirSync(CARTELLA_PROVA, { recursive: true });
const DB_PROVA = path.join(CARTELLA_PROVA, 'prova.sqlite');

for (const f of [DB_PROVA, `${DB_PROVA}-wal`, `${DB_PROVA}-shm`]) fs.rmSync(f, { force: true });

process.env.DB_FILE = DB_PROVA;
process.env.PORT = '3999';
process.env.INBOX_POLLING_ENABLED = 'false';
process.env.GOOGLE_SHEETS_ENABLED = 'false';
// I test parlano direttamente in HTTP locale; la produzione resta HTTPS
// fail-closed salvo questa disattivazione esplicita.
process.env.SITO_HTTPS = 'false';

// Spento anche il lavoratore dei Moduli: acceso, mentre le prove girano legge il
// foglio delle risposte vero e ne infila le righe nel database usa e getta. Le
// prove piu' sotto si inseriscono le proprie righe a mano con importaRighe, e si
// aspettano di trovare sulla scrivania quelle e basta: con dentro anche le
// richieste vere dei pazienti prendevano il record sbagliato e i conteggi
// cambiavano da un'esecuzione all'altra. E' il motivo per cui il numero di prove
// fallite oscillava fra 11 e 12 senza che nessuno avesse toccato niente.
process.env.GOOGLE_MODULI_ENABLED = 'false';

// Le copie di sicurezza delle prove restano qui dentro. Senza questa riga
// seguirebbero CARTELLA_BACKUP del .env, che sul server punta a OneDrive: ogni
// "npm run prova" caricherebbe sul cloud una copia di un database usa e getta.
process.env.CARTELLA_BACKUP = path.join(CARTELLA_PROVA, 'backup');

// Nessuna credenziale: le email restano in coda invece di partire davvero.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

// Account admin di prova, indipendente dal .env vero: le prove sul bootstrap e
// sul recovery "once" pilotano da sole config.admin.resetOnce, quindi il valore
// di partenza deve essere spento a prescindere da com'e' messo il file vero.
process.env.ADMIN_EMAIL = 'admin@prova.local';
process.env.ADMIN_PASSWORD = 'ProvaAdmin2026!';
process.env.ADMIN_PASSWORD_RESET = '';
process.env.SEGRETARIA_PASSWORD_RESET = '';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'prova'.repeat(16);

// server.js intercetta le eccezioni e le scrive senza uscire: in produzione e'
// giusto, perche' un errore su una richiesta non deve buttare giu' il sito per
// tutti gli altri. Qui pero' quella rete di sicurezza fa danno: un errore in una
// prova lascerebbe il server in ascolto e il processo appeso, e chi lancia i
// test aspetterebbe per sempre senza capire perche'. Successo l'11 agosto 2026:
// dieci minuti di attesa per un indice sbagliato.
//
// Node chiama tutti i gestori registrati, quindi questo si aggiunge a quello di
// server.js senza toglierlo: lui scrive, questo fa uscire con un errore.
for (const evento of ['uncaughtException', 'unhandledRejection']) {
  process.on(evento, (err) => {
    console.error(`\nPROVE INTERROTTE — ${evento}:`, err);
    process.exit(1);
  });
}

const BASE = 'http://localhost:3999';
let tokenPaziente = '';
const tokenPazienti = new Map();
let registraPazienteDiretto = null;
let creaSessioneDiretta = null;
let inizializzaAdminDiretto = null;

let passati = 0;
let falliti = 0;

function verifica(descrizione, condizione, dettaglio = '') {
  if (condizione) {
    passati++;
    console.log(`  ok    ${descrizione}`);
  } else {
    falliti++;
    console.log(`  FALLITO ${descrizione}${dettaglio ? ` — ${dettaglio}` : ''}`);
  }
}

const chiama = async (metodo, percorso, corpo, token) => {
  const protettaPaziente = percorso.startsWith('/api/prenotazioni')
    || percorso.startsWith('/api/medicine') || percorso === '/api/attesa';
  const creazione = metodo === 'POST' && ['/api/prenotazioni', '/api/medicine', '/api/attesa'].includes(percorso);
  const emailCorpo = String(corpo?.email || '').trim().toLowerCase();
  if (!token && creazione && emailCorpo && !tokenPazienti.has(emailCorpo)
      && registraPazienteDiretto && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailCorpo)
      && /^(\+39)?\d{8,11}$/.test(String(corpo?.telefono || '').replace(/[\s.\-()]/g, ''))
      && corpo?.nome && corpo?.cognome) {
    const reg = registraPazienteDiretto({ ...corpo, password: 'PasswordPaziente!2026' });
    // In produzione l'account entra solo dopo il link email; qui si completa
    // subito la verifica (che segna verificato e collega la scheda).
    verificaEmailDiretto(reg.token);
    tokenPaziente = creaSessioneDiretta(reg.utente.id).token;
    tokenPazienti.set(emailCorpo, tokenPaziente);
  }
  const credenziale = token || tokenPazienti.get(emailCorpo) || (protettaPaziente ? tokenPaziente : '');
  const r = await fetch(BASE + percorso, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(credenziale ? { Authorization: `Bearer ${credenziale}` } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  return { stato: r.status, dati: await r.json().catch(() => ({})) };
};

const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
let verificaEmailDiretto = null;
({ registraPaziente: registraPazienteDiretto, verificaEmailPaziente: verificaEmailDiretto } =
  await import('../src/utenti.js'));
({ creaSessione: creaSessioneDiretta, inizializzaAdmin: inizializzaAdminDiretto } = await import('../src/auth.js'));
const serverModulo = await import('../server.js');
await new Promise((r) => setTimeout(r, 1500));
verifica('un Host ostile non viene riflesso nel redirect HTTPS',
  serverModulo.destinazioneRedirectHttps('evil.example') === '');

const registrazionePaziente = await chiama('POST', '/api/auth/register', {
  nome: 'Mario', cognome: 'Rossi', telefono: '3331234567',
  email: 'mario.rossi.prova@example.it', password: 'PasswordPaziente!2026'
});
verifica('la registrazione non da\' accesso immediato: serve la verifica email',
  registrazionePaziente.stato === 201
  && registrazionePaziente.dati.verifica_inviata === true
  && !registrazionePaziente.dati.token);

const loginNonVerificato = await chiama('POST', '/api/auth/login', {
  email: 'mario.rossi.prova@example.it', password: 'PasswordPaziente!2026'
});
verifica('senza verifica email il login e\' rifiutato con 403',
  loginNonVerificato.stato === 403 && loginNonVerificato.dati.verifica_email === true);

// Flusso completo dal vero endpoint del link (token grezzo da una registrazione diretta).
const regDir = registraPazienteDiretto({
  nome: 'Giulia', cognome: 'Neri', telefono: '3332221100',
  email: 'giulia.neri.prova@example.it', password: 'PasswordGiulia2026!'
});
const conferma = await fetch(
  `${BASE}/api/auth/verifica-email?token=${encodeURIComponent(regDir.token)}`, { redirect: 'manual' });
verifica('il link di verifica conferma e rimanda al sito',
  conferma.status === 303 && (conferma.headers.get('location') || '').includes('email=verificata'));
const loginDopoVerifica = await chiama('POST', '/api/auth/login', {
  email: 'giulia.neri.prova@example.it', password: 'PasswordGiulia2026!'
});
verifica('dopo la verifica il login riesce',
  loginDopoVerifica.stato === 200 && loginDopoVerifica.dati.utente?.ruolo === 'paziente');
const linkScaduto = await chiama('POST', '/api/auth/verifica-email/rinvia',
  { email: 'nessuno.qui@example.it' });
verifica('il rinvio non rivela se l\'account esiste', linkScaduto.stato === 200);

// Per il resto della suite Mario serve verificato e con una sessione.
db.prepare("UPDATE utenti SET email_verificata = 1 WHERE email = 'mario.rossi.prova@example.it'").run();
tokenPaziente = creaSessioneDiretta(
  db.prepare("SELECT id FROM utenti WHERE email = 'mario.rossi.prova@example.it'").get().id).token;
tokenPazienti.set('mario.rossi.prova@example.it', tokenPaziente);

console.log('\nDati pubblici');
{
  const { dati } = await chiama('GET', '/api/ambulatori');
  verifica('elenco ambulatori', dati.ambulatori?.length === 2, JSON.stringify(dati).slice(0, 120));
  verifica('durata slot esposta al frontend', dati.durata_slot === 15, `ricevuto ${dati.durata_slot}`);
}

// Primo giorno utile con almeno uno slot libero, cosi' la prova non dipende
// dal giorno in cui viene eseguita.
const { oggiISO, aggiungiGiorni } = await import('../src/orari.js');
let giorno = null;
let slotLiberi = [];
for (let i = 1; i <= 14 && !giorno; i++) {
  const data = aggiungiGiorni(oggiISO(), i);
  const { dati } = await chiama('GET', `/api/disponibilita?data=${data}&ambulatorio_id=1`);
  const liberi = (dati.slot || []).filter((s) => s.disponibile);
  if (liberi.length >= 8) { giorno = data; slotLiberi = liberi; }
}

console.log('\nDisponibilita');
verifica('esiste un giorno prenotabile entro due settimane', Boolean(giorno));
if (!giorno) { console.log('\nImpossibile proseguire.'); process.exit(1); }

console.log('\nPrenotazione');
let codicePrenotazione = null;
{
  const { stato, dati } = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1,
    data: giorno,
    ora_inizio: slotLiberi[0].ora_inizio,
    nome: 'Mario', cognome: 'Rossi',
    telefono: '3331234567', email: 'mario.rossi@example.com',
    problema: 'Controllo pressione'
  });
  verifica('prenotazione creata', stato === 201, `stato ${stato} ${dati.message || ''}`);
  codicePrenotazione = dati.prenotazione?.codice;
  verifica('codice non indovinabile', /^PRE-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(codicePrenotazione || ''), codicePrenotazione);

  const calendario = dati.prenotazione?.calendario || '';
  const attesi = `${giorno.replace(/-/g, '')}T${slotLiberi[0].ora_inizio.replace(':', '')}00`;
  verifica('il paziente riceve il link per Google Calendar',
    calendario.startsWith('https://calendar.google.com/') && calendario.includes(attesi),
    calendario.slice(0, 120));

  const dopo = await chiama('GET', `/api/disponibilita?data=${giorno}&ambulatorio_id=1`);
  const ancoraLibero = dopo.dati.slot.find((s) => s.ora_inizio === slotLiberi[0].ora_inizio)?.disponibile;
  verifica('lo slot risulta occupato subito dopo', ancoraLibero === false);
}

console.log('\nControlli sui dati');
{
  const fuoriOrario = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: giorno, ora_inizio: '03:00',
    nome: 'Test', cognome: 'Test', telefono: '3331234567', problema: 'x'
  });
  verifica('rifiuta un orario fuori apertura', fuoriOrario.stato === 400, `stato ${fuoriOrario.stato}`);

  const passato = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: '2020-01-06', ora_inizio: '11:00',
    nome: 'Test', cognome: 'Test', telefono: '3331234567', problema: 'x'
  });
  verifica('rifiuta una data passata', passato.stato === 400, `stato ${passato.stato}`);

  const telefono = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: giorno, ora_inizio: slotLiberi[1].ora_inizio,
    nome: 'Test', cognome: 'Test', telefono: 'abc', problema: 'x'
  });
  verifica('rifiuta un telefono non valido', telefono.stato === 400, `stato ${telefono.stato}`);

  const disallineato = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: giorno, ora_inizio: '10:37',
    nome: 'Test', cognome: 'Test', telefono: '3331234567', problema: 'x'
  });
  verifica('rifiuta un orario non allineato allo slot', disallineato.stato === 400, `stato ${disallineato.stato}`);
}

console.log('\nRicerca e annullamento');
{
  const tokenProprietario = tokenPaziente;
  const trovata = await chiama('GET', `/api/prenotazioni/${codicePrenotazione}`);
  verifica('la prenotazione si ritrova col codice', trovata.dati.prenotazione?.codice === codicePrenotazione);
  verifica('i dati interni non escono', trovata.dati.prenotazione?.paziente_id === undefined);

  const inesistente = await chiama('GET', '/api/prenotazioni/PRE-XXXX-XXXX');
  verifica('codice inesistente da 404', inesistente.stato === 404);

  const secondoReg = registraPazienteDiretto({
    nome: 'Secondo', cognome: 'Paziente', telefono: '3337654321',
    email: 'secondo.paziente@example.it', password: 'PasswordSecondo!2026'
  });
  verificaEmailDiretto(secondoReg.token);
  const tokenSecondo = creaSessioneDiretta(secondoReg.utente.id).token;
  tokenPazienti.set('secondo.paziente@example.it', tokenSecondo);
  const loginSecondo = await chiama('POST', '/api/auth/login', {
    email: 'secondo.paziente@example.it', password: 'PasswordSecondo!2026'
  });
  verifica('login paziente riuscito', loginSecondo.stato === 200
    && loginSecondo.dati.utente?.ruolo === 'paziente');
  const incrociata = await chiama('GET', `/api/prenotazioni/${codicePrenotazione}`, null, tokenSecondo);
  verifica('un paziente non legge la pratica di un altro', incrociata.stato === 404);
  tokenPaziente = tokenProprietario;

  const nonConfermata = await chiama('POST', `/api/prenotazioni/${codicePrenotazione}/annulla`, {});
  verifica('annullare richiede conferma esplicita', nonConfermata.stato === 400);

  const annullata = await chiama('POST', `/api/prenotazioni/${codicePrenotazione}/annulla`, { conferma: true });
  verifica('annullamento riuscito', annullata.stato === 200, JSON.stringify(annullata.dati).slice(0, 120));

  verifica('la prenotazione annullata non propone piu\' il calendario',
    annullata.dati.prenotazione?.calendario === null,
    String(annullata.dati.prenotazione?.calendario).slice(0, 80));

  const dueVolte = await chiama('POST', `/api/prenotazioni/${codicePrenotazione}/annulla`, { conferma: true });
  verifica('non si annulla due volte', dueVolte.stato === 400);

  const tornato = await chiama('GET', `/api/disponibilita?data=${giorno}&ambulatorio_id=1`);
  const libero = tornato.dati.slot.find((s) => s.ora_inizio === slotLiberi[0].ora_inizio)?.disponibile;
  verifica('lo slot annullato torna disponibile', libero === true);
}

console.log('\nRichieste di medicinali');
{
  const { stato, dati } = await chiama('POST', '/api/medicine', {
    nome: 'Anna', cognome: 'Bianchi', telefono: '3339876543',
    email: 'anna@example.com', farmaci: 'Tachipirina 1000, Aspirina'
  });
  verifica('richiesta medicinali creata', stato === 201, `stato ${stato} ${dati.message || ''}`);

  const consultata = await chiama('GET', `/api/medicine/${dati.richiesta?.codice}`);
  verifica('la richiesta si ritrova col codice', consultata.dati.richiesta?.stato === 'nuova');
  const medicinaIncrociata = await chiama('GET', `/api/medicine/${dati.richiesta?.codice}`,
    null, tokenPazienti.get('secondo.paziente@example.it'));
  verifica('un paziente non legge i medicinali di un altro', medicinaIncrociata.stato === 404);

  const senzaFarmaci = await chiama('POST', '/api/medicine', {
    nome: 'Anna', cognome: 'Bianchi', telefono: '3339876543', farmaci: ''
  });
  verifica('rifiuta una richiesta senza medicinali', senzaFarmaci.stato === 400);
}

console.log('\nChatbot');
{
  const apertura = await chiama('GET', '/api/chat');
  const sessione = apertura.dati.sessioneId;
  verifica('la chat si apre con una sessione', Boolean(sessione));

  await chiama('POST', '/api/chat', { sessione, testo: 'vorrei prenotare una visita' });
  const ripresa = await chiama('GET', `/api/chat?sessione=${sessione}`);
  verifica('la conversazione riprende dov\'era', ripresa.dati.ripresa === true);
  verifica('la cronologia e\' conservata', ripresa.dati.cronologia?.length >= 2,
    `messaggi: ${ripresa.dati.cronologia?.length}`);

  const menu = await chiama('POST', '/api/chat', { sessione, testo: 'menu' });
  verifica('il comando "menu" riporta al punto di partenza',
    menu.dati.azioni?.some((a) => a.id === 'prenota'), JSON.stringify(menu.dati).slice(0, 140));

  const sconosciuto = await chiama('POST', '/api/chat', { sessione, testo: 'qwerty asdf' });
  verifica('un messaggio incomprensibile non rompe la chat', sconosciuto.stato === 200 && Boolean(sconosciuto.dati.testo));

  db.prepare("UPDATE chat_sessioni SET ultima_attivita = datetime('now', '-73 hours') WHERE id = ?")
    .run(sessione);
  const scaduta = await chiama('GET', `/api/chat?sessione=${encodeURIComponent(sessione)}`);
  const rimasti = db.prepare('SELECT COUNT(*) n FROM chat_messaggi WHERE sessione_id = ?').get(sessione).n;
  verifica('la scadenza a 72 ore cancella davvero la cronologia',
    scaduta.dati.sessioneId !== sessione && rimasti === 0);
}

// Le parole del menu si sovrappongono: "visita dal cardiologo" contiene sia
// "visita" (prenotazione) sia "cardiolog" (specialistica). Se l'ordine dei
// controlli in gestisciMenu tornasse quello di prima, chi chiede uno
// specialista finirebbe a prenotare un appuntamento dalla dottoressa senza
// accorgersene: la chat risponderebbe, sarebbe solo la chat sbagliata.
console.log('\nIl chatbot non confonde una specialistica con un appuntamento');
{
  // Queste quattro prove chiamano il chatbot direttamente invece che via HTTP.
  // Passando dalla rete aprivano quattro sessioni in pochi millisecondi e
  // facevano scattare il freno anti-abuso (60 chiamate al minuto per IP), che
  // poi faceva fallire le prove degli esami piu' sotto: un guasto inventato
  // dalle prove stesse. Qui interessa solo lo smistamento del menu, e quello
  // sta tutto dentro messaggio().
  const { creaSessione, messaggio } = await import('../src/chatbot.js');
  const dove = async (testo) => messaggio(creaSessione(), testo).testo || '';

  const cardiologo = await dove('avrei bisogno di una visita dal cardiologo');
  verifica('"visita dal cardiologo" apre le specialistiche',
    cardiologo.includes('visita specialistica'), cardiologo.slice(0, 90));

  const prelievo = await dove('devo fare il prelievo del sangue');
  verifica('"prelievo del sangue" apre gli esami',
    prelievo.includes('esami'), prelievo.slice(0, 90));

  const ricetta = await dove('mi serve la ricetta per la pressione');
  verifica('"ricetta" apre ancora i medicinali',
    ricetta.toLowerCase().includes('medicinali') || ricetta.toLowerCase().includes('farmac'),
    ricetta.slice(0, 90));

  const appuntamento = await dove('vorrei prenotare una visita');
  verifica('"prenotare una visita" resta la prenotazione',
    appuntamento.toLowerCase().includes('ambulatorio'), appuntamento.slice(0, 90));
}

console.log('\nNel chatbot si torna indietro senza perdere tutto');
{
  const apri = async () => {
    const a = await chiama('GET', '/api/chat');
    const s = a.dati.sessioneId;
    return { s, passo: (testo) => chiama('POST', '/api/chat', { sessione: s, testo }) };
  };

  // Un passo indietro: si rifa' solo l'ultima risposta.
  {
    const { passo } = await apri();
    await passo('medicine');
    await passo('Tachipirina');
    await passo('Luca Ferri');
    const dietro = await passo('indietro');
    verifica('"indietro" riporta alla domanda precedente',
      dietro.dati.testo.includes('Come ti chiami'), dietro.dati.testo.slice(0, 90));

    await passo('Luca Ferrari');
    await passo('3331234567');
    // L'email e' l'ultima domanda: la sua risposta e' gia' il riepilogo.
    const riepilogo = await passo('luca@example.com');
    verifica('la risposta corretta sostituisce quella sbagliata',
      riepilogo.dati.testo.includes('Luca Ferrari') && !riepilogo.dati.testo.includes('Luca Ferri'),
      riepilogo.dati.testo.slice(0, 120));
    verifica('e quello scritto prima dell\'errore e\' ancora li\'',
      riepilogo.dati.testo.includes('Tachipirina'));
  }

  // Dal riepilogo si corregge un dato solo e si torna dritti al riepilogo:
  // chi sbaglia il telefono non deve ridettare anche email e medicinali.
  {
    const { passo } = await apri();
    await passo('medicine');
    await passo('Cardioaspirin');
    await passo('Rosa Neri');
    await passo('3339990000');
    await passo('rosa@example.com');

    const scelta = await passo('correggi');
    verifica('dal riepilogo si sceglie quale dato cambiare',
      scelta.dati.azioni?.some((a) => a.id === 'campo:telefono'), JSON.stringify(scelta.dati.azioni));

    const chiede = await passo('campo:telefono');
    verifica('e il chatbot richiede solo quello',
      chiede.dati.testo.includes('numero di telefono'), chiede.dati.testo.slice(0, 80));

    const tornato = await passo('3337778888');
    verifica('dopo la correzione si torna al riepilogo, non alla domanda dopo',
      tornato.dati.testo.includes('Controlla che sia tutto giusto')
      && tornato.dati.testo.includes('3337778888'), tornato.dati.testo.slice(0, 160));
    verifica('gli altri dati non sono stati toccati',
      tornato.dati.testo.includes('rosa@example.com') && tornato.dati.testo.includes('Cardioaspirin'));

    const fatta = await passo('confermo');
    verifica('e la richiesta parte col dato corretto', String(fatta.dati.richiesta || '').startsWith('MED-'));
    const salvata = db.prepare('SELECT telefono FROM richieste_medicine WHERE codice = ?').get(fatta.dati.richiesta);
    verifica('nel database finisce il numero nuovo', salvata?.telefono === '3337778888', salvata?.telefono);
  }

  // Cambiare l'ambulatorio non puo' lasciare in piedi il giorno gia' scelto:
  // un orario libero ad Arceto non lo e' per forza a Casalgrande.
  {
    const { passo } = await apri();
    await passo('prenota');
    await passo('amb:1');
    const giorni = await passo('');
    const primoGiorno = giorni.dati.azioni?.find((a) => a.id.startsWith('data:'));
    verifica('la prenotazione propone dei giorni', Boolean(primoGiorno));

    await passo(primoGiorno.id);
    const orari = await passo('');
    const primaOra = orari.dati.azioni?.find((a) => a.id.startsWith('ora:'));
    await passo(primaOra.id);
    await passo('Ida Conti');
    await passo('3335554444');
    await passo('ida@example.com');
    await passo('Controllo');

    await passo('correggi');
    const dopoAmbulatorio = await passo('campo:ambulatorio');
    verifica('correggendo l\'ambulatorio si torna a scegliere l\'ambulatorio',
      dopoAmbulatorio.dati.azioni?.some((a) => a.id.startsWith('amb:')));

    const dopoScelta = await passo('amb:2');
    verifica('e il giorno va riscelto invece di restare quello vecchio',
      dopoScelta.dati.azioni?.some((a) => a.id.startsWith('data:'))
      && !dopoScelta.dati.testo.includes('Controlla che sia tutto giusto'),
      dopoScelta.dati.testo.slice(0, 90));
  }

  // Il motivo della visita e' testo libero: una frase che contiene la parola
  // "indietro" e' una risposta, non un comando.
  {
    const { passo } = await apri();
    await passo('prenota');
    await passo('amb:1');
    const giorni = await passo('');
    await passo(giorni.dati.azioni.find((a) => a.id.startsWith('data:')).id);
    const orari = await passo('');
    await passo(orari.dati.azioni.find((a) => a.id.startsWith('ora:')).id);
    await passo('Ugo Bassi');
    await passo('3332221111');
    await passo('ugo.bassi@example.com');
    const scritto = await passo('Non riesco a piegarmi indietro');
    verifica('una frase che contiene "indietro" resta una risposta',
      scritto.dati.testo.includes('Non riesco a piegarmi indietro'), scritto.dati.testo.slice(0, 140));
  }
}

console.log('\nEsami dal chatbot, con la prescrizione allegata');
{
  // Un PNG vero da un pixel: il formato si riconosce dai byte, quindi un
  // finto file di zeri verrebbe rifiutato e la prova non direbbe niente.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

  const carica = (codice, nome) => fetch(
    `${BASE}/api/medicine/${codice}/allegato?conferma=si&nome=${encodeURIComponent(nome)}`,
    { method: 'POST', headers: { 'Content-Type': 'image/png',
      Authorization: `Bearer ${tokenPaziente}` }, body: PNG });

  const apertura = await chiama('GET', '/api/chat');
  const sessione = apertura.dati.sessioneId;
  const passo = (testo) => chiama('POST', '/api/chat', { sessione, testo });

  await passo('esami del sangue');
  await passo('Emocromo e glicemia');
  await passo('Marco Verdi');
  await passo('3331112223');
  await passo('marco.verdi@example.com');
  const fine = await passo('confermo');

  const codice = fine.dati.richiesta;
  verifica('il chatbot registra una richiesta di esami', String(codice || '').startsWith('ESA-'),
    JSON.stringify(fine.dati).slice(0, 160));
  verifica('e offre subito di allegare la prescrizione', fine.dati.allegaA === codice);

  const inCoda = db.prepare(`
    SELECT payload, prossimo_tentativo, creato_il FROM outbox
     WHERE tipo = 'email' AND json_extract(payload, '$.allegatiDi') IS NOT NULL
     ORDER BY id DESC LIMIT 1
  `).get();
  verifica('l\'avviso allo studio andrà a prendersi gli allegati da solo',
    Boolean(inCoda), 'nessuna email con allegatiDi in coda');
  // Il ritardo e' la sola cosa che fa arrivare la foto dentro la stessa email:
  // senza, l'avviso parte prima che il paziente abbia finito di caricarla.
  verifica('e aspetta qualche minuto prima di partire',
    inCoda && inCoda.prossimo_tentativo > inCoda.creato_il,
    `${inCoda?.creato_il} -> ${inCoda?.prossimo_tentativo}`);

  const messo = await carica(codice, 'prescrizione.png');
  verifica('una pratica chatbot senza account resta accessibile solo allo staff', messo.status === 404,
    `stato ${messo.status}`);
}

console.log('\nAccesso amministratore');
let token = null;
{
  const adminPrima = db.prepare('SELECT id, password_hash FROM utenti WHERE email = ?').get(config.admin.email);
  db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?').run('hash-modificato-dal-titolare', adminPrima.id);
  inizializzaAdminDiretto();
  const nonSovrascritto = db.prepare('SELECT password_hash FROM utenti WHERE id = ?').get(adminPrima.id);
  verifica('il bootstrap .env non sovrascrive un account esistente',
    nonSovrascritto.password_hash === 'hash-modificato-dal-titolare');
  db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?').run(adminPrima.password_hash, adminPrima.id);

  const sessioneRecovery = creaSessioneDiretta(adminPrima.id).token;
  config.admin.resetOnce = true;
  inizializzaAdminDiretto();
  const dopoRecovery = db.prepare('SELECT cambio_password FROM utenti WHERE id = ?').get(adminPrima.id);
  const sessioneRevocata = db.prepare('SELECT COUNT(*) n FROM sessioni WHERE utente_id = ?').get(adminPrima.id).n;
  verifica('il recovery once impone cambio password e revoca le sessioni',
    Boolean(sessioneRecovery) && dopoRecovery.cambio_password === 1 && sessioneRevocata === 0);
  db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?').run('seconda-modifica', adminPrima.id);
  inizializzaAdminDiretto();
  verifica('lo stesso recovery non viene riapplicato',
    db.prepare('SELECT password_hash FROM utenti WHERE id = ?').get(adminPrima.id).password_hash === 'seconda-modifica');
  config.admin.resetOnce = false;
  db.prepare('UPDATE utenti SET password_hash = ?, cambio_password = 0 WHERE id = ?')
    .run(adminPrima.password_hash, adminPrima.id);

  const negato = await chiama('GET', '/api/admin/prenotazioni');
  verifica('l\'area admin e\' chiusa senza credenziali', negato.stato === 401);

  const sbagliata = await chiama('POST', '/api/auth/login', { email: config.admin.email, password: 'password-errata' });
  verifica('password errata respinta', sbagliata.stato === 401);

  const accesso = await chiama('POST', '/api/auth/login', {
    email: config.admin.email, password: process.env.ADMIN_PASSWORD
  });
  token = accesso.dati.token;
  verifica('accesso amministratore riuscito', accesso.stato === 200 && Boolean(token),
    JSON.stringify(accesso.dati).slice(0, 120));

  const elenco = await chiama('GET', '/api/admin/prenotazioni', null, token);
  verifica('col token si leggono le prenotazioni', elenco.stato === 200 && Array.isArray(elenco.dati.prenotazioni));

  const riepilogo = await chiama('GET', '/api/admin/riepilogo', null, token);
  verifica('il riepilogo risponde', riepilogo.stato === 200 && riepilogo.dati.riepilogo);

  const finto = await chiama('GET', '/api/admin/prenotazioni', null, 'token-inventato');
  verifica('un token inventato non apre nulla', finto.stato === 401);
}

console.log('\nChiusure (giorni e fasce orarie bloccate)');
{
  const { oggiISO, aggiungiGiorni } = await import('../src/orari.js');
  let g = null;
  let slot = [];
  for (let i = 20; i <= 34 && !g; i++) {
    const d = aggiungiGiorni(oggiISO(), i);
    const r = await chiama('GET', `/api/disponibilita?data=${d}&ambulatorio_id=1`);
    const liberi = (r.dati.slot || []).filter((s) => s.disponibile);
    if (liberi.length >= 6) { g = d; slot = liberi; }
  }
  verifica('trovato un giorno libero per la prova delle chiusure', Boolean(g));

  const paziente = {
    nome: 'Chi', cognome: 'Usura', telefono: '3330000099',
    email: 'chi.usura.prova@example.it', problema: 'prova chiusure'
  };

  // --- Fascia oraria: blocca i primi due slot ---
  const cf = await chiama('POST', '/api/admin/chiusure',
    { dal: g, ora_inizio: slot[0].ora_inizio, ora_fine: slot[2].ora_inizio, motivo: 'prova fascia' }, token);
  verifica('fascia oraria bloccata creata', cf.stato === 201 && cf.dati.chiusura?.ora_inizio === slot[0].ora_inizio);

  const dopoFascia = await chiama('GET', `/api/disponibilita?data=${g}&ambulatorio_id=1`);
  const ore = (dopoFascia.dati.slot || []).map((s) => s.ora_inizio);
  verifica('gli slot dentro la fascia spariscono, gli altri restano',
    !ore.includes(slot[0].ora_inizio) && !ore.includes(slot[1].ora_inizio) && ore.includes(slot[3].ora_inizio));

  const dentro = await chiama('POST', '/api/prenotazioni', { ...paziente, ambulatorio_id: 1, data: g, ora_inizio: slot[0].ora_inizio });
  verifica('prenotare dentro la fascia bloccata viene rifiutato', dentro.stato >= 400);

  const fuori = await chiama('POST', '/api/prenotazioni', { ...paziente, ambulatorio_id: 1, data: g, ora_inizio: slot[3].ora_inizio });
  verifica('prenotare fuori dalla fascia funziona', fuori.stato === 201);

  await chiama('DELETE', `/api/admin/chiusure/${cf.dati.chiusura.id}`, null, token);

  // --- Giornata intera ---
  const cg = await chiama('POST', '/api/admin/chiusure', { dal: g, motivo: 'prova giorno' }, token);
  verifica('chiusura di giornata creata', cg.stato === 201);

  const dopoGiorno = await chiama('GET', `/api/disponibilita?data=${g}&ambulatorio_id=1`);
  verifica('con la giornata chiusa non resta alcuno slot libero',
    !(dopoGiorno.dati.slot || []).some((s) => s.disponibile));

  const inGiornoChiuso = await chiama('POST', '/api/prenotazioni', { ...paziente, ambulatorio_id: 1, data: g, ora_inizio: slot[4].ora_inizio });
  verifica('prenotare in un giorno chiuso viene rifiutato', inGiornoChiuso.stato >= 400);

  const rimozione = await chiama('DELETE', `/api/admin/chiusure/${cg.dati.chiusura.id}`, null, token);
  verifica('la chiusura si elimina', rimozione.stato === 200);

  const dopoRimozione = await chiama('GET', `/api/disponibilita?data=${g}&ambulatorio_id=1`);
  verifica('eliminata la chiusura, gli slot tornano prenotabili',
    (dopoRimozione.dati.slot || []).some((s) => s.disponibile));
}

console.log('\nL\'assistente del pannello');
{
  const chiedi = async (testo) =>
    (await chiama('POST', '/api/admin/assistente', { testo }, token)).dati;

  const fuori = await chiama('POST', '/api/admin/assistente', { testo: 'come va oggi' });
  verifica('l\'assistente e\' chiuso senza credenziali', fuori.stato === 401);

  const saluto = await chiama('GET', '/api/admin/assistente', null, token);
  verifica('l\'assistente saluta e propone qualcosa',
    saluto.stato === 200 && saluto.dati.testo?.length > 10 && saluto.dati.azioni?.length > 0);

  // I numeri devono venire dal database, non da una frase inventata: il modo di
  // verificarlo e' confrontarli con il riepilogo, che li conta per conto suo.
  const veri = (await chiama('GET', '/api/admin/riepilogo', null, token)).dati.riepilogo;
  const oggi = await chiedi('quante prenotazioni ho oggi');
  verifica('il numero delle visite di oggi e\' quello vero',
    oggi.testo.includes(String(veri.prenotazioni_oggi)), oggi.testo);

  const situazione = await chiedi('come va oggi');
  verifica('"come va oggi" mette in fila tutti i conteggi',
    ['Oggi', 'Medicinali', 'specialistiche', 'Esami', 'confermare'].every((p) => situazione.testo.includes(p)),
    situazione.testo.slice(0, 120));

  const sospeso = await chiedi('cosa devo vedere');
  verifica('"cosa devo vedere" risponde senza rompersi', Boolean(sospeso.testo));

  // I tre posti dove si lavora tutti i giorni devono avere il loro bottone
  // anche a coda vuota: e' da li' che si apre l'agenda la mattina.
  const sempre = ['apri moduli', 'apri prenotazioni', 'apri medicine'];
  verifica('"cosa devo vedere" apre sempre da confermare, prenotazioni e medicinali',
    sempre.every((id) => sospeso.azioni?.some((a) => a.id === id)),
    JSON.stringify(sospeso.azioni?.map((a) => a.id)));

  const agenda = await chiedi('chi viene oggi');
  verifica('l\'agenda di oggi risponde', Boolean(agenda.testo));

  // Un codice incollato deve essere riconosciuto e deve dire dove andare.
  const prima = (await chiama('GET', '/api/admin/prenotazioni', null, token)).dati.prenotazioni[0];
  const perCodice = await chiedi(`  ${prima.codice}  `);
  verifica('un codice incollato viene riconosciuto',
    perCodice.testo.includes(prima.codice) && perCodice.vai?.scheda === 'prenotazioni',
    perCodice.testo.slice(0, 100));

  const cercato = await chiedi(`cerca ${prima.paziente_cognome}`);
  verifica('cercando un cognome si trova la persona',
    cercato.testo.includes(prima.paziente_cognome) && cercato.vai?.scheda === 'pazienti',
    cercato.testo.slice(0, 100));

  // Le parole si sovrappongono anche qui: "Esposito" contiene "esa" e i cognomi
  // non si possono prevedere. Chi cerca una persona deve finire fra i pazienti,
  // non fra gli esami del sangue.
  const cognomeInsidioso = await chiedi('cerca Esposito');
  verifica('"cerca Esposito" non finisce negli esami',
    cognomeInsidioso.vai?.scheda === 'pazienti', JSON.stringify(cognomeInsidioso.vai));

  const vai = await chiedi('apri i medicinali');
  verifica('"apri i medicinali" porta sulla scheda giusta', vai.vai?.scheda === 'medicine',
    JSON.stringify(vai.vai));

  const boh = await chiedi('qwerty asdf zxcv');
  verifica('una domanda incomprensibile non lo rompe', Boolean(boh.testo) && boh.azioni?.length > 0);

  // --- L'assistente annulla un appuntamento, ma solo con conferma esplicita ---
  const orari = await import('../src/orari.js');
  const nuova = await chiama('POST', '/api/admin/prenotazioni', {
    forza: true, ambulatorio_id: 1, data: orari.aggiungiGiorni(orari.oggiISO(), 40), ora_inizio: '10:30',
    nome: 'Annulla', cognome: 'Prova', telefono: '3331112222', email: 'annulla.prova@example.it',
    problema: 'da annullare via assistente'
  }, token);
  const cod = nuova.dati.prenotazione?.codice;
  verifica('creata una prenotazione per la prova di annullamento',
    nuova.stato === 201 && /^PRE-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(cod || ''));

  const passo1 = await chiedi(`annulla ${cod}`);
  verifica('"annulla CODICE" chiede conferma e non annulla subito',
    passo1.testo.toLowerCase().includes(`conferma annulla ${cod.toLowerCase()}`)
    && (await chiedi(cod)).testo.includes('Stato: confermata'));

  const passo2 = await chiedi(`conferma annulla ${cod}`);
  verifica('"conferma annulla CODICE" annulla davvero e porta sulle prenotazioni',
    passo2.testo.toLowerCase().includes('annullata') && passo2.vai?.scheda === 'prenotazioni');

  verifica('dopo la conferma la prenotazione risulta annullata',
    (await chiedi(cod)).testo.includes('Stato: annullata'));

  const giaAnnullata = await chiedi(`conferma annulla ${cod}`);
  verifica('un secondo annullamento viene rifiutato con garbo',
    /gi[àa]|annull/i.test(giaAnnullata.testo));

  const inventato = await chiedi('annulla PRE-ZZZZ-ZZZZ');
  verifica('annullare un codice inesistente lo dice', inventato.testo.includes('non risulta'));
}

console.log('\nL\'assistente non aggira il segreto del medico');
{
  // Il motivo della visita e' del medico. L'assistente risponde a voce, e a voce
  // sarebbe la strada piu' comoda per farselo dire lo stesso: se qui passasse,
  // il controllo nelle altre schermate non servirebbe a niente.
  const EMAIL = 'assistente.segretaria@example.com';
  const creato = await chiama('POST', '/api/admin/utenti',
    { nome: 'Giulia', email: EMAIL, ruolo: 'segretaria' }, token);
  const provvisoria = creato.dati.password_provvisoria;

  // Un accesso solo, non due: il freno sul login e' di 10 tentativi ogni cinque
  // minuti e vale per tutta la prova. Cambiando la password la sessione aperta
  // resta valida, quindi il secondo accesso sarebbe stato sprecato — e a furia
  // di sprecarne, e' l'ultima prova della lista a farsi respingere.
  const entra = await chiama('POST', '/api/auth/login', { email: EMAIL, password: provvisoria });
  let tokenCollab = entra.dati.token;
  await chiama('POST', '/api/auth/password',
    { attuale: provvisoria, nuova: 'PasswordSegretaria1' }, tokenCollab);
  verifica('la segretaria entra nel pannello', entra.stato === 200 && Boolean(tokenCollab));
  const revocataCambio = await chiama('GET', '/api/admin/prenotazioni', null, tokenCollab);
  verifica('il cambio password revoca la sessione corrente', revocataCambio.stato === 401);
  tokenCollab = (await chiama('POST', '/api/auth/login',
    { email: EMAIL, password: 'PasswordSegretaria1' })).dati.token;

  const suo = await chiama('POST', '/api/admin/assistente', { testo: 'chi viene oggi' }, tokenCollab);
  verifica('la segretaria usa l\'assistente', suo.stato === 200 && Boolean(suo.dati.testo));

  // Il confronto e' fra le due risposte alla stessa domanda: quella del medico
  // contiene il motivo, quella della segretaria deve contenere il segnaposto al
  // suo posto. Cercare una frase fissa non proverebbe niente il giorno in cui
  // quella frase non c'e'.
  const conMotivo = (await chiama('GET', '/api/admin/prenotazioni', null, token))
    .dati.prenotazioni.find((p) => p.problema && p.problema.trim());
  verifica('c\'e\' una prenotazione con un motivo su cui provare', Boolean(conMotivo),
    'nessuna prenotazione ha un motivo: la prova qui sotto non direbbe nulla');

  const daMedico = await chiama('POST', '/api/admin/assistente', { testo: conMotivo.codice }, token);
  verifica('il medico vede il motivo della visita',
    daMedico.dati.testo.includes(conMotivo.problema), daMedico.dati.testo.slice(0, 200));

  const daSegretaria = await chiama('POST', '/api/admin/assistente',
    { testo: conMotivo.codice }, tokenCollab);
  verifica('la segretaria, sulla stessa prenotazione, non lo vede',
    !daSegretaria.dati.testo.includes(conMotivo.problema)
    && daSegretaria.dati.testo.includes('riservato al medico'),
    daSegretaria.dati.testo.slice(0, 200));
}

console.log('\nGli annullamenti vecchi non ingombrano l\'elenco');
{
  // Un annullamento serve il giorno che succede; il giorno dopo e' rumore su un
  // elenco che si guarda di corsa. Sparisce dalla vista, non dall'archivio: chi
  // lo cerca lo ritrova filtrando su "annullate".
  // Lo slot si chiede adesso invece di pescarlo da slotLiberi: quella lista e'
  // dell'inizio, e nel frattempo le prove qui sopra ne hanno occupati parecchi.
  const disponibili = await chiama('GET', `/api/disponibilita?data=${giorno}&ambulatorio_id=1`);
  const slot = (disponibili.dati.slot || []).find((s) => s.disponibile);
  verifica('c\'e\' uno slot libero per questa prova', Boolean(slot));

  const creata = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: giorno, ora_inizio: slot.ora_inizio,
    nome: 'Vecchio', cognome: 'Annullamento', telefono: '3335554444',
    email: 'vecchio.annullamento@example.com', problema: 'Verifica sparizione dall elenco'
  });
  const codice = creata.dati.prenotazione?.codice;
  await chiama('POST', `/api/prenotazioni/${codice}/annulla`, { conferma: true });

  const appena = await chiama('GET', '/api/admin/prenotazioni', null, token);
  verifica('appena annullata si vede ancora',
    appena.dati.prenotazioni.some((p) => p.codice === codice));

  // La si invecchia di tre giorni senza aspettare tre giorni.
  db.prepare('UPDATE prenotazioni SET annullata_il = ? WHERE codice = ?')
    .run(new Date(Date.now() - 3 * 86400000).toISOString(), codice);

  const dopo = await chiama('GET', '/api/admin/prenotazioni', null, token);
  verifica('passato un giorno sparisce dall\'elenco',
    !dopo.dati.prenotazioni.some((p) => p.codice === codice));

  const cercandola = await chiama('GET', '/api/admin/prenotazioni?stato=annullata', null, token);
  verifica('ma chi la cerca fra le annullate la ritrova',
    cercandola.dati.prenotazioni.some((p) => p.codice === codice));

  const dalPaziente = await chiama('GET', `/api/prenotazioni/${codice}`);
  verifica('e il paziente col suo codice la vede sempre', dalPaziente.stato === 200);
}

console.log('\nUna visita gia\' fatta sgombera l\'elenco');
{
  // L'elenco serve a sapere chi deve ancora venire. Una visita di marzo, ad
  // agosto, e' solo una riga fra cui scorrere per arrivare a quelle di domani.
  const giorno = aggiungiGiorni(oggiISO(), 4);
  const disponibili = await chiama('GET', `/api/disponibilita?data=${giorno}&ambulatorio_id=1`);
  const slot = (disponibili.dati.slot || []).find((s) => s.disponibile);

  const creata = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: giorno, ora_inizio: slot.ora_inizio,
    nome: 'Visita', cognome: 'Passata', telefono: '3335550000',
    email: 'visita.passata@example.com', problema: 'Verifica sparizione dopo il giorno'
  });
  const codice = creata.dati.prenotazione?.codice;

  const prima = await chiama('GET', '/api/admin/prenotazioni', null, token);
  verifica('una visita futura sta nell\'elenco',
    prima.dati.prenotazioni.some((p) => p.codice === codice));

  // La si sposta indietro nel tempo invece di aspettare che passi.
  db.prepare('UPDATE prenotazioni SET data = ? WHERE codice = ?')
    .run(aggiungiGiorni(oggiISO(), -3), codice);

  const dopo = await chiama('GET', '/api/admin/prenotazioni', null, token);
  verifica('passato il giorno della visita sparisce',
    !dopo.dati.prenotazioni.some((p) => p.codice === codice));

  // Ma solo dall'elenco di partenza: chi mette le date o cerca un nome la vuole.
  const conDate = await chiama('GET',
    `/api/admin/prenotazioni?dal=${aggiungiGiorni(oggiISO(), -10)}&al=${oggiISO()}`, null, token);
  verifica('mettendo le date si rivede', conDate.dati.prenotazioni.some((p) => p.codice === codice));

  const cercandola = await chiama('GET', '/api/admin/prenotazioni?cerca=Passata', null, token);
  verifica('e cercando il cognome pure',
    cercandola.dati.prenotazioni.some((p) => p.codice === codice));
}

console.log('\nUna richiesta chiusa resta in vista un giorno, poi va nella scheda');
{
  const creata = await chiama('POST', '/api/medicine', {
    nome: 'Richiesta', cognome: 'Chiusa', telefono: '3335551111',
    email: 'richiesta.chiusa@example.com', farmaci: 'Tachipirina', tipo: 'medicina'
  });
  const codice = creata.dati.richiesta?.codice;
  await chiama('POST', `/api/admin/medicine/${codice}/conferma`, {}, token);

  const appena = await chiama('GET', '/api/admin/medicine', null, token);
  verifica('appena confermata si vede ancora',
    appena.dati.richieste.some((r) => r.codice === codice));

  db.prepare('UPDATE richieste_medicine SET gestita_il = ?, aggiornata_il = ? WHERE codice = ?')
    .run(...Array(2).fill(new Date(Date.now() - 3 * 86400000).toISOString()), codice);

  const dopo = await chiama('GET', '/api/admin/medicine', null, token);
  verifica('dopo ventiquattro ore sparisce dalla scheda',
    !dopo.dati.richieste.some((r) => r.codice === codice));

  const perStato = await chiama('GET', '/api/admin/medicine?stato=confermata', null, token);
  verifica('col filtro sullo stato si ritrova', perStato.dati.richieste.some((r) => r.codice === codice));

  const cercandola = await chiama('GET', '/api/admin/medicine?cerca=Chiusa', null, token);
  verifica('e cercando il cognome pure', cercandola.dati.richieste.some((r) => r.codice === codice));

  // Il punto di tutta la faccenda: sparisce dalla scrivania, non dalla storia.
  const paziente = (await chiama('GET', '/api/admin/pazienti?cerca=Chiusa', null, token))
    .dati.pazienti[0];
  const fascicolo = await chiama('GET', `/api/admin/pazienti/${paziente.id}`, null, token);
  verifica('ma nella scheda del paziente c\'e\' sempre',
    fascicolo.dati.medicine.some((m) => m.codice === codice));
}

console.log('\nChi non e\' piu\' nostro paziente');
{
  const nato = await chiama('POST', '/api/medicine', {
    nome: 'Cambiato', cognome: 'Medico', telefono: '3335552222',
    email: 'cambiato.medico@example.com', farmaci: 'Nulla', tipo: 'medicina'
  });
  verifica('la persona di prova esiste', nato.stato === 201);

  const trova = async (dimessi = false) => (await chiama('GET',
    `/api/admin/pazienti?cerca=Medico${dimessi ? '&dimessi=1' : ''}`, null, token))
    .dati.pazienti.find((p) => p.cognome === 'Medico');

  const paziente = await trova();
  verifica('sta negli elenchi', Boolean(paziente));

  const dimesso = await chiama('POST', `/api/admin/pazienti/${paziente.id}/dimetti`,
    { dimesso: true }, token);
  verifica('il medico lo dimette', dimesso.stato === 200 && Boolean(dimesso.dati.paziente.dimesso_il));

  verifica('sparisce dagli elenchi', !(await trova()));
  verifica('ma si ritrova chiedendo anche i dimessi', Boolean(await trova(true)));

  // Il punto della dimissione: si nasconde, non si cancella.
  const suo = await chiama('GET', `/api/admin/pazienti/${paziente.id}`, null, token);
  verifica('la sua storia e\' ancora tutta li\'',
    suo.stato === 200 && suo.dati.medicine.length > 0);

  const tornato = await chiama('POST', `/api/admin/pazienti/${paziente.id}/dimetti`,
    { dimesso: false }, token);
  verifica('e se torna si riammette', tornato.stato === 200 && !tornato.dati.paziente.dimesso_il);
  verifica('e ricompare negli elenchi', Boolean(await trova()));
}

console.log('\nCancellare un paziente porta via tutto');
{
  const nato = await chiama('POST', '/api/medicine', {
    nome: 'Da', cognome: 'Cancellare', telefono: '3335553333',
    email: 'da.cancellare@example.com', farmaci: 'Prova', tipo: 'medicina'
  });
  const codiceRichiesta = nato.dati.richiesta.codice;

  const paziente = (await chiama('GET', '/api/admin/pazienti?cerca=Cancellare', null, token))
    .dati.pazienti[0];

  const conteggi = await chiama('GET', `/api/admin/pazienti/${paziente.id}/conteggi`, null, token);
  verifica('prima si dice cosa sparirebbe',
    conteggi.stato === 200 && conteggi.dati.conteggi.richieste >= 1,
    JSON.stringify(conteggi.dati.conteggi));

  const rimosso = await chiama('DELETE', `/api/admin/pazienti/${paziente.id}`, null, token);
  verifica('il medico lo cancella', rimosso.stato === 200 && rimosso.dati.rimosso.richieste >= 1);

  const cercato = await chiama('GET', '/api/admin/pazienti?cerca=Cancellare&dimessi=1', null, token);
  verifica('non c\'e\' piu\' nemmeno fra i dimessi',
    !cercato.dati.pazienti.some((p) => p.cognome === 'Cancellare'));

  const suo = await chiama('GET', `/api/admin/pazienti/${paziente.id}`, null, token);
  verifica('la sua scheda non esiste piu\'', suo.stato === 404);

  // Le righe che lo riguardavano non devono restare orfane: una richiesta che
  // punta a un paziente inesistente e' una riga che fa saltare la schermata.
  const orfane = db.prepare(
    'SELECT COUNT(*) n FROM richieste_medicine WHERE codice = ?').get(codiceRichiesta).n;
  verifica('e nemmeno le sue richieste', orfane === 0);
}

console.log('\nAccessi personali dei collaboratori');
{
  const EMAIL_COLLAB = 'collaboratore.prova@example.com';

  const creato = await chiama('POST', '/api/admin/utenti',
    { nome: 'Anna', email: EMAIL_COLLAB, ruolo: 'segretaria' }, token);
  const provvisoria = creato.dati.password_provvisoria;
  verifica('il medico crea un accesso personale',
    creato.stato === 201 && typeof provvisoria === 'string' && provvisoria.length >= 10,
    JSON.stringify(creato.dati).slice(0, 140));
  verifica('la password provvisoria va cambiata al primo ingresso',
    creato.dati.utente?.deve_cambiare_password === true);

  const doppione = await chiama('POST', '/api/admin/utenti',
    { nome: 'Altra', email: EMAIL_COLLAB, ruolo: 'segretaria' }, token);
  verifica('non si creano due accessi con la stessa email', doppione.stato === 400);

  const primo = await chiama('POST', '/api/auth/login', { email: EMAIL_COLLAB, password: provvisoria });
  let tokenCollab = primo.dati.token;
  verifica('il collaboratore entra con la password provvisoria',
    primo.stato === 200 && Boolean(tokenCollab));
  verifica('il sistema gli chiede di cambiarla',
    primo.dati.utente?.deve_cambiare_password === true);

  // Il blocco deve stare nel server, non solo nella pagina.
  const bloccato = await chiama('GET', '/api/admin/prenotazioni', null, tokenCollab);
  verifica('con la password provvisoria non si combina nulla',
    bloccato.stato === 403 && bloccato.dati.cambio_password === true,
    `stato ${bloccato.stato}`);

  const corta = await chiama('POST', '/api/auth/password',
    { attuale: provvisoria, nuova: 'breve' }, tokenCollab);
  verifica('rifiuta una password troppo corta', corta.stato === 400);

  const sbagliata = await chiama('POST', '/api/auth/password',
    { attuale: 'non-e-questa', nuova: 'PasswordPersonale1' }, tokenCollab);
  verifica('per cambiarla serve quella attuale', sbagliata.stato === 400);

  const cambio = await chiama('POST', '/api/auth/password',
    { attuale: provvisoria, nuova: 'PasswordPersonale1' }, tokenCollab);
  verifica('il collaboratore sceglie la sua password', cambio.stato === 200);

  tokenCollab = creaSessioneDiretta(creato.dati.utente.id).token;
  const ora = await chiama('GET', '/api/admin/prenotazioni', null, tokenCollab);
  verifica('adesso lavora normalmente', ora.stato === 200);

  const clinico = await chiama('GET', '/api/admin/statistiche', null, tokenCollab);
  verifica('la segretaria non vede i dati riservati al medico', clinico.stato === 403);

  const idCollab = creato.dati.utente.id;
  const sospeso = await chiama('PATCH', `/api/admin/utenti/${idCollab}`, { attivo: false }, token);
  verifica('il medico sospende l\'accesso', sospeso.stato === 200 && sospeso.dati.utente.attivo === false);

  const scacciato = await chiama('GET', '/api/admin/prenotazioni', null, tokenCollab);
  verifica('chi e\' sospeso viene buttato fuori subito', scacciato.stato === 401);

  const rientro = await chiama('POST', '/api/auth/login',
    { email: EMAIL_COLLAB, password: 'PasswordPersonale1' });
  verifica('e non rientra nemmeno con la password giusta', rientro.stato === 403);

  await chiama('PATCH', `/api/admin/utenti/${idCollab}`, { attivo: true }, token);
  const riammesso = await chiama('POST', '/api/auth/login',
    { email: EMAIL_COLLAB, password: 'PasswordPersonale1' });
  verifica('riattivato, torna a entrare', riammesso.stato === 200, `stato ${riammesso.stato}`);
  tokenCollab = riammesso.dati.token;

  const rinnovo = await chiama('POST', `/api/admin/utenti/${idCollab}/password`, null, token);
  verifica('il medico puo\' dargli una nuova password provvisoria',
    rinnovo.stato === 200 && typeof rinnovo.dati.password_provvisoria === 'string');

  const vecchiaSessione = await chiama('GET', '/api/admin/prenotazioni', null, tokenCollab);
  verifica('rigenerare la password chiude le sessioni aperte', vecchiaSessione.stato === 401);

  const nonStaff = await chiama('GET', '/api/admin/utenti', null, rinnovo.dati.utente ? token : token);
  verifica('l\'elenco dei collaboratori si legge', nonStaff.stato === 200
    && nonStaff.dati.utenti.some((u) => u.email === EMAIL_COLLAB));

  // Le due mosse che chiuderebbero fuori lo studio per sempre.
  const me = nonStaff.dati.utenti.find((u) => u.ruolo === 'admin' && u.attivo);
  const autogol = await chiama('DELETE', `/api/admin/utenti/${me.id}`, null, token);
  verifica('nessuno puo\' cancellare se stesso', autogol.stato === 400, autogol.dati.message);

  const declassamento = await chiama('PATCH', `/api/admin/utenti/${me.id}`, { ruolo: 'segretaria' }, token);
  verifica('nessuno puo\' togliersi i poteri da solo', declassamento.stato === 400);

  const rimosso = await chiama('DELETE', `/api/admin/utenti/${idCollab}`, null, token);
  verifica('un collaboratore si puo\' rimuovere', rimosso.stato === 200);

  const dopo = await chiama('GET', '/api/admin/utenti', null, token);
  verifica('e sparisce dall\'elenco', !dopo.dati.utenti.some((u) => u.email === EMAIL_COLLAB));
}

console.log('\nEmail in arrivo (rete di sicurezza)');
{
  const { registraEmail, superaLimiteMessaggio } = await import('../src/inbox.js');
  verifica('il limite email rifiuta i byte prima del parsing',
    superaLimiteMessaggio(config.inbox.massimoByteMessaggio + 1)
    && !superaLimiteMessaggio(config.inbox.massimoByteMessaggio));

  const medicine = registraEmail({
    messageId: '<prova-1@example.com>',
    mittente: 'paziente@example.com', mittenteNome: 'Luigi Verdi',
    oggetto: 'Richiesta ricetta', corpo: 'Buongiorno, avrei bisogno della ricetta per il Cardioaspirin.'
  });
  verifica('l\'email di medicinali diventa una richiesta', medicine.collegata?.startsWith('MED-'),
    JSON.stringify(medicine));

  const doppia = registraEmail({
    messageId: '<prova-1@example.com>',
    mittente: 'paziente@example.com', oggetto: 'Richiesta ricetta', corpo: 'Doppione.'
  });
  verifica('la stessa email non viene elaborata due volte', doppia.saltata === true);

  // Il programma prende solo quello che riconosce. Una email che non parla ne'
  // di visite ne' di medicinali non entra in archivio e non finisce sulla
  // scrivania: prima ci finiva, e le tre righe che contavano restavano sepolte
  // sotto le newsletter.
  //
  // "ignorata" non vuol dire "buttata": e' il segnale che il giro di lettura usa
  // per NON segnare il messaggio come letto su Gmail, cosi' resta li' dov'e' e
  // lo vede una persona. Se un giorno questa riga diventasse "saltata", una
  // richiesta scritta con parole diverse sparirebbe senza che nessuno la veda.
  const nonPertinente = registraEmail({
    messageId: '<prova-2@example.com>',
    mittente: 'tizio@example.com', oggetto: 'Boh', corpo: 'Testo senza senso.'
  });
  verifica('l\'email che non c\'entra resta fuori dalla scrivania',
    nonPertinente.ignorata === true && !nonPertinente.codice, JSON.stringify(nonPertinente));

  const visita = registraEmail({
    messageId: '<prova-3@example.com>',
    mittente: 'altro@example.com', mittenteNome: 'Maria Neri',
    oggetto: 'Prenotazione visita', corpo: 'Vorrei prenotare un appuntamento la settimana prossima.'
  });
  verifica('l\'email che chiede una visita viene salvata', visita.codice?.startsWith('EML-'),
    JSON.stringify(visita));

  // Notifiche automatiche di Google (condivisione di un Foglio o Modulo che si
  // chiama "Prenotazione visita") e promozioni: nel testo c'e' la parola
  // giusta, ma non sono richieste di pazienti e non devono finire in "Da
  // confermare". Prima ci finivano.
  const moduliMod = await import('../src/moduli.js');
  const daConfPrima = moduliMod.daConfermare();
  const spazzatura = [
    { mittente: 'drive-shares-dm-noreply@google.com', oggetto: 'Foglio di lavoro condiviso con te: "Prenotazione visita (Risposte)"', corpo: 'Ho condiviso un contenuto con te.' },
    { mittente: 'valeriabraglia62@gmail.com', oggetto: 'Invito a rispondere al modulo "Prenotazione visita"', corpo: 'Ho condiviso un modulo con te.' },
    { mittente: 'hello@mail.toogoodtogo.it', oggetto: 'Il tuo appuntamento, Valeria: 5 euro in regalo', corpo: 'Apri app e ottieni un buono.' }
  ].map((e, i) => registraEmail({ messageId: `<spam-${i}@x>`, ...e }));
  verifica('le notifiche automatiche non entrano fra le richieste',
    spazzatura.every((r) => r.ignorata === true && !r.codice), JSON.stringify(spazzatura));
  verifica('e non creano righe in "Da confermare"', moduliMod.daConfermare() === daConfPrima);

  const inCoda = await chiama('GET', '/api/admin/email', null, token);
  verifica('le email compaiono nell\'area admin', inCoda.dati.totale === 2, `totale ${inCoda.dati.totale}`);

  // Un'email di prenotazione non diventa niente da sola: nel testo non c'e' un
  // giorno di cui fidarsi. Deve finire in "Da confermare", dove una persona la
  // legge e prenota. Da quando la scheda "Email ricevute" non esiste piu', e'
  // l'unico posto dove qualcuno la vedra': se questa prova cade, quelle email
  // spariscono senza che nessuno se ne accorga.
  const parcheggiata = (await chiama('GET', '/api/admin/moduli?stato=nuova', null, token))
    .dati.richieste.find((r) => r.email === 'altro@example.com');
  verifica('la prenotazione arrivata per email finisce in "Da confermare"',
    Boolean(parcheggiata), 'nessuna riga parcheggiata per quell\'indirizzo');
  verifica('e porta con se\' il testo di cosa chiedeva',
    parcheggiata?.testo?.includes('prenotare'), parcheggiata?.testo?.slice(0, 80));

  // Il telefono e' obbligatorio per prenotare, ma un'email non ha campi: se non
  // si riesce a pescarlo, chi lavora deve scriverlo a mano. Vale la pena
  // provare i tre modi in cui si prova a trovarlo, perche' ognuno di essi e'
  // una telefonata in meno da fare per chiederlo.
  {
    const numeroDi = (email) => db.prepare(
      "SELECT telefono FROM richieste_modulo WHERE email = ? ORDER BY id DESC LIMIT 1").get(email)?.telefono;

    registraEmail({
      messageId: '<tel-1@example.com>', mittente: 'cellulare@example.com',
      oggetto: 'Prenotazione', corpo: 'Vorrei prenotare. Mi trova al 333 444 5566.'
    });
    verifica('il cellulare scritto nel testo viene letto',
      numeroDi('cellulare@example.com') === '3334445566', numeroDi('cellulare@example.com'));

    registraEmail({
      messageId: '<tel-2@example.com>', mittente: 'fisso@example.com',
      oggetto: 'Prenotazione', corpo: 'Vorrei prenotare un appuntamento. Tel. 0522 123456'
    });
    verifica('anche un fisso, se annunciato da "tel"',
      numeroDi('fisso@example.com') === '0522123456', numeroDi('fisso@example.com'));

    // Una data non e' un numero di telefono. Un recapito sbagliato in archivio
    // e' peggio di nessun recapito: si chiama e risponde un estraneo.
    registraEmail({
      messageId: '<tel-3@example.com>', mittente: 'data@example.com',
      oggetto: 'Prenotazione', corpo: 'Vorrei prenotare un appuntamento dopo il 09.08.2026, grazie.'
    });
    verifica('ma una data non viene scambiata per un numero',
      !numeroDi('data@example.com'), `letto: ${numeroDi('data@example.com')}`);

    // Il caso piu' frequente: chi scrive non mette il numero perche' da' per
    // scontato che lo studio ce l'abbia. E spesso ce l'ha davvero.
    const gia = await chiama('POST', '/api/medicine', {
      nome: 'Gia', cognome: 'Conosciuto', telefono: '3339990011',
      email: 'conosciuto@example.com', farmaci: 'Nulla', tipo: 'medicina'
    });
    verifica('la persona era gia\' passata di qui', gia.stato === 201);

    registraEmail({
      messageId: '<tel-4@example.com>', mittente: 'conosciuto@example.com',
      oggetto: 'Prenotazione', corpo: 'Vorrei prenotare una visita, grazie.'
    });
    verifica('senza numero nel testo si usa quello gia\' in archivio',
      numeroDi('conosciuto@example.com') === '3339990011', numeroDi('conosciuto@example.com'));
  }

  // Rileggere la casella non deve sdoppiarla.
  registraEmail({
    messageId: '<prova-3-bis@example.com>',
    mittente: 'altro@example.com', mittenteNome: 'Maria Neri',
    oggetto: 'Prenotazione visita', corpo: 'Vorrei prenotare un appuntamento la settimana prossima.'
  });
  const quante = (await chiama('GET', '/api/admin/moduli?stato=nuova', null, token))
    .dati.richieste.filter((r) => r.email === 'altro@example.com').length;
  verifica('due email diverse fanno due righe, non una sola', quante === 2, `righe: ${quante}`);

  // Chi fotografa la ricetta e la manda per email fa lo stesso gesto di chi la
  // carica dal sito: il file deve finire dentro la richiesta, non restare in
  // casella dove nessuno lo ricollega.
  {
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');

    const conFoto = registraEmail({
      messageId: '<prova-foto@example.com>',
      mittente: 'fotografo@example.com', mittenteNome: 'Ugo Rossi',
      oggetto: 'Ricetta', corpo: 'Le mando la prescrizione dello specialista in foto.',
      allegati: [
        { filename: 'prescrizione.jpg', content: PNG },
        // Il logo in fondo alla firma: richiamato dall'HTML, non e' un documento.
        { filename: 'logo.png', content: PNG, related: true },
        // Un formato che non si puo' mostrare nel pannello senza rischi.
        { filename: 'appunti.docx', content: Buffer.from('PK finto docx') }
      ]
    });
    verifica('l\'email con la foto diventa comunque una richiesta',
      conFoto.collegata?.startsWith('MED-'), JSON.stringify(conFoto));

    const id = db.prepare('SELECT id, note FROM richieste_medicine WHERE codice = ?').get(conFoto.collegata);
    const files = db.prepare('SELECT nome, tipo_mime FROM allegati WHERE richiesta_id = ?').all(id.id);
    verifica('la foto arrivata per email si trova dentro la richiesta',
      files.length === 1 && files[0].tipo_mime === 'image/png', JSON.stringify(files));
    verifica('il logo della firma non finisce fra gli allegati',
      !files.some((f) => f.nome.includes('logo')));
    verifica('e di quello che non si e\' potuto tenere resta scritto dove cercarlo',
      id.note.includes('appunti.docx'), id.note);
  }

  // L'indirizzo dove arrivano gli avvisi allo studio non deve tornare a essere
  // quello con cui si entra nel pannello. Erano la stessa riga, e spostare la
  // posta su un'altra casella voleva dire cambiare anche le credenziali di
  // accesso: se qualcuno rimettesse insieme le due cose, il giorno che si
  // cambia casella ci si ritroverebbe chiusi fuori dal proprio pannello.
  {
    const { NOTIFY_EMAIL } = await import('../src/config.js');
    const scritto = (process.env.NOTIFY_EMAIL || '').trim().toLowerCase();

    verifica('gli avvisi hanno un indirizzo tutto loro',
      Boolean(scritto) && NOTIFY_EMAIL === scritto,
      `avvisi: ${NOTIFY_EMAIL} · accesso: ${config.admin.email}`);

    // E gli avvisi che partono da noi verso quella casella non devono
    // rientrare come se fossero richieste di un paziente.
    const nostroAvviso = registraEmail({
      messageId: '<prova-avviso@example.com>',
      mittente: NOTIFY_EMAIL,
      oggetto: 'Nuova prenotazione', corpo: 'Notifica interna.'
    });
    verifica('e quelli mandati a quella casella non rientrano',
      nostroAvviso.saltata === true || !nostroAvviso.codice, JSON.stringify(nostroAvviso));
  }

  // La posta che ci siamo mandati da soli non deve rientrare come richiesta:
  // e' cosi' che le notifiche di spostamento avevano invaso le email da leggere.
  const nostra = registraEmail({
    messageId: '<prova-nostra@example.com>',
    mittente: config.email.user || 'valeriabraglia62@gmail.com',
    oggetto: 'Spostata: Tizio Caio — 2026-01-01 10:00', corpo: 'Notifica interna.'
  });
  verifica('le notifiche partite da noi non rientrano', nostra.saltata === true || !nostra.codice,
    JSON.stringify(nostra));

  // Chiudere la pratica deve mandare il messaggio vero nel cestino di Gmail.
  // Qui non si arriva fino a Gmail: si verifica che l'ordine parta, che parta
  // una volta sola e solo per "gestita". Lo spostamento vero lo fa la coda, che
  // e' anche il motivo per cui il bottone non deve aspettarlo.
  const inCestino = () => db.prepare(
    `SELECT COUNT(*) n FROM outbox WHERE tipo = 'cestina_email' AND payload LIKE ?`
  ).get(`%${visita.codice}%`).n;

  await chiama('PATCH', `/api/admin/email/${visita.codice}`, { stato: 'archiviata' }, token);
  verifica('archiviare non tocca la casella', inCestino() === 0);

  await chiama('PATCH', `/api/admin/email/${visita.codice}`, { stato: 'gestita' }, token);
  verifica('segnarla gestita ordina di cestinare il messaggio', inCestino() === 1);

  await chiama('PATCH', `/api/admin/email/${visita.codice}`, { stato: 'nuova' }, token);
  await chiama('PATCH', `/api/admin/email/${visita.codice}`, { stato: 'gestita' }, token);
  verifica('e non lo riordina a ogni click', inCestino() === 1, `ordini ${inCestino()}`);
}

console.log('\nLa casella si svuota da sola');
{
  // Non c'e' piu' una scheda dove sgombrare la posta a mano: le email si
  // cestinano quando la pratica che riguardano e' chiusa, con la stessa
  // scadenza con cui la pratica sparisce dalle schermate di lavoro.
  const { registraEmail, pulisciEmailVecchie } = await import('../src/inbox.js');

  const inCestino = (codice) => db.prepare(
    `SELECT COUNT(*) n FROM outbox WHERE tipo = 'cestina_email' AND payload LIKE ?`
  ).get(`%${codice}%`).n;

  const arrivata = registraEmail({
    messageId: '<pulizia-1@example.com>',
    mittente: 'pulizia@example.com', mittenteNome: 'Rosa Gialli',
    oggetto: 'Richiesta ricetta', corpo: 'Avrei bisogno della ricetta per il Coumadin.'
  });
  verifica('l\'email di prova e\' diventata una richiesta',
    arrivata.collegata?.startsWith('MED-'), JSON.stringify(arrivata));

  pulisciEmailVecchie();
  verifica('finche\' la richiesta e\' da vedere non si tocca niente',
    inCestino(arrivata.codice) === 0);

  await chiama('POST', `/api/admin/medicine/${arrivata.collegata}/conferma`, {}, token);
  pulisciEmailVecchie();
  verifica('e nemmeno il giorno stesso che viene evasa',
    inCestino(arrivata.codice) === 0, 'cestinata troppo presto');

  // Passa il giorno, senza aspettarlo.
  db.prepare('UPDATE richieste_medicine SET gestita_il = ? WHERE codice = ?')
    .run(new Date(Date.now() - 3 * 86400000).toISOString(), arrivata.collegata);

  pulisciEmailVecchie();
  verifica('passate ventiquattro ore il messaggio va nel cestino',
    inCestino(arrivata.codice) === 1, 'ordine di cestinamento non partito');

  pulisciEmailVecchie();
  verifica('e non ci va due volte', inCestino(arrivata.codice) === 1);

  // Il testo dell'email resta: e' l'unica copia che non scade, perche' Gmail
  // svuota il cestino dopo trenta giorni.
  const salvata = db.prepare('SELECT corpo, stato FROM richieste_email WHERE codice = ?')
    .get(arrivata.codice);
  verifica('ma il testo resta nell\'archivio',
    salvata.corpo.includes('Coumadin') && salvata.stato === 'gestita', JSON.stringify(salvata));

  // Una prenotazione arrivata per email aspetta una persona: finche' e' in "Da
  // confermare" non si cestina, altrimenti si butterebbe l'unica cosa da cui si
  // capisce cosa voleva il paziente.
  const daFare = registraEmail({
    messageId: '<pulizia-2@example.com>',
    mittente: 'aspetta@example.com', mittenteNome: 'Nino Blu',
    oggetto: 'Prenotazione', corpo: 'Vorrei prenotare una visita, grazie.'
  });
  pulisciEmailVecchie();
  verifica('una prenotazione ancora da confermare non si cestina',
    inCestino(daFare.codice) === 0);
}

console.log('\nIl fascicolo del paziente');
{
  const medicine = await import('../src/medicine.js');
  const mail = 'fascicolo.prova@example.com';
  const quantiPazienti = () =>
    db.prepare('SELECT COUNT(*) n FROM pazienti WHERE lower(email) = ?').get(mail).n;

  // Come arrivano quelle scritte a mano allo studio: c'e' l'indirizzo, il
  // telefono no. Sono proprio quelle che prima restavano appese al nulla.
  const richiesta = medicine.creaRichiesta({
    nome: 'Fascicolo', cognome: 'Diprova', email: mail, telefono: '',
    farmaci: 'Cardioaspirina 100mg', note: '', origine: 'email'
  });
  verifica('finche\' e\' da vedere non inventa un paziente',
    richiesta.paziente_id == null && quantiPazienti() === 0);

  const confermata = medicine.conferma(richiesta.codice, 'prova@studio');
  verifica('confermarla apre il fascicolo', confermata.paziente_id != null);
  verifica('e il paziente e\' uno solo', quantiPazienti() === 1);

  const seconda = medicine.conferma(medicine.creaRichiesta({
    nome: 'Fascicolo', cognome: 'Diprova', email: mail, telefono: '',
    farmaci: 'Tachipirina 1000', note: '', origine: 'email'
  }).codice, 'prova@studio');
  verifica('la richiesta dopo finisce nello stesso fascicolo, non in uno nuovo',
    seconda.paziente_id === confermata.paziente_id && quantiPazienti() === 1);

  const scheda = await chiama('GET', `/api/admin/pazienti/${confermata.paziente_id}`, null, token);
  verifica('il fascicolo mostra tutti e due i medicinali',
    scheda.dati.medicine?.length === 2, JSON.stringify(scheda.dati.medicine?.map((m) => m.codice)));
  verifica('e dice come e\' finita ognuna',
    scheda.dati.medicine?.every((m) => 'gestita_il' in m && 'motivo_rifiuto' in m));

  // Un no non deve lasciare in archivio una persona che non e' mai stata paziente.
  const rifiutata = medicine.creaRichiesta({
    nome: 'Niente', cognome: 'Difatto', email: 'rifiuto.prova@example.com', telefono: '',
    farmaci: 'Qualcosa', note: '', origine: 'email'
  });
  medicine.rifiuta(rifiutata.codice, 'non si puo\'', 'prova@studio');
  verifica('rifiutare non apre nessun fascicolo',
    db.prepare('SELECT COUNT(*) n FROM pazienti WHERE lower(email) = ?')
      .get('rifiuto.prova@example.com').n === 0);
}

console.log('\nModuli Google (richieste arrivate a sito spento)');
{
  const moduli = await import('../src/moduli.js');

  // Uno slot davvero libero: la conferma deve arrivare fino in fondo.
  const giorno = aggiungiGiorni(oggiISO(), 9);
  const slot = (await chiama('GET', `/api/disponibilita?data=${giorno}`))
    .dati.slot.filter((s) => s.disponibile);
  verifica('c\'e\' uno slot libero per la prova', slot.length >= 2, `liberi: ${slot.length}`);

  const primo = slot[0];
  const [gg, mm, aaaa] = [giorno.slice(8), giorno.slice(5, 7), giorno.slice(0, 4)];

  const INTESTAZIONI = ['Informazioni cronologiche', 'Nome', 'Cognome', 'Telefono',
    'Email', 'Giorno desiderato', 'Ora desiderata', 'Ambulatorio', 'Motivo della visita'];

  const righe = [
    INTESTAZIONI,
    // Data all'italiana, come la scrive Google in italiano.
    ['09/08/2026 21:14:02', 'Marta', 'Bianchi', '333 111 2233', 'marta@example.com',
      `${gg}/${mm}/${aaaa}`, primo.ora_inizio, primo.ambulatorio_nome, 'Controllo pressione'],
    // Riga sgangherata: manca quasi tutto e la data non si capisce.
    ['09/08/2026 22:01:00', 'Gino', '', '', '', 'quando potete', '', '', 'mi fa male la schiena'],
    // Righe vuote in fondo al foglio: non sono richieste.
    ['', '', '', '', '', '', '', '', '']
  ];

  const primoGiro = moduli.importaRighe('prenotazione', righe);
  verifica('le righe del foglio diventano richieste in attesa', primoGiro.nuove === 2,
    JSON.stringify(primoGiro));

  const secondoGiro = moduli.importaRighe('prenotazione', righe);
  verifica('rileggere il foglio non duplica niente', secondoGiro.nuove === 0 && secondoGiro.gia_viste === 2,
    JSON.stringify(secondoGiro));

  // In "Da confermare" non ci sono piu' solo i Moduli Google: da quando la
  // scheda "Email ricevute" e' sparita ci finiscono anche le prenotazioni
  // arrivate per email. Queste prove contano le proprie righe, non tutta la
  // scrivania, altrimenti basta che un'altra prova ne lasci una li' sopra per
  // farle fallire tutte insieme senza che il programma abbia niente che non va.
  const dalFoglio = (elenco) => elenco.filter((r) => JSON.parse(r.riga_json || '{}').riga);

  const inAttesa = await chiama('GET', '/api/admin/moduli', null, token);
  verifica('le richieste compaiono nel pannello', dalFoglio(inAttesa.dati.richieste).length === 2,
    `dal foglio: ${dalFoglio(inAttesa.dati.richieste).length}`);

  const marta = inAttesa.dati.richieste.find((r) => r.nome === 'Marta');
  verifica('nome, cognome e telefono vengono letti bene',
    marta?.cognome === 'Bianchi' && marta?.telefono === '3331112233', JSON.stringify(marta));
  verifica('la data all\'italiana viene capita', marta?.data_chiesta === giorno, marta?.data_chiesta);
  verifica('l\'ora viene capita', marta?.ora_chiesta === primo.ora_inizio, marta?.ora_chiesta);
  verifica('l\'ambulatorio viene riconosciuto dal nome',
    marta?.ambulatorio_id === primo.ambulatorio_id, `letto ${marta?.ambulatorio_id}`);

  const gino = inAttesa.dati.richieste.find((r) => r.nome === 'Gino');
  verifica('anche la richiesta incompleta viene conservata', Boolean(gino), 'Gino non e\' stato salvato');
  verifica('di quella incompleta si conserva la riga originale',
    JSON.parse(gino.riga_json).riga.includes('mi fa male la schiena'));

  // Conferma: da qui in poi e' una prenotazione come tutte le altre.
  const confermata = await chiama('POST', `/api/admin/moduli/${marta.codice}/conferma`, {}, token);
  verifica('la conferma crea una prenotazione vera',
    confermata.dati.generata?.codice?.startsWith('PRE-'), JSON.stringify(confermata.dati));

  const collegata = await chiama('GET', `/api/prenotazioni/${confermata.dati.generata.codice}`);
  verifica('la prenotazione da Moduli senza account resta riservata allo staff',
    collegata.stato === 404);

  const ribattuta = await chiama('POST', `/api/admin/moduli/${marta.codice}/conferma`, {}, token);
  verifica('la stessa richiesta non si conferma due volte', ribattuta.stato === 400, ribattuta.dati.message);

  // Due pazienti che chiedono lo stesso orario: il secondo non deve passare,
  // ma nemmeno sparire.
  // Ugo ha la sua email: quello che si prova qui e' lo scontro sull'orario, e
  // senza email la conferma verrebbe respinta prima ancora di arrivarci,
  // facendo passare la prova per il motivo sbagliato.
  const doppione = moduli.importaRighe('prenotazione', [INTESTAZIONI,
    ['09/08/2026 22:30:00', 'Ugo', 'Neri', '3334445566', 'ugo.neri@example.com',
      `${gg}/${mm}/${aaaa}`, primo.ora_inizio, primo.ambulatorio_nome, 'Stesso orario di Marta']]);
  verifica('il doppio orario entra comunque in attesa', doppione.nuove === 1);

  const ugo = (await chiama('GET', '/api/admin/moduli', null, token))
    .dati.richieste.find((r) => r.nome === 'Ugo');
  const scontro = await chiama('POST', `/api/admin/moduli/${ugo.codice}/conferma`, {}, token);
  verifica('confermare un orario gia\' occupato viene rifiutato', scontro.stato === 409, scontro.dati.message);

  const ancoraLi = (await chiama('GET', '/api/admin/moduli', null, token))
    .dati.richieste.find((r) => r.codice === ugo.codice);
  verifica('e la richiesta resta in attesa invece di perdersi', ancoraLi?.stato === 'nuova');

  // Spostandola su un altro orario deve passare.
  const spostata = await chiama('POST', `/api/admin/moduli/${ugo.codice}/conferma`,
    { ora_inizio: slot[1].ora_inizio, ambulatorio_id: slot[1].ambulatorio_id }, token);
  verifica('spostandola su un orario libero la conferma riesce',
    spostata.dati.generata?.codice?.startsWith('PRE-'), JSON.stringify(spostata.dati));

  // Rifiuto: sparisce dalla scrivania ma resta scritto cosa era arrivato.
  const rifiutata = await chiama('POST', `/api/admin/moduli/${gino.codice}/rifiuta`,
    { motivo: 'Richiesta troppo vaga, il paziente e\' stato richiamato.' }, token);
  verifica('una richiesta si puo\' scartare', rifiutata.dati.richiesta?.stato === 'rifiutata');
  verifica('e resta scritto il perche\'',
    rifiutata.dati.richiesta?.motivo_rifiuto?.includes('vaga'));

  const scrivania = await chiama('GET', '/api/admin/moduli', null, token);
  verifica('la scrivania resta pulita', dalFoglio(scrivania.dati.richieste).length === 0,
    `restano ${dalFoglio(scrivania.dati.richieste).length}`);

  // Modulo dei medicinali: stessa strada, arrivo diverso.
  const med = moduli.importaRighe('medicina', [
    ['Informazioni cronologiche', 'Nome e cognome', 'Telefono', 'Email', 'Medicinali richiesti', 'Note'],
    ['09/08/2026 23:00:00', 'Carla Rossi', '3339998877', 'carla@example.com',
      'Cardioaspirin 100mg', 'Ritiro ad Arceto']
  ]);
  verifica('anche il modulo dei medicinali viene raccolto', med.nuove === 1);

  const carla = dalFoglio((await chiama('GET', '/api/admin/moduli', null, token)).dati.richieste)
    .find((r) => r.nome === 'Carla');
  verifica('nome e cognome scritti insieme vengono divisi',
    carla.nome === 'Carla' && carla.cognome === 'Rossi', `${carla.nome}/${carla.cognome}`);

  const ricetta = await chiama('POST', `/api/admin/moduli/${carla.codice}/conferma`, {}, token);
  verifica('la conferma crea la richiesta di medicinali',
    ricetta.dati.generata?.codice?.startsWith('MED-'), JSON.stringify(ricetta.dati));

  // Specialistiche ed esami: le intestazioni sono quelle vere dei due moduli
  // creati dallo studio, copiate dal foglio delle risposte. Se un domani
  // qualcuno riscrive una domanda e la colonna smette di essere riconosciuta,
  // la richiesta arriverebbe vuota senza che nessuno se ne accorga: e' il
  // motivo per cui qui si prova il testo esatto e non una versione semplificata.
  for (const [tipoModulo, testata, risposta, prefisso] of [
    ['specialistica', 'Specialistiche  Di quale visita specialistica ha bisogno? ',
      'Visita cardiologica di controllo', 'SPE-'],
    ['esami', 'Esami  Quali esami del sangue le servono? ',
      'Emocromo, glicemia, colesterolo', 'ESA-']
  ]) {
    const arrivate = moduli.importaRighe(tipoModulo, [
      ['Informazioni cronologiche', 'Nome', 'Cognome', 'Telefono', 'Email',
        '\nFarmacia/ Ambulatorio\n', testata, 'Note'],
      ['09/08/2026 23:30:00', 'Elsa', 'Grandi', '3337778899', 'elsa@example.com',
        'Farmavi', risposta, 'Ha fretta']
    ]);
    verifica(`il modulo ${tipoModulo} viene raccolto`, arrivate.nuove === 1, JSON.stringify(arrivate));

    const elsa = dalFoglio((await chiama('GET', '/api/admin/moduli', null, token)).dati.richieste)
      .find((r) => r.nome === 'Elsa' && r.stato === 'nuova');
    verifica(`e si legge cosa ha chiesto (${tipoModulo})`, elsa?.testo === risposta,
      `letto: ${JSON.stringify(elsa?.testo)}`);
    // "Farmavi" non e' un ambulatorio nostro: deve restare vuoto, non farsi
    // scambiare per uno dei due studi.
    verifica(`il ritiro in farmacia non diventa un ambulatorio (${tipoModulo})`,
      elsa?.ambulatorio_id === null, `letto ${elsa?.ambulatorio_id}`);

    const nata = await chiama('POST', `/api/admin/moduli/${elsa.codice}/conferma`, {}, token);
    verifica(`la conferma la fa nascere del tipo giusto (${tipoModulo})`,
      nata.dati.generata?.codice?.startsWith(prefisso), JSON.stringify(nata.dati).slice(0, 160));
  }

  // Restano solo le prenotazioni arrivate per email delle prove piu' sopra:
  // quelle aspettano davvero una persona, ed e' giusto che il riepilogo le conti.
  const restano = dalFoglio((await chiama('GET', '/api/admin/moduli', null, token)).dati.richieste);
  verifica('nessuna riga del foglio resta da confermare', restano.length === 0,
    JSON.stringify(restano.map((r) => r.nome)));

  const riepilogo = await chiama('GET', '/api/admin/riepilogo', null, token);
  const daEmail = db.prepare(
    "SELECT COUNT(*) n FROM richieste_modulo WHERE stato = 'nuova' AND chiave LIKE 'email:%'").get().n;
  verifica('il riepilogo conta le richieste ancora da confermare',
    riepilogo.dati.riepilogo.moduli_da_confermare === daEmail,
    `contate ${riepilogo.dati.riepilogo.moduli_da_confermare}, da email ${daEmail}`);
}

console.log('\nOgni tipo di richiesta va sul suo Foglio Google');
{
  // Prima finivano tutte e tre sul foglio dei medicinali, dove nella colonna
  // "Medicinali" ci si ritrovava scritto "Visita cardiologica di controllo".
  const sheets = await import('../src/sheets.js');
  const inCoda = (tipo) => db.prepare(
    "SELECT COUNT(*) n FROM outbox WHERE tipo = ?").get(`sheet_${tipo}`).n;

  const prima = { medicina: inCoda('medicina'), specialistica: inCoda('specialistica'), esami: inCoda('esami') };

  for (const [tipo, cosa] of [
    ['medicina', 'Tachipirina'],
    ['specialistica', 'Visita dermatologica'],
    ['esami', 'Emocromo']
  ]) {
    const creata = await chiama('POST', '/api/medicine', {
      nome: 'Foglio', cognome: 'Giusto', telefono: '3336667777',
      email: 'foglio.giusto@example.com', farmaci: cosa, tipo
    });
    verifica(`la richiesta ${tipo} nasce`, creata.stato === 201, JSON.stringify(creata.dati).slice(0, 90));
    verifica(`e finisce in coda per il foglio ${tipo}`, inCoda(tipo) === prima[tipo] + 1,
      `prima ${prima[tipo]}, ora ${inCoda(tipo)}`);
  }

  // Le colonne dei tre fogli: il numero della ricetta sta in fondo, non in
  // mezzo, altrimenti nel foglio dei medicinali — che esiste da mesi — tutte le
  // righe gia' scritte si troverebbero sotto l'intestazione sbagliata.
  const colonne = sheets.SCHEDE_PROVA;
  verifica('il numero della ricetta e\' l\'ultima colonna',
    ['medicina', 'specialistica', 'esami'].every((t) => {
      const i = colonne[t].intestazioni;
      return i[i.length - 1].toLowerCase().includes('numero');
    }), JSON.stringify(colonne.medicina.intestazioni));

  verifica('le prime colonne restano quelle di prima',
    colonne.medicina.intestazioni.slice(0, 11).join('|')
      === 'Codice|Stato|Paziente|Telefono|Email|Medicinali|Note|Ambulatorio|Origine|Creata il|Aggiornata il',
    colonne.medicina.intestazioni.join('|'));

  verifica('ogni foglio chiama le cose col loro nome',
    colonne.specialistica.intestazioni.includes('Visita richiesta')
    && colonne.esami.intestazioni.includes('Esami richiesti'),
    JSON.stringify(colonne.esami.intestazioni));
}

console.log('\nNulla va perso quando i servizi esterni sono spenti');
{
  const inAttesa = db.prepare(`SELECT COUNT(*) n FROM outbox WHERE stato = 'in_attesa'`).get().n;
  verifica('le consegne restano in coda invece di sparire', inAttesa > 0, `in coda: ${inAttesa}`);

  const perse = db.prepare(`SELECT COUNT(*) n FROM outbox WHERE stato = 'scartato'`).get().n;
  verifica('nessuna consegna scartata', perse === 0, `scartate: ${perse}`);
}

console.log('\nTrecento pazienti sullo stesso orario');
{
  // La corsa si prova sul servizio, non sull'HTTP: il freno anti-abuso e' per
  // IP e in una prova arrivano tutte dallo stesso, mentre nella realta' sono
  // trecento indirizzi diversi. Cio' che deve reggere e' il vincolo del database.
  const { creaPrenotazione, ErroreDominio: Errore } = await import('../src/prenotazioni.js');
  const oraContesa = slotLiberi[5].ora_inizio;
  const inizio = Date.now();

  const esiti = await Promise.all(
    Array.from({ length: 300 }, (_, i) => Promise.resolve().then(() => {
      try {
        creaPrenotazione({
          ambulatorio_id: 1, data: giorno, ora_inizio: oraContesa,
          nome: `Paziente${i}`, cognome: 'Prova',
          telefono: `33300${String(i).padStart(5, '0')}`,
          email: `paziente${i}@example.com`,
          problema: 'Corsa allo stesso slot'
        });
        return 'creata';
      } catch (err) {
        return err instanceof Errore && err.codiceHttp === 409 ? 'occupato' : `errore: ${err.message}`;
      }
    }))
  );

  const durata = Date.now() - inizio;
  const creati = esiti.filter((e) => e === 'creata').length;
  const occupati = esiti.filter((e) => e === 'occupato').length;
  const imprevisti = esiti.filter((e) => e.startsWith('errore'));

  verifica('una sola prenotazione va a buon fine', creati === 1, `create: ${creati}`);
  verifica('le altre 299 ricevono "orario occupato"', occupati === 299, `occupati: ${occupati}`);
  verifica('nessun errore imprevisto', imprevisti.length === 0, imprevisti[0]);

  const righe = db.prepare(
    `SELECT COUNT(*) n FROM prenotazioni WHERE data = ? AND ora_inizio = ? AND stato = 'confermata'`
  ).get(giorno, oraContesa).n;
  verifica('nel database esiste una sola riga per quello slot', righe === 1, `righe: ${righe}`);

  console.log(`  (300 tentativi in ${durata}ms)`);
}

console.log('\nTrecento prenotazioni diverse in contemporanea');
{
  const { creaPrenotazione } = await import('../src/prenotazioni.js');
  const richieste = [];

  for (let i = 15; i <= 55 && richieste.length < 300; i++) {
    const { dati } = await chiama('GET', `/api/disponibilita?data=${aggiungiGiorni(oggiISO(), i)}`);
    for (const s of (dati.slot || []).filter((x) => x.disponibile)) {
      if (richieste.length < 300) richieste.push(s);
    }
  }

  verifica('ci sono abbastanza slot per la prova', richieste.length === 300, `trovati ${richieste.length}`);

  const inizio = Date.now();
  const esiti = await Promise.all(richieste.map((s, i) => Promise.resolve().then(() => {
    try {
      creaPrenotazione({
        ambulatorio_id: s.ambulatorio_id, data: s.data, ora_inizio: s.ora_inizio,
        nome: `Utente${i}`, cognome: 'Carico',
        telefono: `33911${String(i).padStart(5, '0')}`,
        email: `utente${i}@example.com`,
        problema: 'Prova di carico'
      });
      return true;
    } catch { return false; }
  })));

  const durata = Date.now() - inizio;
  verifica('tutte e 300 vengono registrate', esiti.every(Boolean), `riuscite: ${esiti.filter(Boolean).length}`);
  console.log(`  (300 prenotazioni scritte in ${durata}ms — ${Math.round(300000 / durata)} al secondo)`);

  const totale = db.prepare(`SELECT COUNT(*) n FROM prenotazioni WHERE stato = 'confermata'`).get().n;
  const inCoda = db.prepare('SELECT COUNT(*) n FROM outbox').get().n;
  verifica('ogni prenotazione ha le sue consegne in coda', inCoda >= totale, `prenotazioni ${totale}, coda ${inCoda}`);
}

console.log(`\n${passati} verifiche superate, ${falliti} fallite\n`);
process.exit(falliti === 0 ? 0 : 1);
