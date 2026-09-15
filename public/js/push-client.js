/**
 * Tre cose in comune fra sito e pannello, tutte legate al "diventare
 * un'app" sul telefono: notifiche push, il pulsante "Installa" che offre
 * Chrome/Android, e la nota per chi e' su iPhone (dove l'installazione e le
 * notifiche esistono solo passando da "Aggiungi alla schermata Home", non
 * automaticamente). Un file solo, cosi' la logica non va scritta due volte.
 */

/**
 * Il banner "è disponibile una versione più recente", con un pulsante per
 * aggiornare subito — come fa Gmail. Un service worker nuovo (dopo un
 * deploy) di norma resta "in attesa" finche' non si chiudono tutte le
 * schede aperte, per non interrompere di sorpresa chi sta compilando un
 * modulo: qui si salta l'attesa solo quando l'utente lo chiede esplicitamente.
 */
// Diventa true solo nell'istante in cui si clicca "Aggiorna": e' quello che
// distingue un cambio di service worker chiesto dall'utente da uno che il
// browser decide da solo in background (es. riprendendo un'app rimasta a
// lungo in secondo piano) — solo il primo deve far ricaricare la pagina.
let aggiornamentoRichiesto = false;

function mostraBannerAggiornamento(registrazione) {
  if (document.getElementById('banner-aggiornamento')) return; // gia' mostrato
  const banner = document.createElement('div');
  banner.id = 'banner-aggiornamento';
  banner.className = 'banner-aggiornamento';

  const testo = document.createElement('span');
  testo.textContent = 'È disponibile una versione più recente.';
  const bottone = document.createElement('button');
  bottone.type = 'button';
  bottone.textContent = 'Aggiorna';
  bottone.addEventListener('click', () => {
    aggiornamentoRichiesto = true;
    registrazione.waiting?.postMessage('salta-attesa');
    banner.remove();
  });

  banner.append(testo, bottone);
  document.body.append(banner);
}

/**
 * Registra il service worker appena la pagina si carica, per chiunque —
 * anche prima del login. Serve a farsi riconoscere come "installabile" da
 * subito: se lo si registrasse solo al momento di attivare le notifiche,
 * chi non le attiva mai non vedrebbe mai il pulsante "Installa".
 *
 * Collega anche l'aggiornamento automatico: appena il nuovo service worker
 * prende il controllo (dopo il click su "Aggiorna"), la pagina si ricarica
 * da sola — un solo tocco, non serve saperlo fare a mano.
 */
export function registraServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('/sw-push.js').then((registrazione) => {
    const avvisaSeInAttesa = () => {
      // "controller" presente = non e' la primissima visita: c'era gia' un
      // service worker attivo, quindi questo e' davvero un aggiornamento.
      if (registrazione.waiting && navigator.serviceWorker.controller) {
        mostraBannerAggiornamento(registrazione);
      }
    };
    avvisaSeInAttesa();

    registrazione.addEventListener('updatefound', () => {
      registrazione.installing?.addEventListener('statechange', function () {
        if (this.state === 'installed') avvisaSeInAttesa();
      });
    });

    // Il browser controlla da solo, ma non spesso: un controllo ogni po' fa
    // comparire il banner in tempi ragionevoli anche a scheda tenuta aperta
    // a lungo (tipico del pannello), invece di aspettare la prossima visita.
    setInterval(() => registrazione.update().catch(() => {}), 10 * 60 * 1000);
  }).catch(() => { /* niente di grave: si riprova dopo */ });

  // Si ricarica SOLO se il cambio di controller e' stato chiesto col click su
  // "Aggiorna": un cambio "spontaneo" non deve far sparire una pagina che
  // nessuno ha chiesto di ricaricare — e non deve nemmeno essere scambiato
  // per un buon motivo per considerare l'iscrizione alle notifiche perduta.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!aggiornamentoRichiesto) return;
    aggiornamentoRichiesto = false;
    location.reload();
  });
}

/** true su iPhone/iPad — anche su iPadOS recenti, che si presentano come "Mac" ma con lo schermo touch. */
function suIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * true se il sito gira gia' come app installata (aperta dall'icona sulla
 * schermata Home), non dentro una scheda di Safari. Su iPhone/iPad questo e'
 * `navigator.standalone`; altrove (Chrome/Edge) e' lo standard
 * `display-mode: standalone`.
 */
function giaInstallato() {
  return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * Mostra l'elemento (di solito la nota su come installare) solo su
 * iPhone/iPad, e solo se non e' gia' installato: chi la vede gia' aperta
 * dall'icona sulla Home non deve leggere "aggiungila alla schermata Home",
 * confonderebbe soltanto.
 */
export function mostraSuIOS(elemento) {
  if (elemento && suIOS() && !giaInstallato()) elemento.hidden = false;
}

// Chrome (Android e computer) avvisa quando il sito e' pronto per essere
// installato come app. L'evento arriva anche prima che qualcuno chiami
// collegaInstallazione, quindi va intercettato subito, non dentro la
// funzione: altrimenti un pulsante creato dopo lo perderebbe per sempre.
let promptInstallazione = null;
window.addEventListener('beforeinstallprompt', (evento) => {
  evento.preventDefault();
  promptInstallazione = evento;
  document.dispatchEvent(new CustomEvent('app-installabile'));
});
window.addEventListener('appinstalled', () => { promptInstallazione = null; });

/**
 * Il pulsante "Installa l'app": esiste solo su Chrome/Edge (Android e
 * computer). Su iPhone questo evento non arriva mai — li' l'installazione e'
 * un gesto manuale (Condividi → Aggiungi alla schermata Home), spiegato
 * dalla nota che mostra mostraSuIOS.
 */
export function collegaInstallazione(bottone) {
  if (!bottone) return;
  const mostraSeIdoneo = () => { if (promptInstallazione) bottone.hidden = false; };
  mostraSeIdoneo();
  document.addEventListener('app-installabile', mostraSeIdoneo);

  bottone.addEventListener('click', async () => {
    if (!promptInstallazione) return;
    bottone.hidden = true;
    const scelta = promptInstallazione;
    promptInstallazione = null;
    scelta.prompt();
    await scelta.userChoice; // non serve leggere l'esito: il pulsante e' gia' sparito
  });
}

/** Il server manda la chiave in base64url; il browser la vuole come bytes. */
function chiaveComeBytes(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const testo = atob(base64);
  const byte = new Uint8Array(testo.length);
  for (let i = 0; i < testo.length; i++) byte[i] = testo.charCodeAt(i);
  return byte;
}

/**
 * Mostra il pulsante solo se ha senso premerlo: il browser deve supportare le
 * notifiche, il permesso non deve essere gia' stato negato in passato, e non
 * deve esserci gia' un'iscrizione attiva su questo dispositivo. Dopo il click
 * il pulsante sparisce comunque, riuscito o no: uno che resta li' dopo un
 * rifiuto confonderebbe soltanto ("perche' non succede niente?").
 */
export async function collegaNotifiche(bottone, api, avvisa) {
  if (!bottone) return;
  const dillo = (messaggio) => { console.error('[notifiche]', messaggio); avvisa?.(messaggio, 'errore'); };

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return; // Il pulsante resta nascosto: su questo browser non si puo' fare.
  }
  if (Notification.permission === 'denied') return;

  let registrazione;
  try {
    await navigator.serviceWorker.register('/sw-push.js');
    // .ready aspetta che per questa pagina ci sia davvero un service worker
    // ATTIVO, non solo registrato: subito dopo un'apertura "a freddo" (tipico
    // di iOS, dopo aver chiuso del tutto l'app dal multitasking) .register()
    // puo' risolvere un attimo prima che lo sia ancora, e interrogare
    // getSubscription() in quel momento puo' dare "non iscritto" anche
    // quando l'iscrizione c'e' ed e' valida — da qui il pulsante che
    // ricompare senza che le notifiche si siano davvero disattivate.
    registrazione = await navigator.serviceWorker.ready;
    if (await registrazione.pushManager.getSubscription()) return; // gia' iscritto
  } catch (err) {
    dillo(`Non riesco a registrare il service worker: ${err.message}`);
    return; // Niente service worker, niente pulsante: non si spiegherebbe l'errore a nessuno.
  }

  bottone.hidden = false;
  bottone.addEventListener('click', async () => {
    bottone.disabled = true;
    try {
      // Il permesso va chiesto SUBITO, come prima cosa: Safari/iOS lo lega al
      // gesto dell'utente (il click) e, se in mezzo c'e' anche una sola await
      // di rete prima, considera il gesto "scaduto" e ignora la richiesta in
      // silenzio, senza mostrare nessun popup e senza un errore da intercettare.
      const permesso = await Notification.requestPermission();
      if (permesso !== 'granted') {
        dillo(`Permesso non concesso (stato: ${permesso}). Le notifiche restano disattivate.`);
        bottone.hidden = true;
        return;
      }

      const { chiave } = await api('/push/chiave-pubblica');
      const iscrizione = await registrazione.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: chiaveComeBytes(chiave)
      });
      await api('/push/iscrivi', { method: 'POST', body: { iscrizione: iscrizione.toJSON() } });
      bottone.hidden = true;
      avvisa?.('Notifiche attivate.', 'ok');
    } catch (err) {
      dillo(`Non sono riuscito ad attivare le notifiche: ${err.message}`);
      bottone.disabled = false;
    }
  });
}
