# Da completare prima della messa in produzione

Stato dopo il secondo audit Codex (branch `installazione-npm-windows`).
`node prova/backend.mjs` → **264/264**. `npm audit` → **0 vulnerabilità**.

Le voci **[FATTO]** sono applicate nel codice. Le voci **[TU]** richiedono
un'azione tua (privilegi di amministratore, credenziali, o una decisione).

---

## Da fare adesso — 3 cose

### 1. Pubblicare la cronologia Git ripulita  **[TU]**

La vecchia password del pannello era finita in un commit; è stata tolta da
**tutta** la cronologia locale. Su GitHub c'è ancora. Da `C:\Users\valer\studiomedico`:

```bash
git push --force origin main installazione-npm-windows
```

Dopo il push, ogni copia esistente del repository va **riclonata** (i vecchi
commit restano nelle copie già fatte). Backup della cronologia precedente in
`%TEMP%\...\scratchpad\repo-pre-rewrite-2.bundle`.

### 2. Cambiare la password dell'amministratore  **[TU] — URGENTE**

La vecchia password va cambiata (era in chiaro nella cronologia e potrebbe
essere riutilizzata altrove). Con **PowerShell amministratore**:

1. In `C:\Users\valer\studiomedico\.env`:
   ```
   ADMIN_PASSWORD=<una password lunga, nuova, non usata altrove>
   ADMIN_PASSWORD_RESET=once
   ```
2. `& 'C:\Users\valer\studiomedico\strumenti\nssm.exe' restart StudioMedico`
3. Entra nel pannello con la password nuova → ti fa scegliere quella definitiva.
   Tutte le sessioni aperte vengono chiuse.
4. Rimetti `ADMIN_PASSWORD=` e `ADMIN_PASSWORD_RESET=` **vuote** e riavvia.

Stesso schema per la segreteria con `SEGRETARIA_PASSWORD` / `SEGRETARIA_PASSWORD_RESET=once`.

### 3. Riavviare per caricare i fix dell'audit  **[TU]**

```powershell
& 'C:\Users\valer\studiomedico\strumenti\nssm.exe' restart StudioMedico
Invoke-WebRequest -UseBasicParsing http://localhost:3000/salute | Select StatusCode
```

---

## Poi — il server sempre acceso (h24)

Il sito sul PC non è online quando il PC è spento. Per il vero 24/7 c'è il kit
in `strumenti/server/` e la guida **`DEPLOY-SERVER.md`**: VPS Aruba in Italia
(~5 €/mese). Il dominio `studiomedicobragliavaleria.it` è già acquistato e già
scritto negli script del kit. Sul server la configurazione è già fail-closed
(HTTPS obbligatorio, backup cifrato obbligatorio, ascolto solo su loopback
dietro Caddy, codice in sola lettura).

Sul server, dopo il primo avvio, verifica anche:

- [ ] restore di prova: `node strumenti/decifra-backup.mjs <ultimo .enc>` su
      un'altra macchina, e aprire il file risultante — che la copia si legga davvero.
- [ ] monitoraggio che non guardi solo `/salute` ma anche: coda `outbox` che si
      svuota, backup recenti in `data/backup`, spazio disco.
- [ ] smoke test reale dietro Caddy: registrazione → email → verifica → login →
      modifica profilo → prenotazione (da sito e da pannello, con e senza email)
      → upload allegato → annullamento → chiusura → backup e restore.

---

## Cosa è già stato fatto  **[FATTO]**

Sicurezza:

- Account paziente completi: registrazione, **verifica email** obbligatoria,
  login, isolamento dati (un paziente non vede/modifica le pratiche di un altro)
- `PATCH /api/paziente/profilo` senza mass-assignment; gli id vengono dalla
  sessione, mai dal corpo
- Registrazione che **non rivela** se un'email ha già un account
- `uncaughtException`/`unhandledRejection` → chiusura ordinata + uscita, così il
  gestore del servizio riparte pulito
- `Host` fuori da `HOST_AMMESSI` rifiutato su **ogni** richiesta (non solo nel redirect)
- Backup cifrati AES-256-GCM; **obbligatori** in produzione (senza chiave non parte)
- Password bootstrap `.env` che non sovrascrive account esistenti; recovery monouso
- Cambio/reset/logout revocano le sessioni
- Assistente pannello: annulla prenotazioni e crea chiusure, con **conferma a
  due passi reale** (gettone in memoria, non solo la parola "conferma")
- Chiusure per giorno o fascia oraria, con enforcement server-side
- Casella: le notifiche automatiche di Google e le newsletter non diventano
  più richieste da confermare
- Limite byte sulla posta prima del parsing; nessun dato personale nei log
- Dipendenze: 0 vulnerabilità (`firebase` rimossa perché inutilizzata, `qs`
  fissato a 6.16.0 per due CVE recenti)
- Password rimossa dai documenti e da **tutta** la cronologia Git locale

Funzioni:

- Sito paziente con schermata d'accesso iniziale e menu account in alto a destra
  (modifica nome/telefono/email, cambio password, esci)
- Prenotazioni dal pannello: email **facoltativa** (allo sportello, al telefono)
- Kit di installazione su server Linux (systemd con sandbox, Caddy con HTTPS
  automatico, deploy con rollback e backup DB pre-deploy, backup offsite via rclone)

Ambiente:

- App spostata fuori da OneDrive in `C:\Users\valer\studiomedico`, servizio
  `StudioMedico` che riparte da solo a ogni avvio/crash
- Suite di test da 213 a **264** verifiche

## Non applicabile

- **BitLocker**: non disponibile su questo Windows 11 Home. La cifratura che
  conta (i backup che escono dal PC) è già attiva. Se sposti tutto sul server,
  la cifratura a riposo la gestisce quello.
