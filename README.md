# Meteo del Mercato

Dashboard locale che unisce **gamma (GEX/DEX)** e **orderflow** per BTC, ETH, SOL e oro, e riassume il contesto in un
"meteo": ☀️ Sereno (mean reversion), ⛅ Variabile (attesa), ⛈️ Temporale (trend). È una lettura di contesto,
non un segnale operativo.

## Avvio (PC Windows)

```powershell
.\run.ps1
```

Poi apri http://127.0.0.1:8080. Serve Node.js 20 o superiore; nessun'altra installazione.

Test del motore: `npm test`. Sincronizzazione con TradingView: `npm run tv-sync` (vedi sotto).

## Da dove arrivano i dati

| Dato | Fonte | Note |
|---|---|---|
| Trade | Binance USDⓈ-M perpetual, websocket `/market` | `aggTrade` |
| Book locale | Binance: snapshot REST (1000 livelli per lato) + diff `@depth@100ms` su `/public` | sincronizzato con gli update id, risincronizzazione automatica, rinfresco ogni 5 min |
| Storico della sessione | Klines 1m Binance | delta esatto; profilo approssimato fino all'avvio |
| Candele del grafico | Klines Binance al timeframe scelto (45m costruito da 15m) + barre 1m live | candele chiuse da Binance (cache 30 min, riletta appena si chiude una candela con trade persi all'avvio o in una riconnessione); dalla candela ancora aperta all'ultima lettura in poi dalle barre 1m |
| Opzioni BTC/ETH/SOL | Deribit, API pubblica | ogni 2 min, scadenze entro 45 giorni |
| Opzioni oro | CBOE, GLD (ritardo ~15 min) | livelli riportati al prezzo XAU con il rapporto XAU/GLD |
| Orderflow oro | Perpetual `XAUUSDT` Binance | è una proxy, non il future GC del CME |

La sessione è il giorno UTC (00:00–24:00).

## Cosa calcola

- **GEX**: gamma × OI × spot² × 1% per strike, con la convenzione dealer (call +, put −) configurabile in `config.json`.
  Il **gamma flip** è il prezzo in cui il GEX totale, ricalcolato con Black-Scholes, cambia segno.
  Call/put wall: gli strike con il GEX call/put più grande in valore assoluto.
- **Orderflow**: delta, CVD di sessione e degli ultimi 15 minuti, volume profile (POC, VAH/VAL al 70%, LVN), big trade.
- **Iceberg / assorbimento**: un livello in cui viene eseguito almeno 3× la size massima mostrata dal book, per un
  nozionale minimo, senza che il prezzo lo attraversi. Con 2 o più ricariche del book è marcato *iceberg*, altrimenti
  *assorbimento*. È una stima: il book mostra solo la parte visibile degli ordini, non quella nascosta.
- **Pressione book ±0,25%**: quota del nozionale in acquisto (bid) sul totale bid+ask esposto entro ±0,25% dal prezzo,
  media esponenziale sul tempo reale con costante di 30 s. Sopra 50% ci sono più ordini in acquisto sotto il prezzo
  che in vendita sopra. È un segnale debole (gli ordini esposti possono sparire) e non entra nel meteo: compare solo
  fra i motivi sopra 65% o sotto 35%, e solo con il book sincronizzato.
  Lo snapshot di Binance copre circa ±0,15% su BTC, ±0,4% su ETH, ±0,28% sull'oro
  e ben oltre la banda su SOL: fuori da questa finestra il book contiene solo i livelli toccati dagli aggiornamenti
  (`covered: false` nell'API), quindi su BTC la banda ±0,25% è sempre in parte ricostruita.
- **Meteo e checklist** (location → aggressione → conferma): regole in `src/engine/regime.js`.

## API

| Metodo | Percorso | Uso |
|---|---|---|
| GET | `/api/snapshot` | riepilogo di tutti gli asset |
| GET | `/api/snapshot/BTC?tf=45m` | dettaglio con candele al timeframe `tf` (1m, 3m, 5m, 15m, 30m, 45m, 1h, 4h, 1d; senza `tf` 1m), profilo, GEX per strike e profondità del book ±1%. CVD per candela `giornaliero` fino a 1h, `cumulativo` su 4h e 1d (`cvdMode`). Con `&since=<t ultima candela>&rev=<rev ricevuta>` arrivano solo le candele da `since` in poi (`full: false`); se la `rev` è cambiata, di nuovo la serie intera (`full: true`) |
| GET | `/api/levels/BTC` | livelli chiave + stringa per TradingView (`pine`) |
| POST | `/api/ingest/gex` | GEX da Hermes: `{"asset":"BTC","total":..., "flip":..., "callWall":..., "putWall":...}` |
| GET | `/api/status` | stato dei feed |
| WS | `/stream` | riepilogo ogni secondo |

## TradingView

### Una tantum
L'indicatore si crea una volta sola; poi tv-sync ne cambia solo le impostazioni (input), senza toglierlo e rimetterlo.
Serve TradingView avviato con la porta di debug (punto 1 sotto).

1. `npm run tv-setup`: prova, non modifica nulla. Controlla che il Pine compili, cerca "Meteo Livelli" fra tutti gli
   script salvati dell'account e sul grafico attivo, e stampa il piano.
2. `npm run tv-setup -- --apply`: crea lo script privato "Meteo Livelli" se manca (salvataggio nuovo, senza
   sovrascrivere: il Pine Editor non viene toccato) e lo aggiunge al grafico attivo se manca. Dopo il salvataggio
   rilegge l'elenco e controlla che nessun altro script sia cambiato. Rilanciarlo non crea doppioni.
3. Se modifichi `tradingview/meteo-livelli.pine`: `npm run tv-setup -- --update` salva una nuova versione dello stesso
   script; TradingView aggiorna l'indicatore già sul grafico.

A mano: Pine Editor → **Crea nuovo → Indicatore**, incolla il file, salva come "Meteo Livelli", **Aggiungi al grafico**.

### Aggiornamento automatico
1. `scripts\avvia-tradingview.ps1`: riavvia TradingView Desktop con la porta di debug 9222 (solo locale).
   Chiude le finestre di TradingView aperte.
2. `npm run tv-sync`: ogni 15 s legge il simbolo del grafico attivo (BTC, ETH, SOL, oro: alias in `config.json`),
   chiede i livelli alla dashboard e aggiorna gli input dell'indicatore "Meteo Livelli". Scrive solo quando i livelli
   cambiano. Non aggiunge né toglie indicatori: se manca dal grafico lo segnala nel log.
   L'alias va seguito da una quotazione in dollari o da una scadenza (`BTCUSDT.P`, `XAUUSD`, `GC1!`): `BTC.D`, `ETHBTC`,
   `BTCDOMUSDT` non contano. Un alias con l'exchange (`TVC:GOLD`) vale solo per quel simbolo.
   Con `"autoAddIndicator": true` nella sezione `tradingview` lo aggiunge una volta per grafico e per avvio, se il
   piano ha ancora posto per un indicatore.

Usa la libreria di [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) (installata in
`C:\Users\giuli\Desktop\tradingview-mcp`, percorso in `config.json`). Lo stesso MCP è registrato in Claude Code con il
nome `tradingview`, quindi nelle nuove sessioni Claude può leggere il grafico e disegnare.
Si appoggia a interfacce interne non ufficiali: un aggiornamento di TradingView può romperlo.

Senza sincronizzazione resta il metodo manuale: nella dashboard **Copia livelli per TradingView** e incolla il testo
nell'input "Livelli dalla dashboard".

Per l'oro i livelli sono calcolati su `XAUUSDT` di Binance: su XAUUSD spot o sul future GC la base può spostarli di
qualche dollaro.

## Passaggio al Raspberry Pi

Copia la cartella, poi in `config.json` imposta `"host": "0.0.0.0"` per raggiungerla dalla rete di casa e avvia
`node src/server.js` come servizio `systemd`. Il codice non cambia.

## Configurazione

`config.json`: simboli, tick del profilo, soglie dei big trade e degli iceberg per asset, orizzonte delle scadenze,
segni del GEX e parametri del CVD. Nella sezione `orderflow`: `bookBandPct` (banda della pressione, in %),
`bookSmoothingSec` (costante della media) e `bookPrunePct` (oltre questa distanza % dal prezzo i livelli del book
vengono scartati per limitare la memoria).
