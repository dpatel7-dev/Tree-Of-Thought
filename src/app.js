'use strict';
// The Tree of Thought screen.
//
//   ╭─ tree of thought ────────┬─ ✿ Some Model · OpenRouter ─────────────╮
//   │ GARDEN                   │  you                                    │
//   │ ▌[plant] Some Model      │  what should I name my cat?             │
//   │  [plant] Other Model     │                                         │
//   │ + Plant a model          │  ✿ Some Model        ‹ 1 of 3 ›         │
//   │ CHATS                    │  How about "Pixel"?                     │
//   │ › cat names        2m    ├─────────────────────────────────────────┤
//   │ + New chat         [🌳]  │ › Ask Some Model…                       │
//   ╰──────────────────────────┴─────────────────────────────────────────╯

const fs = require('fs');
const path = require('path');
const A = require('./ansi');
const Th = require('./theme');
const R = require('./rowan');
const Pl = require('./plants');
const P = require('./providers');
const St = require('./store');
const Md = require('./markdown');
const { Editor } = require('./editor');
const { Tui, fit, center, spread, copy, open } = require('./tui');
const pkg = require('../package.json');

const keyOf = (m) => `${m.provider}:${m.id}`;
const money = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : v === 0 ? '0' : v < 0.1 ? v.toFixed(3).replace(/0+$/, '') : v < 10 ? v.toFixed(2).replace(/\.?0+$/, '') : v.toFixed(0));

function priceText(m) {
  if (m.provider === 'ollama') return 'on this computer · free';
  if (m.free || /:free$/.test(m.id)) return 'free';
  if (m.price && m.price.in !== null && m.price.out !== null && m.price.in !== undefined) return `$${money(m.price.in)} in · $${money(m.price.out)} out /M`;
  return P.PROVIDERS[m.provider] ? P.PROVIDERS[m.provider].name : m.provider;
}

class App {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.cfg = St.config.load();
    this.keys = St.keys.load();
    P.setCustomBase(this.cfg.customBase);
    Th.use(this.cfg.theme);
    this.ed = new Editor();
    this.chat = (this.cfg.last && St.chats.load(this.cfg.last)) || new St.Chat();
    this.chatList = St.chats.list();
    this.jobs = new Map();
    this.scroll = 0;
    this.cursor = { kind: 'model', i: this.cfg.current || 0 };
    this.menu = null;
    this.flash = null;
    this.editing = null; // asking again from an earlier question: its parent
    this.mood = { scene: 'idle', at: Date.now(), until: 0 };
    this.cache = new Map();
    this.ui = new Tui({ input, output, paper: Th.t().paper, render: (w, h) => this.frame(w, h) });
    this.ui.on('key', (s, k) => this.onKey(s, k));
    this.ui.on('paste', (t) => { if (this.menu && this.menu.input) this.menu.input.ed.insert(t.replace(/\n/g, ' ')); else this.ed.insert(t); this.dirty(); });
    this.ui.on('mouse', (m) => this.onMouse(m));
  }

  get garden() { return this.cfg.garden || []; }
  model() { return this.garden[Math.min(this.cfg.current || 0, this.garden.length - 1)] || null; }
  modelByKey(k) { return this.garden.find((m) => keyOf(m) === k) || null; }

  run() {
    return new Promise((resolve) => {
      this.done = resolve;
      this.ui.start();
      this.ticker = setInterval(() => {
        if (this.flash && this.flash.until < Date.now()) this.flash = null;
        this.dirty();
      }, 120);
      if (!this.garden.length) this.plantFirstGarden();
      this.watcher = setInterval(() => this.reloadIfChanged(), 1500);
    });
  }

  /** The dashboard (or another tot) changed the garden, keys or settings: pick that up. */
  reloadIfChanged() {
    const stamp = (f) => { try { return fs.statSync(path.join(St.home(), f)).mtimeMs; } catch { return 0; } };
    const now = stamp('config.json') + stamp('keys.json');
    if (this.stamp === undefined) { this.stamp = now; return; }
    if (now === this.stamp || Date.now() - (this.savedAt || 0) < 1500) { this.stamp = now; return; }
    this.stamp = now;
    const cfg = St.config.load();
    this.cfg = { ...this.cfg, garden: cfg.garden, current: cfg.current, theme: cfg.theme, system: cfg.system, thoughts: cfg.thoughts, customBase: cfg.customBase };
    this.keys = St.keys.load();
    P.setCustomBase(this.cfg.customBase);
    if (Th.name() !== this.cfg.theme) { Th.use(this.cfg.theme); this.ui.setPaper(Th.t().paper); }
    this.dirty();
  }

  async dashboard() {
    try {
      if (!this.dash) this.dash = await require('./dashboard').serve();
      else open(this.dash.url);
      this.say('Opened your dashboard in the browser.');
    } catch (e) { this.say(e.message, 8000); }
  }

  quit() {
    for (const j of this.jobs.values()) j.ac.abort();
    clearInterval(this.ticker);
    clearInterval(this.watcher);
    if (this.dash) this.dash.close();
    St.chats.save(this.chat);
    this.ui.stop();
    if (this.done) this.done();
  }

  dirty() { this.ui.schedule(); }
  say(text, ms = 3500) { this.flash = { text, until: Date.now() + ms }; this.dirty(); }
  saveCfg() { this.savedAt = Date.now(); St.config.save(this.cfg); }
  react(scene, ms = 0) { this.mood = { scene, at: Date.now(), until: ms ? Date.now() + ms : 0 }; }

  // ── the garden ─────────────────────────────────────────────────────────────
  /** No models yet: use Ollama if it's running, or build one from the first key. */
  async plantFirstGarden() {
    const withKey = P.IDS.find((id) => this.keys[id]);
    if (withKey) return this.gardenFrom(withKey);
    const local = await P.ollamaHere();
    if (local && local.length && !this.garden.length) {
      this.cfg.garden = local.slice(0, 6).map((m) => ({ provider: 'ollama', id: m.id, name: m.name }));
      this.cfg.current = 0;
      this.saveCfg();
      this.say(`Found Ollama on this computer: planted ${local.length > 6 ? 6 : local.length} local models.`);
    }
  }

  async gardenFrom(provider) {
    this.say(`Looking at what ${P.PROVIDERS[provider].name} offers…`, 8000);
    try {
      const all = await P.listModels(provider, this.keys[provider]);
      let pick = provider === 'openrouter' ? P.pickGarden(all) : all.filter((m) => m.text && !/embed|tts|whisper|dall-e|moderation|image|audio|realtime|transcribe|guard/i.test(m.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 5);
      if (!pick.length) pick = all.slice(0, 5);
      const have = new Set(this.garden.map(keyOf));
      for (const m of pick) if (!have.has(keyOf(m))) this.garden.push({ provider, id: m.id, name: m.name, price: m.price, free: m.free });
      this.cfg.garden = this.garden;
      this.saveCfg();
      this.say(`Planted ${pick.length} models from ${P.PROVIDERS[provider].name}. Add more with Tab → Plant a model.`, 6000);
    } catch (e) {
      this.say(e.message, 9000);
    }
    this.dirty();
  }

  pickModel(i) {
    if (!this.garden[i]) return;
    this.cfg.current = i;
    this.saveCfg();
    this.react('idle');
  }

  // ── asking ─────────────────────────────────────────────────────────────────
  send() {
    const text = this.ed.text.trim();
    if (!text) return;
    if (text[0] === '/' && !/^\/\//.test(text)) { this.ed.clear(); return this.command(text.slice(1)); }
    const m = this.model();
    if (!m) return this.say('Plant a model first: press Tab → API keys (or run Ollama on this computer).', 6000);
    this.ed.clear();
    this.ask(text, [m]);
  }

  ask(text, models) {
    const parent = this.editing ? this.editing.parent : this.lastOnPath();
    this.editing = null;
    const q = this.chat.add(parent, 'user', { text });
    this.answer(q, models);
  }

  lastOnPath() {
    const p = this.chat.path();
    return p.length ? p[p.length - 1].id : null;
  }

  /** Ask one or more models to answer a question (several = side-by-side branches). */
  answer(q, models) {
    const made = models.map((m) => this.chat.add(q.id, 'assistant', { model: keyOf(m), name: m.name, provider: m.provider, live: true }));
    this.chat.leaf = made[0].id;
    this.scroll = 0;
    this.react('think');
    for (let i = 0; i < made.length; i++) this.stream(made[i], models[i]);
    St.chats.save(this.chat);
    this.chatList = St.chats.list();
    if (this.cfg.last !== this.chat.id) { this.cfg.last = this.chat.id; this.saveCfg(); }
    this.cursor = { kind: 'chat', id: this.chat.id };
  }

  async stream(node, m) {
    const ac = new AbortController();
    this.jobs.set(node.id, { ac, model: m });
    const started = Date.now();
    const messages = this.chat.path(node.parent).filter((n) => !n.err && n.text).map((n) => ({ role: n.role, content: n.text }));
    let wrote = false;
    try {
      const r = await P.chat({
        provider: m.provider, key: this.keys[m.provider], model: m.id, messages, system: this.cfg.system || undefined, signal: ac.signal,
        onText: (t) => { node.text += t; if (!wrote) { wrote = true; if (this.mood.scene === 'think') this.react('write'); } this.dirty(); },
        onThought: (t) => { node.thought = (node.thought || '') + t; this.dirty(); },
      });
      if (r.usage) node.usage = r.usage;
      if (!node.text && !r.text) node.err = 'The model sent back an empty answer.';
    } catch (e) {
      if (e.name === 'AbortError') node.stopped = true;
      else node.err = e.message;
    } finally {
      delete node.live;
      node.took = Date.now() - started;
      this.jobs.delete(node.id);
      if (!this.jobs.size) this.react(node.err ? 'wilt' : 'bloom', node.err ? 4000 : R.length('bloom'));
      St.chats.save(this.chat);
      this.dirty();
    }
  }

  stop() {
    if (!this.jobs.size) return false;
    for (const j of this.jobs.values()) j.ac.abort();
    this.say('Stopped.');
    return true;
  }

  /** The newest answer on screen (for retry, copy, branches). */
  lastAnswer() {
    const p = this.chat.path();
    for (let i = p.length - 1; i >= 0; i--) if (p[i].role === 'assistant') return p[i];
    return null;
  }

  lastQuestion() {
    const p = this.chat.path();
    for (let i = p.length - 1; i >= 0; i--) if (p[i].role === 'user') return p[i];
    return null;
  }

  retry() {
    const a = this.lastAnswer();
    const m = this.model();
    if (!a || !m) return this.say('Nothing to ask again yet.');
    this.answer(this.chat.nodes[a.parent], [m]);
  }

  /** Ask every model in your garden at once - each answer is a branch. */
  grove(text) {
    if (!this.garden.length) return this.say('Your garden is empty: press Tab → API keys first.');
    if (text) return this.ask(text, this.garden);
    const q = this.lastQuestion();
    if (!q) return this.say('Type a question, then press Ctrl+G to ask every model at once.');
    const answered = new Set(this.chat.children(q.id).map((n) => n.model));
    const todo = this.garden.filter((m) => !answered.has(keyOf(m)));
    if (!todo.length) return this.say('Every model in your garden has already answered this one. ←/→ to compare.');
    this.answer(q, todo);
    this.say(`Asked ${todo.length} model${todo.length === 1 ? '' : 's'}. Use ← → to flip between their answers.`, 5000);
  }

  /** Edit your last question: sending makes a new branch next to the old one. */
  edit() {
    const q = this.lastQuestion();
    if (!q) return this.say('No question to edit yet.');
    this.editing = { parent: q.parent };
    this.ed.set(q.text);
    this.say('Editing: Enter grows a new branch (the old one stays). Esc cancels.', 6000);
  }

  /** ←/→: show the next or previous branch. */
  turn(step) {
    const p = this.chat.path();
    for (let i = p.length - 1; i >= 0; i--) {
      if (this.chat.siblings(p[i].id).length > 1) {
        const n = this.chat.turn(p[i].id, step);
        if (n) { this.scroll = 0; St.chats.save(this.chat); this.cfg.last = this.chat.id; }
        return;
      }
    }
    this.say('Only one branch here. Ctrl+R asks again, Ctrl+G asks every model, Ctrl+E edits your question.');
  }

  newChat() {
    St.chats.save(this.chat);
    for (const j of this.jobs.values()) j.ac.abort();
    this.chat = new St.Chat();
    this.cfg.last = null;
    this.saveCfg();
    this.scroll = 0;
    this.editing = null;
    this.chatList = St.chats.list();
    this.cursor = { kind: 'new' };
  }

  openChat(id) {
    if (id === this.chat.id) return;
    St.chats.save(this.chat);
    const c = St.chats.load(id);
    if (!c) return;
    this.chat = c;
    this.cfg.last = id;
    this.saveCfg();
    this.scroll = 0;
    this.editing = null;
  }

  // ── commands ───────────────────────────────────────────────────────────────
  command(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch ((cmd || '').toLowerCase()) {
      case 'new': return this.newChat();
      case 'grove': case 'all': case 'everyone': return this.grove(arg);
      case 'retry': case 'again': return this.retry();
      case 'edit': return this.edit();
      case 'copy': return this.copyAnswer(/^code/i.test(arg));
      case 'key': case 'keys': {
        if (rest.length >= 2 && P.PROVIDERS[rest[0]]) return this.setKey(rest[0], rest.slice(1).join(''));
        return this.openMenu(this.keysMenu());
      }
      case 'add': case 'plant': return this.openMenu(this.plantMenu(arg));
      case 'remove': case 'uproot': return this.uproot();
      case 'model': case 'm': {
        const i = this.garden.findIndex((m) => (m.name + ' ' + m.id).toLowerCase().includes(arg.toLowerCase()));
        if (arg && i >= 0) { this.pickModel(i); this.cursor = { kind: 'model', i }; return this.say(`Now asking ${this.garden[i].name}.`); }
        return this.openMenu(this.plantMenu(arg));
      }
      case 'theme': case 'colours': case 'colors': {
        if (Th.THEMES[arg]) return this.setTheme(arg);
        return this.openMenu(this.themeMenu());
      }
      case 'system': return arg ? this.setSystem(arg) : this.openMenu(this.systemMenu());
      case 'thoughts': this.cfg.thoughts = !this.cfg.thoughts; this.saveCfg(); return this.say(`Thoughts are now ${this.cfg.thoughts ? 'shown' : 'hidden'}.`);
      case 'chats': case 'open': return this.openMenu(this.chatsMenu());
      case 'delete': return this.deleteChat();
      case 'rename': if (arg) { this.chat.title = arg.slice(0, 48); St.chats.save(this.chat); this.chatList = St.chats.list(); } return;
      case 'export': case 'save': return this.exportChat();
      case 'help': case '?': return this.openMenu(this.helpMenu());
      case 'quit': case 'exit': case 'q': return this.quit();
      default: return this.say(`"/${cmd}" isn't a command. Press Tab for the menu, or /help.`);
    }
  }

  setKey(provider, key) {
    this.keys = St.keys.set(provider, key.trim());
    this.say(`Saved your ${P.PROVIDERS[provider].name} key (only readable by you, in ${St.home()}).`);
    if (key && !this.garden.some((m) => m.provider === provider)) this.gardenFrom(provider);
  }

  setTheme(name) {
    Th.use(name);
    this.cfg.theme = name;
    this.saveCfg();
    this.cache.clear();
    this.ui.setPaper(Th.t().paper);
  }

  setSystem(text) {
    this.cfg.system = text.trim();
    this.saveCfg();
    this.say(this.cfg.system ? 'Saved. Every model gets these instructions from now on.' : 'Instructions cleared.');
  }

  uproot() {
    const m = this.model();
    if (!m) return;
    this.garden.splice(this.cfg.current, 1);
    this.cfg.current = Math.max(0, Math.min(this.cfg.current, this.garden.length - 1));
    this.saveCfg();
    this.say(`Removed ${m.name} from your garden.`);
  }

  copyAnswer(code) {
    const a = this.lastAnswer();
    if (!a || !a.text) return this.say('No answer to copy yet.');
    let text = a.text;
    if (code) {
      const blocks = Md.codeBlocks(a.text);
      if (!blocks.length) return this.say('That answer has no code block.');
      text = blocks[blocks.length - 1];
    }
    copy(text, this.ui.output);
    this.say(code ? 'Copied the code.' : 'Copied the answer.');
  }

  deleteChat() {
    const id = this.chat.id;
    St.chats.remove(id);
    this.chat = new St.Chat();
    this.cfg.last = null;
    this.saveCfg();
    this.chatList = St.chats.list();
    this.say('Deleted that chat.');
  }

  exportChat() {
    if (this.chat.empty) return this.say('Nothing to save yet.');
    const fs = require('fs');
    const path = require('path');
    const name = (this.chat.title || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat';
    const file = path.join(process.cwd(), `${name}.md`);
    fs.writeFileSync(file, St.toMarkdown(this.chat, (k) => this.nameOf(k)));
    this.say(`Saved this branch to ${file}`, 6000);
  }

  nameOf(k, node) {
    const m = this.modelByKey(k);
    return (m && m.name) || (node && node.name) || String(k || '').split(':').slice(1).join(':') || 'model';
  }

  // ── menus ──────────────────────────────────────────────────────────────────
  openMenu(page) {
    if (!page) return;
    this.menu = { stack: [page], index: 0, filter: '' };
    this.dirty();
  }

  pushPage(page) {
    if (!this.menu) return this.openMenu(page);
    this.menu.stack.push(page);
    this.menu.index = 0;
    this.menu.filter = '';
  }

  mainMenu() {
    const m = this.model();
    return {
      title: 'Tree of Thought',
      items: [
        { label: 'New chat', hint: 'ctrl+n', run: () => this.newChat() },
        { label: 'Ask every model at once', hint: 'ctrl+g', desc: 'each answer becomes a branch', run: () => { const text = this.ed.text.trim(); this.ed.clear(); this.grove(text); } },
        { label: 'Ask again', hint: 'ctrl+r', desc: m ? `with ${m.name}` : '', run: () => this.retry() },
        { label: 'Edit my last question', hint: 'ctrl+e', desc: 'grows a new branch', run: () => this.edit() },
        { label: 'Open a chat…', run: () => this.pushPage(this.chatsMenu()) },
        { label: 'Plant a model…', desc: 'add one to your garden', run: () => this.pushPage(this.plantMenu('')) },
        ...(m ? [{ label: `Remove ${m.name}`, run: () => this.uproot() }] : []),
        { label: 'API keys…', desc: Object.keys(this.keys).length ? Object.keys(this.keys).join(', ') : 'none yet', run: () => this.pushPage(this.keysMenu()) },
        { label: 'Instructions for every model…', desc: this.cfg.system ? 'set' : 'none', run: () => this.pushPage(this.systemMenu()) },
        { label: `${this.cfg.thoughts ? 'Hide' : 'Show'} the models' thinking`, run: () => this.command('thoughts') },
        { label: 'Colours…', desc: Th.name(), run: () => this.pushPage(this.themeMenu()) },
        { label: 'Copy the last answer', hint: 'ctrl+y', run: () => this.copyAnswer(false) },
        { label: 'Save this chat as Markdown', run: () => this.exportChat() },
        { label: 'Delete this chat', run: () => this.deleteChat() },
        { label: 'Open the dashboard', desc: 'chats as trees, garden, keys, models on this computer', run: () => this.dashboard() },
        { label: 'Which services work on this network?', desc: 'for school or office Wi-Fi', run: () => this.networkPage() },
        { label: 'Help', run: () => this.pushPage(this.helpMenu()) },
        { label: 'Quit', hint: 'ctrl+d', run: () => this.quit() },
      ],
    };
  }

  keysMenu() {
    return {
      title: 'API keys',
      note: "Keys stay on this computer. OpenRouter is the easy one: one key, every big model. If a service is blocked where you are, check which ones work (Tab → Which services work on this network?), or use Ollama: it needs no internet.",
      items: P.IDS.map((id) => {
        const p = P.PROVIDERS[id];
        return {
          label: p.name, desc: p.noKey ? 'no key needed' : this.keys[id] ? '✓ key saved' : p.about,
          run: () => (p.noKey ? this.gardenFrom(id)
            : p.custom && !this.cfg.customBase ? this.pushPage(this.inputPage('Address of the service', 'Like https://example.com/v1 (any OpenAI-compatible service).', '', (v) => { if (/^https?:\/\/\S+$/.test(v.trim())) { this.cfg.customBase = v.trim().replace(/\/+$/, ''); P.setCustomBase(this.cfg.customBase); this.saveCfg(); this.say('Saved the address. Now pick Other service again for its key.'); } else this.say('That should start with https://'); }))
              : this.pushPage(this.inputPage(`${p.name} key`, p.keyUrl ? `Get one at ${p.keyUrl}, then paste it here.` : 'Paste its key here.', '', (v) => this.setKey(id, v), true))),
          keep: !p.noKey,
        };
      }),
    };
  }

  async networkPage() {
    this.say('Checking which services this network lets through…', 15000);
    const res = await P.checkNetwork();
    const word = { ok: 'works', slow: 'slow', blocked: 'blocked', inspected: 'inspected', off: 'not running' };
    const ok = res.filter((r) => r.api === 'ok' && r.id !== 'ollama').map((r) => r.name);
    this.flash = null;
    this.pushPage({
      title: 'This network',
      note: ok.length ? `Works here: ${ok.join(', ')}. Keys you saved somewhere else still work here.` : 'No online service gets through here, but Ollama models on this computer still work: they need no internet.',
      items: res.map((r) => ({ label: r.name, desc: `answers: ${word[r.api] || r.api}${r.site ? ` · key website: ${word[r.site] || r.site}` : ''}`, run: () => {} })),
    });
  }

  inputPage(title, note, value, done, secret = false) {
    const ed = new Editor();
    ed.set(value || '');
    return { title, note, input: { ed, done, secret }, items: [] };
  }

  systemMenu() {
    return this.inputPage('Instructions for every model', 'Like: "Answer briefly. I\'m a beginner programmer." Leave empty to clear.', this.cfg.system, (v) => this.setSystem(v));
  }

  themeMenu() {
    return {
      title: 'Colours',
      items: Th.NAMES.map((n) => ({ label: n + (n === Th.name() ? '  ✓' : ''), desc: Th.THEMES[n].about, run: () => this.setTheme(n) })),
    };
  }

  chatsMenu() {
    const list = St.chats.list();
    return {
      title: 'Your chats',
      filter: true,
      items: list.length ? list.map((c) => ({ label: c.title, desc: `${c.messages} messages · ${require('./tui').ago(c.updated)}`, run: () => this.openChat(c.id) }))
        : [{ label: 'No saved chats yet', run: () => {} }],
    };
  }

  helpMenu() {
    const rows = [
      ['Enter', 'ask'], ['Alt+Enter', 'new line'], ['↑ ↓', 'pick a model or a chat'], ['← →', 'flip between branches (other answers)'],
      ['Ctrl+G', 'ask every model in your garden at once'], ['Ctrl+R', 'ask again'], ['Ctrl+E', 'edit your last question (new branch)'],
      ['Ctrl+Y', 'copy the last answer'], ['Ctrl+N', 'new chat'], ['Esc', 'stop an answer'], ['PgUp PgDn', 'scroll'], ['Tab', 'this menu'],
      ['/key openrouter …', 'save a key'], ['/model name', 'switch model'], ['/copy code', 'copy the last code block'], ['/system …', 'instructions for every model'],
    ];
    return { title: 'Keys', items: rows.map(([k, d]) => ({ label: k, desc: d, run: () => {} })) };
  }

  plantMenu(filter) {
    const page = { title: 'Plant a model', filter: true, loading: true, items: [], note: 'Loading the models your keys can use…' };
    page.preset = filter || '';
    const providers = P.IDS.filter((id) => this.keys[id] || id === 'ollama');
    Promise.all(providers.map((id) => P.listModels(id, this.keys[id]).catch((e) => (id === 'ollama' ? [] : { error: e.message }))))
      .then((lists) => {
        const errs = lists.filter((l) => l && l.error).map((l) => l.error);
        const all = lists.filter(Array.isArray).flat().filter((m) => m.text).sort((a, b) => (b.created || 0) - (a.created || 0));
        page.loading = false;
        page.note = all.length ? `${all.length} models. Type to search · Enter plants one.` : errs[0] || 'No models found. Add an API key first (Tab → API keys).';
        const have = new Set(this.garden.map(keyOf));
        page.items = all.map((m) => ({
          label: m.name, desc: `${P.PROVIDERS[m.provider].name} · ${priceText(m)}${have.has(keyOf(m)) ? ' · in your garden' : ''}`,
          search: `${m.name} ${m.id} ${m.provider}`, plant: Pl.plantFor(m),
          run: () => {
            const i = this.garden.findIndex((g) => keyOf(g) === keyOf(m));
            if (i >= 0) { this.pickModel(i); this.cursor = { kind: 'model', i }; return; }
            this.garden.push({ provider: m.provider, id: m.id, name: m.name, price: m.price, free: m.free });
            this.cfg.garden = this.garden;
            this.pickModel(this.garden.length - 1);
            this.cursor = { kind: 'model', i: this.garden.length - 1 };
            this.say(`Planted ${m.name}.`);
          },
        }));
        if (this.menu && this.menu.stack.includes(page) && page.preset) this.menu.filter = page.preset;
        this.dirty();
      });
    return page;
  }

  menuItems() {
    const page = this.menu.stack[this.menu.stack.length - 1];
    const f = this.menu.filter.toLowerCase();
    return !f ? page.items : page.items.filter((it) => (it.search || it.label + ' ' + (it.desc || '')).toLowerCase().includes(f));
  }

  menuKey(s, k) {
    const page = this.menu.stack[this.menu.stack.length - 1];
    if (page.input) {
      const ed = page.input.ed;
      if (k.name === 'escape') return this.menuBack();
      if (k.name === 'return') { const v = ed.text; this.menuBack(); page.input.done(v); if (this.menu) this.menu = null; return; }
      return this.editKey(ed, s, k);
    }
    const items = this.menuItems();
    if (k.name === 'escape') { if (this.menu.filter) { this.menu.filter = ''; this.menu.index = 0; return; } return this.menuBack(); }
    if (k.name === 'up') this.menu.index = (this.menu.index - 1 + items.length) % Math.max(1, items.length);
    else if (k.name === 'down') this.menu.index = (this.menu.index + 1) % Math.max(1, items.length);
    else if (k.name === 'pageup') this.menu.index = Math.max(0, this.menu.index - 10);
    else if (k.name === 'pagedown') this.menu.index = Math.min(items.length - 1, this.menu.index + 10);
    else if (k.name === 'return') {
      const it = items[this.menu.index];
      if (!it) return;
      const before = this.menu.stack.length;
      const r = it.run();
      if (this.menu && this.menu.stack.length === before && !it.keep) this.menu = null;
      return r;
    } else if (k.name === 'tab') this.menu = null;
    else if (page.filter && k.name === 'backspace') { this.menu.filter = this.menu.filter.slice(0, -1); this.menu.index = 0; }
    else if (page.filter && s && !k.ctrl && !k.meta && s >= ' ' && s.length === 1) { this.menu.filter += s; this.menu.index = 0; }
  }

  menuBack() {
    this.menu.stack.pop();
    this.menu.index = 0;
    this.menu.filter = '';
    if (!this.menu.stack.length) this.menu = null;
  }

  // ── keys ───────────────────────────────────────────────────────────────────
  onKey(s, k) {
    if (k.ctrl && k.name === 'c') { if (!this.stop()) { if (this.ed.text) this.ed.clear(); else this.quit(); } return this.dirty(); }
    if (this.menu) { this.menuKey(s, k); return this.dirty(); }
    const empty = !this.ed.text;
    if (k.ctrl) {
      switch (k.name) {
        case 'd': if (empty) return this.quit(); this.ed.del(); break;
        case 'g': { const t = this.ed.text.trim(); this.ed.clear(); this.grove(t); break; }
        case 'r': this.retry(); break;
        case 'e': this.edit(); break;
        case 'y': this.copyAnswer(false); break;
        case 'n': this.newChat(); break;
        case 'l': this.ui.prev = []; break;
        case 'j': this.ed.insert('\n'); break;
        default: this.editKey(this.ed, s, k);
      }
      return this.dirty();
    }
    switch (k.name) {
      case 'return': if (k.meta) this.ed.insert('\n'); else if (empty && this.cursor.kind === 'add') this.openMenu(this.plantMenu('')); else if (empty && this.cursor.kind === 'new') this.newChat(); else this.send(); break;
      case 'tab': this.openMenu(this.mainMenu()); break;
      case 'escape':
        if (this.stop()) break;
        if (this.editing) { this.editing = null; this.ed.clear(); break; }
        if (this.ed.text) this.ed.clear(); else this.scroll = 0;
        break;
      case 'up': if (empty) this.moveCursor(-1); else this.editKey(this.ed, s, k); break;
      case 'down': if (empty) this.moveCursor(1); else this.editKey(this.ed, s, k); break;
      case 'left': if (empty) this.turn(-1); else this.ed.left(); break;
      case 'right': if (empty) this.turn(1); else this.ed.right(); break;
      case 'pageup': this.scroll += Math.max(3, this.ui.height - 8); break;
      case 'pagedown': this.scroll = Math.max(0, this.scroll - Math.max(3, this.ui.height - 8)); break;
      default: this.editKey(this.ed, s, k);
    }
    this.dirty();
  }

  editKey(ed, s, k) {
    if (k.meta && k.name === 'backspace') return ed.deleteWord();
    if (k.ctrl) {
      if (k.name === 'a') return ed.home();
      if (k.name === 'e') return ed.end();
      if (k.name === 'u') return ed.killToStart();
      if (k.name === 'k') return ed.killToEnd();
      if (k.name === 'w') return ed.deleteWord();
      if (k.name === 'left') return ed.wordLeft();
      if (k.name === 'right') return ed.wordRight();
      return;
    }
    switch (k.name) {
      case 'backspace': return ed.backspace();
      case 'delete': return ed.del();
      case 'left': return ed.left();
      case 'right': return ed.right();
      case 'home': return ed.home();
      case 'end': return ed.end();
      case 'up': case 'down': return;
      default:
        if (s && !k.meta && (s >= ' ' || s === '\n')) ed.insert(s.replace(/\r/g, ''));
    }
  }

  rows() {
    const out = this.garden.map((m, i) => ({ kind: 'model', i }));
    out.push({ kind: 'add' });
    for (const c of this.chatList.slice(0, 30)) out.push({ kind: 'chat', id: c.id });
    out.push({ kind: 'new' });
    return out;
  }

  sameRow(a, b) { return a.kind === b.kind && a.i === b.i && a.id === b.id; }

  moveCursor(step) {
    const rows = this.rows();
    let i = rows.findIndex((r) => this.sameRow(r, this.cursor));
    if (i < 0) i = 0;
    i = Math.max(0, Math.min(rows.length - 1, i + step));
    this.cursor = rows[i];
    if (this.cursor.kind === 'model') this.pickModel(this.cursor.i);
    if (this.cursor.kind === 'chat') this.openChat(this.cursor.id);
  }

  onMouse(m) {
    if (m.wheel) { this.scroll = Math.max(0, this.scroll - m.wheel * 3); return this.dirty(); }
    if (m.click && this.hit) {
      const row = this.hit.get(m.y);
      if (row && m.x < this.sideW) { this.cursor = row; if (row.kind === 'model') this.pickModel(row.i); else if (row.kind === 'chat') this.openChat(row.id); else if (row.kind === 'add') this.openMenu(this.plantMenu('')); else if (row.kind === 'new') this.newChat(); }
      this.dirty();
    }
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  frame(W, H) {
    const t = Th.t();
    const B = (s) => A.paint(s, { fg: t.border });
    const side = W >= 72;
    const sideW = side ? Math.max(26, Math.min(34, Math.floor(W * 0.3))) : 0;
    this.sideW = sideW;
    const paneW = side ? W - sideW - 4 : W - 2;
    const editor = this.menu ? null : this.ed.layout(paneW - 4, Math.min(6, Math.max(1, Math.floor(H / 5))));
    const inputH = editor ? editor.lines.length : 1;
    const bodyH = H - 4 - inputH;

    // title bar
    const m = this.model();
    const plant = m ? Pl.plantFor(m) : 'sprout';
    const title = m ? A.paint('✿ ', { fg: Pl.color(plant) }) + A.paint(m.name, { bold: true }) + Th.dim(' · ' + P.PROVIDERS[m.provider].name) : Th.dim('no model yet');
    const left = side ? B('╭─ ') + Th.leaf('tree of thought', { bold: true }) + ' ' : '';
    const tt = A.clip(title, paneW - 5);
    const top = side
      ? left + B('─'.repeat(Math.max(0, sideW + 2 - A.vwidth(left)))) + B('┬─ ') + tt + ' ' + B('─'.repeat(Math.max(0, paneW - 3 - A.vwidth(tt)))) + B('╮')
      : B('╭─ ') + A.clip(title, W - 6) + ' ' + B('─'.repeat(Math.max(0, W - 5 - A.vwidth(A.clip(title, W - 6))))) + B('╮');

    const sideLines = side ? this.sideLines(sideW, bodyH + 1 + inputH) : [];
    const paneLines = this.menu ? this.menuLines(paneW, bodyH + 1 + inputH) : this.paneLines(paneW, bodyH);

    const lines = [fit(top, W)];
    for (let y = 0; y < bodyH + 1 + inputH; y++) {
      let pane;
      if (this.menu) pane = paneLines[y] || '';
      else if (y < bodyH) pane = paneLines[y] || '';
      else if (y === bodyH) pane = null; // the line above the typing box
      else pane = this.inputLine(editor, y - bodyH - 1, paneW);
      const l = side ? B('│') + fit(sideLines[y] || '', sideW) + ' ' : '';
      if (pane === null) lines.push(l + B('├') + B('─'.repeat(paneW)) + B('┤'));
      else lines.push(l + B('│') + ' ' + fit(pane, paneW - 1) + B('│'));
    }
    lines.push(B('╰' + (side ? '─'.repeat(sideW + 1) + '┴' : '') + '─'.repeat(Math.max(0, W - (side ? sideW + 4 : 2))) + '╯'));
    lines.push(this.hintLine(W));
    while (lines.length < H) lines.splice(lines.length - 2, 0, B('│') + ' '.repeat(W - 2) + B('│'));

    let cursor = null;
    const base = side ? sideW + 4 : 2; // where the pane's text starts on screen
    if (editor && !this.menu) cursor = { row: 1 + bodyH + 1 + editor.row, col: base + 3 + editor.col };
    if (this.menu) {
      const page = this.menu.stack[this.menu.stack.length - 1];
      if (page.input && this.menuCursor) cursor = { row: 1 + this.menuCursor.row, col: base + this.menuCursor.col };
    }
    return { lines: lines.slice(0, H), cursor };
  }

  inputLine(editor, i, w) {
    const t = Th.t();
    const m = this.model();
    if (!editor) return '';
    const text = editor.lines[i] || '';
    const lead = i === 0 ? (this.editing ? A.paint('✎ ', { fg: t.blossom }) : A.paint('› ', { fg: t.leaf, bold: true })) : '  ';
    if (!this.ed.text && i === 0) {
      const ph = this.jobs.size ? 'growing an answer… (esc to stop)' : m ? `Ask ${m.name}…  (tab for the menu)` : 'Add an API key first: press Tab → API keys';
      return ' ' + lead + Th.faint(ph);
    }
    return ' ' + lead + text;
  }

  hintLine(W) {
    const t = Th.t();
    if (this.flash) return ' ' + A.paint(A.clip(this.flash.text, W - 2), { fg: t.sun });
    const job = this.jobs.size;
    const opts = this.menu ? ['↑↓ choose · enter pick · esc back · type to search', 'enter pick · esc back']
      : job ? [`growing ${job} answer${job === 1 ? '' : 's'} · esc stop`, 'esc stop']
        : this.editing ? ['enter grows a new branch · esc cancels']
          : ['↑↓ garden & chats · ←→ branches · ctrl+g ask every model · tab menu', '↑↓ models · ←→ branches · ctrl+g all · tab menu', 'tab menu'];
    const right = Th.dim(`v${pkg.version}`);
    for (const o of opts) if (A.vwidth(o) + 12 < W) return ' ' + spread(Th.dim(o), right + ' ', W - 1);
    return ' ' + Th.dim(A.clip(opts[opts.length - 1], W - 2));
  }

  sideLines(w, h) {
    const t = Th.t();
    const bg = t.paper.bg;
    const out = [];
    const rowAt = new Map();
    const mark = (row) => rowAt.set(out.length, row);
    const isCur = (row) => this.sameRow(row, this.cursor);
    const sel = (s, on) => (on && s[0] === ' ' ? Th.leaf('›') + s.slice(1) : s);

    out.push(' ' + Th.leaf('GARDEN', { bold: true }) + Th.faint(this.garden.length ? `  ${this.garden.length}` : ''));
    if (!this.garden.length) {
      out.push(Th.dim('  nothing planted yet'));
      out.push(Th.dim('  tab → API keys'));
    }
    this.garden.forEach((m, i) => {
      const row = { kind: 'model', i };
      const plant = Pl.plantFor(m);
      const emb = Pl.small(plant, bg);
      const chosen = i === (this.cfg.current || 0);
      const bar = chosen ? A.paint('▌', { fg: t.leaf }) : ' ';
      const name = A.paint(A.clip(m.name, w - 9), chosen ? { bold: true, fg: Pl.color(plant) } : { fg: t.paper.fg });
      const busy = [...this.jobs.values()].some((j) => keyOf(j.model) === keyOf(m));
      const l1 = bar + emb[0] + ' ' + name + (busy ? ' ' + Th.sun('•') : '');
      const l2 = bar + emb[1] + ' ' + Th.dim(A.clip(P.PROVIDERS[m.provider] ? P.PROVIDERS[m.provider].name : m.provider, w - 9));
      const l3 = bar + emb[2] + ' ' + Th.faint(A.clip(priceText(m), w - 9));
      for (const l of [l1, l2, l3]) { mark(row); out.push(l); }
    });
    { const row = { kind: 'add' }; mark(row); out.push(sel(' ' + Th.leaf('+') + ' ' + Th.dim('Plant a model'), isCur(row))); }
    out.push('');
    out.push(' ' + Th.blossom('CHATS', { bold: true }));
    for (const c of this.chatList.slice(0, 30)) {
      const row = { kind: 'chat', id: c.id };
      const open = c.id === this.chat.id;
      const when = Th.faint(require('./tui').ago(c.updated).replace(' ago', ''));
      mark(row);
      out.push(sel((open ? Th.blossom('›') : ' ') + ' ' + spread(A.paint(A.clip(c.title, w - 10), open ? { bold: true } : {}), when, w - 3), isCur(row)));
    }
    { const row = { kind: 'new' }; mark(row); out.push(sel(' ' + Th.blossom('+') + ' ' + Th.dim('New chat'), isCur(row))); }

    // keep the highlighted row on screen, and Rowan at the bottom when there's room
    const room = h - (R.HEIGHT + 1);
    let lines = out;
    let first = 0;
    if (out.length > (room >= 10 ? room : h)) {
      const want = room >= 10 ? room : h;
      const cur = [...rowAt.entries()].filter(([, r]) => isCur(r)).map(([y]) => y);
      const c = cur.length ? cur[cur.length - 1] : 0;
      first = Math.max(0, Math.min(out.length - want, c - Math.floor(want / 2)));
      lines = out.slice(first, first + want);
      if (first + want < out.length) lines[lines.length - 1] = Th.faint('  ↓ more');
      if (first > 0) lines[0] = Th.faint('  ↑ more');
    }
    this.hit = new Map();
    for (const [y, r] of rowAt) if (y >= first && y < first + lines.length) this.hit.set(1 + y - first, r);
    if (room >= 10 && !this.chat.empty) {
      while (lines.length < room) lines.push('');
      lines.push('');
      const tree = this.rowan(bg);
      for (const l of tree) lines.push(' '.repeat(Math.max(0, Math.floor((w - R.WIDTH) / 2))) + l);
    }
    return lines;
  }

  rowan(bg) {
    if (this.mood.until && Date.now() > this.mood.until) this.react(this.jobs.size ? 'think' : 'idle');
    if (this.mood.scene === 'bloom' && !this.mood.until) this.react('bloom', R.length('bloom'));
    return R.draw(this.mood.scene, Date.now() - this.mood.at, bg);
  }

  // the conversation (or the welcome card)
  paneLines(w, h) {
    if (this.chat.empty) return this.welcome(w, h);
    const t = Th.t();
    const all = [];
    const path = this.chat.path();
    const inner = w - 4;
    for (const n of path) {
      all.push('');
      const sib = this.chat.siblings(n.id);
      const pos = sib.length > 1 ? Th.dim(`  ‹ ${sib.findIndex((x) => x.id === n.id) + 1} of ${sib.length} ›`) : '';
      if (n.role === 'user') {
        all.push(' ' + Th.blossom('you', { bold: true }) + Th.faint('  ' + new Date(n.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })) + pos);
        for (const l of Md.plain(n.text, inner)) all.push('  ' + l);
        continue;
      }
      const plant = Pl.plantFor({ id: String(n.model || '').split(':').slice(1).join(':'), provider: n.provider, name: n.name });
      const took = n.took ? Th.faint(`  ${(n.took / 1000).toFixed(n.took < 10000 ? 1 : 0)}s`) : '';
      all.push(' ' + A.paint('✿ ', { fg: Pl.color(plant) }) + A.paint(this.nameOf(n.model, n), { bold: true, fg: Pl.color(plant) }) + took + pos);
      if (n.thought && (this.cfg.thoughts || (n.live && !n.text))) {
        const th = this.cfg.thoughts ? n.thought : n.thought.slice(-inner * 3);
        for (const l of Md.plain(th, inner - 2)) all.push('  ' + A.paint('┊ ', { fg: t.faint }) + A.paint(l, { fg: t.dim, italic: true }));
      }
      if (n.text) {
        const key = `${n.id}|${n.text.length}|${inner}|${Th.name()}`;
        let lines = this.cache.get(key);
        if (!lines) {
          lines = Md.render(n.text, inner);
          if (!n.live) { for (const k of this.cache.keys()) if (k.startsWith(n.id + '|')) this.cache.delete(k); this.cache.set(key, lines); }
        }
        for (const l of lines) all.push('  ' + l);
        if (n.live) all[all.length - 1] += A.paint('▍', { fg: t.leaf });
      } else if (n.live) {
        const dots = '.'.repeat(1 + (Math.floor(Date.now() / 400) % 3));
        all.push('  ' + Th.dim(n.thought ? `thinking${dots} (${n.thought.length} characters of thought)` : `thinking${dots}`));
      }
      if (n.err) for (const l of Md.plain('✗ ' + n.err, inner)) all.push('  ' + Th.err(l));
      if (n.stopped) all.push('  ' + Th.faint('(stopped)'));
      if (sib.length > 1 && n === path[path.length - 1]) {
        const others = sib.map((x) => {
          const pl = Pl.plantFor({ id: String(x.model || '').split(':').slice(1).join(':'), provider: x.provider, name: x.name });
          const state = x.live ? Th.sun('…') : x.err ? Th.err('✗') : Th.leaf('✓');
          const nm = A.clip(this.nameOf(x.model, x), 18);
          return (x.id === n.id ? A.paint(nm, { bold: true, fg: Pl.color(pl), underline: true }) : A.paint(nm, { fg: Pl.color(pl) })) + ' ' + state;
        });
        all.push('');
        let line = '  ' + Th.faint('branches: ');
        others.push(Th.faint('← →'));
        for (const part of others) {
          if (A.vwidth(line) + A.vwidth(part) + 3 > inner + 2 && A.vwidth(line) > 14) { all.push(line); line = '  ' + ' '.repeat(10); }
          line += part + '   ';
        }
        all.push(line);
      }
    }
    all.push('');
    const max = Math.max(0, all.length - h);
    this.scroll = Math.min(this.scroll, max);
    const start = Math.max(0, all.length - h - this.scroll);
    const view = all.slice(start, start + h);
    if (this.scroll && view.length) view[view.length - 1] = Th.dim(` ↓ ${this.scroll} more lines · pgdn or esc`);
    while (view.length < h) view.unshift('');
    return view;
  }

  welcome(w, h) {
    const t = Th.t();
    const bg = t.paper.bg;
    const out = [];
    const m = this.model();
    const tree = R.draw(this.mood.scene === 'idle' ? 'idle' : this.mood.scene, Date.now() - this.mood.at, bg);
    const head = [
      '', ...tree.map((l) => center(l, w - 1)), '',
      center(Th.leaf('Tree of Thought', { bold: true }), w - 1),
      center(Th.dim('many minds, one garden. every answer is a branch.'), w - 1), '',
    ];
    const body = [];
    if (m) {
      const plant = Pl.plantFor(m);
      const big = Pl.big(plant, bg);
      const info = [
        A.paint(m.name, { bold: true, fg: Pl.color(plant) }),
        Th.dim(P.PROVIDERS[m.provider].name + ' · ' + Pl.PLANTS[plant].about),
        Th.faint(A.clip(m.id, Math.max(10, w - 22))),
        Th.faint(priceText(m)), '',
        Th.dim(`${this.garden.length} model${this.garden.length === 1 ? '' : 's'} in your garden`),
      ];
      const cardW = Math.min(w - 4, 12 + 2 + Math.max(...info.map((x) => A.vwidth(x))));
      const pad = ' '.repeat(Math.max(0, Math.floor((w - 1 - cardW) / 2)));
      for (let i = 0; i < 6; i++) body.push(pad + big[i] + '  ' + (info[i] || ''));
      body.push('');
      const tips = [['Enter', 'ask'], ['Ctrl+G', 'ask every model at once'], ['← →', 'flip between their answers'], ['Ctrl+E', 'edit a question: grows a new branch'], ['Tab', 'menu: models, keys, colours']];
      for (const [k, d] of tips) body.push(center(Th.leaf(k.padEnd(7)) + ' ' + Th.dim(d.padEnd(36)), w - 1));
    } else {
      const lines = [
        Th.bold('Plant your first model'), '',
        Th.leaf('1.') + ' Get a key - the easy one is ' + Th.bold('OpenRouter') + Th.dim(' (one key, every big model):'),
        '   ' + A.paint('https://openrouter.ai/keys', { fg: t.water, underline: true }),
        Th.leaf('2.') + ' Press ' + Th.bold('Tab') + ' → ' + Th.bold('API keys') + ' → ' + Th.bold('OpenRouter') + ', and paste it.',
        Th.leaf('3.') + ' Your garden fills with the strongest model from each maker.', '',
        Th.dim('Free options: Google AI Studio and Groq have free tiers, and'),
        Th.dim('Ollama (ollama.com) runs models on this computer for nothing.'),
        Th.dim('Is a site blocked where you are? Tab → Which services work on this network?'),
      ];
      const cw = Math.max(...lines.map((x) => A.vwidth(x)));
      const pad = ' '.repeat(Math.max(0, Math.floor((w - 1 - cw) / 2)));
      for (const l of lines) body.push(pad + l);
    }
    let all = head.concat(body);
    if (all.length > h) all = head.slice(Math.min(head.length, all.length - h)).concat(body).slice(-h);
    const top = Math.max(0, Math.floor((h - all.length) / 2));
    for (let i = 0; i < top; i++) out.push('');
    return out.concat(all).slice(0, h);
  }

  menuLines(w, h) {
    const t = Th.t();
    const page = this.menu.stack[this.menu.stack.length - 1];
    const out = [''];
    const crumbs = this.menu.stack.map((p) => p.title).join(Th.faint(' › '));
    out.push(' ' + Th.leaf(crumbs, { bold: true }));
    if (page.note) for (const l of Md.plain(page.note, w - 4)) out.push(' ' + Th.dim(l));
    this.menuCursor = null;
    if (page.input) {
      out.push('');
      const ed = page.input.ed;
      const lay = ed.layout(w - 6, 3);
      lay.lines.forEach((l, i) => out.push(' ' + (i === 0 ? Th.leaf('› ') : '  ') + (page.input.secret ? '•'.repeat(A.vwidth(l)) : l)));
      this.menuCursor = { row: 3 + (page.note ? Md.plain(page.note, w - 4).length : 0) + lay.row, col: 3 + lay.col };
      out.push('');
      out.push(' ' + Th.dim('enter saves · esc goes back'));
      return out;
    }
    if (page.filter) out.push(' ' + Th.dim('search: ') + (this.menu.filter ? Th.sun(this.menu.filter) : Th.faint('type to search')));
    out.push('');
    const items = this.menuItems();
    const room = h - out.length - 1;
    const first = Math.max(0, Math.min(this.menu.index - Math.floor(room / 2), items.length - room));
    items.slice(first, first + room).forEach((it, j) => {
      const i = first + j;
      const on = i === this.menu.index;
      const dot = it.plant ? A.paint('✿ ', { fg: Pl.color(it.plant) }) : '';
      const label = (on ? Th.leaf('› ', { bold: true }) : '  ') + dot + A.paint(it.label, on ? { bold: true } : {}) + (it.hint ? Th.faint('  ' + it.hint) : '');
      const line = spread(label, Th.dim(A.clip(it.desc || '', Math.max(0, w - A.vwidth(label) - 6))), w - 3);
      out.push(' ' + line);
    });
    if (!items.length) out.push('  ' + Th.dim(page.loading ? 'loading…' : 'nothing matches'));
    return out;
  }
}

module.exports = { App, keyOf, priceText };
