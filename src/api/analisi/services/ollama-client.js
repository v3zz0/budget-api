'use strict';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

async function chiamaOllama(prompt, { json = true } = {}) {
  const body = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: { temperature: 0.1 },
  };
  if (json) body.format = 'json';

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.response;
}

module.exports = () => ({
  // Estrae transazioni strutturate dal testo grezzo dell'estratto conto
  async estraiTransazioni(testoEstratto, categorieDisponibili) {
    const nomiCategorie = categorieDisponibili.map((c) => c.Nome).join(', ');

    const prompt = `Sei un assistente che estrae transazioni da un estratto conto bancario italiano.

Testo dell'estratto conto:
"""
${testoEstratto.slice(0, 12000)}
"""

Categorie disponibili nell'app: ${nomiCategorie}

Estrai TUTTE le transazioni di addebito (uscite/spese) dal testo. Ignora gli accrediti/entrate.
Per ogni transazione suggerisci la categoria piu' probabile tra quelle disponibili (o "Altro" se nessuna calza).

Rispondi SOLO con JSON valido in questo formato esatto:
{
  "transazioni": [
    {
      "data": "YYYY-MM-DD",
      "importo": 12.50,
      "descrizione": "ESSELUNGA MILANO",
      "categoriaSuggerita": "Spesa"
    }
  ]
}

Regole:
- importo sempre positivo (rappresenta una spesa)
- data in formato ISO YYYY-MM-DD
- descrizione: copia il testo del movimento, pulito
- categoriaSuggerita: nome ESATTO da {${nomiCategorie}} oppure "Altro"`;

    const raw = await chiamaOllama(prompt, { json: true });
    try {
      const parsed = JSON.parse(raw);
      return parsed.transazioni || [];
    } catch (e) {
      strapi.log.error('Ollama: JSON non parsabile', raw);
      return [];
    }
  },

  // Genera un giudizio sintetico sul mese
  async giudizioMese({ mese, sforamenti, totaleSpeso, totaleBudget, mancanti }) {
    const prompt = `Sei un assistente finanziario personale. Analizza i dati del mese ${mese} e genera un giudizio SINTETICO (max 3 frasi) in italiano.

Dati:
- Budget totale del mese: ${totaleBudget}€
- Speso totale: ${totaleSpeso}€
- Categorie sforate: ${JSON.stringify(sforamenti.filter((s) => s.sforato))}
- Transazioni trovate in banca ma non registrate nell'app: ${mancanti.length}

Tono: diretto, amichevole, italiano colloquiale. Se tutto ok complimenti. Se sforato segnala dove. Niente preamboli.

Rispondi con JSON: { "giudizio": "testo qui" }`;

    const raw = await chiamaOllama(prompt, { json: true });
    try {
      const parsed = JSON.parse(raw);
      return parsed.giudizio || '';
    } catch (e) {
      return raw;
    }
  },
});
