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
// I test parlano direttamente in HTTP locale; la produzione resta HTTPS
// fail-closed salvo questa disattivazione esplicita.
process.env.SITO_HTTPS = 'false';

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

/**
 * Il primo giorno (a partire da +dpartenza) con almeno uno slot libero per
 * l'ambulatorio 1, e lo slot. Serve perche' i giorni fissi ("oggi + 4")
 * cadono sul weekend a seconda del giorno in cui girano le prove, e con
 * l'ambulatorio chiuso non c'e' nessuno slot da prenotare.
 */
async function giornoConSlot(partenza = 3, fino = 21) {
  const { oggiISO, aggiungiGiorni } = await import('../src/orari.js');
  for (let i = partenza; i <= fino; i++) {
    const data = aggiungiGiorni(oggiISO(), i);
    const r = await chiama('GET', `/api/disponibilita?data=${data}&ambulatorio_id=1`);
    const slot = (r.dati.slot || []).find((s) => s.disponibile);
    if (slot) return { giorno: data, slot };
  }
  return { giorno: null, slot: null };
}

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

  // Orario ritoccato: le mattine di Arceto aprono alle 11:00, tutte le sere
  // (Arceto mercoledi', Casalgrande lun/gio) alle 17:30 — niente 17:00/17:15.
  const arceto = dati.ambulatori.find((a) => a.id === 1);
  const casal = dati.ambulatori.find((a) => a.id === 2);
  const mattinaArceto = [1, 2, 4, 5].map((g) => arceto.orari?.[g]?.inizio);
  verifica('Arceto la mattina apre alle 11:00 (niente 10:30 e 10:45)',
    mattinaArceto.every((h) => h === '11:00'), JSON.stringify(mattinaArceto));
  const sere = [arceto.orari?.[3]?.inizio, casal.orari?.[1]?.inizio, casal.orari?.[4]?.inizio];
  verifica('le sere aprono alle 17:30 (niente 17:00 e 17:15)',
    sere.every((h) => h === '17:30'), JSON.stringify(sere));
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

  // Dal sito la visita nasce come richiesta, non come prenotazione confermata:
  // niente link al calendario finche' lo studio non la conferma.
  verifica('la visita dal sito nasce come richiesta da confermare',
    dati.prenotazione?.stato === 'in_attesa', dati.prenotazione?.stato);
  verifica('la richiesta non in attesa non propone il calendario',
    dati.prenotazione?.calendario === null, String(dati.prenotazione?.calendario).slice(0, 80));

  const dopo = await chiama('GET', `/api/disponibilita?data=${giorno}&ambulatorio_id=1`);
  const ancoraLibero = dopo.dati.slot.find((s) => s.ora_inizio === slotLiberi[0].ora_inizio)?.disponibile;
  verifica('lo slot risulta occupato subito dopo, anche se solo richiesto', ancoraLibero === false);
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

  // La prenotazione da sito si aggancia alla scheda dell'account (dalla
  // sessione), non a una scheda ricreata per nome/telefono: cosi' il paziente
  // ritrova sempre il suo codice. Si registra un paziente con un nome nella
  // scheda diverso da quello che poi arriva nella prenotazione.
  const rp = registraPazienteDiretto({
    nome: 'Nomescheda', cognome: 'Diversa', telefono: '3337779990',
    email: 'aggancio.scheda@example.it', password: 'PasswordAggancio26!'
  });
  verificaEmailDiretto(rp.token);
  const idScheda = db.prepare('SELECT paziente_id FROM utenti WHERE id = ?').get(rp.utente.id).paziente_id;
  const tRp = creaSessioneDiretta(rp.utente.id).token;
  const gg2 = await chiama('GET', `/api/disponibilita?data=${giorno}&ambulatorio_id=1`);
  const sl2 = (gg2.dati.slot || []).find((s) => s.disponibile);
  const pren2 = await chiama('POST', '/api/prenotazioni',
    { ambulatorio_id: 1, data: giorno, ora_inizio: sl2.ora_inizio, problema: 'aggancio scheda' }, tRp);
  const cod2 = pren2.dati.prenotazione?.codice;
  const idPren = cod2 ? db.prepare('SELECT paziente_id FROM prenotazioni WHERE codice = ?').get(cod2).paziente_id : null;
  verifica('la prenotazione da sito e\' agganciata alla scheda dell\'account',
    idPren === idScheda, `scheda account ${idScheda}, scheda prenotazione ${idPren}`);
  const ritrovo = await chiama('GET', `/api/prenotazioni/${cod2}`, null, tRp);
  verifica('e il paziente la ritrova col suo codice', ritrovo.stato === 200
    && ritrovo.dati.prenotazione?.codice === cod2);

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

console.log('\nRichieste di visita: lo studio conferma o rifiuta');
{
  const { oggiISO, aggiungiGiorni } = await import('../src/orari.js');
  let g = null;
  let liberi = [];
  for (let i = 35 + Math.floor(Math.random() * 5); i <= 55 && !g; i++) {
    const d = aggiungiGiorni(oggiISO(), i);
    const r = await chiama('GET', `/api/disponibilita?data=${d}&ambulatorio_id=1`);
    const s = (r.dati.slot || []).filter((x) => x.disponibile);
    if (s.length >= 4) { g = d; liberi = s; }
  }
  verifica('trovato un giorno libero per le richieste di visita', Boolean(g));

  const datiPaziente = {
    nome: 'Richi', cognome: 'Esta', telefono: '3330001122',
    email: 'richi.esta.prova@example.it', problema: 'mal di schiena da giorni'
  };

  // --- Conferma -----------------------------------------------------------
  const creata = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: g, ora_inizio: liberi[0].ora_inizio, ...datiPaziente
  });
  const codConf = creata.dati.prenotazione?.codice;
  verifica('la richiesta di visita nasce in attesa',
    creata.stato === 201 && creata.dati.prenotazione?.stato === 'in_attesa',
    `${creata.stato} ${creata.dati.prenotazione?.stato}`);

  const nonAncora = await chiama('GET', `/api/prenotazioni/${codConf}`);
  verifica('il paziente puo\' ritirare la richiesta finche\' e\' in attesa',
    nonAncora.dati.annullabile === true && nonAncora.dati.prenotazione?.calendario === null);

  const inElenco = await chiama('GET', '/api/admin/prenotazioni?stato=in_attesa', null, token);
  verifica('la richiesta compare fra quelle da confermare',
    (inElenco.dati.prenotazioni || []).some((p) => p.codice === codConf));

  const riepConf = await chiama('GET', '/api/admin/riepilogo', null, token);
  verifica('il riepilogo conta le richieste di visita da confermare',
    riepConf.dati.riepilogo?.richieste_visita_da_confermare >= 1);

  const conferma = await chiama('POST', `/api/admin/prenotazioni/${codConf}/conferma`, {}, token);
  verifica('lo studio conferma la richiesta',
    conferma.stato === 200 && conferma.dati.prenotazione?.stato === 'confermata',
    `${conferma.stato} ${conferma.dati.prenotazione?.stato}`);

  const dopoConf = await chiama('GET', `/api/prenotazioni/${codConf}`);
  const cal = dopoConf.dati.prenotazione?.calendario || '';
  const attesi = `${g.replace(/-/g, '')}T${liberi[0].ora_inizio.replace(':', '')}00`;
  verifica('dopo la conferma arriva il link per Google Calendar',
    cal.startsWith('https://calendar.google.com/') && cal.includes(attesi), cal.slice(0, 120));

  const giaConf = await chiama('POST', `/api/admin/prenotazioni/${codConf}/conferma`, {}, token);
  verifica('una richiesta gia\' confermata non si riconferma', giaConf.stato === 400);

  // --- Modifica e conferma in un colpo solo ---------------------------
  const daModificare = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: g, ora_inizio: liberi[2].ora_inizio, ...datiPaziente
  });
  const codMod = daModificare.dati.prenotazione?.codice;
  const confModif = await chiama('POST', `/api/admin/prenotazioni/${codMod}/conferma`,
    { ambulatorio_id: 1, data: g, ora_inizio: liberi[3].ora_inizio }, token);
  verifica('lo studio modifica l\'orario e conferma in un passaggio',
    confModif.stato === 200 && confModif.dati.prenotazione?.stato === 'confermata'
    && confModif.dati.prenotazione?.ora_inizio === liberi[3].ora_inizio,
    `${confModif.stato} ${confModif.dati.prenotazione?.ora_inizio} atteso ${liberi[3].ora_inizio}`);
  const slotDopoModif = await chiama('GET', `/api/disponibilita?data=${g}&ambulatorio_id=1`);
  verifica('l\'orario chiesto in origine torna libero dopo la modifica',
    slotDopoModif.dati.slot.find((s) => s.ora_inizio === liberi[2].ora_inizio)?.disponibile === true);

  // --- Rifiuto ----------------------------------------------------------
  const daRifiutare = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: g, ora_inizio: liberi[1].ora_inizio, ...datiPaziente
  });
  const codRif = daRifiutare.dati.prenotazione?.codice;

  const senzaMotivo = await chiama('POST', `/api/admin/prenotazioni/${codRif}/rifiuta`, {}, token);
  verifica('il rifiuto senza motivo viene respinto', senzaMotivo.stato === 400);

  const occupatoOra = await chiama('GET', `/api/disponibilita?data=${g}&ambulatorio_id=1`);
  verifica('la richiesta da rifiutare intanto tiene lo slot',
    occupatoOra.dati.slot.find((s) => s.ora_inizio === liberi[1].ora_inizio)?.disponibile === false);

  const rifiuto = await chiama('POST', `/api/admin/prenotazioni/${codRif}/rifiuta`,
    { motivo: 'In quella giornata il medico non e\' in ambulatorio.' }, token);
  verifica('lo studio rifiuta la richiesta con un motivo',
    rifiuto.stato === 200 && rifiuto.dati.prenotazione?.stato === 'rifiutata',
    `${rifiuto.stato} ${rifiuto.dati.prenotazione?.stato}`);

  const tornatoLibero = await chiama('GET', `/api/disponibilita?data=${g}&ambulatorio_id=1`);
  verifica('rifiutata la richiesta, lo slot torna disponibile',
    tornatoLibero.dati.slot.find((s) => s.ora_inizio === liberi[1].ora_inizio)?.disponibile === true);

  const rifiutaAncora = await chiama('POST', `/api/admin/prenotazioni/${codRif}/rifiuta`,
    { motivo: 'di nuovo' }, token);
  verifica('una richiesta gia\' rifiutata non si rifiuta due volte', rifiutaAncora.stato === 400);

  const annullaRifiutata = await chiama('POST', `/api/prenotazioni/${codRif}/annulla`, { conferma: true });
  verifica('il paziente non annulla una richiesta gia\' rifiutata', annullaRifiutata.stato === 400);
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

  // --- Le prenotazioni gia' confermate colpite da una fascia sono per
  //     SOVRAPPOSIZIONE, non solo per l'ora d'inizio dentro la fascia. ---
  const app = await chiama('POST', '/api/admin/prenotazioni', {
    ambulatorio_id: 1, data: g, ora_inizio: slot[4].ora_inizio, forza: true,
    nome: 'Sovrap', cognome: 'Posta', telefono: '3334445550', problema: 'prova overlap'
  }, token);
  const codApp = app.dati.prenotazione?.codice;
  const [hh, min] = slot[4].ora_inizio.split(':').map(Number);
  // Fascia che PARTE dopo l'inizio della visita ma la sovrappone comunque.
  const inizioFascia = `${String(hh).padStart(2, '0')}:${String(min + 5).padStart(2, '0')}`;
  const fineFascia = `${String(hh + 1).padStart(2, '0')}:00`;
  const conOverlap = await chiama('POST', '/api/admin/chiusure',
    { dal: g, ora_inizio: inizioFascia, ora_fine: fineFascia, motivo: 'overlap' }, token);
  const colpite = conOverlap.dati.prenotazioni_da_avvisare || [];
  verifica('una visita che si sovrappone alla fascia (senza iniziare dentro) risulta colpita',
    Boolean(codApp) && colpite.some((p) => p.codice === codApp),
    `visita ${codApp} · colpite ${JSON.stringify(colpite.map((p) => p.codice))}`);
  if (conOverlap.dati.chiusura?.id) {
    await chiama('DELETE', `/api/admin/chiusure/${conOverlap.dati.chiusura.id}`, null, token);
  }
  if (codApp) await chiama('POST', `/api/admin/prenotazioni/${codApp}/annulla`, {}, token);

  // --- L'assistente del pannello crea una chiusura (due passaggi) ---
  const chiediA = async (testo) => (await chiama('POST', '/api/admin/assistente', { testo }, token)).dati;
  const isoBlocco = aggiungiGiorni(oggiISO(), 45);
  const [ay, am, ad] = isoBlocco.split('-');
  const dataIt = `${ad}/${am}/${ay}`;

  const bloccoVago = await chiediA('blocca giovedì prossimo');
  verifica('l\'assistente senza una data chiara non blocca niente',
    bloccoVago.testo.toLowerCase().includes('non ho capito'));

  const c1 = await chiediA(`blocca il ${dataIt} dalle 10:30 alle 12:00 per prova`);
  verifica('"blocca <data>" chiede conferma e non blocca subito',
    c1.testo.toLowerCase().includes('conferma blocca'));
  const primaN = (await chiama('GET', '/api/admin/chiusure', null, token)).dati.chiusure.length;

  const c2 = await chiediA(`conferma blocca il ${dataIt} dalle 10:30 alle 12:00 per prova`);
  verifica('"conferma blocca ..." crea la chiusura',
    c2.testo.toLowerCase().includes('fatto') && c2.vai?.scheda === 'chiusure');

  const lista = (await chiama('GET', '/api/admin/chiusure', null, token)).dati.chiusure;
  verifica('la chiusura creata dall\'assistente compare in elenco', lista.length === primaN + 1);
  const creata = lista.find((c) => c.dal === isoBlocco);
  verifica('la chiusura dell\'assistente ha la fascia giusta',
    creata?.ora_inizio === '10:30' && creata?.ora_fine === '12:00');

  const elenco = await chiediA('che chiusure ci sono');
  verifica('"che chiusure ci sono" le elenca', elenco.testo.includes('Chiusure impostate'));

  await chiama('DELETE', `/api/admin/chiusure/${creata.id}`, null, token);
}

console.log('\nPrenotazione dallo studio senza email');
{
  const { giorno, slot } = await giornoConSlot();
  const senzaEmail = await chiama('POST', '/api/admin/prenotazioni', {
    ambulatorio_id: 1, data: giorno, ora_inizio: slot.ora_inizio,
    nome: 'Nonna', cognome: 'Senzamail', telefono: '3336667788', problema: 'Controllo pressione'
  }, token);
  verifica('lo studio prenota anche senza indirizzo email',
    senzaEmail.stato === 201 && /^PRE-/.test(senzaEmail.dati.prenotazione?.codice || ''),
    `stato ${senzaEmail.stato} ${senzaEmail.dati.message || ''}`);
  verifica('e la prenotazione risulta senza email',
    !senzaEmail.dati.prenotazione?.paziente_email);

  // La forzatura salta i vincoli operativi, non la sintassi dell'orario.
  const oraImpossibile = await chiama('POST', '/api/admin/prenotazioni', {
    ambulatorio_id: 1, data: giorno, ora_inizio: '99:99', forza: true,
    nome: 'Ora', cognome: 'Assurda', telefono: '3336667799', problema: 'orario impossibile'
  }, token);
  verifica('nemmeno forzando si accetta un orario tipo 99:99', oraImpossibile.stato >= 400);
}

console.log('\nIl paziente modifica il proprio profilo');
{
  const reg = registraPazienteDiretto({
    nome: 'Profilo', cognome: 'Prova', telefono: '3339990001',
    email: 'profilo.prova@example.it', password: 'PasswordProfilo2026!'
  });
  verificaEmailDiretto(reg.token);
  const tok = creaSessioneDiretta(reg.utente.id).token;

  const prof = await chiama('GET', '/api/paziente/profilo', null, tok);
  verifica('il paziente vede i propri dati',
    prof.dati.profilo?.nome === 'Profilo' && prof.dati.profilo?.telefono === '3339990001');

  const rinomina = await chiama('PATCH', '/api/paziente/profilo', {
    nome: 'Profilo', cognome: 'Cambiato', telefono: '3339990009',
    email: 'profilo.prova@example.it'
  }, tok);
  verifica('nome e telefono si cambiano senza password',
    rinomina.stato === 200 && rinomina.dati.profilo?.cognome === 'Cambiato'
    && rinomina.dati.profilo?.telefono === '3339990009' && !rinomina.dati.email_cambiata);

  const emailSenzaPwd = await chiama('PATCH', '/api/paziente/profilo', {
    nome: 'Profilo', cognome: 'Cambiato', telefono: '3339990009',
    email: 'profilo.nuova@example.it'
  }, tok);
  verifica('cambiare email senza la password attuale e\' rifiutato', emailSenzaPwd.stato === 403);

  const emailOk = await chiama('PATCH', '/api/paziente/profilo', {
    nome: 'Profilo', cognome: 'Cambiato', telefono: '3339990009',
    email: 'profilo.nuova@example.it', password: 'PasswordProfilo2026!'
  }, tok);
  verifica('con la password l\'email si cambia',
    emailOk.stato === 200 && emailOk.dati.email_cambiata === true
    && emailOk.dati.profilo?.email === 'profilo.nuova@example.it');

  const loginNuova = await chiama('POST', '/api/auth/login', {
    email: 'profilo.nuova@example.it', password: 'PasswordProfilo2026!'
  });
  verifica('si accede con la nuova email', loginNuova.stato === 200);

  const emailAltrui = await chiama('PATCH', '/api/paziente/profilo', {
    nome: 'Profilo', cognome: 'Cambiato', telefono: '3339990009',
    email: 'mario.rossi.prova@example.it', password: 'PasswordProfilo2026!'
  }, tok);
  verifica('non si puo\' prendere l\'email di un altro account', emailAltrui.stato === 409);

  // Mass-assignment: un paziente prova a passare gli id di un altro nel corpo.
  const bersaglioReg = registraPazienteDiretto({
    nome: 'Bersaglio', cognome: 'Ignaro', telefono: '3337778881',
    email: 'bersaglio.ignaro@example.it', password: 'PasswordBersaglio26!'
  });
  verificaEmailDiretto(bersaglioReg.token);
  const idPazBersaglio = db.prepare('SELECT paziente_id FROM utenti WHERE id = ?').get(bersaglioReg.utente.id).paziente_id;

  const attacco = await chiama('PATCH', '/api/paziente/profilo', {
    pazienteId: idPazBersaglio, utenteId: bersaglioReg.utente.id, ruolo: 'admin', attivo: 1,
    nome: 'Hackerato', cognome: 'Da Altri', telefono: '3330000000',
    email: 'bersaglio.ignaro@example.it'
  }, tok);
  const bersDopo = db.prepare('SELECT nome, telefono FROM pazienti WHERE id = ?').get(idPazBersaglio);
  verifica('gli id nel corpo non toccano la scheda di un altro paziente',
    bersDopo.nome === 'Bersaglio' && bersDopo.telefono === '3337778881',
    `${attacco.stato} ${JSON.stringify(bersDopo)}`);
}

console.log('\nRegistrazione: non svela se l\'email esiste gia\'');
{
  const nuovo = await chiama('POST', '/api/auth/register', {
    nome: 'Prima', cognome: 'Volta', telefono: '3332223330',
    email: 'prima.volta@example.it', password: 'PasswordPrimaVolta26!'
  });
  const ripetuto = await chiama('POST', '/api/auth/register', {
    nome: 'Seconda', cognome: 'Volta', telefono: '3332223331',
    email: 'prima.volta@example.it', password: 'AltraPasswordAncora26!'
  });
  verifica('la seconda registrazione con la stessa email risponde come la prima',
    nuovo.stato === ripetuto.stato && nuovo.stato === 201
    && ripetuto.dati.verifica_inviata === true
    && !/esiste|gi[àa] regist|409/i.test(JSON.stringify(ripetuto.dati)));
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

  // I posti dove si lavora tutti i giorni devono avere il loro bottone
  // anche a coda vuota: e' da li' che si apre l'agenda la mattina.
  const sempre = ['apri prenotazioni', 'apri medicine'];
  verifica('"cosa devo vedere" apre sempre prenotazioni e medicinali',
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

  // Conferma reale a due passi: "conferma annulla X" da solo, senza aver prima
  // chiesto "annulla X", non annulla niente.
  const nuova2 = await chiama('POST', '/api/admin/prenotazioni', {
    forza: true, ambulatorio_id: 1, data: orari.aggiungiGiorni(orari.oggiISO(), 41), ora_inizio: '10:45',
    nome: 'Due', cognome: 'Passi', telefono: '3331113334', problema: 'conferma stateful'
  }, token);
  const cod2 = nuova2.dati.prenotazione?.codice;
  const soloConferma = await chiedi(`conferma annulla ${cod2}`);
  verifica('"conferma annulla" senza il primo passo non annulla',
    soloConferma.testo.toLowerCase().includes('prima')
    && (await chiedi(cod2)).testo.includes('Stato: confermata'));
  await chiama('POST', `/api/admin/prenotazioni/${cod2}/annulla`, {}, token);
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
  // Lo slot si cerca adesso: le prove qui sopra ne hanno occupati parecchi, e
  // un giorno fisso puo' cadere sul weekend a seconda di quando girano le prove.
  const { giorno: gg, slot } = await giornoConSlot();
  verifica('c\'e\' uno slot libero per questa prova', Boolean(slot));

  const creata = await chiama('POST', '/api/prenotazioni', {
    ambulatorio_id: 1, data: gg, ora_inizio: slot.ora_inizio,
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
  const { giorno, slot } = await giornoConSlot();
  verifica('c\'e\' un giorno con slot per questa prova', Boolean(slot));

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

  // Le visite create qui nascono 'in_attesa' (nessuna origine 'studio'): il
  // vincolo idx_slot_unico copre anche quello stato, quindi la riga per lo
  // slot resta comunque una sola.
  const righe = db.prepare(
    `SELECT COUNT(*) n FROM prenotazioni
      WHERE data = ? AND ora_inizio = ? AND stato IN ('confermata', 'in_attesa')`
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

console.log('\nIn produzione la cifratura dei backup e\' obbligatoria');
{
  const { spawnSync } = await import('child_process');
  const provaAvvio = (extra) => spawnSync(process.execPath,
    ['-e', 'import("./src/config.js").then(()=>process.exit(0)).catch(()=>process.exit(3))'],
    {
      cwd: RADICE,
      env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64), ...extra },
      encoding: 'utf8'
    });

  const senzaChiave = provaAvvio({ BACKUP_ENCRYPTION_KEY: '' });
  verifica('senza BACKUP_ENCRYPTION_KEY il programma non parte in produzione',
    senzaChiave.status !== 0, `exit ${senzaChiave.status}`);

  const conChiave = provaAvvio({ BACKUP_ENCRYPTION_KEY: 'a'.repeat(64) });
  verifica('con la chiave parte normalmente in produzione', conChiave.status === 0,
    `exit ${conChiave.status} ${conChiave.stderr?.slice(0, 120) || ''}`);
}

console.log(`\n${passati} verifiche superate, ${falliti} fallite\n`);
process.exit(falliti === 0 ? 0 : 1);
