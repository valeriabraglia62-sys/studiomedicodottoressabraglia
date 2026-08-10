/**
 * Sito pubblico. Il server è l'unica fonte di verità sulle disponibilità:
 * qui non si ricalcola nessun orario, si mostra solo ciò che l'API risponde.
 */

const $ = (sel, dove = document) => dove.querySelector(sel);
const $$ = (sel, dove = document) => [...dove.querySelectorAll(sel)];

const NOMI_MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const NOMI_GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const INIZIALI_GIORNI = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];

// ---- Utilità ---------------------------------------------------------------

async function api(percorso, opzioni = {}) {
  const risposta = await fetch(`/api${percorso}`, {
    headers: opzioni.body ? { 'Content-Type': 'application/json' } : {},
    ...opzioni,
    body: opzioni.body ? JSON.stringify(opzioni.body) : undefined
  });

  let dati = {};
  try { dati = await risposta.json(); } catch { /* risposta non JSON: gestita sotto */ }

  if (!risposta.ok || dati.success === false) {
    throw new Error(dati.message || 'Problema di collegamento. Controlla la rete e riprova.');
  }
  return dati;
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

/** Valida i campi con una regola nota; restituisce true se il modulo è a posto. */
function validaModulo(form) {
  let primoErrore = null;

  for (const campo of $$('input, textarea', form)) {
    const regola = REGOLE[campo.name];
    if (!regola) continue;
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
    campo.addEventListener('blur', () => segnalaCampo(campo, regola(campo.value)));
    campo.addEventListener('input', () => {
      if (campo.closest('.campo')?.classList.contains('errore')) {
        segnalaCampo(campo, regola(campo.value));
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
      avvisa('Prenotazione confermata.', 'ok');
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
  const box = nodo('div', 'avviso ok');
  box.append(nodo('strong', null, `Prenotazione confermata — codice ${p.codice}`));
  box.append(nodo('p', 'piccolo',
    `${dataEstesa(p.data)} alle ${p.ora_inizio} · ${p.ambulatorio.nome}, ${p.ambulatorio.indirizzo}`));
  box.append(nodo('p', 'piccolo',
    'Conserva il codice: ti serve per controllare o annullare la prenotazione.' +
    (p.paziente.email ? ' Ti abbiamo inviato una email di conferma.' : '')));

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

// ---- Richiesta medicinali --------------------------------------------------

function collegaFormMedicine() {
  const form = $('#form-medicine');
  validazioneDalVivo(form);

  form.addEventListener('submit', (evento) => {
    evento.preventDefault();
    if (!validaModulo(form)) return;

    inviaProtetto(form, async () => {
      const { richiesta } = await api('/medicine', { method: 'POST', body: datiModulo(form) });
      form.reset();

      const box = nodo('div', 'avviso ok');
      box.append(nodo('strong', null, `Richiesta registrata — codice ${richiesta.codice}`));
      box.append(nodo('p', 'piccolo',
        'Ti avviseremo quando la ricetta sarà pronta per il ritiro. Conserva il codice per controllarne lo stato.'));
      form.parentElement.prepend(box);
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });

      avvisa('Richiesta inviata.', 'ok');
    });
  });
}

// ---- Ricerca e annullamento ------------------------------------------------

function collegaFormRicerca() {
  const form = $('#form-ricerca');
  const campo = $('#codice-ricerca');
  const esito = $('#esito-ricerca');

  form.addEventListener('submit', (evento) => {
    evento.preventDefault();
    const codice = campo.value.trim().toUpperCase();

    if (!/^(PRE|MED)-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codice)) {
      segnalaCampo(campo, 'Il codice ha la forma PRE-XXXX-XXXX o MED-XXXX-XXXX.');
      return;
    }
    segnalaCampo(campo, '');

    inviaProtetto(form, async () => {
      esito.replaceChildren(nodo('p', 'tenue piccolo', 'Cerco…'));
      if (codice.startsWith('MED')) {
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

  if (p.stato !== 'confermata') return box;

  const azioni = nodo('div', 'azioni');
  azioni.append(bottoneCalendario(p, 'bottone secondario'));

  if (!annullabile) {
    box.append(nodo('div', 'avviso attenzione',
      `Manca meno di un'ora all'appuntamento: per annullare chiama lo ${p.ambulatorio.telefono}.`));
    box.append(azioni);
    return box;
  }

  const pulsante = nodo('button', 'bottone pericolo', 'Annulla la prenotazione');
  pulsante.type = 'button';
  pulsante.addEventListener('click', async () => {
    if (!confirm('Vuoi davvero annullare questa prenotazione?')) return;
    pulsante.disabled = true;
    try {
      const { prenotazione } = await api(`/prenotazioni/${p.codice}/annulla`, { method: 'POST' });
      $('#esito-ricerca').replaceChildren(schedaPrenotazione(prenotazione, false));
      avvisa('Prenotazione annullata. Il posto è tornato disponibile.', 'ok');
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

function schedaRichiesta(r) {
  const box = nodo('div', 'carta');
  const testata = nodo('div');
  testata.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:1rem';
  testata.append(nodo('strong', null, r.codice), nodo('span', `etichetta ${r.stato}`, r.etichetta || r.stato));
  box.append(testata);
  const elenco = nodo('p', null, r.farmaci);
  elenco.style.whiteSpace = 'pre-line';
  box.append(elenco);
  box.append(nodo('p', 'piccolo tenue', `Richiesta del ${new Date(r.creata_il).toLocaleDateString('it-IT')}`));
  return box;
}

// ---- Chatbot ---------------------------------------------------------------

const CHIAVE_SESSIONE = 'studio-medico-chat';

const chat = {
  sessioneId: localStorage.getItem(CHIAVE_SESSIONE) || '',
  avviata: false,
  inCorso: false
};

function bolla(ruolo, contenuto) {
  const el = nodo('div', `bolla ${ruolo === 'utente' ? 'utente' : 'bot'}`);
  // Il grassetto **così** è l'unica formattazione: tutto il resto resta testo.
  for (const [i, pezzo] of testo(contenuto).split(/\*\*(.+?)\*\*/gs).entries()) {
    if (!pezzo) continue;
    el.append(i % 2 ? nodo('strong', null, pezzo) : document.createTextNode(pezzo));
  }
  $('#chat-corpo').append(el);
  $('#chat-corpo').scrollTop = $('#chat-corpo').scrollHeight;
  return el;
}

function disegnaAzioniChat(azioni = []) {
  const contenitore = $('#chat-azioni');
  contenitore.replaceChildren(...azioni.map((a) => {
    const b = nodo('button', null, a.etichetta);
    b.type = 'button';
    b.addEventListener('click', () => inviaChat(a.id, a.etichetta));
    return b;
  }));
}

async function avviaChat() {
  if (chat.avviata) return;
  chat.avviata = true;

  try {
    const dati = await api(`/chat?sessione=${encodeURIComponent(chat.sessioneId)}`);
    chat.sessioneId = dati.sessioneId;
    localStorage.setItem(CHIAVE_SESSIONE, dati.sessioneId);

    $('#chat-corpo').replaceChildren();
    for (const m of dati.cronologia || []) bolla(m.ruolo, m.testo);

    if (dati.ripresa) {
      const nota = nodo('div', 'bolla bot', '↑ Riprendiamo da dove eravamo rimasti.');
      nota.style.opacity = '.7';
      $('#chat-corpo').append(nota);
    }
    disegnaAzioniChat(dati.azioni);
  } catch (err) {
    chat.avviata = false;
    bolla('bot', `Non riesco a collegarmi: ${err.message}`);
  }
}

async function inviaChat(testoMessaggio, etichettaVisibile) {
  const contenuto = String(testoMessaggio || '').trim();
  if (!contenuto || chat.inCorso) return;

  chat.inCorso = true;
  bolla('utente', etichettaVisibile || contenuto);
  disegnaAzioniChat([]);
  $('#chat-testo').value = '';

  const attesa = bolla('bot', '…');

  try {
    const dati = await api('/chat', {
      method: 'POST',
      body: { sessione: chat.sessioneId, testo: contenuto, etichetta: etichettaVisibile || '' }
    });
    chat.sessioneId = dati.sessioneId;
    localStorage.setItem(CHIAVE_SESSIONE, dati.sessioneId);

    attesa.remove();
    bolla('bot', dati.testo);
    disegnaAzioniChat(dati.azioni);

    // Una prenotazione nata in chat cambia le disponibilità mostrate nella pagina.
    if (dati.prenotazione) {
      caricaMese();
      if (stato.dataScelta) scegliGiorno(stato.dataScelta);
    }
  } catch (err) {
    attesa.remove();
    bolla('bot', `Problema di collegamento: ${err.message}. Riprova tra un istante.`);
  } finally {
    chat.inCorso = false;
    $('#chat-testo').focus();
  }
}

function collegaChat() {
  const pannello = $('#chat');
  const apri = $('#chat-apri');

  const mostra = (visibile) => {
    pannello.classList.toggle('nascosto', !visibile);
    apri.classList.toggle('nascosto', visibile);
    if (visibile) { avviaChat(); $('#chat-testo').focus(); }
  };

  apri.addEventListener('click', () => mostra(true));
  $('#chat-chiudi').addEventListener('click', () => mostra(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pannello.classList.contains('nascosto')) mostra(false);
  });

  $('#chat-form').addEventListener('submit', (evento) => {
    evento.preventDefault();
    inviaChat($('#chat-testo').value);
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

async function avvia() {
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

avvia();
