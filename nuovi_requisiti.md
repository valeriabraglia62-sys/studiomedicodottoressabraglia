# Analisi dei Nuovi Requisiti per il Sistema di Prenotazioni Mediche

## Requisiti Funzionali Aggiuntivi

### 1. Interfaccia Utente
- Aggiungere un menu a tendina per migliorare la navigazione
- Ottimizzare ulteriormente il sito per tutti i dispositivi (desktop, tablet, mobile)
- Modificare il testo nella homepage da "Sistema semplice e veloce per prenotare visite mediche presso i nostri ambulatori di Arceto e Casalgrande" a "Prenotarsi solo nell'ambulatorio di residenza"

### 2. Autenticazione
- Implementare la registrazione e login tramite account Google
- Implementare la registrazione e login tramite Apple ID
- Configurare l'accesso amministratore con email valeriabraglia62@gmail.com e password [RIMOSSA-DALLA-CRONOLOGIA]

### 3. Sistema di Prenotazioni
- Permettere ai pazienti di annullare la prenotazione fino a un'ora prima della visita
- Permettere all'amministratore di prenotare visite per i suoi pazienti
- Permettere all'amministratore di annullare le prenotazioni

### 4. Notifiche
- Inviare email di conferma al paziente dopo la prenotazione
- Aggiungere automaticamente l'evento al Google Calendar del paziente
- Inviare un avviso al paziente un'ora prima della visita
- Inviare conferma di annullamento via email sia al paziente che all'amministratore

### 5. Informazioni Ambulatori
- Aggiornare l'indirizzo dell'ambulatorio di Arceto: Via Piazza Castello, 10
- Aggiornare l'indirizzo dell'ambulatorio di Casalgrande: Via Canale, 29

## Modifiche alla Struttura del Database

### 1. Tabella `pazienti`
- Aggiungere campo `google_id` per l'autenticazione con Google
- Aggiungere campo `apple_id` per l'autenticazione con Apple
- Aggiungere campo `google_calendar_id` per l'integrazione con Google Calendar

### 2. Tabella `prenotazioni`
- Aggiungere campo `stato` per tracciare lo stato della prenotazione (confermata, annullata)
- Aggiungere campo `data_annullamento` per registrare quando è stata annullata
- Aggiungere campo `annullata_da` per registrare chi ha annullato (paziente o amministratore)
- Aggiungere campo `evento_calendar_id` per l'ID dell'evento in Google Calendar

### 3. Tabella `ambulatori`
- Aggiornare gli indirizzi degli ambulatori

## Modifiche all'Architettura del Sistema

### 1. Autenticazione
- Implementare OAuth 2.0 per Google e Apple
- Gestire i token di autenticazione e le sessioni
- Aggiornare il sistema di autenticazione esistente

### 2. Integrazione con Google Calendar
- Implementare l'API di Google Calendar
- Gestire la creazione, modifica e cancellazione di eventi
- Gestire le autorizzazioni per accedere al calendario del paziente

### 3. Sistema di Notifiche
- Espandere il sistema di notifiche per includere i pazienti
- Implementare diversi tipi di notifiche (conferma, promemoria, annullamento)
- Gestire l'invio di notifiche in base allo stato della prenotazione

## Considerazioni Tecniche

### 1. Autenticazione OAuth
- Registrare l'applicazione su Google Cloud Platform per ottenere le credenziali OAuth
- Registrare l'applicazione su Apple Developer per ottenere le credenziali OAuth
- Implementare il flusso di autenticazione OAuth 2.0

### 2. API Google Calendar
- Utilizzare l'API Google Calendar v3
- Gestire l'autorizzazione con scope calendar.events
- Implementare la creazione e cancellazione di eventi

### 3. Sicurezza
- Proteggere le credenziali OAuth
- Implementare HTTPS per tutte le comunicazioni
- Gestire in modo sicuro i token di accesso

### 4. Interfaccia Utente
- Implementare un design responsive con Bootstrap o framework simili
- Utilizzare JavaScript per il menu a tendina e altre interazioni
- Ottimizzare per diversi dispositivi con media queries

## Priorità di Implementazione

1. Aggiornare le informazioni degli ambulatori e il testo nella homepage
2. Implementare il menu a tendina e ottimizzare per tutti i dispositivi
3. Aggiornare la struttura del database
4. Implementare l'autenticazione con Google e Apple
5. Implementare la funzionalità di annullamento prenotazioni
6. Implementare l'integrazione con Google Calendar
7. Migliorare il sistema di notifiche email
8. Aggiornare il pannello amministratore
9. Testare tutte le nuove funzionalità
10. Aggiornare la documentazione
11. Eseguire il deployment della versione aggiornata
