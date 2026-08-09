/**
 * Pannello di gestione. Il token di sessione vive in localStorage e viaggia
 * nell'intestazione Authorization: se il server risponde 401 si torna
 * automaticamente alla schermata di accesso, senza pagine bianche.
 */

const $ = (sel, dove = document) => dove.querySelector(sel);
const $$ = (sel, dove = document) => [...dove.querySelectorAll(sel)];

const CHIAVE_TOKEN = 'studio-medico-admin';

const NOMI_MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const NOMI_GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const ETICHETTE_MEDICINE = {
  nuova: 'Nuova',
  in_lavorazione: 'In lavorazione',
  pronta: 'Pronta per il ritiro',
  consegnata: 'Consegnata',
  annullata: 'Annullata'
};

let token = localStorage.getItem(CHIAVE_TOKEN) || '';

// ---- Utilità ---------------------------------------------------------------

function nodo(tag, classe, contenuto) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (contenuto !== undefined && contenuto !== null) el.textContent = String(contenuto);
  return el;
}

function avvisa(messaggio, tipo = 'ok') {
  const el = nodo('div', `notifica ${tipo}`, messaggio);
  $('#notifiche').append(el);
  setTimeout(() => el.remove(), 5000);
  el.addEventListener('click', () => el.remove());
}

class NonAutorizzato extends Error {}

async function api(percorso, opzioni = {}) {
  const intestazioni = { ...(opzioni.headers || {}) };
  if (token) intestazioni.Authorization = `Bearer ${token}`;
  if (opzioni.body) intestazioni['Content-Type'] = 'application/json';

  const risposta = await fetch(`/api${percorso}`, {
    ...opzioni,
    headers: intestazioni,
    body: opzioni.body ? JSON.stringify(opzioni.body) : undefined
  });

  let dati = {};
  try { dati = await risposta.json(); } catch { /* gestito sotto */ }

  // Sessione finita: si torna all'accesso.
  if (risposta.status === 401) {
    throw new NonAutorizzato(dati.message || 'Sessione scaduta.');
  }
  // Password provvisoria ancora addosso: non e' un errore, e' un passaggio.
  if (risposta.status === 403 && dati.cambio_password) {
    chiediNuovaPassword();
    throw new Error(dati.message || 'Scegli prima una password personale.');
  }
  // Vietato ma sessione valida (es. la segreteria sui dati clinici): si dice
  // e basta, senza buttare fuori chi sta lavorando.
  if (!risposta.ok || dati.success === false) {
    throw new Error(dati.message || 'Problema di collegamento. Riprova.');
  }
  return dati;
}

/** Ogni caricamento passa di qui: un 401 riporta all'accesso invece di rompersi. */
async function protetto(azione) {
  try {
    await azione();
  } catch (err) {
    if (err instanceof NonAutorizzato) {
      esci(err.message);
    } else {
      avvisa(err.message, 'errore');
    }
  }
}

const oggiISO = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

function dataBreve(dataStr) {
  if (!dataStr) return '—';
  const [a, m, g] = String(dataStr).slice(0, 10).split('-').map(Number);
  return `${g}/${String(m).padStart(2, '0')}/${a}`;
}

function dataEstesa(dataStr) {
  const [a, m, g] = String(dataStr).slice(0, 10).split('-').map(Number);
  const settimana = new Date(Date.UTC(a, m - 1, g)).getUTCDay();
  return `${NOMI_GIORNI[settimana]} ${g} ${NOMI_MESI[m - 1]} ${a}`;
}

const quando = (iso) => (iso
  ? new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');

/** Aspetta che l'utente smetta di scrivere prima di interrogare il server. */
function attendi(fn, ritardo = 300) {
  let timer;
  return (...argomenti) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...argomenti), ritardo);
  };
}

function tabella(intestazioni, righe) {
  const contenitore = nodo('div', 'tabella-contenitore');
  const tab = nodo('table');

  const thead = nodo('thead');
  const trTesta = nodo('tr');
  intestazioni.forEach((t) => trTesta.append(nodo('th', null, t)));
  thead.append(trTesta);

  const tbody = nodo('tbody');
  for (const celle of righe) {
    const tr = nodo('tr');
    for (const cella of celle) {
      const td = nodo('td');
      if (cella instanceof Node) td.append(cella);
      else if (cella && typeof cella === 'object') {
        td.className = cella.classe || '';
        if (cella.nodo) td.append(cella.nodo); else td.textContent = String(cella.testo ?? '');
      } else {
        td.textContent = String(cella ?? '');
      }
      tr.append(td);
    }
    tbody.append(tr);
  }

  tab.append(thead, tbody);
  contenitore.append(tab);
  return contenitore;
}

const vuoto = (messaggio) => nodo('div', 'avviso info', messaggio);

const etichetta = (stato, testo) => nodo('span', `etichetta ${stato}`, testo || stato);

// ---- Accesso ---------------------------------------------------------------

let utenteAttivo = null;

/** Una sola delle tre schermate per volta: accesso, cambio password, pannello. */
function mostraSchermata(quale) {
  for (const [id, nome] of [['#accesso', 'accesso'], ['#primo-ingresso', 'password'], ['#pannello', 'pannello']]) {
    $(id).classList.toggle('nascosto', nome !== quale);
  }
}

function mostraPannello(utente) {
  utenteAttivo = utente || null;

  // Con la password provvisoria il pannello non si apre nemmeno.
  if (utente?.deve_cambiare_password) return chiediNuovaPassword();

  mostraSchermata('pannello');
  $('#utente-attivo').textContent = utente?.nome || utente?.email || '';

  // La gestione degli accessi la vede solo il medico: alla segreteria la
  // scheda non compare proprio, cosi' non ci sono bottoni che danno errore.
  const medico = utente?.ruolo === 'admin';
  $$('[data-solo-medico]').forEach((el) => { el.hidden = !medico; });
}

function chiediNuovaPassword() {
  mostraSchermata('password');
  $('#pwd-attuale').focus();
}

function esci(messaggio) {
  token = '';
  utenteAttivo = null;
  localStorage.removeItem(CHIAVE_TOKEN);
  mostraSchermata('accesso');
  if (messaggio) avvisa(messaggio, 'errore');
}

function collegaAccesso() {
  const form = $('#form-accesso');
  const errore = $('#acc-password').closest('.campo');

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const pulsante = $('button[type="submit"]', form);
    pulsante.disabled = true;
    pulsante.textContent = 'Attendi…';
    errore.classList.remove('errore');

    try {
      const dati = await api('/auth/login', {
        method: 'POST',
        body: { email: $('#acc-email').value, password: $('#acc-password').value }
      });
      token = dati.token;
      localStorage.setItem(CHIAVE_TOKEN, token);
      $('#acc-password').value = '';
      mostraPannello(dati.utente);
      if (!dati.utente?.deve_cambiare_password) {
        await riempiAmbulatori();
        apriScheda('riepilogo');
      }
    } catch (err) {
      errore.classList.add('errore');
      $('.messaggio-errore', errore).textContent = err.message;
    } finally {
      pulsante.disabled = false;
      pulsante.textContent = 'Entra';
    }
  });

  $('#esci').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* la sessione locale va comunque chiusa */ }
    esci();
  });
}

function collegaCambioPassword() {
  const form = $('#form-password');
  const errore = $('#pwd-ripeti').closest('.campo');

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const pulsante = $('button[type="submit"]', form);
    const nuova = $('#pwd-nuova').value;
    errore.classList.remove('errore');

    // Il controllo che il server non puo' fare: vede una password sola.
    if (nuova !== $('#pwd-ripeti').value) {
      errore.classList.add('errore');
      $('.messaggio-errore', errore).textContent = 'Le due password non coincidono.';
      return;
    }

    pulsante.disabled = true;
    pulsante.textContent = 'Attendi…';
    try {
      await api('/auth/password', {
        method: 'POST',
        body: { attuale: $('#pwd-attuale').value, nuova }
      });
      form.reset();
      utenteAttivo = { ...utenteAttivo, deve_cambiare_password: false };
      avvisa('Password aggiornata. Da adesso la conosci solo tu.', 'ok');
      mostraPannello(utenteAttivo);
      await riempiAmbulatori();
      apriScheda('riepilogo');
    } catch (err) {
      errore.classList.add('errore');
      $('.messaggio-errore', errore).textContent = err.message;
    } finally {
      pulsante.disabled = false;
      pulsante.textContent = 'Salva e continua';
    }
  });
}

// ---- Schede ----------------------------------------------------------------

const CARICATORI = {
  riepilogo: caricaRiepilogo,
  prenotazioni: caricaPrenotazioni,
  medicine: caricaMedicine,
  email: caricaEmail,
  pazienti: caricaPazienti,
  collaboratori: caricaCollaboratori,
  sistema: caricaSistema
};

function apriScheda(nome) {
  // Un indirizzo con #collaboratori non deve aprire nulla alla segreteria.
  const bottone = $(`#schede button[data-scheda="${nome}"]`);
  if (!CARICATORI[nome] || bottone?.hidden) nome = 'riepilogo';

  $$('#schede button').forEach((b) => b.classList.toggle('attiva', b.dataset.scheda === nome));
  $$('[data-pannello]').forEach((s) => s.classList.toggle('nascosto', s.dataset.pannello !== nome));
  location.hash = nome;
  protetto(CARICATORI[nome]);
}

// ---- Riepilogo -------------------------------------------------------------

async function caricaRiepilogo() {
  const { riepilogo, agenda_oggi } = await api('/admin/riepilogo');

  const voci = [
    ['Visite oggi', riepilogo.prenotazioni_oggi],
    ['Visite future', riepilogo.prenotazioni_future],
    ['Medicinali da evadere', riepilogo.medicine_da_evadere],
    ['Email da leggere', riepilogo.email_da_leggere],
    ['Pazienti in archivio', riepilogo.pazienti],
    ['Consegne in attesa', riepilogo.consegne_in_attesa]
  ];

  $('#numeri').replaceChildren(...voci.map(([didascalia, valore]) => {
    const carta = nodo('div', 'carta riquadro-numero');
    carta.append(nodo('div', 'numero', valore), nodo('div', 'didascalia', didascalia));
    return carta;
  }));

  const agenda = $('#agenda-oggi');
  if (!agenda_oggi.length) {
    agenda.replaceChildren(vuoto(`Nessuna visita in programma per ${dataEstesa(oggiISO())}.`));
    return;
  }

  agenda.replaceChildren(tabella(
    ['Ora', 'Paziente', 'Telefono', 'Ambulatorio', 'Motivo', 'Codice'],
    agenda_oggi.map((p) => [
      `${p.ora_inizio}–${p.ora_fine}`,
      `${p.nome} ${p.cognome}`,
      { nodo: collegamentoTelefono(p.telefono) },
      p.ambulatorio_nome,
      p.problema,
      { testo: p.codice, classe: 'codice' }
    ])
  ));
}

function collegamentoTelefono(numero) {
  const a = nodo('a', null, numero || '—');
  if (numero) a.href = `tel:${String(numero).replace(/\s/g, '')}`;
  return a;
}

// ---- Prenotazioni ----------------------------------------------------------

async function caricaPrenotazioni() {
  const parametri = new URLSearchParams();
  const aggiungi = (chiave, valore) => { if (valore) parametri.set(chiave, valore); };
  aggiungi('dal', $('#pren-dal').value);
  aggiungi('al', $('#pren-al').value);
  aggiungi('stato', $('#pren-stato').value);
  aggiungi('ambulatorio_id', $('#pren-ambulatorio').value);
  aggiungi('cerca', $('#pren-cerca').value.trim());

  const { prenotazioni, totale } = await api(`/admin/prenotazioni?${parametri}`);
  const contenitore = $('#elenco-prenotazioni');

  if (!prenotazioni.length) {
    contenitore.replaceChildren(vuoto('Nessuna prenotazione con questi filtri.'));
    return;
  }

  const righe = prenotazioni.map((p) => [
    { testo: p.codice, classe: 'codice' },
    `${dataBreve(p.data)} ${p.ora_inizio}`,
    `${p.paziente_nome} ${p.paziente_cognome}`,
    { nodo: collegamentoTelefono(p.paziente_telefono) },
    p.ambulatorio_nome,
    p.problema,
    { nodo: etichetta(p.stato) },
    { nodo: p.stato === 'confermata' ? pulsanteAnnulla(p.codice) : nodo('span', 'tenue piccolo', '—') }
  ]);

  contenitore.replaceChildren(
    nodo('p', 'piccolo tenue', `${totale} prenotazioni trovate.`),
    tabella(['Codice', 'Quando', 'Paziente', 'Telefono', 'Ambulatorio', 'Motivo', 'Stato', ''], righe)
  );
}

function pulsanteAnnulla(codice) {
  const b = nodo('button', 'bottone pericolo piccolo', 'Annulla');
  b.type = 'button';
  b.addEventListener('click', () => {
    if (!confirm(`Annullare la prenotazione ${codice}? Il paziente riceverà un avviso.`)) return;
    b.disabled = true;
    protetto(async () => {
      await api(`/admin/prenotazioni/${codice}/annulla`, { method: 'POST' });
      avvisa('Prenotazione annullata.', 'ok');
      await caricaPrenotazioni();
    });
  });
  return b;
}

// ---- Medicinali ------------------------------------------------------------

async function caricaMedicine() {
  const parametri = new URLSearchParams();
  if ($('#med-stato').value) parametri.set('stato', $('#med-stato').value);
  if ($('#med-cerca').value.trim()) parametri.set('cerca', $('#med-cerca').value.trim());

  const { richieste, totale } = await api(`/admin/medicine?${parametri}`);
  const contenitore = $('#elenco-medicine');

  if (!richieste.length) {
    contenitore.replaceChildren(vuoto('Nessuna richiesta con questi filtri.'));
    return;
  }

  const righe = richieste.map((r) => {
    const farmaci = nodo('div', null, r.farmaci);
    farmaci.style.whiteSpace = 'pre-line';
    return [
      { testo: r.codice, classe: 'codice' },
      quando(r.creata_il),
      `${r.nome} ${r.cognome}`,
      { nodo: collegamentoTelefono(r.telefono) },
      { nodo: farmaci },
      r.ambulatorio_nome || '—',
      { nodo: selettoreStatoMedicine(r) }
    ];
  });

  contenitore.replaceChildren(
    nodo('p', 'piccolo tenue', `${totale} richieste trovate.`),
    tabella(['Codice', 'Ricevuta', 'Paziente', 'Telefono', 'Medicinali', 'Ritiro', 'Stato'], righe)
  );
}

function selettoreStatoMedicine(r) {
  const select = nodo('select');
  for (const [valore, testo] of Object.entries(ETICHETTE_MEDICINE)) {
    const opzione = nodo('option', null, testo);
    opzione.value = valore;
    if (valore === r.stato) opzione.selected = true;
    select.append(opzione);
  }
  select.addEventListener('change', () => {
    const nuovo = select.value;
    select.disabled = true;
    protetto(async () => {
      await api(`/admin/medicine/${r.codice}`, { method: 'PATCH', body: { stato: nuovo } });
      avvisa(`${r.codice}: ${ETICHETTE_MEDICINE[nuovo]}.`, 'ok');
      await caricaMedicine();
    });
  });
  return select;
}

// ---- Email ricevute --------------------------------------------------------

async function caricaEmail() {
  const parametri = new URLSearchParams();
  if ($('#mail-stato').value) parametri.set('stato', $('#mail-stato').value);

  const { email, totale } = await api(`/admin/email?${parametri}`);
  const contenitore = $('#elenco-email');

  if (!email.length) {
    contenitore.replaceChildren(vuoto('Nessuna email in questa vista.'));
    return;
  }

  contenitore.replaceChildren(
    nodo('p', 'piccolo tenue', `${totale} email.`),
    ...email.map(schedaEmail)
  );
}

const TIPI_EMAIL = { prenotazione: '📅 Prenotazione', medicina: '💊 Medicinali', altro: '✉️ Altro' };

function schedaEmail(m) {
  const carta = nodo('div', 'carta');

  const testata = nodo('div');
  testata.style.cssText = 'display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between';
  const sinistra = nodo('div');
  sinistra.append(
    nodo('strong', null, m.oggetto || '(senza oggetto)'),
    nodo('div', 'piccolo tenue', `${m.mittente_nome ? `${m.mittente_nome} · ` : ''}${m.mittente} · ${quando(m.ricevuta_il)}`)
  );
  const destra = nodo('div');
  destra.style.cssText = 'display:flex;gap:.4rem;align-items:center';
  destra.append(nodo('span', 'etichetta', TIPI_EMAIL[m.tipo] || m.tipo), etichetta(m.stato));
  testata.append(sinistra, destra);
  carta.append(testata);

  const corpo = nodo('div', 'piccolo', m.corpo);
  corpo.style.cssText = 'white-space:pre-line;margin-top:.85rem;max-height:11rem;overflow:auto;' +
    'background:var(--sfondo);padding:.75rem;border-radius:8px';
  carta.append(corpo);

  if (m.collegata_a) {
    carta.append(nodo('p', 'piccolo tenue', `Richiesta generata: ${m.collegata_a}`));
  }

  const azioni = nodo('div');
  azioni.style.cssText = 'display:flex;gap:.5rem;margin-top:.85rem;flex-wrap:wrap';
  for (const [stato, testo] of [['gestita', 'Segna come gestita'], ['archiviata', 'Archivia'], ['nuova', 'Rimetti da leggere']]) {
    if (m.stato === stato) continue;
    const b = nodo('button', 'bottone secondario piccolo', testo);
    b.type = 'button';
    b.addEventListener('click', () => {
      b.disabled = true;
      protetto(async () => {
        await api(`/admin/email/${m.codice}`, { method: 'PATCH', body: { stato } });
        await caricaEmail();
      });
    });
    azioni.append(b);
  }
  carta.append(azioni);
  return carta;
}

// ---- Pazienti --------------------------------------------------------------

async function caricaPazienti() {
  const cerca = $('#paz-cerca').value.trim();
  const { pazienti } = await api(`/admin/pazienti?${new URLSearchParams(cerca ? { cerca } : {})}`);
  const contenitore = $('#elenco-pazienti');

  if (!pazienti.length) {
    contenitore.replaceChildren(vuoto('Nessun paziente trovato.'));
    return;
  }

  contenitore.replaceChildren(tabella(
    ['Cognome e nome', 'Telefono', 'Email', 'Visite'],
    pazienti.map((p) => [
      `${p.cognome} ${p.nome}`,
      { nodo: collegamentoTelefono(p.telefono) },
      p.email || '—',
      p.visite
    ])
  ));
}

// ---- Collaboratori ---------------------------------------------------------

const NOMI_RUOLO = { admin: 'Medico', segretaria: 'Segreteria' };

/**
 * La password provvisoria si vede una volta sola: nel database ne resta solo
 * l'impronta. Quindi va mostrata bene, con il pulsante per copiarla, e detto
 * chiaramente che ricaricando la pagina sparisce.
 */
function mostraPasswordProvvisoria(utente, password) {
  const box = nodo('div', 'avviso ok');
  box.append(nodo('strong', null, `Accesso pronto per ${utente.nome || utente.email}`));
  box.append(nodo('p', 'piccolo', 'Consegnagli queste due righe. La password compare adesso e mai più: '
    + 'se la perdi puoi generarne un\'altra, non recuperarla.'));

  const credenziali = nodo('p');
  credenziali.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'background:#fff;border:1px solid var(--bordo);border-radius:8px;padding:.7rem .9rem;'
    + 'word-break:break-all;margin:.6rem 0';
  credenziali.append(nodo('span', null, utente.email), nodo('br'), nodo('strong', null, password));
  box.append(credenziali);

  const copia = nodo('button', 'bottone secondario piccolo', 'Copia password');
  copia.type = 'button';
  copia.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(password);
      copia.textContent = 'Copiata';
    } catch {
      avvisa(`La password è ${password}`, 'ok');
    }
  });

  const azioni = nodo('div', 'azioni');
  azioni.append(copia);
  box.append(azioni);

  $('#esito-collaboratore').replaceChildren(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function azioniCollaboratore(u) {
  const gruppo = nodo('div', 'azioni');
  const io = u.email === (utenteAttivo?.email || '');

  // Su se stessi il server rifiuta comunque: qui i pulsanti non compaiono
  // proprio, cosi' nessuno prova a chiudersi fuori da solo.
  if (io) {
    gruppo.append(nodo('span', 'piccolo tenue', 'sei tu'));
    return gruppo;
  }

  const bottone = (testo, classe, azione, conferma) => {
    const b = nodo('button', `bottone ${classe} piccolo`, testo);
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (conferma && !confirm(conferma)) return;
      b.disabled = true;
      await protetto(async () => {
        const esito = await azione();
        if (esito?.password_provvisoria) {
          mostraPasswordProvvisoria(esito.utente, esito.password_provvisoria);
        }
        await caricaCollaboratori();
      });
      b.disabled = false;
    });
    return b;
  };

  gruppo.append(bottone(
    u.attivo ? 'Sospendi' : 'Riattiva',
    'secondario',
    () => api(`/admin/utenti/${u.id}`, { method: 'PATCH', body: { attivo: !u.attivo } }),
    u.attivo ? `Sospendere l'accesso di ${u.nome || u.email}? Non potrà più entrare.` : null
  ));

  gruppo.append(bottone(
    'Nuova password',
    'secondario',
    () => api(`/admin/utenti/${u.id}/password`, { method: 'POST' }),
    `Generare una nuova password provvisoria per ${u.nome || u.email}? Quella attuale smetterà di funzionare.`
  ));

  gruppo.append(bottone(
    'Elimina',
    'pericolo',
    () => api(`/admin/utenti/${u.id}`, { method: 'DELETE' }),
    `Eliminare definitivamente l'accesso di ${u.nome || u.email}?`
  ));

  return gruppo;
}

async function caricaCollaboratori() {
  const { utenti } = await api('/admin/utenti');
  const contenitore = $('#elenco-collaboratori');

  if (!utenti.length) {
    contenitore.replaceChildren(vuoto('Nessun collaboratore.'));
    return;
  }

  contenitore.replaceChildren(tabella(
    ['Nome', 'Email', 'Cosa può fare', 'Stato', 'Ultimo ingresso', 'Azioni'],
    utenti.map((u) => [
      u.nome || '—',
      u.email,
      NOMI_RUOLO[u.ruolo] || u.ruolo,
      {
        nodo: u.attivo
          ? etichetta(u.deve_cambiare_password ? 'nuova' : 'confermata',
            u.deve_cambiare_password ? 'da attivare' : 'attivo')
          : etichetta('annullata', 'sospeso')
      },
      u.ultimo_accesso ? quando(u.ultimo_accesso) : 'mai',
      { nodo: azioniCollaboratore(u) }
    ])
  ));
}

function collegaCollaboratori() {
  const form = $('#form-collaboratore');

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const pulsante = $('button[type="submit"]', form);
    pulsante.disabled = true;

    await protetto(async () => {
      const esito = await api('/admin/utenti', {
        method: 'POST',
        body: {
          nome: $('#col-nome').value.trim(),
          email: $('#col-email').value.trim(),
          ruolo: $('#col-ruolo').value
        }
      });
      form.reset();
      mostraPasswordProvvisoria(esito.utente, esito.password_provvisoria);
      await caricaCollaboratori();
    });

    pulsante.disabled = false;
  });
}

// ---- Stato del sistema -----------------------------------------------------

async function caricaSistema() {
  const { coda, email, foglio, casella } = await api('/admin/sistema');
  const contenitore = $('#stato-sistema');

  const servizio = (titolo, attivo, dettaglio) => {
    const carta = nodo('div', 'carta');
    const riga = nodo('div');
    riga.style.cssText = 'display:flex;gap:.6rem;align-items:center;justify-content:space-between';
    riga.append(nodo('strong', null, titolo),
      nodo('span', `etichetta ${attivo ? 'confermata' : 'annullata'}`, attivo ? 'attivo' : 'non attivo'));
    carta.append(riga);
    if (dettaglio) carta.append(nodo('p', 'piccolo tenue', dettaglio));
    return carta;
  };

  const griglia = nodo('div', 'griglia tre');
  griglia.append(
    servizio('Invio email', email.ok, email.ok ? 'Collegamento verificato.' : email.motivo),
    servizio('Foglio Google', foglio.ok, foglio.ok ? `Foglio "${foglio.titolo}"` : foglio.motivo),
    servizio('Lettura casella Gmail', casella.attivo,
      casella.mai_eseguito
        ? 'Mai eseguita.'
        : `Ultimo controllo ${quando(casella.quando)} · ${casella.ok ? `${casella.nuove ?? 0} nuove` : casella.motivo}`)
  );

  const cartaCoda = nodo('div', 'carta');
  cartaCoda.append(nodo('h3', null, 'Coda delle consegne'));
  cartaCoda.append(nodo('p', 'piccolo tenue',
    'Email e righe del Foglio Google passano da qui. Se un servizio è spento restano in attesa e partono da sole: non si perde nulla.'));

  const numeri = nodo('div', 'griglia tre');
  for (const [chiave, didascalia] of [
    ['in_attesa', 'In attesa'], ['in_difficolta', 'Che faticano'], ['scartati', 'Scartate']
  ]) {
    const c = nodo('div', 'carta riquadro-numero');
    c.append(nodo('div', 'numero', coda[chiave] ?? 0), nodo('div', 'didascalia', didascalia));
    numeri.append(c);
  }
  cartaCoda.append(numeri);

  if (coda.problemi?.length) {
    cartaCoda.append(nodo('h3', null, 'Consegne che non riescono a partire'));
    cartaCoda.append(tabella(
      ['Tipo', 'Tentativi', 'Ultimo errore', 'In coda dal'],
      coda.problemi.map((p) => [p.tipo, p.tentativi, p.ultimo_errore || '—', quando(p.creato_il)])
    ));
  }

  const riprova = nodo('button', 'bottone', 'Riprova subito le consegne in attesa');
  riprova.type = 'button';
  riprova.style.marginTop = '1rem';
  riprova.addEventListener('click', () => {
    riprova.disabled = true;
    protetto(async () => {
      const { rimesse_in_coda } = await api('/admin/sistema/riprova-consegne', { method: 'POST' });
      avvisa(`${rimesse_in_coda} consegne rimesse in coda.`, 'ok');
      await caricaSistema();
    });
  });
  cartaCoda.append(riprova);

  contenitore.replaceChildren(griglia, cartaCoda);
}

// ---- Avvio -----------------------------------------------------------------

async function riempiAmbulatori() {
  const { ambulatori } = await api('/ambulatori');
  const select = $('#pren-ambulatorio');
  const tutti = nodo('option', null, 'Tutti');
  tutti.value = '';
  select.replaceChildren(tutti);
  for (const a of ambulatori) {
    const opzione = nodo('option', null, a.nome);
    opzione.value = a.id;
    select.append(opzione);
  }
}

function collegaFiltri() {
  const ricarica = attendi(() => protetto(caricaPrenotazioni));
  ['#pren-dal', '#pren-al', '#pren-stato', '#pren-ambulatorio'].forEach((s) =>
    $(s).addEventListener('change', ricarica));
  $('#pren-cerca').addEventListener('input', ricarica);
  $('#pren-azzera').addEventListener('click', () => {
    ['#pren-dal', '#pren-al', '#pren-stato', '#pren-ambulatorio', '#pren-cerca'].forEach((s) => { $(s).value = ''; });
    protetto(caricaPrenotazioni);
  });

  const ricaricaMedicine = attendi(() => protetto(caricaMedicine));
  $('#med-stato').addEventListener('change', ricaricaMedicine);
  $('#med-cerca').addEventListener('input', ricaricaMedicine);

  $('#mail-stato').addEventListener('change', () => protetto(caricaEmail));
  $('#mail-controlla').addEventListener('click', (e) => {
    e.target.disabled = true;
    protetto(async () => {
      const { esito } = await api('/admin/email/controlla', { method: 'POST' });
      avvisa(esito?.saltato
        ? 'Un controllo era già in corso.'
        : `Controllo eseguito: ${esito?.nuove ?? 0} nuove email.`, 'ok');
      await caricaEmail();
    }).finally(() => { e.target.disabled = false; });
  });

  $('#paz-cerca').addEventListener('input', attendi(() => protetto(caricaPazienti)));
}

async function avvia() {
  collegaAccesso();
  collegaCambioPassword();
  collegaCollaboratori();
  collegaFiltri();

  $('#schede').addEventListener('click', (evento) => {
    const scheda = evento.target.closest('button[data-scheda]');
    if (scheda) apriScheda(scheda.dataset.scheda);
  });

  if (!token) return;

  try {
    const { utente } = await api('/auth/me');
    mostraPannello(utente);
    if (utente?.deve_cambiare_password) return;
    await riempiAmbulatori();
    apriScheda(location.hash.slice(1) || 'riepilogo');
  } catch {
    esci();
  }
}

avvia();
