# API Analisi Estratto Conto

Endpoint custom che analizza un PDF di estratto conto bancario, confronta
le transazioni con quelle registrate nel DB e genera un report con sforamenti,
transazioni mancanti e un giudizio sintetico generato da LLM (Ollama).

## Endpoint

`POST /api/analisi-estratto-conto`

Content-Type: `multipart/form-data`

Body:

- `pdf` (file): estratto conto in PDF
- `walletId` (string): documentId del wallet
- `mese` (string): mese da analizzare in formato `YYYY-MM`

## Risposta

```json
{
  "mese": "2026-04",
  "walletId": "abc123",
  "validazione": { "ok": true },
  "periodoEstratto": { "dal": "2026-04-01", "al": "2026-04-30" },
  "sforamenti": [
    { "nome": "Spesa", "budget": 400, "speso": 450.20, "rimanente": -50.20, "sforato": true }
  ],
  "mancanti": [
    { "data": "2026-04-12", "importo": 23.50, "descrizione": "ESSELUNGA", "categoriaSuggerita": "Spesa" }
  ],
  "totale": { "budget": 1200, "speso": 980, "rimanente": 220 },
  "giudizio": "Aprile sotto controllo, hai risparmiato 220€. Attenzione alla spesa alimentare."
}
```

## Setup

### 1. Installare la dipendenza pdf-parse

```bash
cd budget-api
npm install pdf-parse
```

### 2. Ollama (installato sull'host)

Ollama gira direttamente sulla macchina host (non in container).
Verifica che sia in ascolto su tutte le interfacce e che il modello sia presente:

```bash
# Verifica binding
ss -lntp | grep 11434   # deve mostrare 0.0.0.0:11434 o *:11434

# Scarica il modello (una volta sola, ~4.7GB)
ollama pull qwen2.5:7b
```

Il modello richiede ~6GB di RAM in esecuzione.

### 3. Variabili ambiente

Configurate in `docker-compose.yml`:

- `OLLAMA_URL` → `http://host.docker.internal:11434` (host dove gira Ollama)
- `OLLAMA_MODEL` → `qwen2.5:7b`

Per cambiare IP/modello modifica il `docker-compose.yml` o passa le env al `npm run develop` in locale.

## Test con curl

```bash
curl -X POST http://localhost:1337/api/analisi-estratto-conto \
  -F "pdf=@/path/to/estratto.pdf" \
  -F "walletId=il-document-id-del-wallet" \
  -F "mese=2026-04"
```

## Note tecniche

- L'endpoint usa `auth: false` per coerenza con gli altri endpoint dell'app.
  In produzione valutare di abilitare JWT.
- Il matching transazioni banca/DB usa tolleranza di 1 cent sull'importo
  e ±3 giorni sulla data (vedi `diff-engine.js`).
- L'LLM riceve max 12000 caratteri di testo estratto. Per estratti molto
  lunghi può servire una strategia di chunking.
