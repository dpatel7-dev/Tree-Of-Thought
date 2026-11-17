'use strict';
// The things that make Tree of Thought dependable for quick questions and
// comfortable for long projects:
//
//   makerOf      who made a model ("Anthropic", "Google"…), shown beside its plant
//   retryable    was that failure a busy/limited/unreachable service (worth trying another model)?
//   fallbacks    which models to try next when one can't answer right now
//   fitMessages  keep a long chat inside what the model can read
//   localPicks   free models to run on this computer, sized to its memory
//   attach       read a file to send along with a question
//   withFiles    a question plus its attached files, as the model sees it
//   usage        tokens (and cost) used per model, across every chat

const fs = require('fs');
const os = require('os');
const path = require('path');

const keyOf = (m) => `${m.provider}:${m.id}`;

// ── who made it ───────────────────────────────────────────────────────────────
const MAKERS = [
  [/claude|anthropic/i, 'Anthropic'],
  [/gpt-oss|gpt|openai|\bo[1-9]\b|o\d-|chatgpt/i, 'OpenAI'],
  [/gemini|gemma|google/i, 'Google'],
  [/deepseek/i, 'DeepSeek'],
  [/grok|x-ai|xai/i, 'xAI'],
  [/llama|meta/i, 'Meta'],
  [/mistral|mixtral|codestral|magistral|devstral|ministral/i, 'Mistral'],
  [/qwen|qwq|alibaba/i, 'Alibaba (Qwen)'],
  [/glm|z-ai|zhipu/i, 'Zhipu (GLM)'],
  [/kimi|moonshot/i, 'Moonshot (Kimi)'],
  [/nvidia|nemotron/i, 'NVIDIA'],
  [/cohere|command/i, 'Cohere'],
  [/phi-?\d|microsoft/i, 'Microsoft'],
  [/granite|ibm/i, 'IBM'],
  [/smollm|hugging/i, 'Hugging Face'],
];

function makerOf(m) {
  const text = `${m.id || ''} ${m.name || ''}`;
  for (const [re, name] of MAKERS) if (re.test(text)) return name;
  return '';
}

// ── when to try another model ─────────────────────────────────────────────────
/** A busy, rate-limited, down or unreachable service: another model may well answer. */
function retryable(e) {
  if (!e || e.name === 'AbortError') return false;
  const s = Number(e.status) || 0;
  if (s === 429 || s === 408 || s === 402 || s === 529 || s >= 500) return true;
  if (s) return false; // 401 (key), 404 (model) and friends: another try won't fix it
  return /couldn't reach|cut off|timed out|ECONNRESET|ETIMEDOUT|socket|network|overloaded|capacity|rate.?limit/i.test(String(e.message || ''));
}

// models that recently said "busy" rest for a while before being tried again
const resting = new Map(); // key -> until
const restFile = () => path.join(process.env.TOT_HOME || path.join(os.homedir(), '.tot'), 'resting.json');
function loadResting() {
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(restFile(), 'utf8')))) if (v > Date.now()) resting.set(k, v); } catch { /* none */ }
}
function rest(m, ms = 10 * 60 * 1000) {
  resting.set(keyOf(m), Date.now() + ms);
  try { fs.mkdirSync(path.dirname(restFile()), { recursive: true }); fs.writeFileSync(restFile(), JSON.stringify(Object.fromEntries([...resting].filter(([, v]) => v > Date.now())))); } catch { /* fine */ }
}
const isResting = (m) => (resting.get(keyOf(m)) || 0) > Date.now();

/**
 * Who to ask instead of `failed`: the rest of the garden, starting after it,
 * models that are resting last, models on this computer first among equals
 * (they have no limits). Never the same model twice.
 */
function fallbacks(garden, failed, tried = []) {
  loadResting();
  const seen = new Set([keyOf(failed), ...tried.map(keyOf)]);
  const i = garden.findIndex((m) => keyOf(m) === keyOf(failed));
  const order = [...garden.slice(i + 1), ...garden.slice(0, Math.max(0, i))].filter((m) => !seen.has(keyOf(m)));
  const score = (m) => (isResting(m) ? 2 : 0) + (m.provider === 'ollama' ? 0 : 1);
  return order.map((m, n) => ({ m, n })).sort((a, b) => score(a.m) - score(b.m) || a.n - b.n).map((x) => x.m);
}

/** Why a model didn't answer, in a few words. */
function whyShort(e) {
  const s = Number(e && e.status) || 0;
  if (s === 429) return 'hit its limit';
  if (s === 402) return 'is out of credit';
  if (s >= 500) return 'was having trouble';
  if (/couldn't reach/i.test(String(e && e.message))) return "couldn't be reached";
  return 'was busy';
}

// ── long chats ───────────────────────────────────────────────────────────────
/** About how many characters a model can read (a token is ~4 characters; keep room for the answer). */
function budgetFor(m) {
  if (m.context) return Math.max(6000, Math.floor(m.context * 4 * 0.6));
  if (m.provider === 'ollama') return 14000; // Ollama's default memory is small
  return 200000;
}

/**
 * Keep the start of the chat (what it's about) and as much of the end as fits.
 * Returns { messages, trimmed } - trimmed is how many messages were left out.
 */
function fitMessages(messages, budget) {
  const size = (m) => String(m.content || '').length + 20;
  let total = messages.reduce((a, m) => a + size(m), 0);
  if (total <= budget || messages.length <= 2) return { messages, trimmed: 0 };
  const first = messages[0];
  const rest = messages.slice(1);
  total = size(first);
  const keep = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    if (total + size(rest[i]) > budget && keep.length) break;
    keep.unshift(rest[i]);
    total += size(rest[i]);
  }
  // after the "left out" note (the model speaking), the next turn must be the person's
  while (keep.length > 1 && keep[0].role !== 'user') keep.shift();
  const trimmed = messages.length - 1 - keep.length;
  const note = { role: 'assistant', content: `(${trimmed} earlier message${trimmed === 1 ? ' was' : 's were'} left out here to fit what I can read at once.)` };
  return { messages: trimmed ? [first, note, ...keep] : [first, ...keep], trimmed };
}

// ── free models on this computer ───────────────────────────────────────────────
// Sizes are roughly what Ollama downloads. If a name stops existing, the next one is tried.
const LOCAL = {
  'llama3.2:3b': { gb: 2.0, about: 'Meta · quick everyday answers' },
  'qwen3:4b': { gb: 2.5, about: 'Alibaba · small, thinks before answering' },
  'gemma3:4b': { gb: 3.3, about: 'Google · small and well-rounded, reads images' },
  'qwen3:8b': { gb: 5.2, about: 'Alibaba · strong all-rounder' },
  'llama3.1:8b': { gb: 4.9, about: 'Meta · solid all-rounder' },
  'gemma3:12b': { gb: 8.1, about: 'Google · noticeably smarter, needs 16 GB' },
  'qwen3:14b': { gb: 9.3, about: 'Alibaba · strong at code and maths' },
  'gpt-oss:20b': { gb: 14, about: 'OpenAI · open model, good reasoning, needs 24 GB+' },
  'gemma3:27b': { gb: 17, about: 'Google · large, needs 32 GB' },
  'qwen3:30b': { gb: 19, about: 'Alibaba · large and fast for its size, needs 32 GB' },
};

/** The best fits for this computer's memory, best first. */
function localPicks(mem = os.totalmem()) {
  const gb = mem / 1024 ** 3;
  const names = gb < 12 ? ['gemma3:4b', 'qwen3:4b', 'llama3.2:3b']
    : gb < 24 ? ['qwen3:8b', 'gemma3:12b', 'llama3.1:8b', 'gemma3:4b']
      : gb < 48 ? ['gpt-oss:20b', 'qwen3:14b', 'gemma3:27b', 'qwen3:8b']
        : ['qwen3:30b', 'gemma3:27b', 'gpt-oss:20b', 'qwen3:14b'];
  return { memoryGB: Math.round(gb), picks: names.map((name) => ({ name, ...LOCAL[name] })) };
}

// ── files ───────────────────────────────────────────────────────────────────
const MAX_FILE = 200 * 1024;

/** Read a file to send with a question: { name, path, text, bytes }. Throws a friendly error. */
function attach(p, cwd = process.cwd()) {
  const full = path.resolve(cwd, String(p || '').replace(/^~(?=$|\/|\\)/, os.homedir()).replace(/^["']|["']$/g, ''));
  let st;
  try { st = fs.statSync(full); } catch { throw new Error(`There's no file at ${full}`); }
  if (st.isDirectory()) throw new Error(`${path.basename(full)} is a folder. Attach the files inside it one at a time.`);
  if (st.size > MAX_FILE) throw new Error(`${path.basename(full)} is ${Math.round(st.size / 1024)} KB: too big to send (the limit is ${MAX_FILE / 1024} KB).`);
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) throw new Error(`${path.basename(full)} isn't a text file, so it can't be sent as text.`);
  return { name: path.basename(full), path: full, text: buf.toString('utf8'), bytes: st.size };
}

/** A question as the model sees it: the words, then each attached file in a fenced block. */
function withFiles(text, files) {
  if (!files || !files.length) return text;
  const blocks = files.map((f) => `File: ${f.name}\n\`\`\`${path.extname(f.name).slice(1)}\n${f.text}\n\`\`\``);
  return `${text}\n\n${blocks.join('\n\n')}`;
}

// ── usage ───────────────────────────────────────────────────────────────────
/** Tokens and cost per model across chats: [{ model, name, answers, in, out, cost }], biggest first. */
function usage(chats) {
  const by = new Map();
  for (const c of chats) {
    for (const n of Object.values(c.nodes || {})) {
      if (n.role !== 'assistant' || !n.model) continue;
      const u = n.usage || {};
      const row = by.get(n.model) || { model: n.model, name: n.name || n.model, answers: 0, in: 0, out: 0, cost: 0 };
      row.answers++;
      row.in += Number(u.in) || 0;
      row.out += Number(u.out) || 0;
      row.cost += Number(u.cost) || 0;
      by.set(n.model, row);
    }
  }
  return [...by.values()].sort((a, b) => b.in + b.out - (a.in + a.out) || b.answers - a.answers);
}

module.exports = { makerOf, retryable, fallbacks, rest, isResting, whyShort, budgetFor, fitMessages, localPicks, LOCAL, attach, withFiles, usage, keyOf };
