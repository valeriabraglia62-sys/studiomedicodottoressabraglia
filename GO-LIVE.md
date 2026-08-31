# Da completare prima della messa in produzione

Stato al 31/08/2026. Le voci **[FATTO]** sono già applicate nel codice e testate
(`npm run prova` → 224/224). Le voci **[TU]** richiedono un'azione tua: privilegi
di amministratore, le tue credenziali, o una decisione tua.

---

## 1. Riavviare il servizio per caricare le ultime modifiche  **[TU]**

Il servizio `StudioMedico` gira ancora con il codice caricato all'ultimo
riavvio: ha già account paziente, isolamento dati e i fix dell'audit, ma **non**
ha ancora *verifica email* e *backup cifrati*. In PowerShell **come amministratore**:

```powershell
& 'C:\Users\valer\studiomedico\strumenti\nssm.exe' restart StudioMedico
Start-Sleep 8
Invoke-WebRequest -UseBasicParsing http://localhost:3000/salute | Select-Object StatusCode
```

Atteso: `StatusCode 200`. La migrazione del database (nuove colonne per la
verifica email) parte da sola all'avvio ed è additiva.

---

## 2. Cambiare la password dell'amministratore  **[TU] — URGENTE**

La vecchia password del pannello era finita in chiaro nella cronologia Git (ora
ripulita) ed è debole. Va cambiata. Con **PowerShell amministratore**:

1. Apri `C:\Users\valer\studiomedico\.env` e metti una password nuova e robusta:
   ```
   ADMIN_PASSWORD=<una password lunga e non riutilizzata altrove>
   ADMIN_PASSWORD_RESET=once
   ```
2. Riavvia: `& 'C:\Users\valer\studiomedico\strumenti\nssm.exe' restart StudioMedico`
3. Entra nel pannello con la password nuova: ti chiederà di sceglierne una
   personale al primo accesso. Tutte le sessioni aperte vengono chiuse.
4. Rimetti `ADMIN_PASSWORD=` e `ADMIN_PASSWORD_RESET=` **vuote** nel `.env`.

Lo stesso vale per la segreteria con `SEGRETARIA_PASSWORD` / `SEGRETARIA_PASSWORD_RESET=once`.

---

## 3. Pubblicare la cronologia Git ripulita  **[TU]**

La cronologia locale è stata riscritta per togliere la password. Su GitHub c'è
ancora quella vecchia. Da un terminale nella cartella `C:\Users\valer\studiomedico`:

```bash
git remote add origin https://github.com/valeriabraglia62-sys/studiomedicodottoressabraglia.git
git push --force origin main installazione-npm-windows
```

Dopo il push: se qualcun altro ha una copia del repository, deve **riclonarla**
(i vecchi commit restano nelle copie già esistenti). Backup della vecchia
cronologia (per sicurezza) in `%TEMP%\...\scratchpad\repo-pre-rewrite.bundle`.

---

## 4. Cifratura dei backup  **[TU]**

1. Genera la chiave una volta sola (Git Bash o WSL):
   ```bash
   openssl rand -hex 32
   ```
2. In `C:\Users\valer\studiomedico\.env`:
   ```
   BACKUP_ENCRYPTION_KEY=<i 64 caratteri generati>
   ```
3. **Salva la chiave anche fuori dalla macchina** (password manager, foglio in
   cassaforte): senza, un backup cifrato non si recupera più.
4. Riavvia il servizio. Da lì i backup finiscono cifrati (`*.sqlite.enc`) in
   `C:\Users\valer\OneDrive - Unimore\StudioMedico-Backup`.
5. Per rileggere un backup: `node strumenti/decifra-backup.mjs <file.sqlite.enc>`

La cartella di backup è già stata spostata su **OneDrive - Unimore** (account
organizzativo), fuori dal Desktop così il "backup cartelle note" non la sposta.

---

## 5. Permessi sulla cartella dati  **[TU]**

Il servizio gira come `LocalSystem`. Restringi `data\` a SYSTEM e agli
amministratori. **PowerShell amministratore**:

```powershell
$d = 'C:\Users\valer\studiomedico\data'
icacls $d /inheritance:r /grant "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" /T
```

(Se in futuro fai girare il servizio con un account dedicato invece di
LocalSystem, aggiungi quell'account al posto di SYSTEM.)

---

## 6. BitLocker sul disco  **[TU]**

1. Menu Start → cerca **"Crittografia unità BitLocker"** → aprilo.
2. Sul disco `C:` (dove stanno `studiomedico\data` e i backup locali) → **Attiva BitLocker**.
3. Scegli **"Salva su un file"** o **"Stampa"** per la chiave di ripristino, e
   conservala **fuori dal PC** (non sul disco che stai cifrando).
4. "Crittografa l'intero disco" → avvia. Il PC resta usabile durante la cifratura.

Se BitLocker non compare, il PC potrebbe non avere il chip TPM: in quel caso
serve abilitarlo dal BIOS/UEFI, oppure usare BitLocker senza TPM via Criteri di
gruppo. Fammi sapere e ti guido.

---

## 7. Dominio e HTTPS  **[TU] — quando sei pronta**

Oggi il sito è in HTTP sulla porta 3000 (come prima). Per esporlo su internet in
sicurezza servono un dominio e un tunnel Cloudflare:

1. **Registra un dominio** (es. su Cloudflare stessa, ~10 €/anno) — per esempio
   `prenotazioni-braglia.it`.
2. **Cloudflare Tunnel** (gratis): installa `cloudflared` sul PC, crea un tunnel
   che punta a `http://localhost:3000`, associalo al dominio. Guida:
   <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
3. In `C:\Users\valer\studiomedico\.env`:
   ```
   SITO_HTTPS=true
   SITO_URL=https://prenotazioni-braglia.it
   HOST_AMMESSI=prenotazioni-braglia.it
   PROXY_DAVANTI=1
   ```
   (commenta la riga `SITO_HTTPS=false`)
4. In Cloudflare, SSL/TLS mode → **Full (strict)**.
5. Riavvia il servizio.

Finché il dominio non c'è, lascia `SITO_HTTPS=false`: con l'HTTPS attivo e senza
`HOST_AMMESSI` l'app rifiuta ogni richiesta.

---

## 8. Verifica in due passaggi sull'account dei backup  **[TU]**

I backup vanno su **OneDrive - Unimore**, quindi sull'account Microsoft/Unimore.
Attiva la 2FA lì:

- Vai su <https://mysignins.microsoft.com/security-info> con l'account Unimore.
- **Aggiungi metodo** → App Authenticator (Microsoft Authenticator sul telefono)
  o SMS. Segui la procedura.
- Se l'ateneo la impone già a livello di tenant, potresti trovarla attiva.

(La 2FA di Gmail dello studio risulta già attiva: bene.)

---

## 9. Pulizia file  **[TU]**

Nella cartella del progetto ci sono vecchie copie del `.env` con la password e i
segreti in chiaro. Eliminale:

```powershell
Remove-Item 'C:\Users\valer\studiomedico\.env.prima-*'
```

E, quando il sito nuovo gira bene da qualche giorno, elimina le cartelle messe
da parte:

- `C:\Users\valer\Desktop\studiomedicodottoressabraglia.DA-ELIMINARE`
- `C:\Users\valer\OneDrive - Unimore\Desktop\studiomedicodottoressabraglia.DA-ELIMINARE-copia-onedrive`

---

## Riepilogo di cosa è già stato fatto  **[FATTO]**

- Account paziente completi: registrazione, login, **verifica email** obbligatoria
- Isolamento dati: un paziente non accede alle pratiche di un altro (verificato)
- Password bootstrap `.env` non sovrascrive più account esistenti; recovery monouso
- Cambio/reset password revoca tutte le sessioni
- HTTPS fail-closed con allowlist host (pronto, si attiva da `.env`)
- Redirect basato su Host validato; `/salute` mai redirezionato
- Chat: alla scadenza 72h i messaggi vengono cancellati davvero
- Inbox: limite byte prima del parsing MIME
- Log senza dati personali / codici pratica
- Moduli Google: lettura incrementale invece dell'intero foglio
- Token pannello admin in `sessionStorage`
- Dipendenze: 3 vulnerabilità high risolte (`npm audit` → 0)
- **Backup cifrati** (AES-256-GCM) — da attivare con la chiave (punto 4)
- Password rimossa dai documenti e dalla cronologia Git locale
- App spostata fuori da OneDrive in `C:\Users\valer\studiomedico`, servizio riconfigurato
- Suite di test: da 213 a **224 verifiche**, tutte verdi
