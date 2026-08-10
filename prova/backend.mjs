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
const DB_PROVA = path.join(RADICE, 'data', 'prova.sqlite');

for (const f of [DB_PROVA, `${DB_PROVA}-wal`, `${DB_PROVA}-shm`]) fs.rmSync(f, { force: true });

process.env.DB_FILE = DB_PROVA;
process.env.PORT = '3999';
process.env.INBOX_POLLING_ENABLED = 'false';
process.env.GOOGLE_SHEETS_ENABLED = 'false';
// Nessuna credenziale: le email restano in coda invece di partire davvero.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const BASE = 'http://localhost:3999';

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
  const r = await fetch(BASE + percorso, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  return { stato: r.status, dati: await r.json().catch(() => ({})) };
};

const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
await import('../server.js');
await new Promise((r) => setTimeout(r, 1500));

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
  const trovata = await chiama('GET', `/api/prenotazioni/${codicePrenotazione}`);
  verifica('la prenotazione si ritrova col codice', trovata.dati.prenotazione?.codice === codicePrenotazione);
  verifica('i dati interni non escono', trovata.dati.prenotazione?.paziente_id === undefined);

  const inesistente = await chiama('GET', '/api/prenotazioni/PRE-XXXX-XXXX');
  verifica('codice inesistente da 404', inesistente.stato === 404);

  const annullata = await chiama('POST', `/api/prenotazioni/${codicePrenotazione}/annulla`);
  verifica('annullamento riuscito', annullata.stato === 200, JSON.stringify(annullata.dati).slice(0, 120));

  verifica('la prenotazione annullata non propone piu\' il calendario',
    annullata.dati.prenotazione?.calendario === null,
    String(annullata.dati.prenotazione?.calendario).slice(0, 80));

  const dueVolte = await chiama('POST', `/api/prenotazioni/${codicePrenotazione}/annulla`);
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
}

console.log('\nAccesso amministratore');
let token = null;
{
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
  verifica('riattivato, torna a entrare', riammesso.stato === 200);
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
  const { registraEmail } = await import('../src/inbox.js');

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

  const incomprensibile = registraEmail({
    messageId: '<prova-2@example.com>',
    mittente: 'tizio@example.com', oggetto: 'Boh', corpo: 'Testo senza senso.'
  });
  verifica('anche l\'email incomprensibile viene salvata', incomprensibile.codice?.startsWith('EML-'));

  const inCoda = await chiama('GET', '/api/admin/email', null, token);
  verifica('le email compaiono nell\'area admin', inCoda.dati.totale === 2, `totale ${inCoda.dati.totale}`);

  // La posta che ci siamo mandati da soli non deve rientrare come richiesta:
  // e' cosi' che le notifiche di spostamento avevano invaso le email da leggere.
  const nostra = registraEmail({
    messageId: '<prova-nostra@example.com>',
    mittente: config.email.user || 'valeriabraglia62@gmail.com',
    oggetto: 'Spostata: Tizio Caio — 2026-01-01 10:00', corpo: 'Notifica interna.'
  });
  verifica('le notifiche partite da noi non rientrano', nostra.saltata === true || !nostra.codice,
    JSON.stringify(nostra));
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

  const inAttesa = await chiama('GET', '/api/admin/moduli', null, token);
  verifica('le richieste compaiono nel pannello', inAttesa.dati.totale === 2, `totale ${inAttesa.dati.totale}`);

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
  verifica('la prenotazione generata e\' consultabile dal paziente',
    collegata.dati.prenotazione?.stato === 'confermata');

  const ribattuta = await chiama('POST', `/api/admin/moduli/${marta.codice}/conferma`, {}, token);
  verifica('la stessa richiesta non si conferma due volte', ribattuta.stato === 400, ribattuta.dati.message);

  // Due pazienti che chiedono lo stesso orario: il secondo non deve passare,
  // ma nemmeno sparire.
  const doppione = moduli.importaRighe('prenotazione', [INTESTAZIONI,
    ['09/08/2026 22:30:00', 'Ugo', 'Neri', '3334445566', '',
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
  verifica('la scrivania resta pulita', scrivania.dati.totale === 0, `restano ${scrivania.dati.totale}`);

  // Modulo dei medicinali: stessa strada, arrivo diverso.
  const med = moduli.importaRighe('medicina', [
    ['Informazioni cronologiche', 'Nome e cognome', 'Telefono', 'Email', 'Medicinali richiesti', 'Note'],
    ['09/08/2026 23:00:00', 'Carla Rossi', '3339998877', 'carla@example.com',
      'Cardioaspirin 100mg', 'Ritiro ad Arceto']
  ]);
  verifica('anche il modulo dei medicinali viene raccolto', med.nuove === 1);

  const carla = (await chiama('GET', '/api/admin/moduli', null, token)).dati.richieste[0];
  verifica('nome e cognome scritti insieme vengono divisi',
    carla.nome === 'Carla' && carla.cognome === 'Rossi', `${carla.nome}/${carla.cognome}`);

  const ricetta = await chiama('POST', `/api/admin/moduli/${carla.codice}/conferma`, {}, token);
  verifica('la conferma crea la richiesta di medicinali',
    ricetta.dati.generata?.codice?.startsWith('MED-'), JSON.stringify(ricetta.dati));

  const riepilogo = await chiama('GET', '/api/admin/riepilogo', null, token);
  verifica('il riepilogo conta le richieste ancora da confermare',
    riepilogo.dati.riepilogo.moduli_da_confermare === 0,
    `contate ${riepilogo.dati.riepilogo.moduli_da_confermare}`);
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
