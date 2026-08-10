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
  nuova: 'Da vedere',
  confermata: 'Confermata',
  rifiutata: 'Rifiutata',
  consegnata: 'Consegnata'
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
  moduli: caricaModuli,
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

  // Il numerino sulla linguetta si aggiorna a ogni passaggio da "Oggi": chi
  // apre lo studio vede subito se c'e' arretrato da confermare.
  aggiornaContatoreModuli(riepilogo.moduli_da_confermare);

  // Ogni numero porta dove quel numero si spiega, con il filtro gia' messo:
  // leggere "3 medicinali da evadere" e poi doverli cercare a mano fra tutti e
  // duecento e' esattamente il lavoro che il riepilogo dovrebbe risparmiare.
  const voci = [
    ['Visite oggi', riepilogo.prenotazioni_oggi, {
      scheda: 'prenotazioni',
      filtri: { '#pren-dal': oggiISO(), '#pren-al': oggiISO(), '#pren-stato': 'confermata', '#pren-cerca': '' }
    }],
    ['Da confermare', riepilogo.moduli_da_confermare, {
      scheda: 'moduli', filtri: { '#mod-stato': 'nuova' }
    }],
    ['Visite future', riepilogo.prenotazioni_future, {
      scheda: 'prenotazioni',
      filtri: { '#pren-dal': oggiISO(), '#pren-al': '', '#pren-stato': 'confermata', '#pren-cerca': '' }
    }],
    ['Medicinali da evadere', riepilogo.medicine_da_evadere, {
      scheda: 'medicine', filtri: { '#med-stato': 'nuova' }
    }],
    ['Email da leggere', riepilogo.email_da_leggere, {
      scheda: 'email', filtri: { '#mail-stato': 'nuova' }
    }],
    ['Pazienti in archivio', riepilogo.pazienti, {
      scheda: 'pazienti', filtri: { '#paz-cerca': '' }
    }],
    ['Consegne in attesa', riepilogo.consegne_in_attesa, { scheda: 'sistema' }]
  ];

  $('#numeri').replaceChildren(...voci.map(([didascalia, valore, vai]) => {
    const carta = nodo('button', 'carta riquadro-numero');
    carta.type = 'button';
    carta.append(nodo('div', 'numero', valore), nodo('div', 'didascalia', didascalia));

    // La scheda dei collaboratori e' nascosta alla segreteria, e allo stesso
    // modo un riquadro non deve portare dove chi guarda non puo' entrare.
    const linguetta = $(`#schede button[data-scheda="${vai.scheda}"]`);
    if (!linguetta || linguetta.hidden) return carta;

    carta.style.cursor = 'pointer';
    carta.title = `Apri ${didascalia.toLowerCase()}`;
    carta.addEventListener('click', () => {
      for (const [selettore, valoreFiltro] of Object.entries(vai.filtri || {})) {
        const campo = $(selettore);
        if (campo) campo.value = valoreFiltro;
      }
      apriScheda(vai.scheda);
    });
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

// ---- Pezzi di modulo in comune ---------------------------------------------

// Riempito una volta all'accesso: gli ambulatori non cambiano durante il turno.
let ambulatoriNoti = [];

function scegliAmbulatorio(selezionato) {
  const el = nodo('select');
  for (const a of ambulatoriNoti) {
    const opzione = nodo('option', null, a.nome);
    opzione.value = a.id;
    if (a.id === selezionato) opzione.selected = true;
    el.append(opzione);
  }
  return el;
}

/**
 * Dove si ritira una ricetta. Quasi sempre in farmacia, ed e' il valore
 * predefinito: al paziente non lo si chiede nemmeno piu'. Resta la possibilita'
 * di indicare un ambulatorio per i casi particolari, ma la sceglie lo studio
 * quando conferma, non il paziente quando chiede.
 */
function scegliRitiro(selezionato) {
  const el = nodo('select');
  const farmacia = nodo('option', null, 'In farmacia');
  farmacia.value = '';
  if (!selezionato) farmacia.selected = true;
  el.append(farmacia);

  for (const a of ambulatoriNoti) {
    const opzione = nodo('option', null, `Ritiro in ${a.nome}`);
    opzione.value = a.id;
    if (a.id === selezionato) opzione.selected = true;
    el.append(opzione);
  }
  return el;
}

/** Nome, cognome, telefono, email: identici per una visita e per i medicinali. */
function campiPaziente() {
  const campi = {
    nome: inputTesto('', 'Nome'),
    cognome: inputTesto('', 'Cognome'),
    telefono: inputTesto('', '333 1234567'),
    email: inputTesto('', 'nome@esempio.it')
  };
  campi.telefono.type = 'tel';
  campi.email.type = 'email';

  const riga = nodo('div', 'filtri');
  riga.append(
    campoModulo('Nome', campi.nome),
    campoModulo('Cognome', campi.cognome),
    campoModulo('Telefono', campi.telefono),
    campoModulo('Email', campi.email)
  );
  return { campi, riga };
}

/**
 * Il pezzo di modulo che sceglie il quando: ambulatorio, giorno, ora.
 *
 * Di norma propone soltanto gli orari davvero liberi, cosi' allo sportello non
 * si promette un posto che non c'e'. La spunta "orario mio" apre un campo
 * libero e insieme accende la forzatura: sono la stessa decisione — "lo metto
 * dove dico io" — quindi e' giusto che siano un gesto solo. Da quel momento in
 * poi il riquadro sotto dice a voce alta che cosa si sta scavalcando: giornata
 * di chiusura, fuori orario, data passata.
 */
function selettoreQuando(iniziale = {}) {
  const ambulatorio = scegliAmbulatorio(iniziale.ambulatorio_id);

  const giorno = nodo('input');
  giorno.type = 'date';
  giorno.value = iniziale.data || oggiISO();

  const elenco = nodo('select');
  const manuale = nodo('input');
  manuale.type = 'time';
  manuale.step = 900;
  manuale.value = iniziale.ora || '';

  const spunta = nodo('input');
  spunta.type = 'checkbox';
  const etichettaSpunta = nodo('label', 'piccolo');
  etichettaSpunta.style.cssText = 'display:flex;gap:.35rem;align-items:center;white-space:nowrap';
  etichettaSpunta.append(spunta, document.createTextNode('orario mio'));

  const avviso = nodo('div', 'piccolo tenue');
  avviso.style.marginTop = '.4rem';

  async function proponiLiberi() {
    elenco.replaceChildren();
    if (!giorno.value) { avviso.textContent = 'Scegli prima il giorno.'; return; }
    try {
      const { slot } = await api(`/disponibilita?data=${giorno.value}` +
        `&ambulatorio_id=${ambulatorio.value}`);
      const liberi = slot.filter((s) => s.disponibile);
      for (const s of liberi) {
        const opzione = nodo('option', null, `${s.ora_inizio}–${s.ora_fine}`);
        opzione.value = s.ora_inizio;
        if (s.ora_inizio === iniziale.ora) opzione.selected = true;
        elenco.append(opzione);
      }
      avviso.textContent = liberi.length
        ? `${liberi.length} orari liberi.`
        : 'Nessun orario libero in questa giornata: se serve, spunta "orario mio".';
    } catch (err) {
      avviso.textContent = err.message;
    }
  }

  async function mostraAvvertimenti() {
    if (!manuale.value) { avviso.textContent = 'Scrivi l\'orario.'; return; }
    const parametri = new URLSearchParams({
      data: giorno.value, ora_inizio: manuale.value, ambulatorio_id: ambulatorio.value
    });
    try {
      const { avvertimenti } = await api(`/admin/prenotazioni/avvertimenti?${parametri}`);
      avviso.textContent = avvertimenti.length
        ? avvertimenti.join(' ')
        : 'Orario insolito ma senza problemi.';
      avviso.className = avvertimenti.length ? 'avviso info piccolo' : 'piccolo tenue';
    } catch (err) {
      avviso.textContent = err.message;
    }
  }

  const ridisegna = () => {
    elenco.classList.toggle('nascosto', spunta.checked);
    manuale.classList.toggle('nascosto', !spunta.checked);
    avviso.className = 'piccolo tenue';
    if (spunta.checked) mostraAvvertimenti(); else proponiLiberi();
  };

  /**
   * Il modulo si apre quasi sempre a giornata iniziata, spesso a studio chiuso.
   * Partendo da oggi la tendina degli orari resta vuota — gli orari di oggi sono
   * gia' passati — e da fuori sembra un campo che non si riesce a selezionare,
   * non una giornata senza posti. Quindi si parte dal primo giorno che un posto
   * libero ce l'ha davvero.
   *
   * Vale solo quando si apre un modulo nuovo: se stiamo modificando una
   * prenotazione che esiste, il suo giorno non si tocca.
   */
  async function partiDaUnGiornoUtile() {
    if (iniziale.data) return;
    try {
      const { giorni } = await api(`/calendario?ambulatorio_id=${ambulatorio.value}`);
      const utile = (giorni || []).find((g) => g.liberi > 0);
      if (utile && utile.data !== giorno.value) {
        giorno.value = utile.data;
        proponiLiberi();
      }
    } catch { /* se non risponde resta oggi: lo dice gia' l'avviso */ }
  }

  [spunta, giorno, ambulatorio, manuale].forEach((el) => el.addEventListener('change', ridisegna));
  ridisegna();
  partiDaUnGiornoUtile();

  const riquadroOra = nodo('div');
  riquadroOra.style.cssText = 'display:flex;gap:.5rem;align-items:center';
  riquadroOra.append(elenco, manuale, etichettaSpunta);

  const riga = nodo('div', 'filtri');
  riga.append(
    campoModulo('Ambulatorio', ambulatorio),
    campoModulo('Giorno', giorno),
    campoModulo('Orario', riquadroOra)
  );

  return {
    riga,
    avviso,
    valori: () => ({
      ambulatorio_id: Number(ambulatorio.value),
      data: giorno.value,
      ora_inizio: spunta.checked ? manuale.value : elenco.value,
      forza: spunta.checked
    })
  };
}

/** Apre e chiude un modulo di inserimento sotto il bottone "+ Aggiungi". */
function apriChiudi(contenitore, costruisci) {
  if (contenitore.firstChild) { contenitore.replaceChildren(); return; }
  contenitore.replaceChildren(costruisci(() => contenitore.replaceChildren()));
  contenitore.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- Prenotazioni ----------------------------------------------------------

/**
 * Prenotazione presa al telefono e scritta a mano dallo studio.
 *
 * Vale la pena ricordarlo qui: al paziente arriva la stessa email di conferma
 * che riceverebbe prenotando dal sito. Chi la scrive deve saperlo mentre la
 * scrive, non scoprirlo dopo — per questo l'email e' un campo obbligatorio e
 * il bottone si chiama "Crea e avvisa".
 */
function moduloNuovaPrenotazione(chiudi) {
  const carta = nodo('div', 'carta');
  carta.append(nodo('strong', null, '📅 Nuova prenotazione'));
  carta.append(nodo('p', 'piccolo tenue',
    'Al paziente arriva la solita email di conferma, con il codice per disdire.'));

  const { campi, riga } = campiPaziente();
  const quando = selettoreQuando();
  const problema = inputTesto('', 'Motivo della visita');

  const rigaMotivo = nodo('div', 'filtri');
  rigaMotivo.append(campoModulo('Motivo', problema));

  carta.append(riga, quando.riga, quando.avviso, rigaMotivo);

  const azioni = nodo('div', 'azioni');
  const salva = nodo('button', 'bottone', 'Crea e avvisa il paziente');
  salva.type = 'button';
  salva.addEventListener('click', () => {
    salva.disabled = true;
    protetto(async () => {
      try {
        const { prenotazione } = await api('/admin/prenotazioni', {
          method: 'POST',
          body: {
            nome: campi.nome.value, cognome: campi.cognome.value,
            telefono: campi.telefono.value, email: campi.email.value,
            problema: problema.value, ...quando.valori()
          }
        });
        avvisa(`Prenotata: ${prenotazione.codice}. Al paziente parte l'email.`, 'ok');
        chiudi();
        await caricaPrenotazioni();
      } finally {
        salva.disabled = false;
      }
    });
  });

  const esci = nodo('button', 'bottone secondario', 'Chiudi');
  esci.type = 'button';
  esci.addEventListener('click', chiudi);

  azioni.append(salva, esci);
  carta.append(azioni);
  return carta;
}

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

  contenitore.replaceChildren(
    nodo('p', 'piccolo tenue', `${totale} prenotazioni trovate.`),
    ...prenotazioni.map(schedaPrenotazione)
  );
}

/**
 * Una scheda per appuntamento, come per i medicinali, e per lo stesso motivo:
 * annullare e spostare fanno partire un'email al paziente, e una riga di
 * tabella con due bottoncini in fondo li fa sembrare due click qualsiasi.
 *
 * "Riprogrammata" e' un'etichetta, non uno stato salvato: nel database la
 * prenotazione spostata resta 'confermata', altrimenti sparirebbe dall'agenda,
 * dai promemoria e dai conteggi — che filtrano tutti su quel valore — e
 * perderebbe la protezione contro la doppia prenotazione.
 */
function schedaPrenotazione(p) {
  const carta = nodo('div', 'carta');
  const spostata = Boolean(p.riprogrammata_il) && p.stato === 'confermata';

  const testata = nodo('div');
  testata.style.cssText = 'display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between';
  const sinistra = nodo('div');
  sinistra.append(
    nodo('strong', null, `📅 ${p.paziente_nome} ${p.paziente_cognome}`),
    nodo('div', 'piccolo tenue',
      `${dataEstesa(p.data)} alle ${p.ora_inizio} · ${p.ambulatorio_nome} · ${p.codice}`)
  );
  const testoStato = { confermata: 'Confermata', annullata: 'Annullata' }[p.stato] || p.stato;
  testata.append(sinistra, etichetta(p.stato, spostata ? 'Riprogrammata' : testoStato));
  carta.append(testata);

  const recapiti = nodo('div', 'piccolo');
  recapiti.style.marginTop = '.4rem';
  recapiti.append(collegamentoTelefono(p.paziente_telefono));
  recapiti.append(nodo('span', 'tenue', p.paziente_email ? ` · ${p.paziente_email}` : ' · senza email'));
  carta.append(recapiti);

  if (p.problema) {
    const motivo = nodo('div', null, p.problema);
    motivo.style.marginTop = '.5rem';
    carta.append(motivo);
  }

  if (spostata) {
    carta.append(nodo('div', 'piccolo tenue',
      `Spostata il ${quando(p.riprogrammata_il)}${p.riprogrammata_da ? ` da ${p.riprogrammata_da}` : ''} · ` +
      `prima era ${dataBreve(p.data_originale)} alle ${p.ora_originale}`));
  }

  // Annullata: si legge e basta. Riaprirla vorrebbe dire mandare al paziente
  // una seconda email che smentisce la prima.
  if (p.stato !== 'confermata') {
    // Si scrive chi ha annullato per nome quando lo sappiamo. Le prenotazioni
    // annullate prima che esistesse annullata_utente non ce l'hanno, e per
    // quelle resta il vecchio "da admin", che almeno dice il lato.
    const chiHaAnnullato = p.annullata_utente
      || (p.annullata_da === 'admin' ? 'lo studio' : 'il paziente');
    carta.append(nodo('div', 'piccolo tenue',
      `Annullata il ${quando(p.annullata_il)} da ${chiHaAnnullato}`));
    return carta;
  }

  const sposta = nodo('details');
  sposta.style.marginTop = '.75rem';
  sposta.append(nodo('summary', 'piccolo tenue', 'Sposta questo appuntamento'));

  // Il selettore si costruisce solo alla prima apertura: con cinquanta schede
  // aperte tutte insieme sarebbero cinquanta chiamate agli orari liberi.
  let quandoNuovo = null;
  sposta.addEventListener('toggle', () => {
    if (!sposta.open || quandoNuovo) return;
    quandoNuovo = selettoreQuando({
      ambulatorio_id: p.ambulatorio_id, data: p.data, ora: p.ora_inizio
    });
    const conferma = nodo('button', 'bottone', 'Sposta e avvisa il paziente');
    conferma.type = 'button';
    conferma.addEventListener('click', () => {
      conferma.disabled = true;
      protetto(async () => {
        try {
          await api(`/admin/prenotazioni/${p.codice}/riprogramma`,
            { method: 'POST', body: quandoNuovo.valori() });
          avvisa(`${p.codice}: spostata. Al paziente parte l'email con prima e dopo.`, 'ok');
          await caricaPrenotazioni();
        } finally {
          conferma.disabled = false;
        }
      });
    });
    const azioniSposta = nodo('div', 'azioni');
    azioniSposta.append(conferma);
    sposta.append(quandoNuovo.riga, quandoNuovo.avviso, azioniSposta);
  });
  carta.append(sposta);

  const azioni = nodo('div', 'azioni');
  const annulla = nodo('button', 'bottone pericolo', 'Annulla');
  annulla.type = 'button';
  annulla.addEventListener('click', () => {
    if (!confirm(`Annullare la prenotazione ${p.codice}? Il paziente riceverà un'email.`)) return;
    annulla.disabled = true;
    protetto(async () => {
      try {
        await api(`/admin/prenotazioni/${p.codice}/annulla`, { method: 'POST' });
        avvisa(`${p.codice}: annullata. Al paziente parte l'email.`, 'ok');
        await caricaPrenotazioni();
      } finally {
        annulla.disabled = false;
      }
    });
  });
  azioni.append(annulla);
  carta.append(azioni);
  return carta;
}

// ---- Medicinali ------------------------------------------------------------

/**
 * Richiesta di medicinali presa al telefono. Nasce "da vedere" come tutte le
 * altre: anche se la scrive lo studio, resta una richiesta da confermare, non
 * una ricetta gia' pronta. Chi la registra non e' detto sia chi la valuta.
 */
function moduloNuovaMedicina(chiudi) {
  const carta = nodo('div', 'carta');
  carta.append(nodo('strong', null, '💊 Nuova richiesta di medicinali'));
  carta.append(nodo('p', 'piccolo tenue',
    'Entra fra quelle da vedere: la conferma o il rifiuto restano un secondo passaggio.'));

  const { campi, riga } = campiPaziente();
  const farmaci = areaTesto('', 4);
  const note = areaTesto('', 2);
  const ambulatorio = scegliRitiro();

  const riga2 = nodo('div', 'filtri');
  riga2.append(
    campoModulo('Medicinali', farmaci),
    campoModulo('Note', note),
    campoModulo('Ritiro', ambulatorio)
  );
  carta.append(riga, riga2);

  const azioni = nodo('div', 'azioni');
  const salva = nodo('button', 'bottone', 'Registra la richiesta');
  salva.type = 'button';
  salva.addEventListener('click', () => {
    salva.disabled = true;
    protetto(async () => {
      try {
        const { richiesta } = await api('/admin/medicine', {
          method: 'POST',
          body: {
            nome: campi.nome.value, cognome: campi.cognome.value,
            telefono: campi.telefono.value, email: campi.email.value,
            farmaci: farmaci.value, note: note.value,
            ambulatorio_id: Number(ambulatorio.value) || undefined
          }
        });
        avvisa(`Registrata: ${richiesta.codice}. Ora è fra quelle da vedere.`, 'ok');
        chiudi();
        await caricaMedicine();
      } finally {
        salva.disabled = false;
      }
    });
  });

  const esci = nodo('button', 'bottone secondario', 'Chiudi');
  esci.type = 'button';
  esci.addEventListener('click', chiudi);

  azioni.append(salva, esci);
  carta.append(azioni);
  return carta;
}

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

  contenitore.replaceChildren(
    nodo('p', 'piccolo tenue', `${totale} richieste trovate.`),
    ...richieste.map(schedaMedicina)
  );
}

/** Testo lungo che cresce con quello che contiene: gli elenchi di farmaci vanno a capo. */
function areaTesto(valore, righe = 3) {
  const el = nodo('textarea', null, valore ?? '');
  el.rows = righe;
  el.style.cssText = 'width:100%;font:inherit;padding:.5rem;border-radius:8px;' +
    'border:1px solid var(--bordo);resize:vertical';
  return el;
}

/**
 * Una scheda per richiesta, non una riga di tabella con la tendina.
 *
 * La tendina di prima faceva sembrare tutti i passaggi ugualmente possibili e
 * tutti reversibili, mentre ognuno di questi bottoni fa partire un'email al
 * paziente e non si torna indietro. Con i campi scrivibili accanto ai bottoni,
 * la telefonata al paziente e la correzione dei farmaci sono lo stesso gesto.
 */
function schedaMedicina(r) {
  const carta = nodo('div', 'carta');

  const testata = nodo('div');
  testata.style.cssText = 'display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between';
  const sinistra = nodo('div');
  sinistra.append(
    nodo('strong', null, `💊 ${r.nome} ${r.cognome}`),
    nodo('div', 'piccolo tenue', `Arrivata il ${quando(r.creata_il)} · ${r.codice}` +
      (r.origine && r.origine !== 'sito' ? ` · da ${r.origine}` : ''))
  );
  testata.append(sinistra, etichetta(r.stato, ETICHETTE_MEDICINE[r.stato]));
  carta.append(testata);

  const recapiti = nodo('div', 'piccolo');
  recapiti.style.marginTop = '.4rem';
  recapiti.append(collegamentoTelefono(r.telefono));
  recapiti.append(nodo('span', 'tenue', r.email ? ` · ${r.email}` : ' · senza email'));
  carta.append(recapiti);

  // Chi non ha lasciato un'indirizzo non ricevera' nessuna delle tre email:
  // va detto qui, prima di premere, non scoperto dopo.
  if (!r.email) {
    carta.append(nodo('div', 'avviso info piccolo',
      'Questo paziente non ha lasciato un\'email: qualunque risposta gli va data a voce.'));
  }

  // Quello che aveva chiesto lui, se nel frattempo e' stato corretto.
  if (r.farmaci_originali) {
    const prima = nodo('details');
    prima.style.marginTop = '.6rem';
    prima.append(nodo('summary', 'piccolo tenue', 'Aveva chiesto'));
    const testo = nodo('div', 'piccolo', r.farmaci_originali +
      (r.note_originali ? `\n\nNote: ${r.note_originali}` : ''));
    testo.style.cssText = 'white-space:pre-line;margin-top:.5rem;background:var(--sfondo);' +
      'padding:.75rem;border-radius:8px';
    prima.append(testo);
    carta.append(prima);
  }

  const chiusa = r.stato === 'rifiutata' || r.stato === 'consegnata';

  // Chiusa: si legge e basta. Riaprirla vorrebbe dire mandare al paziente una
  // seconda email che contraddice la prima.
  if (chiusa) {
    const testo = nodo('div', null, r.farmaci);
    testo.style.cssText = 'white-space:pre-line;margin-top:.6rem';
    carta.append(testo);
    if (r.note) carta.append(nodo('div', 'piccolo tenue', `Note: ${r.note}`));
    if (r.motivo_rifiuto) carta.append(nodo('div', 'piccolo tenue', `Motivo: ${r.motivo_rifiuto}`));
    carta.append(nodo('div', 'piccolo tenue',
      `${ETICHETTE_MEDICINE[r.stato]} il ${quando(r.gestita_il)}` +
      (r.gestita_da ? ` da ${r.gestita_da}` : '')));
    return carta;
  }

  const campi = { farmaci: areaTesto(r.farmaci, 4), note: areaTesto(r.note, 2) };

  campi.ambulatorio_id = scegliRitiro(r.ambulatorio_id);

  const riga = nodo('div', 'filtri');
  riga.style.marginTop = '.85rem';
  riga.append(
    campoModulo('Medicinali', campi.farmaci),
    campoModulo('Note', campi.note),
    campoModulo('Ritiro', campi.ambulatorio_id)
  );
  carta.append(riga);

  const azioni = nodo('div', 'azioni');
  const tutti = [];

  /** Un bottone che si spegne insieme agli altri finche' il server non risponde. */
  const bottone = (testo, classe, esegui) => {
    const b = nodo('button', `bottone ${classe}`, testo);
    b.type = 'button';
    b.addEventListener('click', () => {
      const corpo = esegui();
      if (corpo === null) return;
      tutti.forEach((x) => { x.disabled = true; });
      protetto(async () => {
        try {
          await api(`/admin/medicine/${r.codice}/${corpo.azione}`,
            { method: 'POST', body: corpo.dati || {} });
          avvisa(corpo.fatto, 'ok');
          await caricaMedicine();
        } finally {
          tutti.forEach((x) => { x.disabled = false; });
        }
      });
    });
    tutti.push(b);
    azioni.append(b);
    return b;
  };

  const avvisata = (verbo) => (r.email
    ? `${r.codice}: ${verbo}. Al paziente parte l'email.`
    : `${r.codice}: ${verbo}. Senza email: avvisalo tu.`);

  if (r.stato === 'nuova') {
    bottone('Conferma così', '', () => ({ azione: 'conferma', fatto: avvisata('confermata') }));
  }

  bottone(r.stato === 'nuova' ? 'Conferma con modifiche' : 'Salva modifiche', 'secondario', () => ({
    azione: 'modifica',
    dati: {
      farmaci: campi.farmaci.value,
      note: campi.note.value,
      ambulatorio_id: Number(campi.ambulatorio_id.value) || undefined
    },
    fatto: avvisata('modificata')
  }));

  if (r.stato === 'nuova') {
    bottone('Rifiuta', 'pericolo', () => {
      const motivo = prompt('Perché non si può fare? Il paziente lo legge nell\'email.');
      if (motivo === null) return null;
      return { azione: 'rifiuta', dati: { motivo }, fatto: avvisata('rifiutata') };
    });
  }

  if (r.stato === 'confermata') {
    bottone('Ritirata', '', () => {
      if (!confirm(`${r.codice}: il paziente è passato a ritirare?`)) return null;
      return { azione: 'consegnata', fatto: `${r.codice}: segnata come consegnata.` };
    });
  }

  carta.append(azioni);
  return carta;
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

  // Il messaggio in Gmail non c'e' piu' in posta in arrivo: il testo qui sopra
  // e' rimasto l'unica copia che non scade. Va detto, non lasciato scoprire.
  if (m.cestinata_il) {
    carta.append(nodo('p', 'piccolo tenue',
      `Messaggio spostato nel cestino di Gmail il ${quando(m.cestinata_il)}. `
      + 'Gmail lo svuota dopo trenta giorni: il testo qui sopra resta comunque.'));
  }

  const azioni = nodo('div');
  azioni.style.cssText = 'display:flex;gap:.5rem;margin-top:.85rem;flex-wrap:wrap';
  for (const [stato, testo] of [['gestita', 'Segna come gestita'], ['archiviata', 'Archivia'], ['nuova', 'Rimetti da leggere']]) {
    if (m.stato === stato) continue;
    const b = nodo('button', 'bottone secondario piccolo', testo);
    b.type = 'button';
    b.addEventListener('click', () => {
      // Prima qui c'era una richiesta di conferma prima di cestinare. E' stata
      // tolta di proposito: chiudere una pratica e togliere il messaggio dalla
      // posta in arrivo sono la stessa cosa, e chiederlo ogni volta a chi lo fa
      // venti volte al giorno non protegge nessuno, insegna solo a premere
      // "si" senza leggere. Il testo dell'email resta salvato qui comunque, e
      // la scheda lo dice.
      b.disabled = true;
      protetto(async () => {
        await api(`/admin/email/${m.codice}`, { method: 'PATCH', body: { stato } });
        if (stato === 'gestita' && m.message_id) {
          avvisa('Segnata come gestita. Il messaggio va nel cestino di Gmail entro un minuto.', 'ok');
        }
        await caricaEmail();
      });
    });
    azioni.append(b);
  }
  carta.append(azioni);
  return carta;
}

// ---- Richieste dai Moduli Google -------------------------------------------
//
// Sono arrivate mentre il sito era spento e nessuno le ha ancora viste. Il
// pannello le mostra con i campi gia' compilati ma modificabili: il paziente
// scrive di fretta e da un telefono, e chi apre lo studio deve poter
// raddrizzare un orario o un cognome senza rifare tutto a mano.

async function caricaModuli() {
  const parametri = new URLSearchParams();
  const stato = $('#mod-stato').value;
  if (stato) parametri.set('stato', stato);

  const { richieste, totale } = await api(`/admin/moduli?${parametri}`);
  const contenitore = $('#elenco-moduli');

  aggiornaContatoreModuli(stato === 'nuova' ? totale : null);

  if (!richieste.length) {
    contenitore.replaceChildren(vuoto(stato === 'nuova'
      ? 'Nessuna richiesta in attesa: è tutto confermato.'
      : 'Nessuna richiesta in questa vista.'));
    return;
  }

  contenitore.replaceChildren(
    nodo('p', 'piccolo tenue', `${totale} richieste.`),
    ...richieste.map(schedaModulo)
  );
}

/** Il numerino sulla linguetta: si vede da qualsiasi scheda che c'e' lavoro. */
function aggiornaContatoreModuli(quante) {
  const pallino = $('#conta-moduli');
  if (quante === null || quante === undefined) return;
  pallino.textContent = quante ? ` (${quante})` : '';
  pallino.hidden = !quante;
}

const campoModulo = (etichettaTesto, elemento) => {
  const campo = nodo('div', 'campo');
  campo.style.cssText = 'flex:1;min-width:150px';
  const lab = nodo('label', null, etichettaTesto);
  campo.append(lab, elemento);
  return campo;
};

function inputTesto(valore, segnaposto) {
  const el = nodo('input');
  el.value = valore ?? '';
  if (segnaposto) el.placeholder = segnaposto;
  return el;
}

function schedaModulo(m) {
  const carta = nodo('div', 'carta');
  const prenotazione = m.tipo === 'prenotazione';

  const testata = nodo('div');
  testata.style.cssText = 'display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between';
  const sinistra = nodo('div');
  sinistra.append(
    nodo('strong', null, prenotazione ? '📅 Richiesta di visita' : '💊 Richiesta di medicinali'),
    nodo('div', 'piccolo tenue', `Arrivata il ${quando(m.ricevuta_il)} · ${m.codice}`)
  );
  testata.append(sinistra, etichetta(m.stato, {
    nuova: 'da confermare', confermata: 'confermata', rifiutata: 'scartata'
  }[m.stato]));
  carta.append(testata);

  // Gia' gestita: si guarda soltanto, non si tocca piu'.
  if (m.stato !== 'nuova') {
    carta.append(nodo('p', 'piccolo tenue',
      `${m.nome || ''} ${m.cognome || ''} · ${m.telefono || 'senza telefono'}` +
      (m.collegata_a ? ` · diventata ${m.collegata_a}` : '') +
      (m.motivo_rifiuto ? ` · motivo: ${m.motivo_rifiuto}` : '')));
    return carta;
  }

  const campi = {
    nome: inputTesto(m.nome, 'Nome'),
    cognome: inputTesto(m.cognome, 'Cognome'),
    telefono: inputTesto(m.telefono, 'Telefono'),
    email: inputTesto(m.email, 'Email (facoltativa)')
  };

  const riga1 = nodo('div', 'filtri');
  riga1.style.marginTop = '.85rem';
  riga1.append(
    campoModulo('Nome', campi.nome),
    campoModulo('Cognome', campi.cognome),
    campoModulo('Telefono', campi.telefono),
    campoModulo('Email', campi.email)
  );
  carta.append(riga1);

  const riga2 = nodo('div', 'filtri');

  if (prenotazione) {
    campi.ambulatorio_id = scegliAmbulatorio(m.ambulatorio_id);

    campi.data = nodo('input');
    campi.data.type = 'date';
    campi.data.value = m.data_chiesta || '';
    campi.data.min = oggiISO();

    // Elenco degli orari davvero liberi: evita di confermare alla cieca un
    // orario che nel frattempo qualcun altro ha preso.
    campi.ora_inizio = nodo('select');
    const avviso = nodo('div', 'piccolo tenue');

    const aggiornaOrari = async () => {
      campi.ora_inizio.replaceChildren();
      avviso.textContent = '';
      if (!campi.data.value) {
        avviso.textContent = 'Scegli prima il giorno.';
        return;
      }
      try {
        const { slot } = await api(`/disponibilita?data=${campi.data.value}` +
          `&ambulatorio_id=${campi.ambulatorio_id.value}`);
        const liberi = slot.filter((s) => s.disponibile);
        if (!liberi.length) {
          avviso.textContent = 'Nessun orario libero in questa giornata: prova un altro giorno.';
          return;
        }
        for (const s of liberi) {
          const opzione = nodo('option', null, `${s.ora_inizio}–${s.ora_fine}`);
          opzione.value = s.ora_inizio;
          if (s.ora_inizio === m.ora_chiesta) opzione.selected = true;
          campi.ora_inizio.append(opzione);
        }
        avviso.textContent = m.ora_chiesta && !liberi.some((s) => s.ora_inizio === m.ora_chiesta)
          ? `Il paziente aveva chiesto le ${m.ora_chiesta}, che non è libero: scegline un altro.`
          : `${liberi.length} orari liberi.`;
      } catch (err) {
        avviso.textContent = err.message;
      }
    };

    campi.data.addEventListener('change', aggiornaOrari);
    campi.ambulatorio_id.addEventListener('change', aggiornaOrari);
    aggiornaOrari();

    campi.problema = inputTesto(m.testo, 'Motivo della visita');

    riga2.append(
      campoModulo('Ambulatorio', campi.ambulatorio_id),
      campoModulo('Giorno', campi.data),
      campoModulo('Orario', campi.ora_inizio),
      campoModulo('Motivo', campi.problema)
    );
    carta.append(riga2, avviso);
  } else {
    campi.farmaci = inputTesto(m.testo, 'Medicinali richiesti');
    campi.note = inputTesto(m.note, 'Note');
    riga2.append(campoModulo('Medicinali', campi.farmaci), campoModulo('Note', campi.note));
    carta.append(riga2);
  }

  // Cosa aveva scritto davvero il paziente, parola per parola: serve quando la
  // lettura automatica delle colonne ha capito male.
  const originale = nodo('details');
  originale.append(nodo('summary', 'piccolo tenue', 'Vedi la risposta originale'));
  const grezzo = nodo('div', 'piccolo', testoOriginale(m));
  grezzo.style.cssText = 'white-space:pre-line;margin-top:.5rem;background:var(--sfondo);' +
    'padding:.75rem;border-radius:8px';
  originale.append(grezzo);
  originale.style.marginTop = '.85rem';
  carta.append(originale);

  const azioni = nodo('div', 'azioni');

  const conferma = nodo('button', 'bottone', 'Conferma');
  conferma.type = 'button';
  conferma.addEventListener('click', () => {
    const corpo = {};
    for (const [chiave, elemento] of Object.entries(campi)) {
      const valore = String(elemento.value || '').trim();
      if (valore) corpo[chiave] = chiave === 'ambulatorio_id' ? Number(valore) : valore;
    }
    conferma.disabled = true;
    protetto(async () => {
      try {
        const esito = await api(`/admin/moduli/${m.codice}/conferma`, { method: 'POST', body: corpo });
        avvisa(`Confermata: ${esito.generata.codice}. Al paziente parte l'email.`, 'ok');
        await caricaModuli();
      } finally {
        conferma.disabled = false;
      }
    });
  });

  const scarta = nodo('button', 'bottone secondario', 'Scarta');
  scarta.type = 'button';
  scarta.addEventListener('click', () => {
    const motivo = prompt('Perché scarti questa richiesta? (resterà scritto)');
    if (motivo === null) return;
    scarta.disabled = true;
    protetto(async () => {
      try {
        await api(`/admin/moduli/${m.codice}/rifiuta`, { method: 'POST', body: { motivo } });
        avvisa('Richiesta scartata.', 'ok');
        await caricaModuli();
      } finally {
        scarta.disabled = false;
      }
    });
  });

  azioni.append(conferma, scarta);
  carta.append(azioni);
  return carta;
}

function testoOriginale(m) {
  try {
    const { intestazioni, riga } = JSON.parse(m.riga_json);
    return intestazioni
      .map((testata, i) => (riga[i] ? `${testata}: ${riga[i]}` : null))
      .filter(Boolean).join('\n');
  } catch {
    return m.riga_json;
  }
}

function collegaModuli() {
  $('#mod-stato').addEventListener('change', () => protetto(caricaModuli));

  $('#mod-controlla').addEventListener('click', (evento) => {
    const pulsante = evento.currentTarget;
    pulsante.disabled = true;
    pulsante.textContent = 'Controllo…';
    protetto(async () => {
      try {
        const { esito } = await api('/admin/moduli/controlla', { method: 'POST' });
        avvisa(esito.ok
          ? `Controllo fatto: ${esito.nuove} richieste nuove.`
          : `Non ho potuto leggere i moduli: ${esito.motivo}`, esito.ok ? 'ok' : 'errore');
        await caricaModuli();
      } finally {
        pulsante.disabled = false;
        pulsante.textContent = 'Controlla i moduli ora';
      }
    });
  });
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

  // Il fascicolo lo apre solo il medico: contiene i motivi delle visite, che
  // alla segreteria non servono per fare il suo lavoro. Il server la respinge
  // comunque, ma un nome che non si apre e' piu' onesto di un errore dopo il
  // click.
  const medico = utenteAttivo?.ruolo === 'admin';

  contenitore.replaceChildren(tabella(
    ['Cognome e nome', 'Telefono', 'Email', 'Visite'],
    pazienti.map((p) => [
      { nodo: medico ? apriFascicoloBottone(p) : nodo('span', null, `${p.cognome} ${p.nome}`) },
      { nodo: collegamentoTelefono(p.telefono) },
      p.email || '—',
      p.visite
    ])
  ));
}

function apriFascicoloBottone(p) {
  const b = nodo('button', null, `${p.cognome} ${p.nome}`);
  b.type = 'button';
  b.style.cssText = 'background:none;border:0;padding:0;font:inherit;color:var(--verde);'
    + 'cursor:pointer;text-align:left;text-decoration:underline';
  b.addEventListener('click', () => protetto(() => apriFascicolo(p.id)));
  return b;
}

/**
 * Il fascicolo del paziente: visite e medicinali nella stessa schermata.
 *
 * Finora queste due cose vivevano in due schede diverse e non si incontravano
 * mai. Ma la domanda che ci si fa davanti a una persona non e' "quali
 * prenotazioni ha" ne' "quali ricette ha chiesto": e' "cos'e' successo a questa
 * persona". Rispondere richiede di vedere le due storie una accanto all'altra.
 *
 * Le terapie approvate stanno in cima e da sole. Una richiesta rifiutata o
 * ancora da vedere e' una pratica; una confermata e' una cosa che il paziente
 * sta prendendo davvero, e mescolarle vorrebbe dire dover leggere ogni riga per
 * sapere quali sono le seconde.
 */
async function apriFascicolo(id) {
  const { paziente, prenotazioni, medicine } = await api(`/admin/pazienti/${id}`);
  const contenitore = $('#elenco-pazienti');

  const indietro = nodo('button', 'bottone secondario piccolo', '← Torna all\'elenco');
  indietro.type = 'button';
  indietro.addEventListener('click', () => protetto(caricaPazienti));
  const barra = nodo('div', 'azioni');
  barra.append(indietro);

  const intestazione = nodo('div', 'carta');
  intestazione.append(nodo('h3', null, `${paziente.cognome} ${paziente.nome}`));
  const recapiti = nodo('div', 'piccolo');
  recapiti.append(collegamentoTelefono(paziente.telefono));
  recapiti.append(nodo('span', 'tenue', paziente.email ? ` · ${paziente.email}` : ' · senza email'));
  intestazione.append(recapiti);
  intestazione.append(nodo('div', 'piccolo tenue', `In archivio dal ${quando(paziente.creato_il)}`));

  const attive = medicine.filter((m) => m.stato === 'confermata' || m.stato === 'consegnata');
  const altre = medicine.filter((m) => !attive.includes(m));

  contenitore.replaceChildren(
    barra,
    intestazione,
    sezioneFascicolo('💊 Medicinali approvati', attive.map((m) => rigaMedicinaFascicolo(m)),
      'Nessun medicinale approvato per questo paziente.'),
    sezioneFascicolo('📋 Altre richieste di medicinali', altre.map((m) => rigaMedicinaFascicolo(m)), null),
    sezioneFascicolo('📅 Visite', prenotazioni.map((p) => rigaVisitaFascicolo(p)),
      'Nessuna visita registrata.')
  );
}

/** Un blocco del fascicolo. Se non ha righe e non ha niente da dire, sparisce. */
function sezioneFascicolo(titolo, righe, seVuoto) {
  const carta = nodo('div', 'carta');
  carta.style.marginTop = '1rem';
  carta.append(nodo('h3', null, titolo));
  if (!righe.length) {
    if (!seVuoto) { carta.hidden = true; return carta; }
    carta.append(nodo('p', 'piccolo tenue', seVuoto));
    return carta;
  }
  righe.forEach((r) => carta.append(r));
  return carta;
}

function rigaFascicolo() {
  const riga = nodo('div');
  riga.style.cssText = 'padding:.7rem 0;border-top:1px solid var(--bordo)';
  return riga;
}

function rigaMedicinaFascicolo(m) {
  const riga = rigaFascicolo();

  const testa = nodo('div');
  testa.style.cssText = 'display:flex;flex-wrap:wrap;gap:.5rem;justify-content:space-between;align-items:center';
  testa.append(
    nodo('span', 'piccolo tenue', `${quando(m.creata_il)} · ${m.codice}`
      + (m.origine && m.origine !== 'sito' ? ` · da ${m.origine}` : '')),
    etichetta(m.stato, ETICHETTE_MEDICINE[m.stato])
  );
  riga.append(testa);

  const farmaci = nodo('div', null, m.farmaci);
  farmaci.style.whiteSpace = 'pre-wrap';
  riga.append(farmaci);

  if (m.note) riga.append(nodo('div', 'piccolo tenue', m.note));

  // Se l'elenco e' stato corretto al telefono, quello che il paziente aveva
  // chiesto resta scritto: e' la differenza fra i due che spiega la telefonata.
  if (m.farmaci_originali && m.farmaci_originali !== m.farmaci) {
    const prima = nodo('details');
    prima.append(nodo('summary', 'piccolo tenue', 'Aveva chiesto'));
    const testo = nodo('div', 'piccolo tenue', m.farmaci_originali);
    testo.style.whiteSpace = 'pre-wrap';
    prima.append(testo);
    riga.append(prima);
  }

  if (m.motivo_rifiuto) riga.append(nodo('div', 'piccolo tenue', `Rifiutata: ${m.motivo_rifiuto}`));
  if (m.gestita_il) {
    riga.append(nodo('div', 'piccolo tenue',
      `${ETICHETTE_MEDICINE[m.stato]} il ${quando(m.gestita_il)}`
      + (m.gestita_da ? ` da ${m.gestita_da}` : '')));
  }
  return riga;
}

function rigaVisitaFascicolo(p) {
  const riga = rigaFascicolo();
  const spostata = Boolean(p.riprogrammata_il) && p.stato === 'confermata';

  const testa = nodo('div');
  testa.style.cssText = 'display:flex;flex-wrap:wrap;gap:.5rem;justify-content:space-between;align-items:center';
  const testoStato = { confermata: 'Confermata', annullata: 'Annullata' }[p.stato] || p.stato;
  testa.append(
    nodo('span', null, `${dataEstesa(p.data)} alle ${p.ora_inizio} · ${p.ambulatorio_nome}`),
    etichetta(p.stato, spostata ? 'Riprogrammata' : testoStato)
  );
  riga.append(testa);
  riga.append(nodo('div', 'piccolo tenue', p.codice));
  if (p.problema) riga.append(nodo('div', null, p.problema));
  return riga;
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
  // Tenuti da parte anche per le schede delle richieste da confermare.
  ambulatoriNoti = ambulatori;
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

  $('#pren-aggiungi').addEventListener('click', () =>
    apriChiudi($('#modulo-prenotazione'), moduloNuovaPrenotazione));
  $('#med-aggiungi').addEventListener('click', () =>
    apriChiudi($('#modulo-medicina'), moduloNuovaMedicina));

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
  collegaModuli();
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
