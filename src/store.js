'use strict';
// What Tree of Thought keeps on your computer, in ~/.tot:
//   config.json   your garden (the models you picked), colours, system prompt
//   keys.json     your API keys (readable by you only)
//   chats/        one file per conversation
//
// A conversation is a tree, not a list: every message knows the message it
// answers. Asking again, asking another model, or editing a question adds a
// new branch next to the old one instead of throwing anything away.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const home = () => process.env.TOT_HOME || path.join(os.homedir(), '.tot');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode) try { fs.chmodSync(file, mode); } catch { /* windows */ }
}

const DEFAULTS = { garden: [], current: 0, theme: 'grove', system: '', thoughts: false, last: null };

const config = {
  load() { return { ...DEFAULTS, ...readJson(path.join(home(), 'config.json'), {}) }; },
  save(c) { writeJson(path.join(home(), 'config.json'), c); },
};

const keys = {
  load() { return readJson(path.join(home(), 'keys.json'), {}); },
  set(provider, key) {
    const all = keys.load();
    if (key) all[provider] = key; else delete all[provider];
    writeJson(path.join(home(), 'keys.json'), all, 0o600);
    return all;
  },
};

const newId = () => crypto.randomBytes(6).toString('hex');

class Chat {
  constructor(data = {}) {
    this.id = data.id || newId();
    this.title = data.title || '';
    this.created = data.created || Date.now();
    this.updated = data.updated || this.created;
    this.nodes = data.nodes || {}; // id -> { id, parent, role, text, model?, ts, err?, thought? }
    this.leaf = data.leaf || null; // the message at the end of the branch you're looking at
  }

  get empty() { return !Object.keys(this.nodes).length; }

  /** Add a message under `parent` (null for the first). */
  add(parent, role, fields = {}) {
    const node = { id: newId(), parent: parent || null, role, text: '', ts: Date.now(), ...fields };
    this.nodes[node.id] = node;
    this.updated = node.ts;
    if (!this.title && role === 'user' && node.text) this.title = node.text.replace(/\s+/g, ' ').trim().slice(0, 48);
    return node;
  }

  /** The messages from the start down to `leaf` (the branch on screen). */
  path(leaf = this.leaf) {
    const out = [];
    const seen = new Set();
    for (let n = this.nodes[leaf]; n && !seen.has(n.id); n = this.nodes[n.parent]) { out.push(n); seen.add(n.id); }
    return out.reverse();
  }

  children(id) {
    return Object.values(this.nodes).filter((n) => n.parent === (id || null)).sort((a, b) => a.ts - b.ts);
  }

  /** The other answers (or questions) that share this one's parent, in order. */
  siblings(id) {
    const n = this.nodes[id];
    return n ? this.children(n.parent).filter((x) => x.role === n.role) : [];
  }

  /** Follow a branch down to its newest end. */
  tip(id) {
    let n = this.nodes[id];
    for (;;) {
      const kids = this.children(n.id);
      if (!kids.length) return n.id;
      n = kids.reduce((a, b) => (latest(this, b) > latest(this, a) ? b : a));
    }
  }

  /** Show a different branch: the sibling `step` places along from `id`. */
  turn(id, step) {
    const sib = this.siblings(id);
    const i = sib.findIndex((x) => x.id === id);
    if (sib.length < 2 || i < 0) return null;
    const next = sib[(i + step + sib.length) % sib.length];
    this.leaf = this.tip(next.id);
    return next;
  }

  /** How many branches there are in all (ends of the tree). */
  get branches() {
    return Object.values(this.nodes).filter((n) => !this.children(n.id).length).length;
  }

  toJSON() {
    return { id: this.id, title: this.title, created: this.created, updated: this.updated, nodes: this.nodes, leaf: this.leaf };
  }
}

function latest(chat, node) {
  let t = node.ts;
  for (const k of chat.children(node.id)) t = Math.max(t, latest(chat, k));
  return t;
}

const chats = {
  dir: () => path.join(home(), 'chats'),
  save(chat) {
    if (chat.empty) return;
    const data = chat.toJSON();
    data.nodes = {};
    for (const [id, n] of Object.entries(chat.nodes)) {
      const { live, ...rest } = n; // ("live" only means something while it's being written)
      data.nodes[id] = live ? { ...rest, stopped: true } : rest;
    }
    writeJson(path.join(chats.dir(), chat.id + '.json'), data);
  },
  load(id) {
    if (!/^[a-f0-9]{6,32}$/.test(String(id))) return null;
    const data = readJson(path.join(chats.dir(), id + '.json'), null);
    return data ? new Chat(data) : null;
  },
  remove(id) {
    if (!/^[a-f0-9]{6,32}$/.test(String(id))) return;
    try { fs.unlinkSync(path.join(chats.dir(), id + '.json')); } catch { /* already gone */ }
  },
  /** Newest first: [{ id, title, updated, branches }]. */
  list() {
    let files = [];
    try { files = fs.readdirSync(chats.dir()).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      const c = readJson(path.join(chats.dir(), f), null);
      if (c && c.id) out.push({ id: c.id, title: c.title || 'untitled', updated: c.updated || 0, messages: Object.keys(c.nodes || {}).length });
    }
    return out.sort((a, b) => b.updated - a.updated);
  },
};

/** A conversation as Markdown (the branch on screen). */
function toMarkdown(chat, nameOf = (m) => m) {
  const lines = [`# ${chat.title || 'Tree of Thought'}`, ''];
  for (const n of chat.path()) {
    lines.push(n.role === 'user' ? '**You**' : `**${nameOf(n.model)}**`, '', n.err ? `> ${n.err}` : n.text, '');
  }
  return lines.join('\n');
}

module.exports = { home, config, keys, chats, Chat, toMarkdown, readJson, writeJson };
