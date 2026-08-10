# Fa partire il sito da solo a ogni accensione della macchina Windows.
#
#   .\strumenti\servizio-windows.ps1              installa (o aggiorna)
#   .\strumenti\servizio-windows.ps1 stato        dice se sta girando
#   .\strumenti\servizio-windows.ps1 ferma        spegne il sito per lavorarci
#   .\strumenti\servizio-windows.ps1 avvia        lo riaccende
#   .\strumenti\servizio-windows.ps1 riavvia      lo spegne e riaccende
#   .\strumenti\servizio-windows.ps1 rimuovi      toglie l'avvio automatico
#
# E' il corrispondente di strumenti/avvio-automatico.sh, che vale solo sul Mac.
#
# Serve PowerShell aperto COME AMMINISTRATORE per installa, riavvia e rimuovi:
# su Windows i servizi sono roba di sistema, non del singolo utente come i
# LaunchAgent di macOS. Solo "stato" funziona da utente normale.
#
# Un servizio e non l'avvio automatico all'accesso: il servizio parte
# all'accensione senza che nessuno faccia login. Se alle tre di notte va via la
# corrente e torna, la macchina si riaccende e il sito riparte da solo. Con
# l'avvio all'accesso resterebbe fermo sulla schermata di login, e la mattina
# ad Arceto troverebbero il pannello morto senza nessuno davanti a questa
# macchina per accorgersene.

param(
  [ValidateSet('installa', 'stato', 'ferma', 'avvia', 'riavvia', 'rimuovi')]
  [string]$Azione = 'installa',

  # Dove sta nssm.exe. Se non lo passi lo cerco in strumenti\ e poi nel PATH.
  [string]$Nssm
)

$ErrorActionPreference = 'Stop'

$SERVIZIO = 'StudioMedico'
$CARTELLA = Split-Path -Parent $PSScriptRoot
$LOGS = Join-Path $CARTELLA 'logs'
$PORTA = 3000

function sonoAmministratore {
  $identita = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $identita).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function trovaNssm {
  if ($Nssm) {
    if (Test-Path $Nssm) { return (Resolve-Path $Nssm).Path }
    throw "Non trovo nssm.exe in $Nssm"
  }
  $vicino = Join-Path $PSScriptRoot 'nssm.exe'
  if (Test-Path $vicino) { return $vicino }
  $nelPath = Get-Command nssm -ErrorAction SilentlyContinue
  if ($nelPath) { return $nelPath.Source }
  throw @"
Non trovo nssm.exe.
Scaricalo da https://nssm.cc/download, prendi la versione win64 e mettilo in:
  $PSScriptRoot\nssm.exe
oppure passalo cosi':  .\strumenti\servizio-windows.ps1 -Nssm C:\percorso\nssm.exe
"@
}

function trovaNode {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js non trovato. Installalo da https://nodejs.org e riprova.' }
  $node.Source
}

# Elenca gli altri server accesi su questa stessa cartella, cioe' quelli lanciati
# a mano con "npm start" per una prova e mai chiusi.
#
# Ne basta uno di troppo per combinare guai difficili da capire: due server sullo
# stesso database mandano le email due volte, e soprattutto quello di troppo
# serve le pagine nuove (che legge dal disco a ogni richiesta) usando il codice
# vecchio che si e' caricato in memoria all'accensione. Il risultato e' un
# pannello aggiornato che risponde "risorsa non trovata" a pulsanti che esistono.
#
# Sul Mac lo script guarda la cartella di lavoro del processo con lsof. Windows
# non la espone, quindi qui si guarda chi tiene occupata la porta: e' comunque
# quello il conflitto che conta, perche' due server sulla stessa porta non
# possono convivere e il secondo sarebbe partito da questa cartella.
function pidUfficiale {
  $s = Get-CimInstance Win32_Service -Filter "Name='$SERVIZIO'" -ErrorAction SilentlyContinue
  if ($s -and $s.ProcessId) { [int]$s.ProcessId } else { 0 }
}

# Tutti i processi che appartengono al servizio, figli compresi.
#
# NSSM fa da guscio: quello che Windows registra come "il processo del servizio"
# e' nssm.exe, mentre a tenere la porta e' il node che gli sta sotto. Guardando
# solo il PID del servizio, il suo stesso server risulterebbe un intruso: prima
# veniva segnalato come doppione da spegnere, che e' il consiglio peggiore
# possibile.
function processiDelServizio {
  $radice = pidUfficiale
  if (-not $radice) { return @() }

  $tutti = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $suoi = [System.Collections.Generic.HashSet[int]]::new()
  [void]$suoi.Add($radice)

  # Si scende di generazione in generazione finche' non si aggiunge piu' nessuno.
  $trovatoQualcosa = $true
  while ($trovatoQualcosa) {
    $trovatoQualcosa = $false
    foreach ($p in $tutti) {
      if ($suoi.Contains([int]$p.ParentProcessId) -and $suoi.Add([int]$p.ProcessId)) {
        $trovatoQualcosa = $true
      }
    }
  }
  $suoi
}

function doppioni {
  $suoi = processiDelServizio
  $connessioni = Get-NetTCPConnection -LocalPort $PORTA -State Listen -ErrorAction SilentlyContinue
  $trovati = @()
  foreach ($c in $connessioni) {
    if ($suoi -and $suoi.Contains([int]$c.OwningProcess)) { continue }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
    if ($p -and $p.CommandLine -match 'server\.js') { $trovati += [int]$c.OwningProcess }
  }
  $trovati | Sort-Object -Unique
}

function fermaDoppioni {
  $trovati = @(doppioni)
  if ($trovati.Count -eq 0) { return }

  Write-Host "Trovati altri server accesi sulla porta $PORTA ($($trovati -join ', ')). Li spengo."
  foreach ($processo in $trovati) { Stop-Process -Id $processo -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# Il servizio risponde "avviato" appena NSSM parte, ma node ci mette ancora
# qualche istante ad aprire la porta, e la primissima richiesta e' lenta perche'
# alcune parti del programma si caricano solo al primo uso. Chiedere una volta
# sola dice "nessuna risposta" su un sito che sta benissimo.
#
# Quanto aspettare lo decide chi tiene la porta: se non ascolta nessuno non c'e'
# niente da aspettare e si risponde subito, se invece qualcuno ascolta allora e'
# un server che sta ancora scaldandosi e vale la pena dargli tempo.
function rispostaDelSito {
  param([int]$SecondiMax = 20)

  if (-not (Get-NetTCPConnection -LocalPort $PORTA -State Listen -ErrorAction SilentlyContinue)) {
    return $null
  }

  $fine = (Get-Date).AddSeconds($SecondiMax)
  do {
    try { return (Invoke-WebRequest "http://localhost:$PORTA/" -UseBasicParsing -TimeoutSec 5).StatusCode }
    catch { Start-Sleep -Seconds 1 }
  } while ((Get-Date) -lt $fine)
  $null
}

function installa {
  if (-not (sonoAmministratore)) {
    throw 'Serve PowerShell aperto come amministratore. Tasto destro su PowerShell, "Esegui come amministratore".'
  }

  $nssm = trovaNssm
  $node = trovaNode
  New-Item -ItemType Directory -Force $LOGS | Out-Null

  $esistente = Get-Service -Name $SERVIZIO -ErrorAction SilentlyContinue
  if ($esistente) {
    Write-Host "Servizio gia' presente: lo fermo per aggiornarlo."
    fermaServizio
  } else {
    & $nssm install $SERVIZIO $node 'server.js'
  }

  # La cartella di lavoro e' quella del progetto: "server.js" e il percorso del
  # database nel .env sono relativi, quindi senza questo il servizio partirebbe
  # da C:\Windows\System32 e non troverebbe niente.
  & $nssm set $SERVIZIO AppDirectory $CARTELLA
  & $nssm set $SERVIZIO AppParameters 'server.js'
  & $nssm set $SERVIZIO Application $node
  & $nssm set $SERVIZIO Start SERVICE_AUTO_START
  & $nssm set $SERVIZIO AppStdout (Join-Path $LOGS 'servizio.log')
  & $nssm set $SERVIZIO AppStderr (Join-Path $LOGS 'errori.log')

  # Pausa fra un riavvio e l'altro: senza, un guasto serio (per esempio il disco
  # pieno) farebbe riprovare all'infinito molte volte al secondo.
  & $nssm set $SERVIZIO AppRestartDelay 10000

  # I log altrimenti crescono per sempre: qui si girano ogni 10 MB, e la
  # rotazione avviene senza fermare il servizio.
  & $nssm set $SERVIZIO AppRotateFiles 1
  & $nssm set $SERVIZIO AppRotateOnline 1
  & $nssm set $SERVIZIO AppRotateBytes 10485760

  fermaDoppioni
  avviaServizio

  Write-Host "Installato. Il sito ripartira' da solo a ogni accensione."
  stato -AttesaSito 30
}

# Avvio e arresto passano da PowerShell e non da NSSM perche' PowerShell aspetta
# davvero il cambio di stato. Con "nssm start" il comando torna subito e stampa
# "stato inatteso SERVICE_START_PENDING", che sembra un guasto e invece e' solo
# il servizio che sta ancora partendo.
function avviaServizio {
  Start-Service -Name $SERVIZIO
  (Get-Service -Name $SERVIZIO).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
}

function fermaServizio {
  $s = Get-Service -Name $SERVIZIO -ErrorAction SilentlyContinue
  if (-not $s -or $s.Status -eq 'Stopped') { return }
  Stop-Service -Name $SERVIZIO -Force
  $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}

function stato {
  param([int]$AttesaSito = 20)

  $s = Get-Service -Name $SERVIZIO -ErrorAction SilentlyContinue
  if (-not $s) {
    Write-Host 'Avvio automatico non installato.'
  } else {
    $processo = pidUfficiale
    if ($s.Status -eq 'Running' -and $processo) {
      Write-Host "Acceso (processo $processo)."
    } else {
      Write-Host "Registrato ma fermo (stato: $($s.Status)) - guarda logs\errori.log"
    }
  }

  $altri = @(doppioni)
  if ($altri.Count -gt 0) {
    if ($s) {
      Write-Host "ATTENZIONE: c'e' un altro server acceso sulla porta $PORTA ($($altri -join ', ')). Spegnilo con: .\strumenti\servizio-windows.ps1 riavvia"
    } else {
      # Senza servizio installato non c'e' niente da riavviare: quel consiglio
      # darebbe solo un errore a chi lo segue.
      Write-Host "C'e' un server acceso a mano sulla porta $PORTA ($($altri -join ', ')). Lo sostituira' il servizio quando lo installi."
    }
  }

  $codice = rispostaDelSito -SecondiMax $AttesaSito
  if ($codice) {
    Write-Host "Risposta del sito: HTTP $codice"
  } else {
    Write-Host 'Risposta del sito: nessuna risposta'
  }

  $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1 -ExpandProperty IPAddress
  if ($ip) { Write-Host "Dagli altri computer in studio: http://${ip}:$PORTA" }
}

function riavvia {
  if (-not (sonoAmministratore)) {
    throw 'Serve PowerShell aperto come amministratore.'
  }
  fermaServizio
  fermaDoppioni
  avviaServizio
  stato -AttesaSito 30
}

function rimuovi {
  if (-not (sonoAmministratore)) {
    throw 'Serve PowerShell aperto come amministratore.'
  }
  $nssm = trovaNssm
  fermaServizio
  & $nssm remove $SERVIZIO confirm | Out-Null
  Write-Host "Avvio automatico rimosso. Il sito non ripartira' piu' da solo."
}

# Spegne il sito per una manutenzione: i test, un aggiornamento del codice, una
# copia dell'archivio a mano.
#
# Mette anche in pausa la sorveglianza, altrimenti entro dieci minuti quella
# rimetterebbe in piedi il servizio proprio mentre si sta lavorando, e chi
# lavora non capirebbe perche' il server gli riparte da solo.
function ferma {
  if (-not (sonoAmministratore)) {
    throw 'Serve PowerShell aperto come amministratore.'
  }
  New-Item -ItemType Directory -Force $LOGS | Out-Null
  New-Item -ItemType File -Force (Join-Path $LOGS 'sorveglianza-in-pausa') | Out-Null
  fermaServizio
  fermaDoppioni
  Write-Host "Servizio fermo e sorveglianza in pausa. Il sito adesso non risponde."
  Write-Host "Quando hai finito:  .\strumenti\servizio-windows.ps1 avvia"
}

function avvia {
  if (-not (sonoAmministratore)) {
    throw 'Serve PowerShell aperto come amministratore.'
  }
  fermaDoppioni
  avviaServizio
  Remove-Item (Join-Path $LOGS 'sorveglianza-in-pausa') -ErrorAction SilentlyContinue
  Write-Host 'Servizio riacceso e sorveglianza riattivata.'
  stato -AttesaSito 30
}

switch ($Azione) {
  'installa' { installa }
  'stato'    { stato }
  'ferma'    { ferma }
  'avvia'    { avvia }
  'riavvia'  { riavvia }
  'rimuovi'  { rimuovi }
}
