/**
 * Tre cose in comune fra sito e pannello, tutte legate al "diventare
 * un'app" sul telefono: notifiche push, il pulsante "Installa" che offre
 * Chrome/Android, e la nota per chi e' su iPhone (dove l'installazione e le
 * notifiche esistono solo passando da "Aggiungi alla schermata Home", non
 * automaticamente). Un file solo, cosi' la logica non va scritta due volte.
 */

/**
 * Registra il service worker appena la pagina si carica, per chiunque —
 * anche prima del login. Serve a farsi riconoscere come "installabile" da
 * subito: se lo si registrasse solo al momento di attivare le notifiche,
 * chi non le attiva mai non vedrebbe mai il pulsante "Installa".
 */
export function registraServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw-push.js').catch(() => { /* niente di grave: si riprova dopo */ });
  }
}

/** true su iPhone/iPad — anche su iPadOS recenti, che si presentano come "Mac" ma con lo schermo touch. */
function suIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Mostra l'elemento (di solito una nota) solo su iPhone/iPad. */
export function mostraSuIOS(elemento) {
  if (elemento && suIOS()) elemento.hidden = false;
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
export async function collegaNotifiche(bottone, api) {
  if (!bottone) return;

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return; // Il pulsante resta nascosto: su questo browser non si puo' fare.
  }
  if (Notification.permission === 'denied') return;

  let registrazione;
  try {
    registrazione = await navigator.serviceWorker.register('/sw-push.js');
    if (await registrazione.pushManager.getSubscription()) return; // gia' iscritto
  } catch {
    return; // Niente service worker, niente pulsante: non si spiegherebbe l'errore a nessuno.
  }

  bottone.hidden = false;
  bottone.addEventListener('click', async () => {
    bottone.disabled = true;
    try {
      const { chiave } = await api('/push/chiave-pubblica');
      const permesso = await Notification.requestPermission();
      if (permesso !== 'granted') { bottone.hidden = true; return; }

      const iscrizione = await registrazione.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: chiaveComeBytes(chiave)
      });
      await api('/push/iscrivi', { method: 'POST', body: { iscrizione: iscrizione.toJSON() } });
      bottone.hidden = true;
    } catch (err) {
      console.error('[notifiche]', err);
      bottone.disabled = false;
    }
  });
}
