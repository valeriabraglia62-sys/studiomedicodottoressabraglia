# Progettazione del Database

## Tabelle principali

### 1. Ambulatori
Questa tabella memorizza le informazioni sugli ambulatori disponibili.

```sql
CREATE TABLE ambulatori (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    indirizzo VARCHAR(255),
    descrizione TEXT
);
```

### 2. Orari
Questa tabella memorizza gli orari di disponibilità per ciascun ambulatorio.

```sql
CREATE TABLE orari (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ambulatorio_id INT NOT NULL,
    giorno_settimana ENUM('lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica') NOT NULL,
    ora_inizio TIME NOT NULL,
    ora_fine TIME NOT NULL,
    FOREIGN KEY (ambulatorio_id) REFERENCES ambulatori(id)
);
```

### 3. Slot Prenotazioni
Questa tabella memorizza gli slot disponibili per le prenotazioni, generati in base agli orari degli ambulatori.

```sql
CREATE TABLE slot_prenotazioni (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ambulatorio_id INT NOT NULL,
    data_slot DATE NOT NULL,
    ora_inizio TIME NOT NULL,
    ora_fine TIME NOT NULL,
    disponibile BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (ambulatorio_id) REFERENCES ambulatori(id)
);
```

### 4. Pazienti
Questa tabella memorizza le informazioni sui pazienti che effettuano prenotazioni.

```sql
CREATE TABLE pazienti (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    cognome VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    telefono VARCHAR(20)
);
```

### 5. Prenotazioni
Questa tabella memorizza le prenotazioni effettuate dai pazienti.

```sql
CREATE TABLE prenotazioni (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slot_id INT NOT NULL,
    paziente_id INT NOT NULL,
    problema TEXT NOT NULL,
    data_prenotazione DATETIME NOT NULL,
    notifica_inviata BOOLEAN DEFAULT FALSE,
    promemoria_inviato BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (slot_id) REFERENCES slot_prenotazioni(id),
    FOREIGN KEY (paziente_id) REFERENCES pazienti(id)
);
```

### 6. Amministratori
Questa tabella memorizza le informazioni sugli amministratori del sistema.

```sql
CREATE TABLE amministratori (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    cognome VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL
);
```

## Relazioni tra le tabelle

1. Un **ambulatorio** può avere più **orari** di disponibilità (relazione uno a molti)
2. Un **ambulatorio** può avere più **slot di prenotazione** (relazione uno a molti)
3. Uno **slot di prenotazione** può avere al massimo una **prenotazione** (relazione uno a uno)
4. Un **paziente** può effettuare più **prenotazioni** (relazione uno a molti)

## Indici e ottimizzazioni

```sql
-- Indice per migliorare le ricerche di slot disponibili
CREATE INDEX idx_slot_disponibili ON slot_prenotazioni (data_slot, ora_inizio, disponibile);

-- Indice per migliorare le ricerche di prenotazioni per data
CREATE INDEX idx_prenotazioni_data ON prenotazioni (data_prenotazione);

-- Indice per migliorare le ricerche di pazienti per cognome
CREATE INDEX idx_pazienti_cognome ON pazienti (cognome);
```

## Dati iniziali

```sql
-- Inserimento degli ambulatori
INSERT INTO ambulatori (nome, indirizzo) VALUES 
('Ambulatorio Arceto', 'Via Arceto, 1'),
('Ambulatorio Casalgrande', 'Via Casalgrande, 1');

-- Inserimento degli orari per Arceto
INSERT INTO orari (ambulatorio_id, giorno_settimana, ora_inizio, ora_fine) VALUES 
(1, 'lunedi', '10:30', '13:00'),
(1, 'martedi', '08:30', '10:00'),
(1, 'mercoledi', '08:30', '10:00'),
(1, 'giovedi', '08:30', '10:00'),
(1, 'venerdi', '08:30', '10:00');

-- Inserimento degli orari per Casalgrande
INSERT INTO orari (ambulatorio_id, giorno_settimana, ora_inizio, ora_fine) VALUES 
(2, 'lunedi', '17:00', '19:00'),
(2, 'martedi', '10:30', '13:00'),
(2, 'mercoledi', '17:00', '19:00'),
(2, 'giovedi', '17:00', '19:00'),
(2, 'venerdi', '10:30', '13:00');

-- Inserimento dell'amministratore
INSERT INTO amministratori (nome, cognome, email, password) VALUES 
('Valeria', 'Braglia', 'valeriabraglia62@gmail.com', 'password_hash');
```

## Note sulla generazione degli slot

Gli slot di prenotazione verranno generati automaticamente tramite uno script che:
1. Legge gli orari di disponibilità degli ambulatori
2. Crea slot di 30 minuti per ciascun orario disponibile
3. Marca gli slot come disponibili per impostazione predefinita

Questo processo verrà eseguito periodicamente (ad esempio, settimanalmente) per garantire che ci siano sempre slot disponibili per le prenotazioni future.
