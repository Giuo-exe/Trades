# Avvia "Meteo del Mercato" sul PC. Installa le dipendenze al primo avvio.
Set-Location -Path $PSScriptRoot
if (-not (Test-Path "node_modules")) {
    npm install --no-audit --no-fund
}
Write-Host "Dashboard: http://127.0.0.1:8080  (Ctrl+C per fermare)"
node src/server.js
