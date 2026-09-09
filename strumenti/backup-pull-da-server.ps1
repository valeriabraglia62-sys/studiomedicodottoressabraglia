# Scarica i backup cifrati dal server nella cartella OneDrive, che poi li
# sincronizza da sola sul cloud. Lanciato ogni giorno da un'operazione
# pianificata di Windows. Usa la chiave SSH gia' configurata (nessuna password).
#
# I file .enc del server sono cifrati con la BACKUP_ENCRYPTION_KEY del server.
# I file piu' vecchi in questa cartella (di quando il sito girava sul PC) sono
# cifrati con la chiave del PC: per rileggerli serve quella, non la nuova.

$ErrorActionPreference = 'Stop'

$server  = 'root@80.211.22.237'
$origine = '/opt/studiomedico/data/backup/*'
$dest    = Join-Path $env:OneDrive 'StudioMedico-Backup'
$log     = Join-Path $dest '_pull.log'

# Sempre la scp di Windows (OpenSSH), non quella di Git: gestiscono i percorsi
# in modo diverso e solo questa e' garantita dall'Utilita' di pianificazione.
$scp = Join-Path $env:SystemRoot 'System32\OpenSSH\scp.exe'
if (-not (Test-Path $scp)) { $scp = 'scp' }

New-Item -ItemType Directory -Force -Path $dest | Out-Null

try {
    & $scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -r "${server}:${origine}" $dest
    if ($LASTEXITCODE -ne 0) { throw "scp uscito con codice $LASTEXITCODE" }
    $n = (Get-ChildItem $dest -Filter '*.enc' -ErrorAction SilentlyContinue).Count
    "$(Get-Date -Format s)  OK  $n file .enc in cartella" | Add-Content $log
} catch {
    "$(Get-Date -Format s)  ERRORE  $_" | Add-Content $log
    exit 1
}
