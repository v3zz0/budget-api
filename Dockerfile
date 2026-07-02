FROM node:18-alpine

# Installa le dipendenze necessarie
RUN apk add --no-cache build-base gcc autoconf automake zlib-dev libpng-dev vips-dev > /dev/null 2>&1

# Imposta la directory di lavoro
WORKDIR /app

# Copia package.json e package-lock.json
COPY package*.json ./

# Installa le dipendenze
RUN npm install

# Copia i file del progetto
COPY . .

# Le variabili d'ambiente (segreti, DB, ecc.) NON vanno mai scritte qui dentro:
# vengono fornite a runtime dal container (docker-compose env_file / --env-file).
# Vedi .env.example per l'elenco completo delle variabili richieste.
ENV NODE_ENV=production

# Build del pannello di amministrazione
RUN npm run build

# Espone la porta 1337
EXPOSE 1337

# Comando per avviare l'applicazione
CMD ["npm", "run", "start"]