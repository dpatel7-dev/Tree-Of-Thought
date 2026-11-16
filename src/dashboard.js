'use strict';
// `tot dashboard`: your garden in the browser. Look through your chats as
// trees, plant and uproot models, manage keys, download models to run on this
// computer, and check which AI services this network lets through.
//
// It runs on this computer only (127.0.0.1, behind a secret address), reads
// and writes the same files as the terminal app (~/.tot), and never shows your
// keys back: only whether each one is set.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const P = require('./providers');
const St = require('./store');
const Pl = require('./plants');
const R = require('./rowan');
const Th = require('./theme');
const { open: openThing } = require('./tui');
const pkg = require('../package.json');

const keyOf = (m) => `${m.provider}:${m.id}`;
let modelCache = { at: 0, list: [], errors: [] };

function state() {
  const cfg = St.config.load();
  const keys = St.keys.load();
  P.setCustomBase(cfg.customBase);
  return {
    version: pkg.version,
    settings: { theme: cfg.theme, system: cfg.system || '', thoughts: !!cfg.thoughts, customBase: cfg.customBase || '' },
    garden: (cfg.garden || []).map((m, i) => ({ ...m, plant: Pl.plantFor(m), current: i === (cfg.current || 0) })),
    providers: P.IDS.map((id) => ({ id, ...P.PROVIDERS[id], hasKey: !!keys[id] })),
    plants: Pl.PLANTS,
    themes: Object.fromEntries(Object.entries(Th.THEMES).map(([k, v]) => [k, { ...v, rowan: (Th.use(k), R.ink()) }])),
    rowan: R.BASE,
  };
}

async function allModels(force) {
  if (!force && Date.now() - modelCache.at < 5 * 60000 && modelCache.list.length) return modelCache;
  const keys = St.keys.load();
  const cfg = St.config.load();
  P.setCustomBase(cfg.customBase);
  const ids = P.IDS.filter((id) => keys[id] || id === 'ollama');
  const list = [];
  const errors = [];
  await Promise.all(ids.map(async (id) => {
    try {
      const got = await P.listModels(id, keys[id]);
      for (const m of got) if (m.text) list.push({ ...m, plant: Pl.plantFor(m) });
    } catch (e) { if (id !== 'ollama') errors.push(`${P.PROVIDERS[id].name}: ${e.message}`); }
  }));
  list.sort((a, b) => (b.created || 0) - (a.created || 0));
  modelCache = { at: Date.now(), list, errors };
  return modelCache;
}

function body(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new Error('not JSON')); } });
    req.on('error', reject);
  });
}

async function route(req, res, rest) {
  const send = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const m = req.method;
  if (rest === '/api/state') return send(state());
  if (rest === '/api/chats') return send(St.chats.list());
  let x = /^\/api\/chats\/([a-f0-9]{6,32})(\/rename|\/export)?$/.exec(rest);
  if (x) {
    const chat = St.chats.load(x[1]);
    if (!chat) return send({ error: 'That chat is gone.' }, 404);
    if (m === 'DELETE') { St.chats.remove(chat.id); return send({ ok: true }); }
    if (x[2] === '/rename' && m === 'POST') { const b = await body(req); chat.title = String(b.title || '').slice(0, 80) || chat.title; St.chats.save(chat); return send({ ok: true }); }
    if (x[2] === '/export') { res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${(chat.title || 'chat').replace(/[^\w .-]+/g, '').slice(0, 40) || 'chat'}.md"` }); return res.end(St.toMarkdown(chat)); }
    const nodes = {};
    for (const [id, n] of Object.entries(chat.nodes)) nodes[id] = { ...n, plant: n.role === 'assistant' && n.model ? Pl.plantFor({ id: n.model, provider: n.provider }) : null };
    return send({ id: chat.id, title: chat.title, created: chat.created, updated: chat.updated, leaf: chat.leaf, nodes });
  }
  if (rest === '/api/models') return send(await allModels(/[?&]fresh/.test(req.url)));
  if (rest === '/api/garden' && m === 'POST') {
    const b = await body(req);
    const cfg = St.config.load();
    const garden = cfg.garden || [];
    const i = garden.findIndex((g) => keyOf(g) === `${b.provider}:${b.id}`);
    if (b.action === 'add' && i < 0 && P.PROVIDERS[b.provider] && b.id) garden.push({ provider: b.provider, id: String(b.id), name: String(b.name || b.id).slice(0, 60), price: b.price || null, free: !!b.free });
    if (b.action === 'remove' && i >= 0) garden.splice(i, 1);
    if ((b.action === 'up' || b.action === 'down') && i >= 0) { const j = i + (b.action === 'up' ? -1 : 1); if (j >= 0 && j < garden.length) [garden[i], garden[j]] = [garden[j], garden[i]]; }
    if (b.action === 'use' && i >= 0) cfg.current = i;
    cfg.garden = garden;
    cfg.current = Math.max(0, Math.min(cfg.current || 0, garden.length - 1));
    St.config.save(cfg);
    return send(state());
  }
  if (rest === '/api/keys' && m === 'POST') {
    const b = await body(req);
    if (!P.PROVIDERS[b.provider] || P.PROVIDERS[b.provider].noKey) return send({ error: 'Unknown service.' }, 400);
    const key = String(b.key || '').trim();
    if (key) {
      try { await P.listModels(b.provider, key); } catch (e) { if (e.status === 401 || e.status === 403) return send({ error: e.message }, 400); }
    }
    St.keys.set(b.provider, key || null);
    modelCache.at = 0;
    return send(state());
  }
  if (rest === '/api/settings' && m === 'POST') {
    const b = await body(req);
    const cfg = St.config.load();
    if (['grove', 'meadow', 'autumn'].includes(b.theme)) cfg.theme = b.theme;
    if (typeof b.system === 'string') cfg.system = b.system.slice(0, 4000);
    if (typeof b.thoughts === 'boolean') cfg.thoughts = b.thoughts;
    if (typeof b.customBase === 'string') { if (b.customBase && !/^https?:\/\/\S+$/.test(b.customBase)) return send({ error: 'The address should start with https://' }, 400); cfg.customBase = b.customBase.replace(/\/+$/, ''); }
    St.config.save(cfg);
    return send(state());
  }
  if (rest === '/api/network') { const cfg = St.config.load(); P.setCustomBase(cfg.customBase); return send(await P.checkNetwork()); }
  if (rest === '/api/ollama') return send({ models: await P.ollamaModels() });
  if (rest === '/api/ollama/pull' && m === 'POST') {
    const b = await body(req);
    const name = String(b.model || '').trim();
    if (!/^[\w.:/-]{1,80}$/.test(name)) return send({ error: 'That doesn\'t look like a model name (like llama3.2 or qwen3:8b).' }, 400);
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    try {
      await P.ollamaPull(name, { onProgress: (p) => res.write(JSON.stringify(p) + '\n') });
      res.end(JSON.stringify({ status: 'success' }) + '\n');
    } catch (e) { res.end(JSON.stringify({ error: e.message }) + '\n'); }
    return;
  }
  if (rest === '/api/ollama/delete' && m === 'POST') { const b = await body(req); await P.ollamaDelete(String(b.model || '')); return send({ ok: true }); }
  return send({ error: 'not here' }, 404);
}

/** Start it. Resolves with { url, close }. */
function serve({ port = 0, openBrowser = true } = {}) {
  const secret = crypto.randomBytes(12).toString('hex');
  const base = `/${secret}`;
  const server = http.createServer(async (req, res) => {
    const addr = server.address();
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${addr.port}` && host !== `localhost:${addr.port}`) { res.writeHead(403); return res.end(); }
    const url = new URL(req.url, `http://${host}`);
    if (!url.pathname.startsWith(base)) { res.writeHead(404); return res.end('not here'); }
    const rest = url.pathname.slice(base.length) || '/';
    try {
      if (rest === '/') {
        const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'dashboard.html'), 'utf8').replace('/*TOT_CONFIG*/{}', JSON.stringify({ base }));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end(html);
      }
      await route(req, res, rest);
    } catch (e) {
      if (res.headersSent) return res.end();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}${base}/`;
      if (openBrowser) openThing(url);
      resolve({ url, close: () => server.close() });
    });
  });
}

module.exports = { serve, state };
