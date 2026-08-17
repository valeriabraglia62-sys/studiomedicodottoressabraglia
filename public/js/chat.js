/**
 * Il riquadro di conversazione, condiviso fra il sito e il pannello.
 *
 * Sta qui perche' di chatbot ce ne sono tre: quello dei pazienti sul sito,
 * quello dei pazienti dentro il pannello (per chi risponde al telefono) e
 * l'assistente dell'amministratore. Le bolle, i bottoni, il campo di scrittura
 * e il "sto pensando" sono identici in tutti e tre; a cambiare e' solo chi
 * risponde. Copiare il riquadro nelle due pagine voleva dire correggere ogni
 * inezia due volte, e prima o poi correggerla in una sola.
 *
 * Il riquadro si costruisce da solo in JavaScript invece di stare nell'HTML:
 * cosi' le due pagine non devono tenere allineate venti righe di markup che
 * nessuna delle due legge mai.
 */

const nodo = (tag, classe, contenuto) => {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (contenuto != null) el.textContent = contenuto;
  return el;
};

/**
 * Monta il riquadro e restituisce i comandi per aprirlo e chiuderlo.
 *
 * modi: uno o piu' interlocutori, ognuno con il suo motore. Con un modo solo la
 * fila di linguette non compare, e il riquadro e' quello di sempre.
 * Ogni motore e': { apri(), invia(testo, etichetta) } e torna { testo, azioni }.
 */
export function montaChat({
  titolo = 'Assistente',
  sottotitolo = '',
  etichettaApri = '💬 Assistente',
  modi = [],
  suRisposta = null
}) {
  let modo = modi[0];
  let inCorso = false;
  const avviati = new Set();

  const apriBtn = nodo('button', 'chat-apri', etichettaApri);
  apriBtn.type = 'button';

  const pannello = nodo('div', 'chat nascosto');
  pannello.setAttribute('role', 'dialog');
  pannello.setAttribute('aria-label', titolo);

  const testata = nodo('div', 'chat-testata');
  const titoli = nodo('div');
  titoli.append(nodo('strong', null, titolo));
  if (sottotitolo) titoli.append(document.createElement('br'), nodo('span', 'stato', sottotitolo));
  const chiudiBtn = nodo('button', null, '×');
  chiudiBtn.type = 'button';
  chiudiBtn.setAttribute('aria-label', 'Chiudi');
  testata.append(titoli, chiudiBtn);

  const linguette = nodo('div', 'chat-modi');
  const corpo = nodo('div', 'chat-corpo');
  const azioni = nodo('div', 'chat-azioni');

  const piede = nodo('form', 'chat-piede');
  const campo = nodo('input');
  campo.placeholder = 'Scrivi qui…';
  campo.autocomplete = 'off';
  const invia = nodo('button', null, '↑');
  invia.type = 'submit';
  invia.setAttribute('aria-label', 'Invia');
  piede.append(campo, invia);

  pannello.append(testata, linguette, corpo, azioni, piede);
  document.body.append(apriBtn, pannello);

  // ---- disegno ------------------------------------------------------------

  const scorri = () => { corpo.scrollTop = corpo.scrollHeight; };

  const bolla = (ruolo, contenuto) => {
    const el = nodo('div', `bolla ${ruolo === 'utente' ? 'utente' : 'bot'}`);
    // Il grassetto **cosi'** e' l'unica formattazione: il resto resta testo.
    for (const [i, pezzo] of String(contenuto ?? '').split(/\*\*(.+?)\*\*/gs).entries()) {
      if (!pezzo) continue;
      el.append(i % 2 ? nodo('strong', null, pezzo) : document.createTextNode(pezzo));
    }
    corpo.append(el);
    scorri();
    return el;
  };

  const disegnaAzioni = (elenco = []) => {
    const bottoni = elenco.map((a) => {
      const b = nodo('button', null, a.etichetta);
      b.type = 'button';
      b.addEventListener('click', () => manda(a.id, a.etichetta));
      return b;
    });

    // Chi risponde al telefono ha bisogno di ricominciare da zero a ogni
    // chiamata: la conversazione di prima e' di un'altra persona, e riprenderla
    // vorrebbe dire attaccare i dati del signor Rossi alla richiesta della
    // signora Bianchi.
    if (modo.ricomincia) {
      const r = nodo('button', 'chat-ricomincia', modo.ricomincia);
      r.type = 'button';
      r.addEventListener('click', riparti);
      bottoni.unshift(r);
    }

    azioni.replaceChildren(...bottoni);
  };

  /** Serve a chi ospita il riquadro per infilarci dentro i propri riquadri. */
  const vista = { bolla, aggiungi: (el) => { corpo.append(el); scorri(); }, scorri };

  // ---- conversazione ------------------------------------------------------

  async function avvia() {
    if (avviati.has(modo.id)) return;
    avviati.add(modo.id);
    try {
      const dati = await modo.motore.apri();
      corpo.replaceChildren();
      for (const m of dati.cronologia || []) bolla(m.ruolo, m.testo);
      if (dati.ripresa) {
        const nota = bolla('bot', '↑ Riprendiamo da dove eravamo rimasti.');
        nota.style.opacity = '.7';
      } else if (dati.testo) {
        bolla('bot', dati.testo);
      }
      disegnaAzioni(dati.azioni);
      if (suRisposta) suRisposta(dati, vista, modo.id);
    } catch (err) {
      avviati.delete(modo.id);
      bolla('bot', `Non riesco a collegarmi: ${err.message}`);
    }
  }

  /** Ricomincia la conversazione del modo attuale, dalla prima domanda. */
  function riparti() {
    avviati.delete(modo.id);
    corpo.replaceChildren();
    azioni.replaceChildren();
    avvia();
    campo.focus();
  }

  async function manda(testoMessaggio, etichettaVisibile) {
    const contenuto = String(testoMessaggio || '').trim();
    if (!contenuto || inCorso) return;

    inCorso = true;
    bolla('utente', etichettaVisibile || contenuto);
    disegnaAzioni([]);
    campo.value = '';
    const attesa = bolla('bot', '…');

    try {
      const dati = await modo.motore.invia(contenuto, etichettaVisibile || '');
      attesa.remove();
      bolla('bot', dati.testo);
      disegnaAzioni(dati.azioni);
      if (suRisposta) suRisposta(dati, vista, modo.id);
    } catch (err) {
      attesa.remove();
      bolla('bot', `Problema di collegamento: ${err.message}. Riprova tra un istante.`);
    } finally {
      inCorso = false;
      campo.focus();
    }
  }

  // ---- linguette dei modi -------------------------------------------------

  if (modi.length > 1) {
    for (const m of modi) {
      const b = nodo('button', m === modo ? 'attivo' : null, m.etichetta);
      b.type = 'button';
      b.addEventListener('click', () => {
        if (modo === m) return;
        modo = m;
        for (const altro of linguette.children) altro.classList.remove('attivo');
        b.classList.add('attivo');
        // Ogni modo riparte pulito: mescolare le due conversazioni nella stessa
        // finestra confonderebbe chi legge, perche' le risposte vengono da due
        // interlocutori diversi.
        riparti();
      });
      linguette.append(b);
    }
  } else {
    linguette.remove();
  }

  // ---- apertura e chiusura ------------------------------------------------

  const mostra = (visibile) => {
    pannello.classList.toggle('nascosto', !visibile);
    apriBtn.classList.toggle('nascosto', visibile);
    if (visibile) { avvia(); campo.focus(); }
  };

  apriBtn.addEventListener('click', () => mostra(true));
  chiudiBtn.addEventListener('click', () => mostra(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pannello.classList.contains('nascosto')) mostra(false);
  });
  piede.addEventListener('submit', (e) => { e.preventDefault(); manda(campo.value); });

  return { apri: () => mostra(true), chiudi: () => mostra(false), manda, vista };
}
