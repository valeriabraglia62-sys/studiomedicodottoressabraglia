# Piano di Test per il Sistema di Prenotazioni Mediche

## 1. Test del Frontend

### 1.1 Test della Visualizzazione
- Verificare che la pagina principale mostri correttamente gli orari degli ambulatori
- Verificare che il design sia responsive su diversi dispositivi (desktop, tablet, mobile)
- Verificare che tutti i link di navigazione funzionino correttamente

### 1.2 Test del Calendario
- Verificare che il calendario mostri correttamente i giorni disponibili
- Verificare che i giorni non lavorativi (sabato e domenica) siano disabilitati
- Verificare che i giorni passati siano disabilitati
- Verificare che la navigazione tra i mesi funzioni correttamente

### 1.3 Test degli Slot di Prenotazione
- Verificare che vengano mostrati solo gli slot disponibili per la data selezionata
- Verificare che gli slot rispettino gli orari degli ambulatori
- Verificare che ogni slot abbia una durata di 30 minuti
- Verificare che venga mostrato correttamente l'ambulatorio per ogni slot

### 1.4 Test del Form di Prenotazione
- Verificare che tutti i campi obbligatori siano validati
- Verificare che l'email sia validata correttamente
- Verificare che il telefono sia validato correttamente
- Verificare che il riepilogo dei dati prima dell'invio sia corretto

### 1.5 Test della Conferma
- Verificare che venga mostrato un messaggio di conferma dopo la prenotazione
- Verificare che i dati nella conferma siano corretti

## 2. Test del Backend

### 2.1 Test del Database
- Verificare che le tabelle siano create correttamente
- Verificare che le relazioni tra le tabelle funzionino correttamente
- Verificare che gli indici siano creati correttamente

### 2.2 Test delle API
- Verificare che l'API per ottenere gli slot disponibili funzioni correttamente
- Verificare che l'API per creare una prenotazione funzioni correttamente
- Verificare che l'API per l'autenticazione funzioni correttamente
- Verificare che l'API per ottenere le prenotazioni funzioni correttamente
- Verificare che l'API per cancellare una prenotazione funzioni correttamente

### 2.3 Test della Logica di Business
- Verificare che non sia possibile prenotare uno slot già occupato
- Verificare che gli slot vengano marcati come non disponibili dopo la prenotazione
- Verificare che gli slot vengano marcati come disponibili dopo la cancellazione

## 3. Test del Sistema di Notifiche

### 3.1 Test delle Email di Conferma
- Verificare che venga inviata un'email all'amministratore per ogni nuova prenotazione
- Verificare che l'email contenga tutti i dati della prenotazione
- Verificare che l'email venga inviata all'indirizzo corretto (valeriabraglia62@gmail.com)

### 3.2 Test dei Promemoria
- Verificare che venga inviato un promemoria 1 ora prima della visita
- Verificare che il promemoria contenga tutti i dati della prenotazione
- Verificare che il promemoria venga inviato all'indirizzo corretto

### 3.3 Test del Cron Job
- Verificare che il cron job per l'invio dei promemoria funzioni correttamente
- Verificare che i promemoria vengano inviati solo una volta

## 4. Test del Pannello Amministratore

### 4.1 Test dell'Autenticazione
- Verificare che sia possibile accedere con le credenziali corrette
- Verificare che non sia possibile accedere con credenziali errate
- Verificare che il token JWT funzioni correttamente
- Verificare che il logout funzioni correttamente

### 4.2 Test della Dashboard
- Verificare che le statistiche vengano mostrate correttamente
- Verificare che i grafici vengano generati correttamente
- Verificare che le prenotazioni recenti vengano mostrate correttamente
- Verificare che le prenotazioni di oggi vengano mostrate correttamente

### 4.3 Test della Gestione delle Prenotazioni
- Verificare che sia possibile visualizzare i dettagli di una prenotazione
- Verificare che sia possibile cancellare una prenotazione
- Verificare che dopo la cancellazione lo slot torni disponibile

## 5. Test di Integrazione

### 5.1 Test del Flusso Completo
- Verificare il flusso completo dalla prenotazione alla visualizzazione nel pannello amministratore
- Verificare che l'email di conferma venga inviata correttamente
- Verificare che il promemoria venga inviato correttamente
- Verificare che la cancellazione di una prenotazione funzioni correttamente

### 5.2 Test di Carico
- Verificare il comportamento del sistema con più prenotazioni contemporanee
- Verificare il comportamento del sistema con molte prenotazioni nel database

## 6. Test di Sicurezza

### 6.1 Test di Validazione Input
- Verificare che tutti gli input vengano validati correttamente
- Verificare che non sia possibile effettuare SQL injection
- Verificare che non sia possibile effettuare XSS

### 6.2 Test di Autenticazione
- Verificare che le pagine protette non siano accessibili senza autenticazione
- Verificare che il token JWT non possa essere manipolato
- Verificare che la password dell'amministratore sia memorizzata in modo sicuro
