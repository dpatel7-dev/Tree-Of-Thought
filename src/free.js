'use strict';
// Free AI in the cloud, set up in a minute.
//
// Every service here gives you its own free allowance once you make a free
// account and a key (no card). On its own each one has limits; together they
// add up to a lot, and "Auto (free)" spreads your questions across them. The
// models run on the services' computers, not yours.
//
// Setting one up: tot opens the page where you make a key, and watches the
// clipboard while you're on that step. Copy the key and it's added: checked,
// saved, and its best free models planted. (Or paste it.)
//
// The list is curated from official free tiers (see the awesome-freellm-apis
// list for many more). Use one account per service: making extra accounts to
// get more free use breaks their rules, and Groq, for one, counts limits per
// organisation anyway.

const { spawnSync } = require('child_process');
const P = require('./providers');
const St = require('./store');

// pick: [pattern, nice name, power 1-10, extra tags]. Matched against the
// service's own model list, so new versions are found as they appear.
const SERVICES = [
  {
    id: 'groq', name: 'Groq', good: 'the fastest: great for quick questions',
    needs: 'an email or Google account', allowance: 'about 1,000 questions a day per model',
    steps: ['Sign in (Google works)', 'Click "Create API Key" and give it any name', 'Click Copy'],
    key: /^gsk_[A-Za-z0-9]{20,}$/,
    daily: { requests: 1000, perModel: true },
    pick: [[/^openai\/gpt-oss-120b$/, 'GPT-OSS 120B', 8, ['fast']], [/kimi-k2/i, 'Kimi K2', 8, ['fast', 'code']], [/^qwen\/qwen3/i, 'Qwen3', 7, ['fast']], [/llama-3\.3-70b/i, 'Llama 3.3 70B', 6, ['fast']], [/llama-4/i, 'Llama 4', 6, ['fast']]],
  },
  {
    id: 'nvidia', name: 'NVIDIA', good: 'the biggest open models, with no daily limit',
    needs: 'an email, and a phone number to verify', allowance: '40 questions a minute, no daily limit',
    steps: ['Sign in or make an NVIDIA account (it texts your phone once)', 'Click "Generate API Key"', 'Click Copy'],
    key: /^nvapi-[A-Za-z0-9_-]{20,}$/,
    perMinute: 40,
    pick: [[/deepseek-ai\/deepseek-(v3|r1)/i, 'DeepSeek', 10, ['code']], [/moonshotai\/kimi-k2/i, 'Kimi K2', 9, ['code']], [/qwen3-coder-480b/i, 'Qwen3 Coder 480B', 9, ['code']], [/qwen\/qwen3-235b|qwen\/qwen3\.\d/i, 'Qwen3', 8, []], [/z-ai\/glm/i, 'GLM', 8, ['code']], [/openai\/gpt-oss-120b/i, 'GPT-OSS 120B', 8, []]],
  },
  {
    id: 'google', name: 'Google Gemini', good: 'reads very long things (whole books)',
    needs: 'a Google account', allowance: 'a free daily allowance on Gemini Flash',
    steps: ['Sign in with Google', 'Click "Create API key"', 'Click Copy'],
    key: /^AIza[0-9A-Za-z_-]{30,}$/,
    daily: { requests: 250, perModel: true, guess: true },
    pick: [[/^gemini-[\d.]+-flash(-preview[\w-]*)?$/i, 'Gemini Flash', 8, ['long']], [/^gemini-[\d.]+-pro(-preview[\w-]*)?$/i, 'Gemini Pro', 9, ['long']], [/^gemini-[\d.]+-flash-lite/i, 'Gemini Flash-Lite', 6, ['fast', 'long']]],
  },
  {
    id: 'mistral', name: 'Mistral', good: 'Mistral Large and Codestral, about a billion words a month',
    needs: 'an email, and a phone number to verify', allowance: 'about 1 question a second, ~1 billion words a month',
    steps: ['Sign in or make an account', 'Pick the free "Experiment" plan (it texts your phone once)', 'Click "Create new key", then Copy'],
    key: /^[A-Za-z0-9]{32}$/,
    perMinute: 60,
    pick: [[/^mistral-large-latest$/, 'Mistral Large', 8, []], [/^magistral-medium-latest$/, 'Magistral', 8, []], [/^codestral-latest$/, 'Codestral', 7, ['code']], [/^mistral-medium-latest$/, 'Mistral Medium', 7, []]],
  },
  {
    id: 'openrouter', name: 'OpenRouter', good: "lots of free models in one place",
    needs: 'an email or Google account', allowance: '50 free questions a day (1,000 if you ever add $10)',
    steps: ['Sign in (Google works)', 'Click "Create API Key"', 'Click Copy'],
    key: /^sk-or-[A-Za-z0-9-]{20,}$/,
    daily: { requests: 50 },
    freeOnly: true,
    pick: [[/deepseek.*:free$/i, 'DeepSeek (free)', 9, []], [/qwen3.*:free$/i, 'Qwen3 (free)', 8, ['code']], [/gpt-oss-120b:free$/i, 'GPT-OSS 120B (free)', 8, []], [/llama-(4|3\.3).*:free$/i, 'Llama (free)', 7, []], [/nemotron.*:free$/i, 'Nemotron (free)', 8, []]],
  },
  {
    id: 'ollamacloud', name: 'Ollama Cloud', good: 'big open models, kept private (no logging)',
    needs: 'an email', allowance: 'light use, refills every few hours',
    steps: ['Sign in or make an Ollama account', 'Click "Add API Key"', 'Click Copy'],
    key: /^[A-Za-z0-9._-]{24,}$/,
    pick: [[/^deepseek-v3/i, 'DeepSeek', 9, []], [/^kimi-k2/i, 'Kimi K2', 9, ['code']], [/^gpt-oss:120b/i, 'GPT-OSS 120B', 8, []], [/^qwen3-coder/i, 'Qwen3 Coder', 8, ['code']], [/^glm-/i, 'GLM', 8, []]],
  },
  {
    id: 'sambanova', name: 'SambaNova', extra: true, good: 'very fast big models, a few a day',
    needs: 'an email', allowance: 'about 20 questions a day per model',
    steps: ['Sign in or make an account', 'Click "Create API Key"', 'Click Copy'],
    key: /^[0-9a-f-]{32,40}$/i,
    daily: { requests: 20, perModel: true },
    pick: [[/deepseek/i, 'DeepSeek', 9, []], [/llama-4|llama-3\.3-70b/i, 'Llama', 6, []], [/qwen3/i, 'Qwen3', 7, []]],
  },
];

const byId = (id) => SERVICES.find((s) => s.id === id) || null;
const AUTO = { provider: 'auto', id: 'free', name: 'Auto (free)', free: true };
const isAuto = (m) => !!m && m.provider === 'auto';
const isCloudFree = (m) => !!m && m.free && !isAuto(m) && m.provider !== 'ollama' && m.provider !== 'custom';

/** Which service a key belongs to, by its shape (null if it isn't obvious). */
function guess(text) {
  const t = String(text || '').trim();
  for (const s of SERVICES) if (s.id !== 'mistral' && s.id !== 'ollamacloud' && s.id !== 'sambanova' && s.key.test(t)) return s.id;
  return null;
}

/** Could `text` be a key for this service? (Checked for real by asking the service.) */
function looksLike(id, text) {
  const s = byId(id);
  const t = String(text || '').trim();
  if (!s || !t || /\s/.test(t) || t.length > 300) return false;
  const other = guess(t);
  return s.key.test(t) && (!other || other === id);
}

/** The best free models a service offers right now, from its own list. */
function choose(id, list, max = 3) {
  const s = byId(id);
  if (!s) return [];
  const usable = list.filter((m) => m.text && !/embed|rerank|guard|safety|vision|-vl|image|audio|tts|whisper|speech|ocr|parse|reward|retriev/i.test(m.id) && (!s.freeOnly || /:free$/.test(m.id) || m.free));
  const out = [];
  for (const [re, nice, power, tags] of s.pick) {
    const hits = usable.filter((m) => re.test(m.id) && !out.some((o) => o.id === m.id));
    if (!hits.length) continue;
    // the newest version: biggest created date, else the "largest" id (version numbers sort that way)
    hits.sort((a, b) => (b.created || 0) - (a.created || 0) || b.id.localeCompare(a.id, undefined, { numeric: true }));
    const m = hits[0];
    out.push({ provider: id, id: m.id, name: shortName(m, nice), free: true, power, tags, context: m.context || null });
    if (out.length >= max) break;
  }
  return out;
}

/** A friendly name: "openai/gpt-oss-120b" → "GPT-OSS 120B", "kimi-k2-instruct-0905" → "Kimi K2". */
function shortName(m, nice) {
  const shown = String(m.name || '');
  if (shown && shown !== m.id && !/[/_]/.test(shown) && shown.length <= 28) return shown.replace(/\s*\(free\)$/i, '') + (/:free$/.test(m.id) ? ' (free)' : '');
  const SPECIAL = { gpt: 'GPT', oss: 'OSS', glm: 'GLM', deepseek: 'DeepSeek', qwen3: 'Qwen3', kimi: 'Kimi', ai: 'AI', vl: 'VL', r1: 'R1' };
  const words = String(m.id).replace(/^.*\//, '').replace(/:free$/, '').split(/[-_\s:]+/)
    .filter((w) => w && !/^(instruct|versatile|latest|preview|chat|it|\d{4}|\d{6,8})$/i.test(w))
    .map((w) => SPECIAL[w.toLowerCase()] || (/^\d+(\.\d+)?[bm]$/i.test(w) || /^[a-z]\d/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  let name = words.join(' ').replace(/^GPT OSS/, 'GPT-OSS');
  if (/:free$/.test(m.id)) name += ' (free)';
  return name && name.length <= 28 ? name : nice;
}

/** Check a key with the service, save it, plant its best free models, and make Auto the default. */
async function addKey(id, key, cfg = St.config.load()) {
  const s = byId(id);
  key = String(key || '').trim();
  let list;
  try { list = await P.listModels(id, key); } catch (e) {
    if (e.status === 401 || e.status === 403) throw new Error(`${s ? s.name : id} didn't accept that key. Copy it again (the whole thing), or make a new one.`);
    throw e;
  }
  St.keys.set(id, key);
  const picked = choose(id, list);
  if (!picked.length) throw new Error(`Saved your ${s ? s.name : id} key, but none of its free models are available right now.`);
  plant(cfg, picked);
  St.config.save(cfg);
  return { picked, cfg };
}

/** Put models in the garden (no doubles), with Auto (free) at the top and chosen. */
function plant(cfg, models) {
  cfg.garden = cfg.garden || [];
  const key = (m) => `${m.provider}:${m.id}`;
  for (const m of models) {
    const i = cfg.garden.findIndex((g) => key(g) === key(m));
    if (i >= 0) cfg.garden[i] = { ...cfg.garden[i], ...m };
    else cfg.garden.push(m);
  }
  if (!cfg.garden.some(isAuto)) cfg.garden.unshift({ ...AUTO });
  cfg.current = cfg.garden.findIndex(isAuto);
  return cfg;
}

/** Which services you've set up, and which are left. */
function status(keys = St.keys.load()) {
  return SERVICES.map((s) => ({ ...s, keyUrl: P.PROVIDERS[s.id].keyUrl, done: !!keys[s.id] }));
}

// ── the clipboard (only read while you're on a "make a key" step) ─────────────
function readClipboard() {
  const tries = process.platform === 'darwin' ? [['pbpaste', []]]
    : process.platform === 'win32' ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
      : [['wl-paste', ['-n']], ['xclip', ['-o', '-selection', 'clipboard']], ['xsel', ['-ob']]];
  for (const [cmd, args] of tries) {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1500, windowsHide: true });
      if (r.status === 0 && typeof r.stdout === 'string') return r.stdout.trim();
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * Watch the clipboard for a key for service `id`. Calls onKey(key) once when
 * one appears (something that wasn't already there when watching started).
 * Returns stop().
 */
function watchClipboard(id, onKey, { every = 700, read = readClipboard } = {}) {
  let first = read();
  let done = false;
  const t = setInterval(() => {
    if (done) return;
    const now = read();
    if (now === null || now === first) return;
    first = now;
    if (looksLike(id, now)) { done = true; clearInterval(t); onKey(now); }
  }, every);
  if (t.unref) t.unref();
  return () => { done = true; clearInterval(t); };
}

const canWatch = () => readClipboard() !== null;

module.exports = { shortName, SERVICES, byId, AUTO, isAuto, isCloudFree, guess, looksLike, choose, addKey, plant, status, readClipboard, watchClipboard, canWatch };
