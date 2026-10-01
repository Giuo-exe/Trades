# Cicli T-3 (Pine Script)

Indicatore e libreria del motore ciclico, nella versione su cui si basa l'analisi evoluta.

| File | Contenuto |
|---|---|
| `cicli-t3-tree-backtrack-v4.pine` | Indicatore "Cicli T-3: Tree & Backtrack V4": input, ciclo principale, ricentraggio, pannello score, Fibonacci, range del vincolo. |
| `cicli-core-library.pine` | Libreria `CicliCore`: tipi e motore (candidati, raccordi T-6/T-5/T-4/R(T-3), backtracking, vincolo settimanale, swing evoluti, analisi T+1/T+2). |

L'indicatore importa `peppogiuo/CicliCore/1`: la libreria deve essere pubblicata (anche privata) su TradingView
con quel nome e versione, altrimenti l'import non si risolve.

Sono indipendenti dalla dashboard "Meteo del Mercato": `meteo-livelli.pine` (nella cartella sopra) e' l'unico
indicatore che la dashboard aggiorna.
