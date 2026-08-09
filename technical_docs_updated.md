# Documentazione Tecnica - Sistema di Prenotazioni Mediche

## Architettura del sistema

Il sistema di prenotazioni mediche è strutturato secondo un'architettura client-server con i seguenti componenti principali:

1. **Frontend**: Interfaccia utente HTML/CSS/JavaScript
2. **Backend**: API PHP per la gestione delle richieste
3. **Database**: MySQL per la persistenza dei dati
4. **Servizi esterni**: Integrazione con Google Calendar e sistemi di autenticazione

### Struttura delle directory

```
medical-booking-system/
├── index.html                  # Homepage e interfaccia utente principale
├── css/                        # Fogli di stile
│   └── style.css               # Stile principale (responsive)
├── js/                         # Script JavaScript frontend
│   ├── script.js               # Funzionalità principali
│   ├── menu.js                 # Gestione menu a tendina
│   └── auth.js                 # Autenticazione Google/Apple
├── admin/                      # Pannello amministratore
│   ├── dashboard.html          # Dashboard amministratore
│   ├── login.html              # Pagina di login
│   ├── css/
│   │   └── admin.css           # Stile del pannello amministratore
│   └── js/
│       ├── admin-base.js       # Funzionalità base del pannello
│       ├── dashboard.js        # Gestione dashboard
│       ├── prenotazioni.js     # Gestione prenotazioni
│       ├── pazienti.js         # Gestione pazienti
│       ├── booking-form.js     # Form di prenotazione
│       └── auth.js             # Autenticazione amministratore
├── backend/                    # Backend PHP
│   ├── api/                    # API endpoints
│   │   ├── prenotazioni.php    # API per le prenotazioni
│   │   ├── ambulatori.php      # API per gli ambulatori
│   │   ├── auth.php            # API per l'autenticazione
│   │   └── dashboard.php       # API per la dashboard
│   ├── config/                 # Configurazione
│   │   ├── config.php          # Configurazione generale
│   │   └── database.php        # Configurazione database
│   ├── models/                 # Modelli dati
│   │   ├── Ambulatorio.php     # Modello ambulatorio
│   │   ├── Slot.php            # Modello slot temporale
│   │   ├── Paziente.php        # Modello paziente
│   │   └── Prenotazione.php    # Modello prenotazione
│   ├── utils/                  # Utilità
│   │   ├── EmailSender.php     # Gestione email
│   │   ├── GoogleCalendarService.php # Integrazione Google Calendar
│   │   └── NotificationManager.php   # Gestione notifiche
│   └── cron/                   # Script per operazioni pianificate
│       └── send_reminders.php  # Invio promemoria
└── img/                        # Immagini e risorse grafiche
```

## Schema del database

Il database è strutturato con le seguenti tabelle:

### Tabella `ambulatori`
- `id` (INT): Identificativo unico
- `nome` (VARCHAR): Nome dell'ambulatorio
- `indirizzo` (VARCHAR): Indirizzo completo
- `created_at` (TIMESTAMP): Data di creazione
- `updated_at` (TIMESTAMP): Data di ultimo aggiornamento

### Tabella `slots`
- `id` (INT): Identificativo unico
- `ambulatorio_id` (INT): Riferimento all'ambulatorio
- `data` (DATE): Data dello slot
- `ora_inizio` (TIME): Orario di inizio
- `ora_fine` (TIME): Orario di fine
- `disponibile` (BOOLEAN): Disponibilità dello slot
- `created_at` (TIMESTAMP): Data di creazione
- `updated_at` (TIMESTAMP): Data di ultimo aggiornamento

### Tabella `pazienti`
- `id` (INT): Identificativo unico
- `nome` (VARCHAR): Nome del paziente
- `cognome` (VARCHAR): Cognome del paziente
- `email` (VARCHAR): Email del paziente
- `telefono` (VARCHAR): Numero di telefono
- `google_id` (VARCHAR): ID Google (per autenticazione)
- `apple_id` (VARCHAR): ID Apple (per autenticazione)
- `created_at` (TIMESTAMP): Data di creazione
- `updated_at` (TIMESTAMP): Data di ultimo aggiornamento

### Tabella `prenotazioni`
- `id` (INT): Identificativo unico
- `paziente_id` (INT): Riferimento al paziente
- `slot_id` (INT): Riferimento allo slot
- `problema` (TEXT): Descrizione del problema
- `stato` (ENUM): Stato della prenotazione ('confermata', 'annullata')
- `evento_calendar_id` (VARCHAR): ID dell'evento in Google Calendar
- `cancellato_da` (ENUM): Chi ha annullato ('paziente', 'amministratore')
- `data_cancellazione` (TIMESTAMP): Data di annullamento
- `created_at` (TIMESTAMP): Data di creazione
- `updated_at` (TIMESTAMP): Data di ultimo aggiornamento

### Tabella `promemoria`
- `id` (INT): Identificativo unico
- `prenotazione_id` (INT): Riferimento alla prenotazione
- `data_ora_invio` (DATETIME): Data e ora di invio del promemoria
- `inviato` (BOOLEAN): Stato di invio
- `created_at` (TIMESTAMP): Data di creazione
- `updated_at` (TIMESTAMP): Data di ultimo aggiornamento

## API endpoints

### Prenotazioni

- `GET /backend/api/prenotazioni.php?action=get_all`: Ottiene tutte le prenotazioni
- `GET /backend/api/prenotazioni.php?action=get_details&id={id}`: Ottiene i dettagli di una prenotazione
- `GET /backend/api/prenotazioni.php?action=get_slots&ambulatorio_id={id}&date={date}`: Ottiene gli slot disponibili
- `POST /backend/api/prenotazioni.php?action=create_booking`: Crea una nuova prenotazione
- `POST /backend/api/prenotazioni.php?action=cancel_booking`: Annulla una prenotazione

### Ambulatori

- `GET /backend/api/ambulatori.php?action=get_all`: Ottiene tutti gli ambulatori
- `GET /backend/api/ambulatori.php?action=get_orari&id={id}`: Ottiene gli orari di un ambulatorio

### Autenticazione

- `POST /backend/api/auth.php?action=login`: Login con credenziali
- `GET /backend/api/auth.php?action=logout`: Logout
- `GET /backend/api/auth.php?action=google_callback`: Callback per autenticazione Google
- `GET /backend/api/auth.php?action=apple_callback`: Callback per autenticazione Apple

### Dashboard

- `GET /backend/api/dashboard.php`: Ottiene i dati per la dashboard amministratore

## Funzionalità principali

### Menu a tendina

Il menu a tendina è implementato nel file `js/menu.js` e utilizza CSS responsive per adattarsi a diversi dispositivi. La funzione principale è `toggleMenu()` che mostra/nasconde il menu su dispositivi mobili.

### Autenticazione con Google e Apple ID

L'autenticazione è gestita tramite OAuth 2.0:

1. L'utente clicca sul pulsante di login
2. Viene reindirizzato al provider (Google o Apple)
3. Dopo l'autenticazione, viene reindirizzato alla callback
4. Il backend verifica il token e crea/aggiorna l'utente nel database
5. Viene creata una sessione per l'utente autenticato

### Integrazione con Google Calendar

L'integrazione con Google Calendar è implementata nella classe `GoogleCalendarService`:

1. Quando viene creata una prenotazione, viene generato un link per aggiungere l'evento al calendario
2. L'utente riceve il link via email
3. Quando una prenotazione viene annullata, viene inviata una notifica per rimuovere l'evento

### Sistema di notifiche

Il sistema di notifiche è gestito dalla classe `NotificationManager` che coordina:

1. Invio di email di conferma per nuove prenotazioni
2. Invio di promemoria un'ora prima della visita
3. Invio di notifiche di annullamento

Lo script `backend/cron/send_reminders.php` deve essere eseguito periodicamente (ogni 5-10 minuti) per inviare i promemoria al momento giusto.

### Annullamento prenotazioni

I pazienti possono annullare le prenotazioni fino a un'ora prima della visita:

1. Il paziente accede alla sezione "Le mie prenotazioni"
2. Clicca sul pulsante "Annulla prenotazione"
3. Il sistema verifica che l'annullamento sia entro il limite di tempo
4. La prenotazione viene marcata come annullata
5. Vengono inviate le notifiche di annullamento
6. Lo slot viene reso nuovamente disponibile

## Ottimizzazione per dispositivi mobili

Il sistema è completamente responsive grazie a:

1. Meta tag viewport in tutti i file HTML
2. Media queries nel CSS per adattare il layout a diverse dimensioni di schermo
3. Menu a tendina per la navigazione su dispositivi mobili
4. Elementi touch-friendly per una migliore esperienza su dispositivi touchscreen

## Configurazione

Le principali impostazioni del sistema sono nel file `backend/config/config.php`:

- Credenziali dell'amministratore
- Configurazione degli ambulatori e orari
- Impostazioni email
- Chiavi API per Google e Apple
- Configurazione del database
- Impostazioni JWT per l'autenticazione
- Parametri per le prenotazioni (durata slot, limiti di tempo, ecc.)

## Requisiti di sistema

- Server web con PHP 7.4+
- MySQL 5.7+ o MariaDB 10.3+
- Supporto per HTTPS (richiesto per OAuth)
- Accesso SMTP per l'invio di email
- Cron job per l'esecuzione periodica degli script di promemoria

## Deployment

Per il deployment del sistema:

1. Caricare tutti i file su un server web
2. Creare un database MySQL
3. Importare lo schema del database
4. Configurare il file `backend/config/config.php`
5. Configurare un cron job per eseguire `backend/cron/send_reminders.php`
6. Configurare le chiavi API per Google e Apple
7. Testare tutte le funzionalità

## Sicurezza

Il sistema implementa diverse misure di sicurezza:

- Autenticazione basata su JWT
- Password hashate con bcrypt
- Protezione contro SQL injection
- Validazione degli input
- HTTPS per tutte le comunicazioni
- Protezione CSRF per i form

## Manutenzione

Per la manutenzione del sistema:

1. Monitorare i log degli errori
2. Verificare periodicamente l'invio delle email
3. Aggiornare le dipendenze
4. Eseguire backup regolari del database
5. Testare le funzionalità dopo ogni aggiornamento
