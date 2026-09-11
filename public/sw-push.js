/**
 * Service worker per le sole notifiche push. Un file solo per sito e
 * pannello: registrato dalla radice ("/"), il suo raggio d'azione copre
 * entrambe le pagine. Non fa cache, non intercetta le richieste: si limita a
 * mostrare l'avviso quando arriva e ad aprire la pagina giusta se lo si tocca.
 */

self.addEventListener('push', (evento) => {
  let dati = {};
  try { dati = evento.data ? evento.data.json() : {}; } catch { /* corpo non JSON, si ignora */ }

  evento.waitUntil(self.registration.showNotification(dati.titolo || 'Studio Medico Dottoressa Braglia', {
    body: dati.corpo || '',
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
