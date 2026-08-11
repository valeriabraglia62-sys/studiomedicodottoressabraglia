# Riparte da un archivio vuoto, mettendo da parte quello attuale.
#
#   .\strumenti\azzera-archivio.ps1
#
# Serve una volta sola, alla fine delle prove: si e' provato il sistema per
# giorni con pazienti finti, e quello che resta dentro non e' l'archivio dello
# studio ma il residuo delle prove.
#
# NON CANCELLA NIENTE. L'archivio attuale viene rinominato con la data e resta
# li' accanto, e restano anche tutte le copie di sicurezza. Se domani salta
# fuori che dentro c'era qualcosa di vero, si rimette al suo posto e si riparte
# da dov'era: e' un file solo.
#
# Serve PowerShell aperto come amministratore, perche' va fermato il servizio.

$ErrorActionPreference = 'Stop'

$CARTELLA = Split-Path -Parent $PSScriptRoot
$GESTORE = Join-Path $PSScriptRoot 'servizio-windows.ps1'
$ARCHIVIO = Join-Path $CARTELLA 'data\medstudent.sqlite'
$PORTA = 3000

function sonoAmministratore {
  $identita = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $identita).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (sonoAmministratore)) {
  throw 'Serve PowerShell aperto come amministratore. Tasto destro su PowerShell, "Esegui come amministratore".'
}

if (-not (Test-Path $ARCHIVIO)) {
  throw "Non trovo l'archivio in $ARCHIVIO. Non faccio niente."
}

Write-Host '--- Cosa c e dentro adesso ---'
& node (Join-Path $PSScriptRoot 'conta-archivio.cjs')

Write-Host ''
$risposta = Read-Host 'Scrivi AZZERA per procedere, qualsiasi altra cosa per fermarti'
if ($risposta -ne 'AZZERA') {
  Write-Host 'Non ho toccato niente.'
  return
}

Write-Host ''
Write-Host 'Fermo il servizio...'
& powershell -NoProfile -ExecutionPolicy Bypass -File $GESTORE ferma

# Anche i file di appoggio devono seguire l'archivio: un -wal lasciato indietro
# verrebbe letto insieme al file nuovo e ci rovescerebbe dentro le ultime
# scritture di quello vecchio.
$timbro = Get-Date -Format 'yyyy-MM-dd-HH-mm-ss'
$destinazione = "$ARCHIVIO.prove-$timbro"

foreach ($estensione in @('', '-wal', '-shm')) {
  $da = "$ARCHIVIO$estensione"
  if (Test-Path $da) {
    Move-Item $da "$destinazione$estensione"
    Write-Host "  messo da parte: $(Split-Path $da -Leaf) -> $(Split-Path "$destinazione$estensione" -Leaf)"
  }
}

Write-Host ''
Write-Host 'Riaccendo: il programma si crea un archivio nuovo e vuoto...'
& powershell -NoProfile -ExecutionPolicy Bypass -File $GESTORE avvia

Write-Host ''
Write-Host '--- Cosa c e dentro adesso ---'
& node (Join-Path $PSScriptRoot 'conta-archivio.cjs')

Write-Host ''
Write-Host "L'archivio delle prove e' rimasto in:"
Write-Host "  $destinazione"
Write-Host 'Non cancellarlo finche'' non sei sicuro che non serviva.'
