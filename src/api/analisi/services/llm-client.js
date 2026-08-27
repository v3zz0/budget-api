'use strict';

// Client LLM per l'analisi estratto conto.
// Il motore lo sceglie l'utente dalle impostazioni dell'app:
//   - "ollama"     -> il server Ollama di casa (default, come prima)
//   - "openrouter" -> API compatibile OpenAI, con chiave (OpenRouter o
//                     qualsiasi altro servizio con lo stesso formato).

const URL_DEFAULT = process.env.OLLAMA_URL || 'http://ollama:11434';
const MODELLO_DEFAULT = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// Quanto testo passare al modello in una volta sola.
const MAX_BLOCCO = 10000;

// Quanto aspettare una singola risposta del modello prima di mollare.
// Senza questo la fetch resta appesa all'infinito: il reverse proxy davanti a
// Strapi chiude con un 504, il browser vede l'errore, ma il server continua a
// macinare per conto suo una richiesta che nessuno leggerà più.
// I modelli "reasoning" (qwen3, o1, deepseek-r1...) sono i più lenti, perché
// prima di rispondere scrivono un ragionamento che noi buttiamo via.
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60000;

// Tetto all'ANALISI INTERA, non alla singola chiamata. Le chiamate sono in
// fila: con più blocchi da leggere più le due rifiniture, il solo limite per
// chiamata lascia comunque passare svariati minuti, e a quel punto l'app ha
// già chiuso la connessione. Scaduto il budget le chiamate rimaste falliscono
// subito e il controller consegna il report senza di loro — un report parziale
// in due minuti vale più di uno completo che non arriva.
const BUDGET_MS = Number(process.env.AI_BUDGET_MS) || 120000;

// Tetto ai blocchi da mandare al modello quando l'estratto non ha un parser
// dedicato. Ogni blocco è una chiamata sequenziale: senza un limite, un PDF
// lungo diventa dieci minuti di attesa e un timeout garantito.
// Quando scatta lo si dice nel report, non si taglia in silenzio.
const MAX_BLOCCHI = Number(process.env.AI_MAX_BLOCCHI) || 6;

class TimeoutLLM extends Error {
  constructor(secondi) {
    super(`Il modello non ha risposto entro ${secondi}s`);
    this.name = 'TimeoutLLM';
  }
}

class BudgetScaduto extends Error {
  constructor() {
    super('Tempo massimo dell\'analisi esaurito');
    this.name = 'BudgetScaduto';
  }
}

/**
 * fetch con scadenza che copre ANCHE la lettura del corpo.
 *
 * Qui c'era il bug che rendeva il timeout una decorazione: OpenRouter manda gli
 * header (200 OK) subito e poi genera il testo per minuti. Cancellando il timer
 * appena tornava la Response, la parte lenta — `await res.json()` — restava
 * senza limite. Il risultato misurato: 60s dichiarati, 432s reali su
 * un'analisi, con Strapi che continuava a lavorare dopo che l'app aveva già
 * mollato. Leggere il corpo dentro la scadenza è tutta la differenza.
 */
async function fetchConTimeout(url, opzioni, ms) {
  const controller = new AbortController();
  const scadenza = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opzioni, signal: controller.signal });
    return { ok: res.ok, status: res.status, corpo: await res.text() };
  } catch (e) {
    if (e.name === 'AbortError') throw new TimeoutLLM(Math.round(ms / 1000));
    throw e;
  } finally {
    clearTimeout(scadenza);
  }
}

/** Il corpo di una risposta ok deve essere JSON: se è la pagina di errore di
 *  un proxy, dirlo vale più di un "Unexpected token <" in mezzo al report. */
function jsonDelCorpo(res, motore) {
  try {
    return JSON.parse(res.corpo);
  } catch (_) {
    throw new Error(`${motore}: risposta non JSON (${res.corpo.slice(0, 120)})`);
  }
}

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

// Un estratto conto è per la maggior parte intestazioni, condizioni, note
// legali e piè di pagina: righe senza un solo movimento, che però finiscono lo
// stesso nel prompt e moltiplicano blocchi — cioè chiamate, cioè minuti.
// Teniamo solo le righe con una data o un importo in formato italiano.
// Se ne restano pochissime il formato non è quello che ci aspettiamo: meglio
// mandare tutto che mandare il vuoto.
// ponytail: una descrizione andata a capo su una riga senza data né importo si
// perde. Il movimento resta (data e importo stanno sulla riga principale), è la
// descrizione a risultare più corta. Se servisse intera, tenere anche la riga
// successiva a ogni riga utile.
const RIGA_UTILE = /\d{2}\/\d{2}\/\d{4}|\d,\d{2}(\D|$)/;

function soloMovimenti(testo) {
  const utili = String(testo).split('\n').filter((r) => RIGA_UTILE.test(r));
  return utili.length >= 3 ? utili.join('\n') : String(testo);
}

module.exports = (config = {}) => {
  const raw = config.motore === 'openrouter' ? 'openrouter' : config.motore === 'llamacpp' ? 'llamacpp' : 'ollama';
  const motore = raw;
  const url = (config.url || URL_DEFAULT).replace(/\/+$/, '');
  const modello = config.modello || MODELLO_DEFAULT;
  const chiave = config.chiave || '';

  // Cose che l'utente deve sapere sul risultato (troncamenti, passi saltati).
  // Le raccoglie il client e le legge il controller: un limite che scatta senza
  // dirlo si legge come "ho guardato tutto", ed è la bugia peggiore che un
  // report possa raccontare.
  const avvisi = [];

  // Il budget parte alla PRIMA chiamata, non alla creazione del client: il
  // controller istanzia l'LLM in cima e poi legge PDF e database, e quel tempo
  // non va addebitato al modello.
  const budgetMs = Number(config.budgetMs) || BUDGET_MS;
  let fine = null;
  function msDisponibili() {
    if (fine === null) fine = Date.now() + budgetMs;
    return Math.min(TIMEOUT_MS, fine - Date.now());
  }

  // Un modello che ha già sforato una volta non torna vivo dopo mezzo minuto:
  // le chiamate successive falliscono subito invece di regalargli un altro
  // timeout intero a testa. Misurato: 10 secondi di analisi vera e 110 di
  // attesa di un modello che non rispondeva né alla prima né alla seconda.
  let modelloGiu = false;

  // Entrambi i motori rispondono in JSON; cambia solo come glielo si chiede.
  async function chiamaLLM(prompt) {
    // Prima il tempo, poi lo stato del modello: se sono vere entrambe,
    // "il tempo è finito" dice all'utente più di "il modello non risponde".
    const ms = msDisponibili();
    if (ms <= 0) throw new BudgetScaduto();
    if (modelloGiu) throw new TimeoutLLM(Math.round(TIMEOUT_MS / 1000));
    try {
      return await (motore === 'openrouter'
        ? chiamaOpenRouter(prompt, ms)
        : motore === 'llamacpp'
          ? chiamaLlamaCpp(prompt, ms)
          : chiamaOllama(prompt, ms));
    } catch (e) {
      if (e instanceof TimeoutLLM) modelloGiu = true;
      throw e;
    }
  }

  async function chiamaOllama(prompt, ms) {
    const res = await fetchConTimeout(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modello,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.1 },
      }),
    }, ms);
    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${res.corpo}`);
    }
    return jsonDelCorpo(res, 'Ollama').response;
  }

  async function chiamaLlamaCpp(prompt, ms) {
    // llama.cpp server espone un'API OpenAI-compatibile su /v1/chat/completions.
    // Di default non serve chiave API: il server gira in locale.
    const headers = { 'Content-Type': 'application/json' };
    if (chiave) headers.Authorization = `Bearer ${chiave}`;
    const res = await fetchConTimeout(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modello,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    }, ms);
    if (!res.ok) {
      throw new Error(`llama.cpp error ${res.status}: ${res.corpo}`);
    }
    return jsonDelCorpo(res, 'llama.cpp').choices?.[0]?.message?.content || '';
  }

  async function chiamaOpenRouter(prompt, ms) {
    if (!chiave) throw new Error('OpenRouter: chiave API non configurata');
    const res = await fetchConTimeout(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${chiave}`,
      },
      body: JSON.stringify({
        model: modello,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    }, ms);
    if (!res.ok) {
      throw new Error(`OpenRouter error ${res.status}: ${res.corpo}`);
    }
    return jsonDelCorpo(res, 'OpenRouter').choices?.[0]?.message?.content || '';
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

    const raw = await chiamaLLM(prompt);
    try {
      return JSON.parse(raw).transazioni || [];
    } catch (e) {
      strapi.log.error('LLM: JSON non parsabile', raw);
      return [];
    }
  }

  return {
    motore,
    modello,

    /** Avvisi accumulati durante l'analisi, da mostrare nel report. */
    avvisi: () => [...avvisi],

    // Estrae transazioni strutturate dal testo grezzo dell'estratto conto.
    // Fallback per le banche di cui non abbiamo un parser: se il formato è noto
    // (vedi sella-parser.js) questo non viene nemmeno chiamato.
    async estraiTransazioni(testoEstratto, categorieDisponibili) {
      const nomiCategorie = categorieDisponibili.map((c) => c.Nome).join(', ');
      const utile = soloMovimenti(testoEstratto);
      strapi.log.info(
        `Analisi: testo da leggere ${testoEstratto.length} → ${utile.length} caratteri`
      );
      const blocchi = spezza(utile);
      const tutte = [];

      const daLeggere = Math.min(blocchi.length, MAX_BLOCCHI);
      if (blocchi.length > MAX_BLOCCHI) {
        strapi.log.warn(
          `Analisi: documento troppo lungo, letti ${MAX_BLOCCHI} blocchi su ${blocchi.length}. ` +
            `Alza AI_MAX_BLOCCHI o scrivi un parser per questa banca.`
        );
        avvisi.push(
          `Documento troppo lungo: letta solo la prima parte (${MAX_BLOCCHI} blocchi su ${blocchi.length}). ` +
            `Potrebbero mancare dei movimenti.`
        );
      }

      for (let i = 0; i < daLeggere; i++) {
        if (blocchi.length > 1) {
          strapi.log.info(`Analisi estratto conto: blocco ${i + 1}/${daLeggere}`);
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

      const raw = await chiamaLLM(prompt);
      try {
        const perIndice = new Map(
          (JSON.parse(raw).categorie || []).map((c) => [Number(c.i), c.categoria])
        );
        return movimenti.map((m, i) => ({
          ...m,
          // Non sovrascrive un suggerimento già arrivato dall'estrazione.
          categoriaSuggerita: perIndice.get(i) || m.categoriaSuggerita || 'Altro',
        }));
      } catch (e) {
        // Categoria mancante: la UI semplicemente non mostra il suggerimento.
        strapi.log.error('LLM: categorie non parsabili', raw);
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

      const raw = await chiamaLLM(prompt);
      try {
        return JSON.parse(raw).giudizio || '';
      } catch (e) {
        return raw;
      }
    },

    // Una domanda secca che torna { "testo": "..." }. I numeri stanno nel
    // prompt già calcolati: il modello mette solo le parole.
    async giudizioLibero(prompt) {
      const raw = await chiamaLLM(prompt);
      try {
        return JSON.parse(raw).testo || '';
      } catch (e) {
        return '';
      }
    },

    // Usata dal bottone "Prova connessione" delle impostazioni.
    async ping() {
      const raw = await chiamaLLM('Rispondi con JSON: { "ok": true }');
      return String(raw).includes('ok');
    },
  };
};

// La chiave la differenzia il motore: openrouter e llama.cpp sono servizi
// diversi (locale l'uno, cloud l'altro), condividere il campo significherebbe
// perdere una chiave ogni volta che si cambia motore.
function chiaveDiUtente(user, motore) {
  return motore === 'llamacpp' ? user?.aiChiaveLlamacpp : user?.aiChiave;
}

// Esposte solo per i check in tests/spezza.test.js e tests/llm-timeout.test.js
module.exports.spezza = spezza;
module.exports.soloMovimenti = soloMovimenti;
module.exports.chiaveDiUtente = chiaveDiUtente;
