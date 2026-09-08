# Mettere il sito su un server sempre acceso (VPS Aruba)

Oggi il sito gira sul PC di studio: quando il PC è spento, il sito è giù.
Questa guida lo sposta su un piccolo server Linux sempre acceso, in un
datacenter **in Italia** (dati in UE), con HTTPS vero e backup automatici.

- **Dominio**: `studiomedicobragliavaleria.it` (già acquistato su Aruba).
- **Costo**: **~5 €/mese** il VPS. Il dominio è già pagato.
- **Tempo**: circa **30–40 minuti**, una volta sola.

Tutto quello che serve è già nel progetto, in `strumenti/server/`. Il dominio
è già scritto negli script: non c'è da passarlo a mano.

---

## 1. Crea il VPS su Aruba

1. Vai su <https://www.cloud.it> / <https://cloud.aruba.it> e accedi con lo
   stesso account del dominio.
2. Crea un **Cloud Server** (va bene anche "Cloud Server Smart", il più
   piccolo):
   - **Sistema operativo**: **Ubuntu 24.04 LTS**.
   - **Risorse**: almeno **1 vCPU e 2 GB di RAM**, 20+ GB di disco.
   - **Datacenter**: **Italia**.
   - **Accesso**: scegli **password di root** (Aruba te la mostra/manda) —
     oppure una chiave SSH, se sai cos'è.
   - **Nome**: `studiomedico`.
3. Avvia. Dopo qualche minuto hai un **indirizzo IP pubblico**
   (es. `195.231.xx.xx`). Annotalo.

## 2. Fai puntare il dominio al server (pannello DNS Aruba)

Nel pannello di gestione DNS di `studiomedicobragliavaleria.it`:

| Tipo | Nome / Host | Valore |
|------|-------------|--------|
| `A`  | `@`         | l'IP del VPS |
| `A`  | `www`       | l'IP del VPS |

Se esistono già record `A` o un **Redirect** sul dominio, rimuovili: devono
restare solo questi due. Non serve nessun record MX (le email passano da Gmail).

Aspetta la propagazione (da 5 minuti a un'ora). Verifica dal tuo PC:

```powershell
nslookup studiomedicobragliavaleria.it
```

deve rispondere con l'IP del VPS.

## 3. Entra nel server

Da PowerShell (Windows 10/11 ha `ssh` incluso), con l'IP vero:

```powershell
ssh root@195.231.xx.xx
```

(se hai scelto la password, incollala quando la chiede).

## 4. Scarica il codice, controllalo, poi installa

Non eseguire mai `curl | bash` come root: prima si guarda cosa si sta per
eseguire. Ancora collegato al server:

```bash
apt-get update && apt-get install -y git
git clone --branch main https://github.com/valeriabraglia62-sys/studiomedicodottoressabraglia.git /opt/studiomedico
cd /opt/studiomedico

# Controlla che sia il commit che ti aspetti (confrontalo con GitHub):
git log -1 --format='%H  %ci  %s'

# Dai un'occhiata allo script prima di lanciarlo (q per uscire):
less strumenti/server/setup-server.sh
```

Se è tutto a posto, lancialo — il dominio e l'email del certificato sono già
quelli giusti dentro lo script:

```bash
bash strumenti/server/setup-server.sh
```

Fa tutto: Node, Caddy (HTTPS automatico per `studiomedicobragliavaleria.it` e
`www`), firewall, utente di servizio, installa e avvia. Alla fine stampa **la
chiave di cifratura dei backup**: **annotala su carta, fuori dal server.**

## 5. Configura le caselle email e Google

```bash
nano /opt/studiomedico/.env
```

Riempi almeno: `EMAIL_USER`, `EMAIL_PASS` (password per le app Google),
`ADMIN_EMAIL`, `ADMIN_PASSWORD` (una password provvisoria, solo per il primo
accesso). Se usi Fogli/Moduli Google, riempi anche quelli e carica il file
delle credenziali:

```powershell
# da un altro terminale sul TUO PC:
scp "C:\Users\valer\studiomedico\google-credentials.json" root@195.231.xx.xx:/opt/studiomedico/
```
```bash
# sul server:
chown studiomedico:studiomedico /opt/studiomedico/google-credentials.json
systemctl restart studiomedico
```

## 6. Porta i dati veri dal PC

Sul **PC di studio** (PowerShell come amministratore), ferma il servizio e
copia il database:

```powershell
& 'C:\Users\valer\studiomedico\strumenti\nssm.exe' stop StudioMedico
scp "C:\Users\valer\studiomedico\data\medstudent.sqlite" root@195.231.xx.xx:/opt/studiomedico/data/
```

Sul **server**:

```bash
chown studiomedico:studiomedico /opt/studiomedico/data/medstudent.sqlite
systemctl restart studiomedico
```

Da questo momento il server ha tutte le prenotazioni e i pazienti veri.
**Non riaccendere** il servizio sul PC: due copie che scrivono sarebbero un
disastro. Quando sei sicura che il server va, disinstalla il servizio dal PC:
`& 'C:\Users\valer\studiomedico\strumenti\nssm.exe' remove StudioMedico confirm`.

## 7. Verifica

```bash
systemctl status studiomedico      # deve essere "active (running)"
curl -s http://127.0.0.1:3000/salute
```

Apri nel browser **https://studiomedicobragliavaleria.it** — deve caricare col
lucchetto. Prova anche **http://www.studiomedicobragliavaleria.it**: deve
rimbalzare da solo sulla radice in HTTPS. Entra nel pannello con la password
provvisoria, scegline una tua, poi sul server svuota `ADMIN_PASSWORD` nel
`.env` e `systemctl restart studiomedico`.

## 8. Backup automatici verso OneDrive (consigliato)

```bash
sudo -u studiomedico RCLONE_CONFIG=/opt/studiomedico/data/rclone.conf rclone config
```

Scegli `n` (new remote), nome **`onedrive`**, tipo **Microsoft OneDrive**,
segui il login (ti dà un link da aprire nel browser). Alla fine:

```bash
systemctl enable --now backup-remoto.timer
```

Ogni ora i backup **cifrati** finiscono in `OneDrive/StudioMedico-Backup`.

## 9. Aggiornamenti futuri

Quando ci sono modifiche nuove nel codice (su GitHub):

```bash
ssh root@195.231.xx.xx
bash /opt/studiomedico/strumenti/server/deploy.sh
```

Scarica, riavvia, verifica; se qualcosa non risponde torna da solo alla
versione precedente.

---

## In caso di problemi

- `journalctl -u studiomedico -n 50` — gli ultimi errori del sito
- `journalctl -u caddy -n 30` — problemi di certificato / dominio
- `systemctl restart studiomedico` — riavvio
- Certificato che non parte: quasi sempre il record DNS non è ancora propagato,
  o `www` manca. Controlla con `nslookup`, aspetta, poi `systemctl restart caddy`.
- Recuperare un backup: `node /opt/studiomedico/strumenti/decifra-backup.mjs <file.sqlite.enc>`
  (serve la `BACKUP_ENCRYPTION_KEY` annotata al punto 4)
