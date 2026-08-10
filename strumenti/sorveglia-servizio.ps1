# Controlla che il sito sia in piedi e, se non lo e', lo rimette in piedi.
#
#   .\strumenti\sorveglia-servizio.ps1            controlla una volta
#   .\strumenti\sorveglia-servizio.ps1 registra   crea l'attivita' pianificata
#   .\strumenti\sorveglia-servizio.ps1 rimuovi    toglie l'attivita' pianificata
#
# "registra" e "rimuovi" vogliono PowerShell aperto come amministratore. Il
# controllo in se' gira da chiunque, ma per rimettere in piedi un servizio
# servono i diritti, ed e' per questo che l'attivita' gira come SYSTEM.
#
# La registrazione sta qui dentro e non in un comando da incollare perche' il
# comando equivalente con schtasks porta virgolette dentro virgolette: e' scritto
# nella sintassi di cmd, PowerShell lo smonta prima che schtasks lo veda e
# l'attivita' non nasce. Meglio un verbo che si legge.
#
# A cosa serve, in concreto: il 10 agosto 2026 un aggiornamento di versione di
# Windows ha cancellato il servizio, voce di registro compresa, e il sito e'
# rimasto giu' finche' qualcuno non se n'e' accorto guardando. Le attivita'
# pianificate invece quegli aggiornamenti li sopravvivono, quindi questa e'
# messa apposta al posto giusto per rimediare da sola. Nessuno sta davanti a
# questa macchina: se non si ripara da sola, resta rotta fino alla mattina dopo.
#
# Fa tre controlli in fila, dal piu' grave al piu' lieve:
#   1. il servizio non esiste piu'  -> lo reinstalla
#   2. il servizio esiste ma e' fermo -> lo avvia
#   3. il servizio gira ma il sito non risponde -> lo riavvia
#
# Scrive nel log solo quando trova qualcosa che non va o quando interviene: un
# log che dice "tutto bene" ogni dieci minuti non lo leggerebbe nessuno e
# nasconderebbe le righe che contano. Per sapere che sta lavorando c'e' invece
# logs\sorveglianza-ultimo-controllo.txt, che riporta sempre l'ultima passata.

param(
  [ValidateSet('controlla', 'registra', 'rimuovi')]
  [string]$Azione = 'controlla'
)

$ErrorActionPreference = 'Stop'

$ATTIVITA = 'StudioMedico - sorveglianza'
$OGNI_MINUTI = 10
$SERVIZIO = 'StudioMedico'
$CARTELLA = Split-Path -Parent $PSScriptRoot
$LOGS = Join-Path $CARTELLA 'logs'
$LOG = Join-Path $LOGS 'sorveglianza.log'
$ULTIMO = Join-Path $LOGS 'sorveglianza-ultimo-controllo.txt'
$PAUSA = Join-Path $LOGS 'sorveglianza-in-pausa'
$GESTORE = Join-Path $PSScriptRoot 'servizio-windows.ps1'
$PORTA = 3000

New-Item -ItemType Directory -Force $LOGS | Out-Null

function annota {
  param([string]$Testo)

  # Il log non deve crescere all'infinito su una macchina che nessuno guarda.
  if ((Test-Path $LOG) -and (Get-Item $LOG).Length -gt 1MB) {
    $coda = Get-Content $LOG -Tail 200
    Set-Content $LOG $coda -Encoding UTF8
  }
  Add-Content $LOG ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Testo) -Encoding UTF8
}

function sitoRisponde {
  param([int]$SecondiMax = 20)

  $fine = (Get-Date).AddSeconds($SecondiMax)
  do {
    try {
      $r = Invoke-WebRequest "http://localhost:$PORTA/" -UseBasicParsing -TimeoutSec 5
      return ($r.StatusCode -eq 200)
    } catch { Start-Sleep -Seconds 2 }
  } while ((Get-Date) -lt $fine)
  $false
}

function sonoAmministratore {
  $identita = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $identita).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function controlla {

# Chi ferma il servizio di proposito, per una manutenzione o per lanciare i
# test, crea questo file: senza, la sorveglianza glielo riaccenderebbe sotto le
# mani e si finirebbe a litigare con la propria stessa automazione.
if (Test-Path $PAUSA) {
  Set-Content $ULTIMO ("{0}  in pausa (esiste logs\sorveglianza-in-pausa)" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
  return
}

$esito = 'tutto a posto'

try {
  $s = Get-Service -Name $SERVIZIO -ErrorAction SilentlyContinue

  if (-not $s) {
    annota 'Il servizio non esiste piu'' - lo reinstallo. Di solito e'' un aggiornamento di versione di Windows che se l''e'' portato via.'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $GESTORE installa *>&1 | Out-Null
    $esito = 'servizio reinstallato'
  }
  elseif ($s.Status -ne 'Running') {
    annota ("Il servizio era fermo (stato: {0}) - lo avvio." -f $s.Status)
    Start-Service -Name $SERVIZIO
    (Get-Service -Name $SERVIZIO).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    $esito = 'servizio riavviato'
  }

  if (-not (sitoRisponde)) {
    annota 'Il servizio risulta acceso ma il sito non risponde - lo riavvio.'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $GESTORE riavvia *>&1 | Out-Null
    if (sitoRisponde) {
      annota 'Dopo il riavvio il sito risponde.'
      $esito = 'sito recuperato con un riavvio'
    } else {
      annota 'ATTENZIONE: dopo il riavvio il sito continua a non rispondere. Serve qualcuno che guardi logs\errori.log.'
      $esito = 'GUASTO NON RISOLTO'
    }
  }
}
catch {
  annota ("Errore durante il controllo: {0}" -f $_.Exception.Message)
  $esito = 'controllo fallito'
}

Set-Content $ULTIMO ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $esito) -Encoding UTF8
Write-Host $esito

}

# Gira come SYSTEM perche' reinstallare o riavviare un servizio vuole i diritti
# di amministratore, e ogni dieci minuti perche' e' il ritardo massimo con cui
# accettiamo che il sito resti giu' senza che nessuno se ne accorga.
function registra {
  if (-not (sonoAmministratore)) {
    throw 'Serve PowerShell aperto come amministratore. Tasto destro su PowerShell, "Esegui come amministratore".'
  }

  $mio = Join-Path $PSScriptRoot 'sorveglia-servizio.ps1'
  $azione = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $mio)

  # Due inneschi apposta. Quello all'avvio copre il caso peggiore, cioe' la
  # macchina che torna su dopo un blackout; quello ripetuto copre tutto il
  # resto. Con uno solo dei due resterebbe scoperto o l'avvio o il seguito.
  $inneschi = @(
    New-ScheduledTaskTrigger -AtStartup
    New-ScheduledTaskTrigger -Once -At (Get-Date) `
      -RepetitionInterval (New-TimeSpan -Minutes $OGNI_MINUTI)
  )

  $identita = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

  # Se un controllo si pianta, il successivo non deve accodarsi: meglio saltarlo
  # e riprovare fra dieci minuti che accumulare copie che si ostacolano.
  $impostazioni = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

  Register-ScheduledTask -TaskName $ATTIVITA -Action $azione -Trigger $inneschi `
    -Principal $identita -Settings $impostazioni -Force | Out-Null

  Write-Host "Sorveglianza registrata: controlla ogni $OGNI_MINUTI minuti e a ogni accensione."
  stato
}

function rimuovi {
  if (-not (sonoAmministratore)) {
    throw 'Serve PowerShell aperto come amministratore.'
  }
  Unregister-ScheduledTask -TaskName $ATTIVITA -Confirm:$false
  Write-Host "Sorveglianza rimossa. Nessuno controllera' piu' che il sito sia in piedi."
}

function stato {
  $a = Get-ScheduledTask -TaskName $ATTIVITA -ErrorAction SilentlyContinue
  if (-not $a) {
    Write-Host 'Sorveglianza non registrata.'
    return
  }
  $info = Get-ScheduledTaskInfo -TaskName $ATTIVITA
  Write-Host ("Sorveglianza registrata, stato {0}. Ultima esecuzione: {1}. Prossima: {2}." -f `
    $a.State, $info.LastRunTime, $info.NextRunTime)
  if (Test-Path $ULTIMO) { Write-Host ('Ultimo controllo: ' + (Get-Content $ULTIMO -Raw).Trim()) }
}

switch ($Azione) {
  'controlla' { controlla }
  'registra'  { registra }
  'rimuovi'   { rimuovi }
}
