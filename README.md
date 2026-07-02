# BudgetApp — Backend (Strapi) & Guida d'installazione completa

App di **gestione budget personale multi-portafoglio**: portafogli con budget mensile,
categorie di spesa, transazioni e un "salvadanaio" che traccia i risparmi mese per mese.

Questo repository contiene il **backend Strapi 5** ed è anche la **guida d'installazione
dell'intero progetto** (backend + web + app Android).

## 🏗️ Architettura

Il progetto è diviso in **tre repository**:

| Repo | Cosa | Stack |
|---|---|---|
| **budget-api** (questo) | Backend / API REST | Strapi 5 + MySQL |
| [budget-app](https://github.com/v3zz0/budget-app) | Frontend web | Vue 3 + Vite + PrimeVue |
| [budget-flutter](https://github.com/v3zz0/budget-flutter) | App Android nativa | Flutter |

Web e mobile consumano **le stesse API REST** esposte da questo backend.

### Modello dati

- **Wallet** → più **Categories** (one-to-many)
- **Category** → più **Transactions** (one-to-many)
- **Salvadanaio** → snapshot mensili per wallet (`risparmio = budget_allocato − speso`, se positivo)

---

## ✅ Prerequisiti

- **Node.js** `>= 20 <= 24` ([nvm](https://github.com/nvm-sh/nvm) consigliato)
- **MySQL** `8.x` (o MariaDB 11.x) in ascolto e raggiungibile
- **npm** `>= 6`
- (Opzionale) **Docker** + Docker Compose per il deploy
- (Opzionale) **Ollama** in locale per la feature "analisi estratto conto" via LLM

---

## 🚀 Installazione backend (sviluppo)

```bash
# 1. Clona il repo
git clone https://github.com/v3zz0/budget-api.git
cd budget-api

# 2. Installa le dipendenze
npm install

# 3. Crea il file di ambiente dai placeholder
cp .env.example .env

# 4. Genera segreti REALI e compilali nel .env (vedi sotto)
openssl rand -base64 16   # ripeti per ogni segreto

# 5. Prepara il database MySQL (una tantum)
#    mysql -u root -p -e "CREATE DATABASE budget CHARACTER SET utf8mb4;"

# 6. Avvia in sviluppo (hot reload + admin panel)
npm run develop
```

Admin panel: **http://localhost:1337/admin** (al primo avvio crei l'utente amministratore).
API REST: **http://localhost:1337/api**

### Variabili d'ambiente (`.env`)

Copiate da `.env.example`. **Nessun valore va committato** (`.env` è in `.gitignore`).

| Variabile | Descrizione |
|---|---|
| `HOST` / `PORT` | Bind del server (default `0.0.0.0:1337`) |
| `APP_KEYS` | Chiavi di sessione (lista separata da virgole) |
| `API_TOKEN_SALT`, `TRANSFER_TOKEN_SALT` | Salt per i token |
| `JWT_SECRET`, `ADMIN_JWT_SECRET` | Firma dei JWT (API e admin) |
| `ENCRYPTION_KEY` | Cifratura dei dati Strapi |
| `DATABASE_*` | Client, host, porta, nome, utente, password del DB |
| `OLLAMA_URL`, `OLLAMA_MODEL` | (Opzionale) endpoint e modello per l'analisi estratto conto |

> ⚠️ **Genera segreti nuovi e casuali** (es. `openssl rand -base64 16`). Non riusare mai
> valori d'esempio o presi da altri deploy.

---

## 🐳 Deploy con Docker

Il repo include `Dockerfile` e `docker-compose.yml`. **I segreti NON sono nell'immagine**:
vengono iniettati a runtime dal file `.env` (che resta fuori dal versionamento).

```bash
# Assicurati di aver compilato .env (vedi sopra)
docker compose up -d --build
```

- Il container legge tutte le variabili da `.env` (`env_file` nel compose).
- Gli upload vengono persistiti in `./data/uploads`.
- Per usare un registry tuo, modifica `image:` nel compose e lo script `pushDocker.sh`
  (l'host `registry.example.com` è un placeholder da sostituire).

---

## 🖥️ Frontend web — [budget-app](https://github.com/v3zz0/budget-app)

```bash
git clone https://github.com/v3zz0/budget-app.git
cd budget-app
npm install
cp .env.example .env   # imposta VITE_API_URL sull'URL del backend
npm run dev            # http://localhost:5173
```

Dettagli nel [README di budget-app](https://github.com/v3zz0/budget-app).

---

## 📱 App Android — [budget-flutter](https://github.com/v3zz0/budget-flutter)

```bash
git clone https://github.com/v3zz0/budget-flutter.git
cd budget-flutter
flutter pub get

# L'URL del backend si passa a build/run time:
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:1337        # emulatore Android
flutter build apk --release --dart-define=API_BASE_URL=https://tuo-backend
```

Guida build APK completa nel [README di budget-flutter](https://github.com/v3zz0/budget-flutter).

---

## 🔒 Sicurezza

- `.env`, `*.sql` e i dump dati **non vanno mai committati** (già in `.gitignore`).
- Se cloni per deploy, **genera segreti tuoi** e usa una password DB forte.
- CORS: per far dialogare web/mobile col backend, configura le origini consentite
  in `config/middlewares.js` (`strapi::cors` → `origin`).

## 📄 Licenza

Progetto personale. Usa/adatta liberamente.
