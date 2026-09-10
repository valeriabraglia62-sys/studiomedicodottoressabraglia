/**
 * Sito pubblico. Il server è l'unica fonte di verità sulle disponibilità:
 * qui non si ricalcola nessun orario, si mostra solo ciò che l'API risponde.
 */

import { montaChat } from './chat.js';

const $ = (sel, dove = document) => dove.querySelector(sel);
const $$ = (sel, dove = document) => [...dove.querySelectorAll(sel)];

const NOMI_MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const NOMI_GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const INIZIALI_GIORNI = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
const CHIAVE_TOKEN_PAZIENTE = 'studio-medico-paziente';
let tokenPaziente = sessionStorage.getItem(CHIAVE_TOKEN_PAZIENTE) || '';

// ---- Utilità ---------------------------------------------------------------

async function api(percorso, opzioni = {}) {
  const headers = { ...(opzioni.body ? { 'Content-Type': 'application/json' } : {}), ...(opzioni.headers || {}) };
  if (tokenPaziente) headers.Authorization = `Bearer ${tokenPaziente}`;
  const risposta = await fetch(`/api${percorso}`, {
    ...opzioni,
    headers,
    body: opzioni.body ? JSON.stringify(opzioni.body) : undefined
  });

  let dati = {};
  try { dati = await risposta.json(); } catch { /* risposta non JSON: gestita sotto */ }

  if (!risposta.ok || dati.success === false) {
    const err = new Error(dati.message || 'Problema di collegamento. Controlla la rete e riprova.');
    err.stato = risposta.status;
    err.dati = dati;
    throw err;
  }
  return dati;
}

/** Mostra la schermata d'accesso oppure il sito vero. */
function mostraSchermataPaziente(quale) {
  $('#accesso-paziente').classList.toggle('nascosto', quale !== 'accesso');
  $('#sito').classList.toggle('nascosto', quale !== 'sito');
}

async function esciPaziente() {
  // Prima di dimenticare il token, lo si fa invalidare anche sul server: cosi'
  // una copia rimasta altrove non resta valida per giorni.
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* si esce comunque */ }
  tokenPaziente = '';
  try { sessionStorage.removeItem(CHIAVE_TOKEN_PAZIENTE); } catch { /* ignora */ }
  location.reload();
}

/** Collega la schermata d'accesso: login, registrazione, verifica, menu account. */
function collegaAccessoPaziente() {
  const statoAccount = $('#stato-account');
  const mostraStato = (testo, tipo = 'ok') => {
    statoAccount.hidden = false;
    statoAccount.className = `avviso ${tipo}`;
    statoAccount.textContent = testo;
  };

  // Ritorno dal link di verifica: /?email=verificata oppure /?email=nonvalida
  const esitoVerifica = new URLSearchParams(location.search).get('email');
  if (esitoVerifica === 'verificata') {
    mostraStato('Indirizzo confermato. Ora puoi accedere con la tua email e password.', 'ok');
  } else if (esitoVerifica === 'nonvalida') {
    mostraStato('Link di verifica non valido o scaduto. Richiedine uno nuovo qui sotto.', 'errore');
  }
  if (esitoVerifica) history.replaceState(null, '', location.pathname + location.hash);

  // Un solo modulo per volta: "Crea account" / "Torna all'accesso".
  const mostraModulo = (quale) => {
    $('#form-login-paziente').hidden = quale !== 'login';
    $('#form-registra-paziente').hidden = quale !== 'registra';
    statoAccount.hidden = true;
  };
  $('#vai-registra').addEventListener('click', (e) => { e.preventDefault(); mostraModulo('registra'); });
  $('#vai-login').addEventListener('click', (e) => { e.preventDefault(); mostraModulo('login'); });

  $('#form-login-paziente').addEventListener('submit', (evento) => {
    evento.preventDefault();
    const form = evento.currentTarget;
    inviaProtetto(form, async () => {
      try {
        const dati = await api('/auth/login', { method: 'POST', body: datiModulo(form) });
        if (dati.utente?.ruolo !== 'paziente') throw new Error('Questo non è un account paziente.');
        tokenPaziente = dati.token;
        try { sessionStorage.setItem(CHIAVE_TOKEN_PAZIENTE, tokenPaziente); } catch { /* ignora */ }
        form.reset();
        await entraNelSito(dati.utente);
      } catch (err) {
        if (err.dati?.verifica_email) {
          mostraStato('Devi prima confermare l\'email. Controlla la posta o usa "Rinvia il link".', 'attenzione');
        }
        throw err;
      }
    });
  });

  $('#form-registra-paziente').addEventListener('submit', (evento) => {
    evento.preventDefault();
    const form = evento.currentTarget;
    // L'indirizzo va letto prima del reset: serve a dire alla persona DOVE
    // guardare, che e' la meta' dell'informazione utile.
    const indirizzo = $('#reg-email').value.trim();
    inviaProtetto(form, async () => {
      await api('/auth/register', { method: 'POST', body: datiModulo(form) });
      form.reset();
      mostraModulo('login');
      mostraStato(
        `Ti abbiamo inviato un'email a ${indirizzo}. Aprila e premi il link dentro per `
        + 'confermare l\'indirizzo: finché non lo fai non puoi accedere. Il link vale 24 ore. '
        + 'Se entro un minuto non la vedi, controlla nello spam / posta indesiderata; '
        + 'oppure scrivi l\'email qui sopra e premi «Rinvia il link».',
        'ok'
      );
    });
  });

  $('#rinvia-verifica').addEventListener('click', async (evento) => {
    evento.preventDefault();
    const email = $('#login-email').value.trim();
    if (!email) { mostraStato('Scrivi la tua email qui sopra, poi premi "Rinvia il link".', 'attenzione'); return; }
    try {
      const dati = await api('/auth/verifica-email/rinvia', { method: 'POST', body: { email } });
      mostraStato(dati.message || 'Se l\'indirizzo è corretto, l\'email di conferma è ripartita.', 'ok');
    } catch (err) {
      avvisa(err.message, 'errore');
    }
  });

  // --- Menu account nella barra in alto (visibile solo da dentro il sito) ---
  const menu = $('#menu-account');
  $('#btn-esci-paziente').addEventListener('click', esciPaziente);

  $('#btn-modifica-account').addEventListener('click', async () => {
    menu.removeAttribute('open');
    $('#acc-esito').replaceChildren();
    $('#acc-esito-pwd').replaceChildren();
    $('#acc-pwd-attuale').value = '';
    $('#acc-pwd-nuova').value = '';
    $('#acc-pwd-conferma').value = '';
    try {
      const { profilo } = await api('/paziente/profilo');
      profiloPazienteCorrente = profilo;
      $('#acc-nome').value = profilo.nome || '';
      $('#acc-cognome').value = profilo.cognome || '';
      $('#acc-telefono').value = profilo.telefono || '';
      $('#acc-email').value = profilo.email || '';
      $('#acc-riga-pwd-conferma').hidden = true;
    } catch (err) { avvisa(err.message, 'errore'); return; }
    $('#dialog-account').showModal();
  });

  // La password serve solo se cambia l'email.
  $('#acc-email').addEventListener('input', () => {
    const cambiata = $('#acc-email').value.trim().toLowerCase()
      !== (profiloPazienteCorrente?.email || '').toLowerCase();
    $('#acc-riga-pwd-conferma').hidden = !cambiata;
  });

  $('#acc-salva-profilo').addEventListener('click', async () => {
    const esito = $('#acc-esito');
    const body = {
      nome: $('#acc-nome').value.trim(),
      cognome: $('#acc-cognome').value.trim(),
      telefono: $('#acc-telefono').value.trim(),
      email: $('#acc-email').value.trim(),
      password: $('#acc-pwd-conferma').value
    };
    try {
      const risp = await api('/paziente/profilo', { method: 'PATCH', body });
      profiloPazienteCorrente = risp.profilo;
      $('#nome-utente-paziente').textContent = `${risp.profilo.nome} ${risp.profilo.cognome}`.trim();
      $('#acc-riga-pwd-conferma').hidden = true;
      $('#acc-pwd-conferma').value = '';
      esito.replaceChildren(nodo('div', 'avviso ok', risp.email_cambiata
        ? 'Dati salvati. Da ora accedi con la nuova email.'
        : 'Dati salvati.'));
    } catch (err) {
      esito.replaceChildren(nodo('div', 'avviso errore', err.message));
    }
  });

  $('#acc-salva-pwd').addEventListener('click', async () => {
    const attuale = $('#acc-pwd-attuale').value;
    const nuova = $('#acc-pwd-nuova').value;
    const esito = $('#acc-esito-pwd');
    if (nuova.length < 10) {
      esito.replaceChildren(nodo('div', 'avviso errore', 'La nuova password deve avere almeno 10 caratteri.'));
      return;
    }
    try {
      await api('/auth/password', { method: 'POST', body: { attuale, nuova } });
      esito.replaceChildren(nodo('div', 'avviso ok',
        'Password cambiata. Per sicurezza ti chiediamo di rientrare con quella nuova.'));
      setTimeout(esciPaziente, 1800);
    } catch (err) {
      esito.replaceChildren(nodo('div', 'avviso errore', err.message));
    }
  });
}

const testo = (s) => String(s ?? '');

/** Inserisce testo dell'utente nel DOM senza mai interpretarlo come HTML. */
function scrivi(elemento, contenuto) {
  elemento.textContent = testo(contenuto);
  return elemento;
}

function nodo(tag, classe, contenuto) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (contenuto !== undefined) el.textContent = testo(contenuto);
  return el;
}

function avvisa(messaggio, tipo = 'ok') {
  const contenitore = $('#notifiche');
  const el = nodo('div', `notifica ${tipo}`, messaggio);
  contenitore.append(el);
  setTimeout(() => el.remove(), 5000);
  el.addEventListener('click', () => el.remove());
}

const isoOggi = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

const iso = (anno, mese, giorno) =>
  `${anno}-${String(mese + 1).padStart(2, '0')}-${String(giorno).padStart(2, '0')}`;

function dataEstesa(dataStr) {
  const [a, m, g] = dataStr.split('-').map(Number);
  const settimana = new Date(Date.UTC(a, m - 1, g)).getUTCDay();
  return `${NOMI_GIORNI[settimana]} ${g} ${NOMI_MESI[m - 1]} ${a}`;
}

// ---- Validazione dei moduli ------------------------------------------------

const telefonoValido = (v) => /^[+]?[\d\s.\-()]{6,20}$/.test(v.trim());
const emailValida = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

const REGOLE = {
  nome: (v) => (v.trim().length >= 2 ? '' : 'Inserisci il nome.'),
  cognome: (v) => (v.trim().length >= 2 ? '' : 'Inserisci il cognome.'),
  telefono: (v) => (telefonoValido(v) ? '' : 'Numero non valido (esempio: 333 1234567).'),
  email: (v) => (!v.trim() || emailValida(v) ? '' : 'Indirizzo email non valido.'),
  problema: (v) => (v.trim().length >= 3 ? '' : 'Descrivi brevemente il motivo della visita.'),
  farmaci: (v) => (v.trim().length >= 2 ? '' : 'Indica almeno un medicinale.')
};

function segnalaCampo(campo, errore) {
  const contenitore = campo.closest('.campo');
  if (!contenitore) return;
  contenitore.classList.toggle('errore', Boolean(errore));
  const messaggio = $('.messaggio-errore', contenitore);
  if (messaggio) messaggio.textContent = errore;
}

/**
 * Un campo facoltativo e vuoto non si controlla.
 *
 * Le regole sono per nome, quindi "farmaci" vale su tutti e tre i moduli. Ma
 * negli esami quel campo puo' restare vuoto, perche' basta la foto della
 * richiesta: senza questo, il modulo rifiutava un invio perfettamente valido
 * chiedendo di indicare un medicinale, che li' non c'entra niente.
 */
const daControllare = (campo) => campo.required || campo.value.trim().length > 0;

/** Valida i campi con una regola nota; restituisce true se il modulo è a posto. */
function validaModulo(form) {
  let primoErrore = null;

  for (const campo of $$('input, textarea', form)) {
    const regola = REGOLE[campo.name];
    if (!regola || !daControllare(campo)) continue;
    const errore = regola(campo.value);
    segnalaCampo(campo, errore);
    if (errore && !primoErrore) primoErrore = campo;
  }

  if (primoErrore) {
    primoErrore.focus();
    primoErrore.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  return !primoErrore;
}

/** L'errore sparisce mentre l'utente corregge, non solo al prossimo invio. */
function validazioneDalVivo(form) {
  for (const campo of $$('input, textarea', form)) {
    const regola = REGOLE[campo.name];
    if (!regola) continue;
    const controlla = () => (daControllare(campo) ? regola(campo.value) : '');
    campo.addEventListener('blur', () => segnalaCampo(campo, controlla()));
    campo.addEventListener('input', () => {
      if (campo.closest('.campo')?.classList.contains('errore')) {
        segnalaCampo(campo, controlla());
      }
    });
  }
}

const datiModulo = (form) => Object.fromEntries(new FormData(form).entries());

/** Blocca il pulsante durante l'invio: due click non generano due prenotazioni. */
async function inviaProtetto(form, azione) {
  const pulsante = $('button[type="submit"]', form);
  const etichetta = pulsante.textContent;
  pulsante.disabled = true;
  pulsante.textContent = 'Attendi…';
  try {
    await azione();
  } catch (err) {
    avvisa(err.message, 'errore');
  } finally {
    pulsante.disabled = false;
    pulsante.textContent = etichetta;
  }
}

// ---- Stato condiviso -------------------------------------------------------

const stato = {
  ambulatori: [],
  ambulatorioId: null,
  meseVisibile: null,   // { anno, mese }
  disponibilita: new Map(), // data ISO -> numero di slot liberi
  dataScelta: null,
  slotScelto: null
};

// ---- Ambulatori ------------------------------------------------------------

async function caricaAmbulatori() {
  const { ambulatori } = await api('/ambulatori');
  stato.ambulatori = ambulatori;
  stato.ambulatorioId = ambulatori[0]?.id ?? null;

  // Solo la scelta delle visite: per i medicinali il ritiro e' in farmacia e
  // quel campo non esiste piu' sul modulo del paziente.
  $('#scelta-ambulatorio').replaceChildren(...ambulatori.map((a) => {
    const opzione = nodo('option', null, a.nome);
    opzione.value = a.id;
    return opzione;
  }));

  $('#elenco-ambulatori').replaceChildren(...ambulatori.map(schedaAmbulatorio));
}

function schedaAmbulatorio(a) {
  const carta = nodo('div', 'carta ambulatorio');
  carta.append(nodo('h3', null, `🏥 ${a.nome}`));

  const dl = nodo('dl');
  const riga = (etichetta, valore, href) => {
    dl.append(nodo('dt', null, etichetta));
    const dd = nodo('dd');
    if (href) {
      const link = nodo('a', null, valore);
      link.href = href;
      dd.append(link);
    } else {
      dd.textContent = valore;
    }
    dl.append(dd);
  };

  riga('Indirizzo', a.indirizzo);
  riga('Telefono', a.telefono, `tel:${String(a.telefono).replace(/\s/g, '')}`);

  const aperture = [1, 2, 3, 4, 5, 6, 0]
    .filter((g) => a.orari?.[g])
    .map((g) => `${NOMI_GIORNI[g]} ${a.orari[g].inizio}–${a.orari[g].fine}`);

  riga('Aperture', aperture.length ? aperture.join('\n') : 'Su appuntamento');
  dl.lastElementChild.style.whiteSpace = 'pre-line';

  carta.append(dl);
  return carta;
}

// ---- Calendario ------------------------------------------------------------

async function caricaMese() {
  const { anno, mese } = stato.meseVisibile;
  const oggi = isoOggi();
  const primo = iso(anno, mese, 1);
  const ultimo = iso(anno, mese, new Date(Date.UTC(anno, mese + 1, 0)).getUTCDate());

  $('#etichetta-mese').textContent = `${NOMI_MESI[mese]} ${anno}`;

  const dal = primo < oggi ? oggi : primo;
  stato.disponibilita = new Map();

  if (dal <= ultimo) {
    const parametri = new URLSearchParams({ dal, al: ultimo });
    if (stato.ambulatorioId) parametri.set('ambulatorio_id', stato.ambulatorioId);
    try {
      const { giorni } = await api(`/calendario?${parametri}`);
      for (const g of giorni) stato.disponibilita.set(g.data, g.liberi);
    } catch (err) {
      avvisa(err.message, 'errore');
    }
  }
  disegnaCalendario();
}

function disegnaCalendario() {
  const { anno, mese } = stato.meseVisibile;
  const griglia = $('#calendario');
  const oggi = isoOggi();
  const elementi = INIZIALI_GIORNI.map((i) => nodo('div', 'etichetta-giorno', i));

  // La settimana parte da lunedì: la domenica di JS (0) va in settima posizione.
  const primoGiorno = (new Date(Date.UTC(anno, mese, 1)).getUTCDay() + 6) % 7;
  for (let i = 0; i < primoGiorno; i++) elementi.push(nodo('div', 'giorno vuoto'));

  const giorniNelMese = new Date(Date.UTC(anno, mese + 1, 0)).getUTCDate();
  for (let g = 1; g <= giorniNelMese; g++) {
    const data = iso(anno, mese, g);
    const liberi = stato.disponibilita.get(data) ?? 0;

    const bottone = nodo('button', 'giorno');
    bottone.type = 'button';
    bottone.append(nodo('span', null, g));
    bottone.disabled = data < oggi || liberi === 0;

    if (liberi > 0) {
      bottone.append(nodo('span', 'pallino'));
      bottone.title = `${liberi} orari liberi`;
    }
    if (data === stato.dataScelta) bottone.classList.add('scelto');

    bottone.addEventListener('click', () => scegliGiorno(data));
    elementi.push(bottone);
  }

  griglia.replaceChildren(...elementi);
}

function cambiaMese(passo) {
  const d = new Date(Date.UTC(stato.meseVisibile.anno, stato.meseVisibile.mese + passo, 1));
  stato.meseVisibile = { anno: d.getUTCFullYear(), mese: d.getUTCMonth() };
  caricaMese();
}

// ---- Orari disponibili -----------------------------------------------------

async function scegliGiorno(data) {
  stato.dataScelta = data;
  stato.slotScelto = null;
  disegnaCalendario();
  $('#modulo-prenotazione').classList.add('nascosto');

  const contenitore = $('#contenitore-fasce');
  contenitore.replaceChildren(nodo('p', 'tenue piccolo', 'Carico gli orari…'));

  try {
    const parametri = new URLSearchParams({ data });
    if (stato.ambulatorioId) parametri.set('ambulatorio_id', stato.ambulatorioId);
    const { slot } = await api(`/disponibilita?${parametri}`);
    disegnaFasce(slot);
  } catch (err) {
    contenitore.replaceChildren(nodo('div', 'avviso errore', err.message));
  }
}

function disegnaFasce(slot) {
  const contenitore = $('#contenitore-fasce');
  const liberi = slot.filter((s) => s.disponibile);

  if (!liberi.length) {
    contenitore.replaceChildren(nodo('div', 'avviso attenzione',
      `Nessun orario libero ${dataEstesa(stato.dataScelta)}. Prova con un altro giorno.`));
    return;
  }

  const titolo = nodo('p', 'piccolo tenue', dataEstesa(stato.dataScelta));
  titolo.style.marginBottom = '.75rem';

  const fasce = nodo('div', 'fasce');
  for (const s of liberi) {
    const bottone = nodo('button', 'fascia', s.ora_inizio);
    bottone.type = 'button';
    bottone.addEventListener('click', () => {
      stato.slotScelto = s;
      $$('.fascia', fasce).forEach((b) => b.classList.remove('scelta'));
      bottone.classList.add('scelta');
      apriModuloPrenotazione(s);
    });
    fasce.append(bottone);
  }

  contenitore.replaceChildren(titolo, fasce);
}

function apriModuloPrenotazione(s) {
  const modulo = $('#modulo-prenotazione');
  modulo.classList.remove('nascosto');
  scrivi($('#riepilogo-scelta'),
    `${s.ambulatorio_nome} — ${dataEstesa(s.data)} alle ${s.ora_inizio}`);
  modulo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- Invio prenotazione ----------------------------------------------------

function collegaFormPrenotazione() {
  const form = $('#form-prenotazione');
  validazioneDalVivo(form);

  form.addEventListener('submit', (evento) => {
    evento.preventDefault();
    if (!stato.slotScelto) return avvisa('Scegli prima giorno e orario.', 'errore');
    if (!validaModulo(form)) return;

    inviaProtetto(form, async () => {
      const { prenotazione } = await api('/prenotazioni', {
        method: 'POST',
        body: {
          ...datiModulo(form),
          ambulatorio_id: stato.slotScelto.ambulatorio_id,
          data: stato.slotScelto.data,
          ora_inizio: stato.slotScelto.ora_inizio
        }
      });

      form.reset();
      $('#modulo-prenotazione').classList.add('nascosto');
      stato.slotScelto = null;
      mostraConferma(prenotazione);
      avvisa(prenotazione.stato === 'in_attesa'
        ? 'Richiesta inviata: lo studio la conferma a breve.'
        : 'Prenotazione confermata.', 'ok');
      await caricaMese();
      if (stato.dataScelta) scegliGiorno(stato.dataScelta);
    });
  });
}

/**
 * Pulsante "salva in calendario": apre Google Calendar con l'evento gia'
 * compilato, poi decide il paziente. Se il collegamento non c'e' (prenotazione
 * annullata, dati incompleti) non restituisce nulla da mostrare.
 */
function bottoneCalendario(p, classe = 'bottone secondario piccolo') {
  if (!p?.calendario) return document.createDocumentFragment();
  const link = nodo('a', classe, 'Aggiungi al calendario');
  link.href = p.calendario;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function mostraConferma(p) {
  const inAttesa = p.stato === 'in_attesa';
  const box = nodo('div', 'avviso ok');
  box.append(nodo('strong', null,
    `${inAttesa ? 'Richiesta inviata' : 'Prenotazione confermata'} — codice ${p.codice}`));
  box.append(nodo('p', 'piccolo',
    `${dataEstesa(p.data)} alle ${p.ora_inizio} · ${p.ambulatorio.nome}, ${p.ambulatorio.indirizzo}`));
  box.append(nodo('p', 'piccolo',
    (inAttesa
      ? 'Non è ancora confermata: lo studio la conferma a breve' +
        (p.paziente.email ? ' e ti arriva una email' : '') + '. '
      : '') +
    'Conserva il codice: ti serve per controllare o ' +
    (inAttesa ? 'ritirare la richiesta.' : 'annullare la prenotazione.') +
    (!inAttesa && p.paziente.email ? ' Ti abbiamo inviato una email di conferma.' : '')));

  const copia = nodo('button', 'bottone secondario piccolo', 'Copia il codice');
  copia.type = 'button';
  copia.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(p.codice);
      copia.textContent = 'Codice copiato';
    } catch {
      avvisa(`Il tuo codice è ${p.codice}`, 'ok');
    }
  });
  const azioni = nodo('div', 'azioni');
  azioni.append(copia, bottoneCalendario(p));
  box.append(azioni);

  // Contenitore separato dagli orari: ricaricando le fasce la conferma resta.
  $('#esito-prenotazione').replaceChildren(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---- Richieste: medicinali, visite specialistiche, esami -------------------

/**
 * I tre moduli sono lo stesso modulo con parole diverse.
 *
 * Quello che cambia davvero e' uno solo: agli esami il testo puo' mancare, se
 * c'e' la foto della richiesta dello specialista. Tutto il resto — i campi, i
 * controlli, l'invio, il codice che torna indietro — e' identico, e tenerlo in
 * una funzione sola vuol dire che una correzione vale per tutti e tre.
 */
const MODULI_RICHIESTA = [
  {
    tipo: 'medicina',
    form: '#form-medicine',
    file: null,
    fatto: 'Ti avviseremo quando la ricetta sarà pronta. Conserva il codice per controllarne lo stato.'
  },
  {
    tipo: 'specialistica',
    form: '#form-specialistica',
    file: '#spe-file',
    fatto: 'Le rispondiamo per email appena il medico ha guardato la richiesta. Conserva il codice.'
  },
  {
    tipo: 'esami',
    form: '#form-esami',
    file: '#esa-file',
    fatto: 'Le rispondiamo per email appena il medico ha guardato la richiesta. Conserva il codice.'
  }
];

/**
 * Mostra cosa si sta per mandare.
 *
 * Serve piu' di quanto sembri: chi fotografa una prescrizione col telefono non
 * sa se ha inquadrato tutto, e accorgersi che la foto e' storta o tagliata dopo
 * che la richiesta e' partita vuol dire una telefonata in piu' per tutti.
 */
function mostraAnteprime(campoFile) {
  const contenitore = campoFile.parentElement.querySelector('.anteprime');
  if (!contenitore) return;
  contenitore.replaceChildren();

  for (const file of campoFile.files) {
    const riquadro = nodo('div', 'anteprima');

    if (file.type.startsWith('image/')) {
      const img = nodo('img');
      img.alt = file.name;
      img.src = URL.createObjectURL(file);
      // Liberare l'indirizzo temporaneo appena l'immagine e' a schermo: senza,
      // ogni foto scelta resta in memoria finche' non si ricarica la pagina.
      img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
      riquadro.append(img);
    } else {
      riquadro.append(nodo('span', 'piccolo', '📄'));
    }

    riquadro.append(nodo('span', 'piccolo tenue',
      `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} kB`));
    contenitore.append(riquadro);
  }
}

/** Manda i file uno per uno, dopo che la richiesta esiste e ha un codice. */
async function inviaAllegati(codice, campoFile) {
  if (!campoFile?.files?.length) return;
  if (!confirm('Confermi di voler caricare questi documenti sanitari?')) {
    throw new Error('Caricamento annullato: la richiesta è comunque registrata.');
  }

  for (const file of campoFile.files) {
    const risposta = await fetch(
      `/api/medicine/${codice}/allegato?conferma=si&nome=${encodeURIComponent(file.name)}`,
      { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream',
        Authorization: `Bearer ${tokenPaziente}` }, body: file }
    );

    if (!risposta.ok) {
      const dati = await risposta.json().catch(() => ({}));
      // La richiesta e' gia' registrata: un allegato che non passa non deve
      // farla sembrare persa, altrimenti il paziente la rimanda da capo.
      throw new Error(`${dati.message || 'Non sono riuscito a caricare il file.'} `
        + `La richiesta ${codice} è comunque registrata: ci mandi la foto per email.`);
    }
  }
}

function collegaFormRichiesta({ tipo, form: selettore, file: selettoreFile, fatto }) {
  const form = $(selettore);
  if (!form) return;
  validazioneDalVivo(form);

  const campoFile = selettoreFile ? $(selettoreFile) : null;
  if (campoFile) campoFile.addEventListener('change', () => mostraAnteprime(campoFile));

  form.addEventListener('submit', (evento) => {
    evento.preventDefault();
    if (!validaModulo(form)) return;

    // Agli esami il testo puo' mancare, ma qualcosa deve pur arrivare: senza
    // testo e senza foto non ci sarebbe nessuna richiesta da leggere.
    if (tipo === 'esami' && !form.querySelector('[name=farmaci]').value.trim()
      && !campoFile?.files?.length) {
      avvisa('Scriva quali esami le servono, oppure alleghi la foto della richiesta.', 'errore');
      return;
    }

    inviaProtetto(form, async () => {
      const { richiesta } = await api('/medicine', {
        method: 'POST',
        body: { ...datiModulo(form), tipo, conAllegato: Boolean(campoFile?.files?.length) }
      });

      await inviaAllegati(richiesta.codice, campoFile);

      form.reset();
      if (campoFile) mostraAnteprime(campoFile);

      const box = nodo('div', 'avviso ok');
      box.append(nodo('strong', null, `Richiesta registrata — codice ${richiesta.codice}`));
      box.append(nodo('p', 'piccolo', fatto));
      form.parentElement.prepend(box);
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });

      avvisa('Richiesta inviata.', 'ok');
    });
  });
}

const collegaFormMedicine = () => MODULI_RICHIESTA.forEach(collegaFormRichiesta);

// ---- Ricerca e annullamento ------------------------------------------------

function collegaFormRicerca() {
  const form = $('#form-ricerca');
  const campo = $('#codice-ricerca');
  const esito = $('#esito-ricerca');

  form.addEventListener('submit', (evento) => {
    evento.preventDefault();
    const codice = campo.value.trim().toUpperCase();

    if (!/^(PRE|MED|SPE|ESA)-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codice)) {
      segnalaCampo(campo, 'Il codice ha la forma PRE-XXXX-XXXX (o MED, SPE, ESA).');
      return;
    }
    segnalaCampo(campo, '');

    inviaProtetto(form, async () => {
      esito.replaceChildren(nodo('p', 'tenue piccolo', 'Cerco…'));
      // PRE e' l'appuntamento; MED, SPE ed ESA sono tutte richieste, e stanno
      // insieme. L'elenco va tenuto allineato ai prefissi in medicine.js: se
      // domani nascesse un quarto tipo e ci si dimenticasse di aggiungerlo qui,
      // il paziente cercherebbe il suo codice fra le prenotazioni e si
      // sentirebbe dire che non esiste.
      if (['MED', 'SPE', 'ESA'].some((p) => codice.startsWith(p))) {
        const { richiesta } = await api(`/medicine/${codice}`);
        esito.replaceChildren(schedaRichiesta(richiesta));
      } else {
        const dati = await api(`/prenotazioni/${codice}`);
        esito.replaceChildren(schedaPrenotazione(dati.prenotazione, dati.annullabile));
      }
    });
  });

  // Il messaggio di errore sparisce appena l'utente ricomincia a scrivere.
  campo.addEventListener('input', () => segnalaCampo(campo, ''));
}

function schedaPrenotazione(p, annullabile) {
  const box = nodo('div', 'carta');
  const testata = nodo('div');
  testata.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:1rem';
  testata.append(nodo('strong', null, p.codice), nodo('span', `etichetta ${p.stato}`, p.stato));
  box.append(testata);

  box.append(nodo('p', null, `${dataEstesa(p.data)} · ${p.ora_inizio}–${p.ora_fine}`));
  box.append(nodo('p', 'piccolo tenue', `${p.ambulatorio.nome} — ${p.ambulatorio.indirizzo}`));
  box.append(nodo('p', 'piccolo', `${p.paziente.nome} ${p.paziente.cognome} · ${p.problema}`));

  const inAttesa = p.stato === 'in_attesa';
  if (p.stato !== 'confermata' && !inAttesa) return box;

  if (inAttesa) {
    box.append(nodo('div', 'avviso attenzione',
      'In attesa di conferma dallo studio: quando è confermata ricevi una email. ' +
      'Fino ad allora l\'orario resta tuo ma la visita non è ancora in agenda.'));
  }

  const azioni = nodo('div', 'azioni');
  if (!inAttesa) azioni.append(bottoneCalendario(p, 'bottone secondario'));

  if (!annullabile) {
    box.append(nodo('div', 'avviso attenzione',
      `Manca meno di un'ora all'appuntamento: per annullare chiama lo ${p.ambulatorio.telefono}.`));
    box.append(azioni);
    return box;
  }

  const pulsante = nodo('button', 'bottone pericolo',
    inAttesa ? 'Ritira la richiesta' : 'Annulla la prenotazione');
  pulsante.type = 'button';
  pulsante.addEventListener('click', async () => {
    if (!confirm(inAttesa
      ? 'Vuoi davvero ritirare questa richiesta?'
      : 'Vuoi davvero annullare questa prenotazione?')) return;
    pulsante.disabled = true;
    try {
      const { prenotazione } = await api(`/prenotazioni/${p.codice}/annulla`, {
        method: 'POST', body: { conferma: true }
      });
      $('#esito-ricerca').replaceChildren(schedaPrenotazione(prenotazione, false));
      avvisa(inAttesa
        ? 'Richiesta ritirata. Il posto è tornato disponibile.'
        : 'Prenotazione annullata. Il posto è tornato disponibile.', 'ok');
      caricaMese();
    } catch (err) {
      avvisa(err.message, 'errore');
      pulsante.disabled = false;
    }
  });
  azioni.append(pulsante);
  box.append(azioni);
  return box;
}

const NOME_TIPO = {
  medicina: 'Medicinali',
  specialistica: 'Visita specialistica',
  esami: 'Esami del sangue'
};

function schedaRichiesta(r) {
  const box = nodo('div', 'carta');
  const testata = nodo('div');
  testata.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:1rem';
  testata.append(nodo('strong', null, r.codice), nodo('span', `etichetta ${r.stato}`, r.etichetta || r.stato));
  box.append(testata);

  // Di che richiesta si tratta: chi ne ha mandate tre in una settimana, dal
  // solo codice non lo distingue.
  box.append(nodo('p', 'piccolo tenue', NOME_TIPO[r.tipo] || NOME_TIPO.medicina));

  if (r.farmaci) {
    const elenco = nodo('p', null, r.farmaci);
    elenco.style.whiteSpace = 'pre-line';
    box.append(elenco);
  }

  // Se aveva mandato una foto lo diciamo: e' la conferma che il documento e'
  // arrivato, che altrimenti dovrebbe chiedere per telefono.
  if (r.allegati) {
    box.append(nodo('p', 'piccolo', r.allegati === 1
      ? 'Abbiamo ricevuto il documento che hai allegato.'
      : `Abbiamo ricevuto i ${r.allegati} documenti che hai allegato.`));
  }

  // Il numero della ricetta e' quello che serve in farmacia.
  if (r.numero_ricetta) {
    box.append(nodo('p', null, `Numero della ricetta: ${r.numero_ricetta}`));
  }

  box.append(nodo('p', 'piccolo tenue', `Richiesta del ${new Date(r.creata_il).toLocaleDateString('it-IT')}`));
  return box;
}

// ---- Chatbot ---------------------------------------------------------------

const CHIAVE_SESSIONE = 'studio-medico-chat';

/**
 * Chi risponde al paziente: la sessione vive nel browser, la conversazione nel
 * server. Il riquadro non sa niente di tutto questo, e va bene cosi': cambiare
 * il modo di parlare col server non deve voler dire rimettere mano alle bolle.
 */
function motorePaziente() {
  let sessioneId = localStorage.getItem(CHIAVE_SESSIONE) || '';

  const ricorda = (dati) => {
    sessioneId = dati.sessioneId;
    localStorage.setItem(CHIAVE_SESSIONE, sessioneId);
    return dati;
  };

  return {
    apri: async () => ricorda(await api(`/chat?sessione=${encodeURIComponent(sessioneId)}`)),
    invia: async (contenuto, etichetta) => ricorda(await api('/chat', {
      method: 'POST',
      body: { sessione: sessioneId, testo: contenuto, etichetta }
    }))
  };
}

/**
 * Il riquadro per allegare la prescrizione, dentro la conversazione.
 *
 * Non e' un modulo: e' un bottone e basta. Chi arriva qui ha appena finito di
 * scrivere e ha il telefono in mano, quindi la strada piu' corta e' scattare la
 * foto sul posto. Se qualcosa va storto la richiesta resta comunque valida e il
 * messaggio lo dice, altrimenti uno pensa di aver perso tutto e ricomincia.
 */
function riquadroAllega(codice, vista) {
  const riquadro = nodo('div', 'bolla bot allega-chat');
  riquadro.append(nodo('span', 'piccolo tenue', '📎 Allega la richiesta dello specialista (foto o PDF)'));

  const campo = nodo('input');
  campo.type = 'file';
  campo.accept = 'image/*,application/pdf';
  campo.multiple = true;
  campo.className = 'piccolo';
  riquadro.append(campo);

  const esito = nodo('p', 'piccolo tenue');
  riquadro.append(esito);

  campo.addEventListener('change', async () => {
    if (!campo.files.length) return;
    campo.disabled = true;
    esito.className = 'piccolo tenue';
    esito.textContent = 'Sto caricando…';
    try {
      await inviaAllegati(codice, campo);
      esito.textContent = campo.files.length === 1
        ? '✅ Allegato caricato: lo studio lo vedrà insieme alla richiesta.'
        : `✅ ${campo.files.length} allegati caricati: lo studio li vedrà insieme alla richiesta.`;
      campo.remove();
    } catch (err) {
      esito.className = 'piccolo errore';
      esito.textContent = err.message;
      campo.disabled = false;
    }
    vista.scorri();
  });

  return riquadro;
}

function collegaChat() {
  montaChat({
    titolo: 'Assistente',
    sottotitolo: 'Studio Dottoressa Braglia',
    etichettaApri: '💬 Assistente',
    modi: [{ id: 'paziente', etichetta: 'Assistente', motore: motorePaziente() }],

    suRisposta(dati, vista) {
      // Solo per le richieste con allegato: la richiesta e' appena nata e ha un
      // codice, quindi la foto della prescrizione ha dove attaccarsi. Il bottone
      // compare dentro la conversazione perche' chi sta parlando col chatbot non
      // deve uscire, andare a cercare il modulo sul sito e ricominciare da capo.
      if (dati.allegaA) vista.aggiungi(riquadroAllega(dati.allegaA, vista));

      // Una prenotazione nata in chat cambia le disponibilità mostrate nella pagina.
      if (dati.prenotazione) {
        caricaMese();
        if (stato.dataScelta) scegliGiorno(stato.dataScelta);
      }
    }
  });
}

// ---- Navigazione -----------------------------------------------------------

function collegaNavigazione() {
  const sezioni = $$('main section[id]');
  const voci = $$('.menu a[data-sezione]');

  const osservatore = new IntersectionObserver((voci_visibili) => {
    for (const v of voci_visibili) {
      if (!v.isIntersecting) continue;
      voci.forEach((a) => a.classList.toggle('attivo', a.dataset.sezione === v.target.id));
    }
  }, { rootMargin: '-45% 0px -45% 0px' });

  sezioni.forEach((s) => osservatore.observe(s));
}

// ---- Avvio -----------------------------------------------------------------

let sitoAvviato = false;

let profiloPazienteCorrente = null;

/** Entra nel sito vero: la prima volta ne monta anche tutte le parti. */
async function entraNelSito(utente) {
  $('#nome-utente-paziente').textContent = utente?.nome || utente?.email || 'Account';
  mostraSchermataPaziente('sito');

  if (sitoAvviato) return;
  sitoAvviato = true;

  const oggi = isoOggi();
  const [anno, mese] = oggi.split('-').map(Number);
  stato.meseVisibile = { anno, mese: mese - 1 };

  collegaNavigazione();
  collegaFormPrenotazione();
  collegaFormMedicine();
  collegaFormRicerca();
  collegaChat();

  $('#mese-precedente').addEventListener('click', () => cambiaMese(-1));
  $('#mese-successivo').addEventListener('click', () => cambiaMese(1));

  $('#scelta-ambulatorio').addEventListener('change', (e) => {
    stato.ambulatorioId = Number(e.target.value);
    stato.dataScelta = null;
    stato.slotScelto = null;
    $('#modulo-prenotazione').classList.add('nascosto');
    $('#contenitore-fasce').replaceChildren(
      nodo('p', 'tenue piccolo', 'Scegli un giorno dal calendario.'));
    caricaMese();
  });

  try {
    await caricaAmbulatori();
    await caricaMese();
  } catch (err) {
    avvisa(err.message, 'errore');
  }
}

async function avvia() {
  collegaAccessoPaziente();

  if (tokenPaziente) {
    try {
      const { utente } = await api('/auth/me');
      if (utente?.ruolo === 'paziente' && utente.paziente_id) return entraNelSito(utente);
    } catch { /* token scaduto o non valido: si torna all'accesso */ }
    tokenPaziente = '';
    try { sessionStorage.removeItem(CHIAVE_TOKEN_PAZIENTE); } catch { /* ignora */ }
  }
  mostraSchermataPaziente('accesso');
}

avvia();
