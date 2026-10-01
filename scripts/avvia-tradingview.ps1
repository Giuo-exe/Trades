# Riavvia TradingView Desktop con la porta di debug 9222 (solo 127.0.0.1), necessaria
# per tv-sync e per l'MCP. ATTENZIONE: chiude le finestre di TradingView aperte.
# Usa la funzione launch di tradingview-mcp, che gestisce anche l'installazione dal
# Microsoft Store (se Windows blocca la porta, avvia una copia locale del pacchetto).
$config = Get-Content (Join-Path $PSScriptRoot "..\config.json") -Raw | ConvertFrom-Json
$health = "file:///" + ($config.tradingview.mcpPath -replace '\\', '/') + "/src/core/health.js"
$script = "import('$health').then(m => m.launch({})).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exit(1); })"
node --input-type=module -e $script
