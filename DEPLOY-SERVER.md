# Mettere il sito su un server sempre acceso (Hetzner)

Oggi il sito gira sul PC di studio: quando il PC è spento, il sito è giù.
Questa guida lo sposta su un piccolo server Linux sempre acceso, in UE
(Germania/Finlandia), con HTTPS vero e backup automatici.

Costo: **~4,50 €/mese** il server + **~10 €/anno** il dominio.
Tempo: circa **30–40 minuti**, una volta sola.

Tutto quello che serve è già nel progetto, in `strumenti/server/`.

---

## 1. Crea il server su Hetzner

1. Registrati su <https://console.hetzner.com> (Hetzner Cloud).
2. **New Project** → **Add Server**:
   - **Location**: Nuremberg o Falkenstein (Germania) — dati in UE.
   - **Image**: **Ubuntu 24.04**.
   - **Type**: **CX22** (2 vCPU, 4 GB) — abbondante. ~4,50 €/mese.
   - **SSH Key**: se sai cos'è, caricala. Altrimenti scegli **password** e
     Hetzner te la manda per email.
   - **Name**: `studiomedico`.
3. Crea. Dopo un minuto hai un **indirizzo IP** (es. `91.99.12.34`). Annotalo.

## 2. Il dominio

1. Compra un dominio (es. su <https://www.namecheap.com> o su Hetzner stessa),
   per esempio `prenotazioni-braglia.it`.
2. Nel pannello del dominio, crea un record **A**:
   - Tipo: `A` · Host: `@` (o `prenotazioni`) · Valore: **l'IP del server**.
3. Aspetta che si propaghi (da 5 minuti a un'ora). Verifica da un altro PC:
   `ping prenotazioni-braglia.it` deve rispondere con l'IP del server.

## 3. Entra nel server

Da PowerShell (Windows 10/11 ha `ssh` incluso):

```powershell
ssh root@91.99.12.34
```

(usa l'IP vero; se hai scelto la password, incollala quando la chiede).

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

Se è tutto a posto, lancialo (cambia dominio ed email):

```bash
DOMINIO=prenotazioni-braglia.it EMAIL_TLS=tuo@email.it bash strumenti/server/setup-server.sh
```

Fa tutto: Node, Caddy (HTTPS automatico), utente di servizio, riusa il
codice, installa, avvia. Alla fine stampa **la chiave di cifratura dei
backup**: **annotala su carta, fuori dal server.**

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
scp "C:\Users\valer\studiomedico\google-credentials.json" root@91.99.12.34:/opt/studiomedico/
```
```bash
# sul server:
chown studiomedico:studiomedico /opt/studiomedico/google-credentials.json
systemctl restart studiomedico
```

## 6. Porta i dati veri dal PC

Sul **PC di studio** (PowerShell admin), ferma il servizio e copia il database:

```powershell
& 'C:\Users\valer\studiomedico\strumenti\nssm.exe' stop StudioMedico
scp "C:\Users\valer\studiomedico\data\medstudent.sqlite" root@91.99.12.34:/opt/studiomedico/data/
```

Sul **server**:

```bash
chown studiomedico:studiomedico /opt/studiomedico/data/medstudent.sqlite
systemctl restart studiomedico
```

Da questo momento il server ha tutte le prenotazioni e i pazienti veri.
**Non riaccendere** il servizio sul PC (`nssm stop` è definitivo): due copie
che scrivono sarebbero un disastro. Quando sei sicura che il server va,
disinstalla il servizio dal PC: `nssm remove StudioMedico confirm`.

## 7. Verifica

```bash
systemctl status studiomedico      # deve essere "active (running)"
curl -s http://127.0.0.1:3000/salute
```

Apri nel browser **https://prenotazioni-braglia.it** — deve caricare col
lucchetto. Entra nel pannello con la password provvisoria, scegline una tua,
poi sul server svuota `ADMIN_PASSWORD` nel `.env` e `systemctl restart studiomedico`.

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
ssh root@91.99.12.34
bash /opt/studiomedico/strumenti/server/deploy.sh
```

Scarica, riavvia, verifica; se qualcosa non risponde torna da solo alla
versione precedente.

---

## In caso di problemi

- `journalctl -u studiomedico -n 50` — gli ultimi errori del sito
- `journalctl -u caddy -n 30` — problemi di certificato / dominio
- `systemctl restart studiomedico` — riavvio
- Recuperare un backup: `node /opt/studiomedico/strumenti/decifra-backup.mjs <file.sqlite.enc>`
  (serve la `BACKUP_ENCRYPTION_KEY` annotata al punto 4)
