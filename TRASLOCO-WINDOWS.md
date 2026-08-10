# Trasloco del server su Windows 11

Questo file serve a due lettori: a te, per sapere cosa fare e in che ordine, e a
Claude Code sulla macchina Windows, che aprira' questa cartella senza sapere
niente di quello che ci siamo detti finora. Tienilo aggiornato mentre procedi:
segna cosa e' fatto, cosi' chi riprende in mano il lavoro sa dove siamo.

Leggilo dall'inizio la prima volta. Dopo si usa a pezzi.

---

## 1. Cos'e' questo programma

Sistema di prenotazioni e richieste medicinali per lo Studio Medico Dottoressa
Braglia. Due ambulatori, Arceto e Casalgrande.

- I **pazienti** aprono il sito e prenotano una visita o chiedono i medicinali.
- Lo **studio** apre `/admin.html`, vede tutto e conferma, modifica o rifiuta.
- A ogni conferma, modifica o rifiuto parte una **email** al paziente.
- Il sistema **legge anche la casella Gmail** dello studio come rete di
  sicurezza, per raccogliere le richieste arrivate per email invece che dal sito.

Tecnicamente: Node.js, Express 4, database SQLite in un file solo
(`data/medstudent.sqlite`). Nessun servizio esterno indispensabile: senza
internet il programma continua a funzionare in locale e recupera dopo.

**Tutto e' in italiano**: interfaccia, codice, commenti, messaggi di commit. I
commenti spiegano *perche'* una cosa e' fatta cosi', non *cosa* fa la riga sotto,
e usano apostrofi ASCII (`perche'`, `puo'`) invece delle lettere accentate.

---

## 2. Regole che valgono sempre

Queste non cambiano con il trasloco. Chi riprende il lavoro deve saperle.

1. **Non cambiare mai `ADMIN_PASSWORD`.** Ne' il valore nel `.env`, ne' quello
   nel database. E' una richiesta esplicita del proprietario.
2. **I segreti non entrano nel repository.** `.gitignore` gia' esclude `.env`,
   `google-credentials.json`, `data/` e i file `*.sqlite`. Non aggirarlo.
3. **Il database contiene dati sanitari di persone reali.** Niente copie in
   cartelle temporanee, niente esportazioni "per provare", niente righe di prova
   scritte nell'archivio vero.
4. **Le email partono davvero.** Il programma manda posta a indirizzi reali. Ogni
   prova che tocca la coda di invio va fatta sapendo questo. E' gia' successo che
   una riga di prova mandasse una notifica vera a un indirizzo vero.
5. **Un solo server acceso alla volta.** Due processi sulla stessa cartella hanno
   gia' causato errori "Risorsa non trovata" difficili da capire, perche' i file
   statici si leggono dal disco a ogni richiesta ma il codice delle rotte resta
   in memoria fino al riavvio.

---

## 3. Dove siamo adesso

**Aggiornato al 10 agosto 2026: il trasloco e' avvenuto.** Il server gira sulla
macchina Windows, come servizio `StudioMedico`, sulla porta 3000, in
`C:\Users\valer\Desktop\studiomedicodottoressabraglia`. Dagli altri computer
dello studio si raggiunge a `http://172.20.10.7:3000`. Il Mac non deve piu'
avviare il server. Resta da fare la prova del riavvio senza login (punto 5.7).

Com'era prima, per riferimento: il server girava **sul Mac**, avviato da
`launchd` con l'etichetta `com.studiomedico.server`, sulla porta 3000.

Versioni in uso sul Mac, da replicare su Windows:

| Cosa            | Versione                     |
| --------------- | ---------------------------- |
| Node.js         | 24.x (qui gira la 24.15.0)   |
| better-sqlite3  | ^13.0.3                      |
| Express         | ^4.21.2                      |

Cose che funzionano e non vanno toccate durante il trasloco:

- **Backup automatico**: `src/backup.js` parte insieme al server, gira ogni 24
  ore, tiene le ultime 14 copie in `data/backup/`. Usa l'API di backup di SQLite,
  non una copia del file, cosi' le istantanee sono coerenti anche se qualcuno sta
  prenotando in quel momento. **Limite attuale: le copie stanno sullo stesso
  disco dell'originale.** Si risolve al punto 5.8.
- **Coda di uscita**: `src/outbox.js`. Ogni notifica da mandare viene scritta nel
  database *nella stessa transazione* del dato che la genera, e un lavoratore la
  ritenta ogni 30 secondi con attese crescenti. Se il server e' spento quando
  arriva una richiesta, la notifica parte alla riaccensione.
- **Lettura della casella**: `src/inbox.js`, IMAP su Gmail ogni 120 secondi.
  Segnare una email come "gestita" la sposta nel cestino di Gmail — provato dal
  vivo, funziona.

Test: `npm run prova`. **Adesso passano tutte: 102 su 102.**

Fino al 10 agosto 2026 ne fallivano 12, da prima di questi lavori, e ballavano
fra 11 e 12 da un'esecuzione all'altra. Le cause erano due. La prima, quella
nota: test scritti quando l'email del paziente era facoltativa, e ora e'
obbligatoria. La seconda, che nessuno sospettava: il lavoratore dei Moduli Google
restava acceso durante le prove e infilava nel database usa e getta le richieste
vere dei pazienti, cosi' i test prendevano il record sbagliato e i conteggi
cambiavano a ogni giro. Vedi il punto 7.

---

## 4. Perche' ci si sposta

Il server sta sul portatile di Gioele. L'assistente lo usa la mattina ad Arceto,
Valeria il pomeriggio a Casalgrande. Finche' l'archivio vive su un portatile che
gira con una persona, gli altri due dipendono da quella persona.

La macchina Windows fissa a casa risolve questo. **Resta un archivio solo**: non
si installa il programma su piu' computer, perche' ogni copia si porterebbe
dietro il suo archivio e dopo una settimana nessuno saprebbe piu' quale sia
quello giusto. Tutti accedono alla stessa macchina dal browser.

---

## 5. Il trasloco, passo per passo

### 5.1 Sul Mac: repository privato su GitHub

Il progetto oggi vive solo sul Mac. Senza un repository remoto, ogni modifica
futura diventa una copia a mano fra le due macchine, e prima o poi divergono.

Il repository dev'essere **privato**: nella storia dei commit c'e' il nome dello
studio.

```bash
gh repo create medstudent --private --source=. --remote=origin --push
```

Verifica che i segreti non siano partiti — deve rispondere che nessun file
corrisponde:

```bash
git ls-files | grep -E "\.env$|google-credentials|\.sqlite$"
```

### 5.2 Su Windows: Node.js e Git

- Node.js 24 LTS da `nodejs.org`, installer `.msi` a 64 bit.
- Git for Windows da `git-scm.com`.

Poi, in PowerShell, controlla che rispondano:

```powershell
node -v
git --version
```

### 5.3 Scaricare il codice

```powershell
cd $HOME\Documents
git clone https://github.com/<tuo-utente>/medstudent.git
cd medstudent
```

### 5.4 Installare le dipendenze — FATTO il 10 agosto 2026

```powershell
npm install
```

Finisce in una ventina di secondi, 283 pacchetti, senza compilare niente.

**Gli strumenti di Visual Studio non servono.** Questo punto prima diceva il
contrario, e mandava a scaricare qualche giga per niente. Ecco cosa succede
davvero, perche' l'errore porta fuori strada.

`better-sqlite3` non va piu' compilato: il pacchetto pubblicato contiene gia' i
binari pronti per tutte le piattaforme, Windows x64 compreso, e nel manifesto
dichiara `gypfile: false`, cioe' "non compilarmi". Dentro il pacchetto pero'
restano anche i sorgenti, quindi npm trova `binding.gyp` sul disco, ignora quella
dichiarazione e lancia `node-gyp` di testa sua. Su Windows quel tentativo si
ferma su "Could not find any Python installation", che sembra chiedere Python e i
compilatori C++ ma sta solo facendo un lavoro inutile. Sul Mac non si era mai
visto perche' li' la compilazione riusciva in silenzio: gli strumenti di Xcode ci
sono gia'.

A fermare tutto questo c'e' il file `.npmrc` nella radice, con dentro
`ignore-scripts=true` e il commento che spiega il perche'. Vale anche sul Mac,
dove evita la stessa compilazione inutile. Non toglie niente al programma:
nessuna dipendenza qui ha bisogno di uno script di installazione, e `npm start` e
`npm run prova` continuano a funzionare, perche' `ignore-scripts` ferma gli
script dei pacchetti scaricati, non quelli scritti in `package.json`.

Da qui viene anche la riga `"hasInstallScript": true` comparsa in
`package-lock.json` accanto a `better-sqlite3`: e' npm che annota la sua
decisione sbagliata. Con l'`.npmrc` davanti non ha piu' effetto.

Se `npm install` viene lanciato per sbaglio senza l'`.npmrc` e fallisce, la
cartella `node_modules` resta a meta': va cancellata e rifatta da zero,
altrimenti npm si porta dietro i pezzi del tentativo fallito.

### 5.5 I tre pezzi che Git non porta — FATTO il 10 agosto 2026

I tre file sono al loro posto, copiati dalla chiavetta e verificati identici
all'originale con l'impronta SHA256. Attenzione a dove vanno, perche' non e'
la stessa cartella per tutti e tre: **solo il database sta in `data\`**, mentre
`.env` e `google-credentials.json` vanno nella radice del progetto, che e' dove
`src/config.js` li cerca. Messi in `data\` il programma non li troverebbe.

Non sono stati copiati i file di appoggio di SQLite (`-wal`, `-shm`) che stavano
sulla chiavetta accanto al database: il `-wal` era di zero byte, cioe' non
conteneva nessuna transazione in sospeso, quindi tutto il contenuto era gia' nel
file principale. SQLite li ricrea da solo alla prima apertura.

**Il `.gitignore` e' gia' fatto bene**: esclude `.env`, `google-credentials.json`
e tutta la cartella `data/`. Vuol dire che le password e l'archivio dei pazienti
non finiscono su GitHub, nemmeno per sbaglio — che e' esattamente come deve
essere. Quei tre pezzi si spostano a mano con la chiavetta.

| File                      | Cosa contiene                         | Quando spostarlo    |
| ------------------------- | ------------------------------------- | ------------------- |
| `.env`                    | password Gmail, chiave di sessione    | quando ti pare      |
| `google-credentials.json` | chiave del servizio Google            | quando ti pare      |
| `data/medstudent.sqlite`  | l'archivio: pazienti, visite, medicine | la sera del travaso |

Con la chiavetta, non per email: sono password e dati sanitari.

Il `.env` va copiato **identico**. In particolare `ADMIN_PASSWORD` non si tocca e
`SESSION_SECRET` non si rigenera: cambiarlo butterebbe fuori tutti i dispositivi
gia' collegati.

Le voci da correggere sul server nuovo, ma **solo al punto 5.10**, quando il
tunnel esiste davvero:

```
SITO_HTTPS=true
SITO_URL=https://studio.tuodominio.it
PROXY_DAVANTI=1
```

Metterle prima e' un errore: il sito rimanderebbe a un indirizzo sicuro che non
esiste ancora, e `PROXY_DAVANTI=1` senza un proxy davanti apre un buco, perche'
l'intestazione con l'indirizzo di chi chiama se la scriverebbe chi chiama.

Nel `.env` arrivato dal Mac quelle tre voci **non ci sono proprio**, ed e'
giusto cosi': senza di loro `src/config.js` usa HTTPS spento, indirizzo pubblico
vuoto e zero proxy davanti, che e' esattamente lo stato che serve adesso. Non
vanno aggiunte fino al 5.10.

### 5.6 Il travaso e la prima prova — FATTO il 10 agosto 2026

Riuscito. L'archivio e' arrivato integro (`integrity_check` risponde `ok`) con
tutto il suo contenuto: 6 pazienti, 8 prenotazioni, 6 richieste di medicinali, 2
ambulatori, 14 orari, 37 email gia' processate. C'e' anche `idx_slot_unico`, che
e' l'unica cosa che impedisce il doppio appuntamento.

I test, il giorno del trasloco, hanno dato **90 superate e 12 fallite**: i numeri
attesi, quindi il trasloco era riuscito. Le 12 sono state sistemate la sera
stessa e adesso passano tutte, 102 su 102 (vedi il punto 7).

Le copie di sicurezza funzionano anche su Windows: la prima e' partita da sola
pochi minuti dopo l'accensione.

Prima di rifare questo passaggio, per chi ci tornasse sopra:

Scegli una sera in cui non usa il pannello nessuno.

1. **Sul Mac**, ferma il server, cosi' l'archivio e' fermo e coerente:
   ```bash
   ./strumenti/avvio-automatico.sh rimuovi
   ```
2. Copia `data/medstudent.sqlite` sulla chiavetta e da li' in
   `medstudent\data\` sulla macchina Windows.
3. **Su Windows**, avvia a mano:
   ```powershell
   npm start
   ```
4. Apri `http://localhost:3000` e `http://localhost:3000/admin.html` **da quella
   stessa macchina**. Se il pannello si apre, il login funziona e ci sono tutte
   le prenotazioni, il travaso e' riuscito.
5. Poi lancia i test:
   ```powershell
   npm run prova
   ```
   Adesso devono passare tutti: 102 su 102. Numeri diversi vanno capiti prima di
   andare avanti.

Da questo momento il Mac **non deve piu' avviare il server**, altrimenti si torna
a due archivi che divergono.

### 5.7 Farlo partire da solo — FATTO il 10 agosto 2026, prova del riavvio ancora da fare

Gli script in `strumenti/` sono bash e `launchd`: su Windows non partono. Il loro
corrispondente adesso c'e' ed e' `strumenti/servizio-windows.ps1`, con gli stessi
quattro comandi di quello del Mac.

Perche' un servizio e non l'avvio automatico all'accesso: un servizio parte
**all'accensione, senza che nessuno faccia login**. Se alle tre di notte va via la
corrente e torna, la macchina si riaccende e il server riparte da solo. Con
l'avvio all'accesso resterebbe fermo sulla schermata di login, e la mattina
l'assistente ad Arceto troverebbe il pannello morto senza nessuno davanti a quella
macchina per accorgersene.

Si usa NSSM, che avvolge un comando qualsiasi e lo registra fra i servizi.
**`choco install nssm` non funziona su questa macchina**: non c'e' Chocolatey e
non c'e' nemmeno winget, manca proprio il pacchetto App Installer. NSSM si prende
a mano da <https://nssm.cc/download>, versione win64, e il solo `nssm.exe` va in
`strumenti\nssm.exe`, dove lo script lo cerca da solo. E' escluso da Git di
proposito: e' un programma di terzi e non si versiona.

Sappi che **NSSM 2.24 non ha firma digitale**. Il file corrisponde all'impronta
pubblicata dal progetto, ma un antivirus puo' storcere il naso proprio perche'
registra servizi.

Poi, da PowerShell aperto **come amministratore**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\valer\Desktop\studiomedicodottoressabraglia\strumenti\servizio-windows.ps1" installa
```

Servono i diritti di amministratore per `installa`, `riavvia` e `rimuovi`, perche'
su Windows i servizi sono di sistema e non del singolo utente come i LaunchAgent
di macOS. Solo `stato` gira da utente normale.

Lo script spegne da solo un eventuale server acceso a mano prima di partire, come
fa quello del Mac.

#### La cosa da non dimenticare: gli aggiornamenti di versione di Windows

**Un aggiornamento di versione di Windows cancella il servizio.** E' successo il
10 agosto 2026: la macchina si e' aggiornata, e al ritorno il servizio non
esisteva piu' — sparita anche la voce nel registro. Un aggiornamento del genere
ri-registra i servizi di Microsoft e butta via quelli di terze parti registrati
con NSSM, perche' non risultano appartenere a nessun programma installato.

Non e' l'antivirus e non e' un guasto: succedera' ancora. Un riavvio normale
invece non tocca niente.

Il segnale e' che il sito non risponde piu' e `stato` dice "Avvio automatico non
installato". Si rimedia rilanciando il comando qui sopra.

**Ma accorgersene guardando non basta**, perche' davanti a questa macchina non
sta nessuno: se capita di notte, la mattina ad Arceto trovano il pannello morto
senza sapere perche'. Per questo c'e' `strumenti/sorveglia-servizio.ps1`, da
registrare come attivita' pianificata ogni dieci minuti. Le attivita' pianificate
gli aggiornamenti di Windows li sopravvivono, quindi possono rimettere a posto il
servizio che invece non sopravvive.

Controlla tre cose in fila: se il servizio non esiste piu' lo reinstalla, se
esiste ma e' fermo lo avvia, se gira ma il sito non risponde lo riavvia. Scrive
in `logs\sorveglianza.log` solo quando trova qualcosa che non va o quando
interviene, perche' un log che dice "tutto bene" ogni dieci minuti finirebbe per
nascondere le righe che contano; per sapere che sta lavorando c'e'
`logs\sorveglianza-ultimo-controllo.txt`, riscritto a ogni passata.

Si registra cosi', da PowerShell **come amministratore**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\valer\Desktop\studiomedicodottoressabraglia\strumenti\sorveglia-servizio.ps1" registra
```

Se ne occupa lo script stesso, e non e' un vezzo: il comando equivalente scritto
con `schtasks` porta virgolette dentro virgolette in sintassi `cmd`, e PowerShell
le smonta prima che `schtasks` le veda. Il risultato e' che l'attivita' non
nasce, con un errore che parla di un'opzione mancante e non lascia capire il
perche'. Provato dal vivo il 10 agosto 2026.

L'attivita' ha due inneschi: uno a ogni accensione, che copre il ritorno dopo un
blackout, e uno ripetuto ogni dieci minuti per tutto il resto. Con `rimuovi` si
toglie.

**Quando serve fermare il servizio di proposito** — una manutenzione, un
aggiornamento del codice, o lanciare `npm run prova` — si usa `ferma`, e alla
fine `avvia`. Da amministratore:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\valer\Desktop\studiomedicodottoressabraglia\strumenti\servizio-windows.ps1" ferma
```

`ferma` mette anche la sorveglianza in pausa da solo, e `avvia` la riattiva.
Senza quella pausa, entro dieci minuti la sorveglianza rimetterebbe in piedi il
servizio proprio mentre ci si sta lavorando, e chi lavora non capirebbe perche'
il server gli riparte da solo. E' il tipo di cosa che fa perdere un pomeriggio.

Da notare che l'archivio non ha corso pericoli: il server si era chiuso in modo
pulito e il database e' rimasto integro.

#### La prova vera, ancora da fare

Riavviare la macchina **senza fare login** e controllare da un altro dispositivo
che il sito risponda. Il riavvio del 10 agosto non conta come prova, perche' era
quello dell'aggiornamento che ha rimosso il servizio.

### 5.8 Impedire che la macchina si addormenti — FATTO il 10 agosto 2026, manca solo l'ibernazione

Uno standby dopo mezz'ora e' lo scenario cattivo: nessuno la tocca perche' e' un
server, quindi si addormenta proprio quando non c'e' nessuno li' a riaccenderla.
Era impostata a 15 minuti con la corrente attaccata, quindi il problema era
reale e attivo.

**La macchina e' un portatile**, un ASUS VivoBook X580GD, e questo cambia il
capitolo: il documento era scritto pensando a un fisso. Un portatile ha due
punti deboli in piu' e uno in meno.

Quello in meno: **niente da toccare nel BIOS**. Sui fissi serve l'impostazione
"riaccenditi quando torna la corrente", altrimenti dopo un blackout la macchina
resta spenta e tutto il lavoro sul servizio non serve. Qui c'e' la batteria, che
fa da gruppo di continuita': un blackout non spegne niente.

I due in piu':

- **A batteria si sospendeva dopo 10 minuti.** Cosi' la batteria non serviva a
  niente: durante un blackout il sito sarebbe caduto lo stesso, solo dieci minuti
  piu' tardi. Adesso non si sospende ne' con la corrente ne' a batteria.
- **Chiudere il coperchio sospendeva la macchina.** E' il modo piu' banale e piu'
  probabile di ammazzare il server: basta che qualcuno passi e lo chiuda. Adesso
  chiudere il coperchio non fa niente.

Comandi dati, tutti riusciti senza diritti di amministratore:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-dc 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /setactive SCHEME_CURRENT
```

Lo schermo si spegne dopo dieci minuti con la corrente e dopo tre a batteria, la
macchina resta sveglia.

Resta da dare, e vuole PowerShell **come amministratore**:

```powershell
powercfg /hibernate off
```

Toglie anche l'avvio rapido, che su un server e' un bene: garantisce che
un'accensione sia un'accensione vera e non il risveglio da uno stato salvato.

**Il coperchio conviene comunque tenerlo aperto.** Un portatile che lavora chiuso
scalda, e adesso che chiuderlo non lo sospende piu' resterebbe a macinare con le
prese d'aria schiacciate.

Poi, in Impostazioni → Windows Update → Opzioni avanzate, imposta le ore di
attivita' in modo che i riavvii se li prenda di notte. Con il servizio installato
un riavvio e' innocuo, ma tanto vale che capiti quando non serve a nessuno.

### 5.9 Portare le copie di backup fuori dalla macchina

Il backup gia' funziona, ma le copie stanno accanto all'originale: se salta quel
disco, saltano insieme. Windows 11 ha OneDrive gia' dentro, quindi basta far
scrivere le copie li'.

Costo zero: l'archivio pesa meno di mezzo mega, un anno di copie giornaliere sta
in centocinquanta mega scarsi.

**La voce di configurazione adesso c'e'**: `CARTELLA_BACKUP` nel `.env`. Lasciata
vuota, le copie restano in `data/backup` come sempre, quindi finche' non la si
tocca non cambia niente. Il percorso puo' essere assoluto o relativo alla radice
del progetto.

Per mandarle su OneDrive basta scrivere nel `.env`:

```
CARTELLA_BACKUP=C:\Users\valer\OneDrive\StudioMedico\backup
```

e riavviare il servizio, perche' la configurazione si legge all'avvio.

**Prima di farlo, una cosa va detta chiaramente.** Dentro quelle copie ci sono i
dati sanitari di persone reali. Sincronizzarle su OneDrive significa metterle su
un servizio esterno, sull'account personale di chi possiede quella cartella. E' il
prezzo da pagare per non perdere tutto se salta il disco, ed e' un compromesso
ragionevole, ma va scelto sapendolo. Non e' una comodita' da attivare di sfuggita.

Da sapere anche: le copie dei test si chiamano `prova-*.sqlite` e quelle vere
`medstudent-*.sqlite`. Le due serie si contano separatamente, quindi rilanciare i
test non consuma piu' le quattordici copie buone.

### 5.10 Il tunnel, il dominio e Access

Questa parte viene per ultima, per decisione tua.

1. Comprare un dominio su Cloudflare Registrar (~10 € l'anno).
2. Installare `cloudflared` su Windows — su Windows si installa come servizio da
   solo, quindi e' persino piu' semplice che sul Mac:
   ```powershell
   cloudflared service install <token>
   ```
3. Solo a questo punto mettere `SITO_HTTPS=true`, `SITO_URL` e `PROXY_DAVANTI=1`
   nel `.env`, e riavviare il servizio.
4. Configurare Cloudflare Access davanti a `/admin.html`, `/api/admin` e
   `/api/auth`, con gli indirizzi email delle tre persone. Chi apre il pannello
   riceve un codice via email prima ancora di vedere la pagina di login: due
   porte in fila, cosi' una password rubata da sola non basta.

Lo script `strumenti/tunnel-cloudflare.sh` fa questo lavoro sul Mac e va tradotto.
La logica dentro e le istruzioni per Access valgono comunque, leggile da li'.

---

## 6. Come tornare indietro

Fino al punto 5.7 il Mac resta intatto e completo. Se qualcosa non va:

1. Ferma il servizio su Windows: `nssm stop StudioMedico`.
2. Riporta `data\medstudent.sqlite` da Windows al Mac con la chiavetta — quello
   e' l'archivio aggiornato, non quello vecchio del Mac.
3. Sul Mac: `./strumenti/avvio-automatico.sh installa`.

Il punto delicato e' sempre e solo l'archivio: il codice e' su GitHub e si
riscarica, i segreti sono in due file, ma le prenotazioni prese nel frattempo
esistono in una copia sola. Prima di ogni passaggio, l'ultima copia in
`data/backup/` e' la rete.

---

## 7. Cosa resta da fare dopo il trasloco

Cose gia' decise ma non ancora fatte, in ordine di utilita':

- **Casella email dedicata allo studio.** Oggi la stessa casella Gmail personale
  fa da mittente e da destinatario, e per questo `src/inbox.js` deve riconoscere
  le proprie stesse notifiche per non trattarle come richieste dei pazienti. Con
  una casella separata il problema sparisce. Serve creare l'account e una
  password per le app, poi cambiare `EMAIL_USER`/`EMAIL_PASS` nel `.env` e
  `NOTIFY_EMAIL` in `src/config.js` (riga 130, dove c'e' ancora un indirizzo
  scritto fisso come ripiego).
- ~~**I 12 test che falliscono da prima.**~~ **Fatto il 10 agosto 2026**: adesso
  passano tutte, 102 su 102, e tre esecuzioni di fila danno lo stesso numero.
  Le cause erano due, non una:
  - L'email del paziente, diventata obbligatoria. Le due prove di carico
    creavano trecento prenotazioni senza indirizzo, e una riga dei Moduli
    lasciava il campo vuoto. Aggiunte email `@example.com`, il dominio riservato
    che non puo' esistere davvero.
  - **Il lavoratore dei Moduli Google restava acceso durante le prove.** Il file
    di prova spegneva la casella Gmail e i Fogli, ma non i Moduli: cosi', mentre
    i test inserivano le proprie righe finte, quello importava nel database usa e
    getta le richieste vere arrivate dal foglio dello studio. I test prendevano
    il record sbagliato e i conteggi cambiavano da un giro all'altro. E' il
    motivo per cui il numero di fallite oscillava fra 11 e 12 senza che nessuno
    toccasse niente.
- **Cartella SOLE**: nessuna automazione. Deciso di lasciare l'inserimento delle
  ricette a mano. Non riproporlo.
- **Fascicolo sanitario nazionale**: idem, fuori portata e non voluto. Nel
  pannello i medicinali confermati compaiono gia' sulla scheda del paziente, e
  tanto basta.

---

## 8. I file che contano

| File                         | A cosa serve                                        |
| ---------------------------- | --------------------------------------------------- |
| `server.js`                  | avvio, middleware, avvio dei lavoratori di fondo     |
| `src/config.js`              | lettura del `.env`, `ROOT`, `NOTIFY_EMAIL`           |
| `src/db.js`                  | schema e migrazioni idempotenti                      |
| `src/prenotazioni.js`        | visite, disponibilita', vincolo anti-sovrapposizione |
| `src/medicine.js`            | richieste di medicinali                              |
| `src/inbox.js`               | lettura Gmail, classificazione, cestino              |
| `src/outbox.js`              | coda delle notifiche in uscita                       |
| `src/backup.js`              | copie di sicurezza                                   |
| `src/api.js`                 | tutte le rotte HTTP                                  |
| `public/js/admin.js`         | il pannello                                          |
| `prova/backend.mjs`          | i test                                               |
| `strumenti/avvio-automatico.sh`  | avvio automatico sul Mac (launchd)               |
| `strumenti/servizio-windows.ps1` | avvio automatico su Windows (servizio, NSSM)     |
| `strumenti/tunnel-cloudflare.sh` | il tunnel sul Mac, ancora da tradurre            |
| `.npmrc`                     | impedisce a npm di compilare better-sqlite3          |

Una cosa da sapere sul database: il divieto di due visite confermate stesso
ambulatorio, stesso giorno, stessa ora e' un indice unico parziale,
`idx_slot_unico`, con dentro `WHERE stato = 'confermata'`. E' l'unica cosa che
impedisce il doppio appuntamento, ed e' anche il motivo per cui "Riprogrammata"
e' un'etichetta calcolata nell'interfaccia e non uno stato salvato.
