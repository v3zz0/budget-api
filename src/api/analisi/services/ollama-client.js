'use strict';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// Quanto testo passare al modello in una volta sola.
const MAX_BLOCCO = 10000;

// Spezza il testo in blocchi, tagliando SOLO a fine riga: un movimento non
// deve mai finire a cavallo di due blocchi.
// Prima qui c'era un slice(0, 12000): tutto il resto dell'estratto conto
// spariva senza dire niente, e i movimenti tagliati fuori non comparivano tra
// i mancanti. Un "tutto ok" che significava "ho guardato solo mezzo mese".
function spezza(testo, max = MAX_BLOCCO) {
  const blocchi = [];
  let corrente = '';
  for (const riga of String(testo).split('\n')) {
    if (corrente && corrente.length + riga.length > max) {
      blocchi.push(corrente);
      corrente = '';
    }
    corrente += riga + '\n';
  }
  if (corrente.trim()) blocchi.push(corrente);
  return blocchi;
}

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

async function estraiDaBlocco(testoEstratto, nomiCategorie) {
  const prompt = `Sei un assistente che estrae transazioni da un estratto conto bancario italiano.

Testo dell'estratto conto:
"""
${testoEstratto}
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
}

module.exports = () => ({
  // Estrae transazioni strutturate dal testo grezzo dell'estratto conto.
  // Fallback per le banche di cui non abbiamo un parser: se il formato è noto
  // (vedi sella-parser.js) questo non viene nemmeno chiamato.
  async estraiTransazioni(testoEstratto, categorieDisponibili) {
    const nomiCategorie = categorieDisponibili.map((c) => c.Nome).join(', ');
    const blocchi = spezza(testoEstratto);
    const tutte = [];

    for (let i = 0; i < blocchi.length; i++) {
      if (blocchi.length > 1) {
        strapi.log.info(`Analisi estratto conto: blocco ${i + 1}/${blocchi.length}`);
      }
      tutte.push(...(await estraiDaBlocco(blocchi[i], nomiCategorie)));
    }
    return tutte;
  },

  // Assegna una categoria ai movimenti già estratti (dal parser o dall'LLM).
  // Riceve solo le descrizioni, non l'estratto conto intero.
  async suggerisciCategorie(movimenti, categorieDisponibili) {
    if (!movimenti.length) return movimenti;
    const nomiCategorie = categorieDisponibili.map((c) => c.Nome).join(', ');
    const elenco = movimenti.map((m, i) => `${i}: ${m.descrizione}`).join('\n');

    const prompt = `Associa ogni movimento bancario alla categoria di spesa piu' probabile.

Categorie disponibili: ${nomiCategorie}

Movimenti:
${elenco}

Rispondi SOLO con JSON: { "categorie": [ { "i": 0, "categoria": "Spesa" } ] }
Usa il nome ESATTO di una categoria tra {${nomiCategorie}}, oppure "Altro".`;

    const raw = await chiamaOllama(prompt, { json: true });
    try {
      const parsed = JSON.parse(raw);
      const perIndice = new Map(
        (parsed.categorie || []).map((c) => [Number(c.i), c.categoria])
      );
      return movimenti.map((m, i) => ({
        ...m,
        // Non sovrascrive un suggerimento già arrivato dall'estrazione.
        categoriaSuggerita: perIndice.get(i) || m.categoriaSuggerita || 'Altro',
      }));
    } catch (e) {
      // Categoria mancante: la UI semplicemente non mostra il suggerimento.
      strapi.log.error('Ollama: categorie non parsabili', raw);
      return movimenti;
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

// Esposta solo per il check in tests/spezza.test.js
module.exports.spezza = spezza;
