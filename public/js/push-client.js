/**
 * Notifiche push sul dispositivo: pezzo di codice comune al sito e al
 * pannello, cosi' la logica di iscrizione non va scritta (e mantenuta) due
 * volte. Chi lo usa passa il proprio pulsante e la propria funzione `api`
 * gia' pronta a parlare col server con le credenziali giuste.
 */

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
