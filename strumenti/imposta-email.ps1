<#
  Cambia la casella da cui il programma spedisce e che legge.

  Chiede la password per le app senza mostrarla a schermo e la scrive nel .env.
  Serve uno strumento apposta perche' quella password non deve passare per la
  cronologia dei comandi ne' per una conversazione: qui la si digita una volta e
  finisce solo dentro il file.

  Uso:
      .\strumenti\imposta-email.ps1
      .\strumenti\imposta-email.ps1 -Indirizzo auslvaleria@gmail.com

  Del .env viene fatta una copia prima di toccarlo. Dopo, il servizio va
  riavviato: le impostazioni si leggono all'avvio.
#>

param(
  [string]$Indirizzo = ''
)

$ErrorActionPreference = 'Stop'

$radice = Split-Path -Parent $PSScriptRoot
$env_file = Join-Path $radice '.env'

if (-not (Test-Path $env_file)) {
  Write-Host "Non trovo il file .env in $radice" -ForegroundColor Red
  exit 1
}

if (-not $Indirizzo) {
  $Indirizzo = Read-Host 'Indirizzo della casella (es. auslvaleria@gmail.com)'
}
$Indirizzo = $Indirizzo.Trim()

if ($Indirizzo -notmatch '^[^@\s]+@[^@\s]+\.[a-z]{2,}$') {
  Write-Host "Questo non sembra un indirizzo email: $Indirizzo" -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'Password per le app di Google (16 lettere). Non comparira'' a schermo.'
Write-Host 'Gli spazi che Google mostra fra i gruppetti si possono lasciare: li tolgo io.'
$segreta = Read-Host 'Password' -AsSecureString

$puntatore = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segreta)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($puntatore)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($puntatore)
}

$password = ($password -replace '\s', '')

if ($password.Length -lt 16) {
  Write-Host "La password ha $($password.Length) caratteri: quelle di Google ne hanno 16. Non ho scritto niente." -ForegroundColor Red
  exit 1
}

# Copia di sicurezza: e' il file da cui dipende tutto il programma.
$copia = "$env_file.prima-di-imposta-email"
Copy-Item $env_file $copia -Force

$righe = [System.Collections.ArrayList](Get-Content $env_file)

function Imposta-Riga {
  param($righe, [string]$chiave, [string]$valore)
  for ($i = 0; $i -lt $righe.Count; $i++) {
    if ($righe[$i].StartsWith("$chiave=")) {
      $righe[$i] = "$chiave=$valore"
      return "$chiave aggiornata"
    }
  }
  [void]$righe.Add("$chiave=$valore")
  return "$chiave aggiunta"
}

Write-Host ''
Write-Host (Imposta-Riga $righe 'EMAIL_USER' $Indirizzo)
Write-Host (Imposta-Riga $righe 'EMAIL_PASS' $password)

Set-Content -Path $env_file -Value $righe -Encoding UTF8

Write-Host ''
Write-Host "Copia di sicurezza in: $copia"
Write-Host 'Adesso riavvia il servizio da un PowerShell come amministratore:'
Write-Host '    Restart-Service StudioMedico'
Write-Host ''
Write-Host 'Poi controlla in "Stato del sistema" che "Invio email" sia attivo.'
