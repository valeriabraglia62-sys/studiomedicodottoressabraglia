-- Aggiornamento della struttura del database per i nuovi requisiti

-- Aggiornamento della tabella ambulatori con i nuovi indirizzi
UPDATE ambulatori SET indirizzo = 'Via Piazza Castello, 10' WHERE nome LIKE '%Arceto%';
UPDATE ambulatori SET indirizzo = 'Via Canale, 29' WHERE nome LIKE '%Casalgrande%';

-- Modifica della tabella pazienti per aggiungere i campi per l'autenticazione e Google Calendar
ALTER TABLE pazienti 
ADD COLUMN google_id VARCHAR(255) NULL,
ADD COLUMN apple_id VARCHAR(255) NULL,
ADD COLUMN google_calendar_id VARCHAR(255) NULL,
ADD COLUMN password_hash VARCHAR(255) NULL,
ADD COLUMN is_registered BOOLEAN DEFAULT FALSE,
ADD COLUMN registration_date DATETIME NULL,
ADD COLUMN last_login DATETIME NULL;

-- Modifica della tabella prenotazioni per aggiungere i campi per lo stato e l'annullamento
ALTER TABLE prenotazioni
ADD COLUMN stato ENUM('confermata', 'annullata') DEFAULT 'confermata',
ADD COLUMN data_annullamento DATETIME NULL,
ADD COLUMN annullata_da ENUM('paziente', 'amministratore') NULL,
ADD COLUMN evento_calendar_id VARCHAR(255) NULL,
ADD COLUMN notifica_paziente_inviata BOOLEAN DEFAULT FALSE,
ADD COLUMN promemoria_paziente_inviato BOOLEAN DEFAULT FALSE;

-- Creazione di un indice per migliorare le prestazioni delle query sullo stato delle prenotazioni
CREATE INDEX idx_prenotazioni_stato ON prenotazioni (stato);

-- Creazione di un indice per migliorare le prestazioni delle query sui pazienti registrati
CREATE INDEX idx_pazienti_registrati ON pazienti (is_registered);

-- Creazione di indici per l'autenticazione con Google e Apple
CREATE INDEX idx_google_id ON pazienti (google_id);
CREATE INDEX idx_apple_id ON pazienti (apple_id);

-- Aggiornamento della password dell'amministratore
-- Nota: in produzione, utilizzare password_hash() per generare l'hash della password
UPDATE amministratori 
SET password = '$2y$10$YourGeneratedHashHere', 
    email = 'valeriabraglia62@gmail.com' 
WHERE id = 1;

-- Creazione di una nuova tabella per le sessioni utente
CREATE TABLE sessioni (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    user_type ENUM('paziente', 'amministratore') NOT NULL,
    token VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    UNIQUE KEY (token)
);

-- Creazione di un indice per migliorare le prestazioni delle query sulle sessioni
CREATE INDEX idx_sessioni_token ON sessioni (token);
CREATE INDEX idx_sessioni_user ON sessioni (user_id, user_type);
