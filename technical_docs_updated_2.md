# Documentazione Tecnica - Sistema di Prenotazioni Mediche (Aggiornata)

## Panoramica del Sistema

Il Sistema di Prenotazioni Mediche è una piattaforma web che consente ai pazienti di prenotare visite mediche presso gli ambulatori di Arceto e Casalgrande. Il sistema è stato progettato per essere intuitivo, efficiente e accessibile da qualsiasi dispositivo.

## Architettura del Sistema

Il sistema è basato su un'architettura client-server con le seguenti componenti:

### Frontend
- HTML5, CSS3 e JavaScript per l'interfaccia utente
- Design responsive per l'ottimizzazione su tutti i dispositivi
- Menu a tendina per una navigazione più intuitiva
- Integrazione con Google e Apple per l'autenticazione
- Integrazione con Google Calendar per la gestione degli appuntamenti

### Backend
- PHP per la logica di business e l'API
- MySQL per il database
- Sistema di notifiche email per conferme e promemoria
- Integrazione con Google Calendar API
- Sistema di autenticazione con supporto per Google e Apple ID

## Schema del Database

Il database è strutturato con le seguenti tabelle:

1. **utenti**
   - id (PK)
   - nome
   - cognome
   - email
   - telefono
   - password_hash
   - google_id
   - apple_id
   - data_registrazione
   - ultimo_accesso

2. **ambulatori**
   - id (PK)
   - nome
   - indirizzo
   - telefono
   - note

3. **orari_ambulatori**
   - id (PK)
   - ambulatorio_id (FK)
   - giorno
   - ora_inizio
   - ora_fine

4. **prenotazioni**
   - id (PK)
   - utente_id (FK)
   - ambulatorio_id (FK)
   - data
   - ora_inizio
   - ora_fine
   - problema
   - stato (confermata, annullata)
   - google_calendar_event_id
   - data_creazione
   - data_modifica

5. **notifiche**
   - id (PK)
   - prenotazione_id (FK)
   - tipo (conferma, promemoria, annullamento)
   - stato (inviata, fallita)
   - data_invio

## API Endpoints

Il sistema espone i seguenti endpoint API:

### Autenticazione
- `POST /backend/api/auth.php?action=register` - Registrazione utente
- `POST /backend/api/auth.php?action=login` - Login utente
- `POST /backend/api/auth.php?action=google_auth` - Autenticazione con Google
- `POST /backend/api/auth.php?action=apple_auth` - Autenticazione con Apple
- `GET /backend/api/auth.php?action=verify` - Verifica token

### Ambulatori
- `GET /backend/api/ambulatori.php?action=list` - Lista ambulatori
- `GET /backend/api/ambulatori.php?action=orari&id={id}` - Orari ambulatorio

### Prenotazioni
- `GET /backend/api/prenotazioni.php?action=slots&data={data}&ambulatorio={id}` - Slot disponibili
- `POST /backend/api/prenotazioni.php?action=create` - Crea prenotazione
- `GET /backend/api/prenotazioni.php?action=list` - Lista prenotazioni utente
- `GET /backend/api/prenotazioni.php?action=admin_list` - Lista prenotazioni (admin)
- `POST /backend/api/prenotazioni.php?action=cancel` - Annulla prenotazione
- `POST /backend/api/prenotazioni.php?action=admin_create` - Crea prenotazione (admin)

## Funzionalità Principali

### Sistema di Prenotazione
- Selezione data tramite calendario interattivo
- Visualizzazione slot disponibili (30 minuti ciascuno)
- Verifica dei dati prima dell'invio
- Conferma della prenotazione con riepilogo
- Invio email di conferma al paziente
- Aggiunta automatica dell'evento a Google Calendar
- Invio promemoria 1 ora prima della visita

### Autenticazione e Sicurezza
- Registrazione con email e password
- Autenticazione con Google
- Autenticazione con Apple ID
- Protezione delle password con hashing
- Autenticazione basata su token JWT
- Protezione CSRF per i form

### Gestione Prenotazioni
- Visualizzazione prenotazioni utente
- Annullamento prenotazioni (fino a 1 ora prima)
- Invio conferma di annullamento via email

### Pannello Amministratore
- Login amministratore (credenziali: `[RIMOSSE — configurare in .env]`)
  > Nota: la credenziale precedentemente presente va considerata compromessa e ruotata;
  > la rimozione dalla cronologia Git deve essere eseguita separatamente.
- Dashboard con statistiche e grafici
- Visualizzazione di tutte le prenotazioni
- Filtri per data, ambulatorio e stato
- Creazione prenotazioni per i pazienti
- Annullamento prenotazioni
- Invio notifiche di annullamento

## Requisiti di Sistema

### Server
- PHP 7.4 o superiore
- MySQL 5.7 o superiore
- Supporto per invio email (SMTP)
- Supporto per cron job (per i promemoria)

### Client
- Browser web moderno (Chrome, Firefox, Safari, Edge)
- JavaScript abilitato
- Supporto per cookies

## Deployment

### Requisiti
- Server web con PHP e MySQL
- Dominio configurato
- Certificato SSL (per HTTPS)

### Procedura di Installazione
1. Caricare i file sul server
2. Creare il database MySQL
3. Importare lo schema del database (`database_schema.sql`)
4. Configurare i parametri in `backend/config/config.php`:
   - Credenziali database
   - Email amministratore
   - Chiavi API per Google e Apple
   - Configurazione JWT
5. Configurare il cron job per l'invio dei promemoria:
   ```
   0 * * * * php /path/to/backend/cron/send_reminders.php
   ```

## Manutenzione

### Backup
Si consiglia di eseguire backup regolari del database e dei file del sistema.

### Aggiornamenti
Per aggiornare il sistema:
1. Effettuare un backup completo
2. Sostituire i file con la nuova versione
3. Eseguire eventuali script di aggiornamento del database

## Personalizzazione

Il sistema può essere personalizzato modificando:
- `css/style.css` per l'aspetto grafico
- `js/script.js` per il comportamento frontend
- `backend/config/config.php` per le impostazioni generali

## Risoluzione Problemi

### Problemi di Autenticazione
- Verificare le chiavi API di Google e Apple
- Controllare la configurazione JWT
- Verificare i permessi dei file di configurazione

### Problemi di Invio Email
- Verificare la configurazione SMTP
- Controllare i log del server
- Testare l'invio email manualmente

### Problemi di Prenotazione
- Verificare la configurazione degli orari degli ambulatori
- Controllare la disponibilità degli slot
- Verificare l'integrazione con Google Calendar
