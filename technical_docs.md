# Documentazione Tecnica - Sistema di Prenotazioni Mediche

## Indice
1. Panoramica del sistema
2. Architettura
3. Struttura del database
4. Frontend
5. Backend
6. Sistema di notifiche
7. Pannello amministratore
8. Sicurezza
9. Installazione e configurazione
10. Manutenzione

## 1. Panoramica del sistema

Il Sistema di Prenotazioni Mediche è una piattaforma web completa che consente ai pazienti di prenotare visite mediche presso gli ambulatori di Arceto e Casalgrande. Il sistema gestisce gli orari degli ambulatori, gli slot di prenotazione di 30 minuti, le informazioni dei pazienti e invia notifiche email all'amministratore.

### 1.1 Requisiti funzionali

- Visualizzazione degli orari degli ambulatori
- Prenotazione di visite mediche in slot di 30 minuti
- Verifica dei dati prima dell'invio
- Visualizzazione dell'ambulatorio assegnato
- Notifiche email all'amministratore per nuove prenotazioni
- Promemoria 1 ora prima della visita
- Pannello amministratore per la gestione delle prenotazioni

### 1.2 Tecnologie utilizzate

- **Frontend**: HTML5, CSS3, JavaScript
- **Backend**: PHP
- **Database**: MySQL
- **Email**: PHPMailer
- **Grafici**: Chart.js
- **Autenticazione**: JWT (JSON Web Token)

## 2. Architettura

Il sistema è basato su un'architettura client-server con separazione tra frontend e backend:

- **Frontend**: Interfaccia utente responsive per pazienti e amministratori
- **Backend**: API RESTful per la gestione dei dati e la logica di business
- **Database**: Memorizzazione persistente dei dati
- **Sistema di notifiche**: Invio di email di conferma e promemoria

### 2.1 Struttura delle directory

```
medical-booking-system/
├── index.html              # Pagina principale per i pazienti
├── css/                    # Fogli di stile CSS
│   └── style.css           # Stile principale
├── js/                     # Script JavaScript
│   └── script.js           # Script principale
├── img/                    # Immagini e risorse
├── admin/                  # Pannello amministratore
│   ├── login.html          # Pagina di login
│   ├── dashboard.html      # Dashboard amministratore
│   ├── css/                # Stili specifici per l'admin
│   │   └── admin.css       # Stile del pannello admin
│   └── js/                 # Script per l'admin
│       ├── admin.js        # Script comune
│       ├── login.js        # Script per il login
│       └── dashboard.js    # Script per la dashboard
├── backend/                # Backend PHP
│   ├── api/                # API RESTful
│   │   ├── ambulatori.php  # API per gli ambulatori
│   │   ├── prenotazioni.php # API per le prenotazioni
│   │   └── auth.php        # API per l'autenticazione
│   ├── config/             # Configurazione
│   │   ├── config.php      # Configurazione generale
│   │   └── database.php    # Classe di connessione al DB
│   ├── models/             # Modelli di dati
│   │   ├── Ambulatorio.php # Modello per gli ambulatori
│   │   ├── Slot.php        # Modello per gli slot
│   │   ├── Paziente.php    # Modello per i pazienti
│   │   └── Prenotazione.php # Modello per le prenotazioni
│   ├── utils/              # Utilità
│   │   └── EmailSender.php # Classe per l'invio di email
│   ├── cron/               # Script cron
│   │   └── send_reminders.php # Script per i promemoria
│   └── install.php         # Script di installazione
├── user_manual.md          # Manuale utente
├── technical_docs.md       # Documentazione tecnica
└── test_plan.md            # Piano di test
```

## 3. Struttura del database

Il database è composto da 6 tabelle principali:

### 3.1 Tabella `ambulatori`

Memorizza le informazioni sugli ambulatori disponibili.

```sql
CREATE TABLE ambulatori (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    indirizzo VARCHAR(255),
    descrizione TEXT
);
```

### 3.2 Tabella `orari`

Memorizza gli orari di disponibilità per ciascun ambulatorio.

```sql
CREATE TABLE orari (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ambulatorio_id INT NOT NULL,
    giorno_settimana ENUM('lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica') NOT NULL,
    ora_inizio TIME NOT NULL,
    ora_fine TIME NOT NULL,
    FOREIGN KEY (ambulatorio_id) REFERENCES ambulatori(id) ON DELETE CASCADE
);
```

### 3.3 Tabella `slot_prenotazioni`

Memorizza gli slot disponibili per le prenotazioni.

```sql
CREATE TABLE slot_prenotazioni (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ambulatorio_id INT NOT NULL,
    data_slot DATE NOT NULL,
    ora_inizio TIME NOT NULL,
    ora_fine TIME NOT NULL,
    disponibile BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (ambulatorio_id) REFERENCES ambulatori(id) ON DELETE CASCADE
);
```

### 3.4 Tabella `pazienti`

Memorizza le informazioni sui pazienti.

```sql
CREATE TABLE pazienti (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    cognome VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    telefono VARCHAR(20)
);
```

### 3.5 Tabella `prenotazioni`

Memorizza le prenotazioni effettuate.

```sql
CREATE TABLE prenotazioni (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slot_id INT NOT NULL,
    paziente_id INT NOT NULL,
    problema TEXT NOT NULL,
    data_prenotazione DATETIME NOT NULL,
    notifica_inviata BOOLEAN DEFAULT FALSE,
    promemoria_inviato BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (slot_id) REFERENCES slot_prenotazioni(id) ON DELETE CASCADE,
    FOREIGN KEY (paziente_id) REFERENCES pazienti(id) ON DELETE CASCADE
);
```

### 3.6 Tabella `amministratori`

Memorizza le informazioni sugli amministratori del sistema.

```sql
CREATE TABLE amministratori (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    cognome VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL
);
```

### 3.7 Relazioni tra le tabelle

- Un **ambulatorio** può avere più **orari** di disponibilità (relazione uno a molti)
- Un **ambulatorio** può avere più **slot di prenotazione** (relazione uno a molti)
- Uno **slot di prenotazione** può avere al massimo una **prenotazione** (relazione uno a uno)
- Un **paziente** può effettuare più **prenotazioni** (relazione uno a molti)

## 4. Frontend

### 4.1 Pagina principale

La pagina principale (`index.html`) contiene:
- Informazioni sugli ambulatori e orari
- Calendario per la selezione della data
- Selezione degli slot disponibili
- Form di prenotazione
- Verifica e conferma della prenotazione

### 4.2 Funzionalità JavaScript

Il file `script.js` implementa:
- Inizializzazione del calendario
- Generazione dinamica degli slot disponibili
- Validazione del form di prenotazione
- Verifica dei dati prima dell'invio
- Gestione della conferma della prenotazione

### 4.3 Stile CSS

Il file `style.css` implementa:
- Layout responsive per desktop e dispositivi mobili
- Stile del calendario e degli slot
- Stile del form di prenotazione
- Stile dei modal di verifica e conferma

## 5. Backend

### 5.1 Configurazione

Il file `config.php` contiene:
- Configurazione del database
- Configurazione email
- Configurazione degli ambulatori
- Configurazione generale del sistema

### 5.2 Connessione al database

La classe `Database` implementa:
- Pattern Singleton per la connessione al database
- Metodi per eseguire query
- Metodi per ottenere risultati

### 5.3 Modelli

I modelli implementano la logica di business:
- `Ambulatorio`: gestione degli ambulatori e orari
- `Slot`: gestione degli slot di prenotazione
- `Paziente`: gestione dei pazienti
- `Prenotazione`: gestione delle prenotazioni

### 5.4 API

Le API RESTful implementano:
- `ambulatori.php`: API per gli ambulatori e gli slot
- `prenotazioni.php`: API per le prenotazioni
- `auth.php`: API per l'autenticazione

## 6. Sistema di notifiche

### 6.1 Classe EmailSender

La classe `EmailSender` implementa:
- Configurazione di PHPMailer
- Metodi per inviare email di notifica
- Metodi per inviare promemoria
- Template HTML e testo per le email

### 6.2 Script cron

Lo script `send_reminders.php` implementa:
- Ricerca delle prenotazioni imminenti
- Invio dei promemoria
- Aggiornamento dello stato dei promemoria

### 6.3 Configurazione cron

Il cron job deve essere configurato per eseguire lo script ogni 5 minuti:

```
*/5 * * * * php /path/to/medical-booking-system/backend/cron/send_reminders.php >> /path/to/medical-booking-system/backend/cron/reminders.log 2>&1
```

## 7. Pannello amministratore

### 7.1 Autenticazione

Il sistema di autenticazione implementa:
- Login con email e password
- Generazione di token JWT
- Verifica dei token JWT
- Protezione delle pagine e delle API

### 7.2 Dashboard

La dashboard implementa:
- Statistiche sulle prenotazioni
- Grafici con Chart.js
- Elenco delle prenotazioni recenti
- Elenco delle prenotazioni di oggi

### 7.3 Gestione delle prenotazioni

Il pannello amministratore permette di:
- Visualizzare i dettagli delle prenotazioni
- Cancellare le prenotazioni
- Aggiornare i dati in tempo reale

## 8. Sicurezza

### 8.1 Autenticazione

- Password hashate con `password_hash()`
- Token JWT per l'autenticazione
- Verifica della validità dei token

### 8.2 Validazione input

- Validazione lato client con JavaScript
- Validazione lato server con PHP
- Prepared statements per prevenire SQL injection

### 8.3 CORS

- Configurazione CORS per le API
- Gestione delle richieste OPTIONS

## 9. Installazione e configurazione

### 9.1 Requisiti di sistema

- Server web (Apache, Nginx)
- PHP 7.4 o superiore
- MySQL 5.7 o superiore
- Estensione PDO per PHP
- Estensione OpenSSL per PHP

### 9.2 Procedura di installazione

1. Clonare il repository o estrarre l'archivio nella directory del server web
2. Configurare il database in `backend/config/config.php`
3. Eseguire lo script di installazione `backend/install.php`
4. Configurare il cron job per l'invio dei promemoria
5. Configurare il server web per servire la directory principale

### 9.3 Configurazione email

Per configurare il sistema di email:
1. Modificare le impostazioni SMTP in `backend/config/config.php`
2. Impostare l'indirizzo email dell'amministratore
3. Testare l'invio delle email

## 10. Manutenzione

### 10.1 Generazione degli slot

Gli slot di prenotazione devono essere generati periodicamente:
- Utilizzare l'API `ambulatori.php?action=generate_slots` con metodo POST
- Fornire le date di inizio e fine per il periodo desiderato
- Eseguire questa operazione settimanalmente o mensilmente

### 10.2 Backup

Si consiglia di effettuare backup regolari del database:
- Backup giornalieri del database
- Backup settimanali dei file del sistema

### 10.3 Log

I log del sistema sono disponibili in:
- Log del server web
- Log del cron job in `backend/cron/reminders.log`
- Log delle email (se configurati)
