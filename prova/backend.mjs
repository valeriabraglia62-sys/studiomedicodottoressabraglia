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
