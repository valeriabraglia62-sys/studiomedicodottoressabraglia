/**
 * Service worker per le notifiche push e per una schermata di cortesia
 * quando manca la rete. Un file solo per sito e pannello: registrato dalla
 * radice ("/"), il suo raggio d'azione copre entrambe le pagine.
 *
 * Non tiene in cache pagine, script o stili: chi lo ha gia' installato (ci
 * e' gia' passato almeno una volta) e prova a riaprire il sito senza
 * connessione vede una schermata "sei offline" invece dell'errore secco del
 * browser ("Safari non puo' aprire la pagina..."). Chi apre il sito la prima
 * volta, o chi non ha mai installato/visitato il sito prima, non e' toccato
 * da questo: quell'errore dipende dalla rete del suo dispositivo, non da
 * qui, e non si puo' evitare dal lato del sito.
 */

const PAGINA_OFFLINE = `<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sei offline — Studio Medico Dottoressa Braglia</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#FBF8F3; color:#16221F; font:16px/1.5 -apple-system,system-ui,sans-serif; padding:24px; box-sizing:border-box; }
  .riquadro { max-width:360px; text-align:center; }
  .simbolo { font-size:2.5rem; color:#0D6E6E; }
  h1 { font-size:1.25rem; margin:0.5em 0; }
  p { color:#5B6B6A; margin:0 0 1.5em; }
  button { background:#0D6E6E; color:#fff; border:none; border-radius:0.6em; padding:0.7em 1.4em;
           font-size:1rem; font-weight:600; cursor:pointer; }
</style></head>
<body>
  <div class="riquadro">
    <div class="simbolo" aria-hidden="true">✚</div>
    <h1>Sei offline</h1>
    <p>Non c'e' connessione internet in questo momento. Controlla il Wi-Fi o i dati mobili e riprova.</p>
    <button onclick="location.reload()">Riprova</button>
  </div>
</body></html>`;

self.addEventListener('fetch', (evento) => {
  if (evento.request.mode !== 'navigate') return;
  evento.respondWith(
    fetch(evento.request).catch(() => new Response(PAGINA_OFFLINE, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }))
  );
});

self.addEventListener('push', (evento) => {
  let dati = {};
  try { dati = evento.data ? evento.data.json() : {}; } catch { /* corpo non JSON, si ignora */ }

  evento.waitUntil(self.registration.showNotification(dati.titolo || 'Studio Medico Dottoressa Braglia', {
    body: dati.corpo || '',
    silent: Boolean(dati.silenzioso),
    data: { url: dati.url || '/' }
  }));
});

self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const url = evento.notification.data?.url || '/';

  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((finestre) => {
      const gia_aperta = finestre.find((f) => f.url.includes(url));
      if (gia_aperta) return gia_aperta.focus();
      return self.clients.openWindow(url);
    })
  );
});

/**
 * Aggiornamenti: di norma un service worker nuovo resta "in attesa" finche'
 * non si chiudono tutte le schede aperte, cosi' un deploy non interrompe di
 * sorpresa chi sta compilando un modulo. Qui si salta l'attesa solo su
 * richiesta esplicita — il click su "Aggiorna" nel banner che mostra
 * push-client.js — e si prende subito il controllo delle pagine aperte, cosi'
 * un solo ricaricamento basta a vedere la versione nuova.
 */
self.addEventListener('message', (evento) => {
  if (evento.data === 'salta-attesa') self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(self.clients.claim());
});
