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
//   │ + New chat      [Rowan]  │ › Ask Some Model…                       │
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
const S = require('./smart');
const Ans = require('./answer');
const F = require('./free');
const Me = require('./meter');
const { Editor } = require('./editor');
const { Tui, fit, center, spread, copy, open, size, bar } = require('./tui');
const pkg = require('../package.json');

const keyOf = (m) => `${m.provider}:${m.id}`;
const money = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : v === 0 ? '0' : v < 0.1 ? v.toFixed(3).replace(/0+$/, '') : v < 10 ? v.toFixed(2).replace(/\.?0+$/, '') : v.toFixed(0));

/** "Anthropic · via OpenRouter", or just "OpenRouter" when it's the maker's own service. */
function whoText(m) {
  if (F.isAuto(m)) return 'picks a free model for each question';
  const maker = S.makerOf(m);
  const via = m.provider === 'ollama' ? 'this computer' : P.PROVIDERS[m.provider] ? P.PROVIDERS[m.provider].name : m.provider;
  if (!maker || maker === via) return via;
  return m.provider === 'ollama' ? `${maker} · on this computer` : `${maker} · via ${via}`;
}

function priceText(m) {
  if (F.isAuto(m)) return 'free · spreads across your services';
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
    this.files = []; // files attached to the next question
    this.mood = { scene: 'idle', at: Date.now(), until: 0 };
    this.cache = new Map();
    this.ui = new Tui({ input, output, paper: Th.t().paper, render: (w, h) => this.frame(w, h) });
    this.ui.on('key', (s, k) => this.onKey(s, k));
    this.ui.on('paste', (t) => this.onPaste(t));
    this.ui.on('mouse', (m) => this.onMouse(m));
  }

  get garden() { return this.cfg.garden || []; }
  get projects() { return this.cfg.projects || (this.cfg.projects = []); }
  project(id = this.chat.project) { return this.projects.find((p) => p.id === id) || null; }
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
    this.cfg = { ...this.cfg, garden: cfg.garden, current: cfg.current, theme: cfg.theme, system: cfg.system, thoughts: cfg.thoughts, customBase: cfg.customBase, projects: cfg.projects, fallback: cfg.fallback };
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
    const free = F.SERVICES.filter((sv) => this.keys[sv.id]);
    if (free.length) { for (const sv of free) await this.plantFree(sv.id, this.keys[sv.id], true).catch(() => {}); return; }
    const withKey = P.IDS.find((id) => this.keys[id]);
    if (withKey) return this.gardenFrom(withKey);
    // nothing yet: the welcome card offers free setup (Enter)
  }

  /** A key for a free service: check it, save it, plant its best free models, make Auto the default. */
  async plantFree(id, key, quiet) {
    const sv = F.byId(id);
    if (!quiet) this.say(`Checking your ${sv.name} key…`, 8000);
    try {
      const { picked, cfg } = await F.addKey(id, key, this.cfg);
      this.cfg = cfg;
      this.keys = St.keys.load();
      this.savedAt = Date.now();
      this.cursor = { kind: 'model', i: this.cfg.current };
      if (!quiet) this.say(`✓ ${sv.name} works: planted ${picked.map((m) => m.name).join(', ')}. Auto (free) now spreads your questions across ${F.SERVICES.filter((x) => this.keys[x.id]).length} free service${F.SERVICES.filter((x) => this.keys[x.id]).length === 1 ? '' : 's'}.`, 9000);
      this.react('bloom', R.length('bloom'));
      return picked;
    } catch (e) {
      if (!quiet) this.say(e.message, 9000);
      throw e;
    } finally { this.dirty(); }
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
    // a dragged-in file that arrived as typing rather than a paste: attach it
    const asPath = text.replace(/\\(.)/g, '$1').replace(/^'(.*)'$/, '$1');
    if (/^[/~]/.test(asPath) && !/\s\S+\s/.test(text.replace(/\\ /g, '')) && (() => { try { return fs.statSync(asPath.replace(/^~(?=\/)/, require('os').homedir())).isFile(); } catch { return false; } })()) { this.ed.clear(); return this.attachFile(asPath); }
    if (text[0] === '/' && !/^\/\//.test(text)) { this.ed.clear(); return this.command(text.slice(1)); }
    const m = this.model();
    if (!m) return this.say('Plant a model first: press Tab → API keys (or run Ollama on this computer).', 6000);
    this.ed.clear();
    this.ask(text, [m]);
  }

  ask(text, models) {
    const parent = this.editing ? this.editing.parent : this.lastOnPath();
    this.editing = null;
    const files = this.files.map(({ name, text: body, bytes }) => ({ name, text: body, bytes }));
    this.files = [];
    if (this.chat.empty && !this.chat.project && this.cfg.project) this.chat.project = this.cfg.project;
    const q = this.chat.add(parent, 'user', { text, ...(files.length ? { files } : {}) });
    this.answer(q, models);
  }

  /** Dragging a file into the terminal types its path: attach it instead. */
  onPaste(t) {
    const asKey = F.guess(t);
    if (asKey && !(this.menu && this.menu.input && this.menu.input.secret)) {
      if (this.menu && this.menu.input) this.menuBack();
      this.plantFree(asKey, t.trim()).catch(() => {});
      return this.dirty();
    }
    const page = this.menu && this.menu.stack[this.menu.stack.length - 1];
    if (page && page.input) { page.input.ed.insert(t.replace(/\n/g, ' ')); return this.dirty(); }
    const paths = t.trim().split(/(?<!\\) (?=[/~])/).map((x) => x.trim().replace(/\\(.)/g, '$1').replace(/^'(.*)'$/, '$1'));
    const files = paths.every((x) => /^[/~]/.test(x) && x.length < 1024) ? paths.map((x) => { try { return S.attach(x); } catch { return null; } }) : [];
    if (files.length && files.every(Boolean)) { for (const f of files) this.attachFile(f); return this.dirty(); }
    this.ed.insert(t);
    this.dirty();
  }

  attachFile(fileOrPath) {
    try {
      const f = typeof fileOrPath === 'string' ? S.attach(fileOrPath) : fileOrPath;
      this.files = this.files.filter((x) => x.path !== f.path).concat(f);
      this.say(`Attached ${f.name} (${size(f.bytes)}). It goes with your next question. /unattach removes it.`, 6000);
    } catch (e) { this.say(e.message, 6000); }
  }

  /** Everything every model is told first: your instructions, the project's, and the project's pinned files. */
  systemFor(chat) {
    const parts = [];
    if (this.cfg.system) parts.push(this.cfg.system);
    const pr = this.project(chat.project);
    if (pr) {
      parts.push(`You are helping with a project called "${pr.name}".${pr.instructions ? '\n' + pr.instructions : ''}`);
      const files = [];
      let total = 0;
      for (const f of pr.files || []) { try { const a = S.attach(f); if (total + a.bytes < 400 * 1024) { files.push(a); total += a.bytes; } } catch { /* moved or deleted */ } }
      if (files.length) parts.push(S.withFiles('These files belong to the project (they are re-read every time, so they are always current):', files));
    }
    return parts.join('\n\n') || undefined;
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
    for (let i = 0; i < made.length; i++) this.stream(made[i], models[i], { fallback: models.length === 1 && this.cfg.fallback !== false });
    St.chats.save(this.chat);
    this.chatList = St.chats.list();
    if (this.cfg.last !== this.chat.id) { this.cfg.last = this.chat.id; this.saveCfg(); }
    this.cursor = { kind: 'chat', id: this.chat.id };
  }

  async stream(node, m, { fallback = true } = {}) {
    const ac = new AbortController();
    this.jobs.set(node.id, { ac, model: m });
    const started = Date.now();
    const messages = this.chat.path(node.parent).filter((n) => !n.err && n.text)
      .map((n) => ({ role: n.role, content: n.role === 'user' ? S.withFiles(n.text, n.files) : n.text }));
    let wrote = false;
    try {
      const r = await Ans.answer({
        model: m, garden: this.garden, keys: this.keys, messages, system: this.systemFor(this.chat), signal: ac.signal, fallback,
        onText: (t) => { node.text += t; if (!wrote) { wrote = true; if (this.mood.scene === 'think') this.react('write'); } this.dirty(); },
        onThought: (t) => { node.thought = (node.thought || '') + t; this.dirty(); },
        onSwitch: (next, why) => {
          node.thought = '';
          Object.assign(node, { model: keyOf(next), name: next.name, provider: next.provider, auto: F.isAuto(m) || undefined });
          this.jobs.set(node.id, { ac, model: next });
          if (why) this.say(`${why.model.name} ${why.why}: asking ${next.name} instead…`, 5000);
          this.dirty();
        },
      });
      if (r.usage) node.usage = r.usage;
      if (r.tried.length) node.note = Ans.switchNote(r.tried, r.model);
      if (r.trimmed) node.trimmed = r.trimmed;
      if (!node.text && !r.text) node.err = 'The model sent back an empty answer.';
    } catch (e) {
      if (e.name === 'AbortError') node.stopped = true;
      else {
        node.err = e.message;
        if (e.tried && e.tried.length) node.note = `Also tried: ${e.tried.map((t) => `${t.model.name} (${t.why})`).join(', ')}.`;
      }
    } finally {
      delete node.live;
      this.meterAt = 0; // the usage line in the sidebar catches up
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
    this.chat = new St.Chat({ project: this.cfg.project || null });
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
      case 'export': return this.exportChat();
      case 'save': return this.saveAnswer(arg);
      case 'file': case 'attach': case 'f': return arg ? this.attachFile(arg) : this.openMenu(this.inputPage('Attach a file', 'The path of a text or code file (or drag the file into this window). It goes with your next question.', '', (v) => v.trim() && this.attachFile(v.trim())));
      case 'unattach': case 'detach': this.files = []; return this.say('Nothing attached now.');
      case 'pin': return this.pinFile(arg);
      case 'project': case 'projects': case 'p': return arg ? this.switchProject(arg) : this.openMenu(this.projectsMenu());
      case 'find': case 'search': return this.openMenu(this.findMenu(arg));
      case 'usage': case 'stats': case 'limits': return this.openMenu(this.usageMenu());
      case 'free': case 'setup': return this.openMenu(this.freeMenu());
      case 'local': case 'offline': return this.openMenu(this.localMenu());
      case 'tidy': return this.openTidy();
      case 'tools': return this.openMenu(this.toolsMenu());
      case 'cram': case 'howto': return this.openMenu(this.toolsMenu());
      case 'sidebar': this.cfg.sidebar = this.cfg.sidebar === false; this.saveCfg(); return;
      case 'switch': case 'fallback': this.cfg.fallback = this.cfg.fallback === false; this.saveCfg(); return this.say(this.cfg.fallback ? 'If a model is busy or over its limit, the next one in your garden answers.' : "Models won't stand in for each other now.");
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

  /** Save the last answer (or its last code block: /save code name.py) to a file here. */
  saveAnswer(arg) {
    const a = this.lastAnswer();
    if (!a || !a.text) return this.say('No answer to save yet.');
    let code = false;
    let name = arg.trim();
    if (/^code\b/i.test(name)) { code = true; name = name.replace(/^code\s*/i, ''); }
    let text = a.text;
    if (code) {
      const blocks = Md.codeBlocks(a.text);
      if (!blocks.length) return this.say('That answer has no code block.');
      text = blocks[blocks.length - 1];
    }
    if (!name) name = (code ? 'code' : (this.chat.title || 'answer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'answer') + (code ? '.txt' : '.md');
    const file = path.resolve(process.cwd(), name.replace(/^~(?=$|\/)/, require('os').homedir()));
    if (fs.existsSync(file)) return this.say(`${file} already exists. Pick another name: /save ${code ? 'code ' : ''}other-name`, 7000);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n');
    this.say(`Saved ${code ? 'the code' : 'the answer'} to ${file}`, 7000);
  }

  // ── projects: their own instructions, pinned files and chats ────────────────
  switchProject(nameOrId) {
    let pr = this.projects.find((p) => p.id === nameOrId || p.name.toLowerCase() === String(nameOrId).toLowerCase());
    if (!pr && nameOrId) {
      pr = { id: require('crypto').randomBytes(4).toString('hex'), name: String(nameOrId).slice(0, 40), instructions: '', files: [], made: Date.now() };
      this.projects.push(pr);
      this.say(`Made the project "${pr.name}". Tab → Projects to give it instructions or pin files.`, 6000);
    }
    this.cfg.project = pr ? pr.id : null;
    this.saveCfg();
    if (!pr) this.say('Back to everyday chats.');
    // stay in this chat if it belongs, otherwise open the project's newest chat (or a fresh one)
    if ((this.chat.project || null) !== this.cfg.project) {
      const mine = St.chats.list().find((c) => (c.project || null) === this.cfg.project);
      if (mine) this.openChat(mine.id); else this.newChat();
    }
    this.chatList = St.chats.list();
  }

  pinFile(p) {
    const pr = this.project(this.cfg.project);
    if (!pr) return this.say('Pinning is for projects: make one first with /project <name>.', 6000);
    if (!p) return this.openMenu(this.inputPage(`Pin a file to ${pr.name}`, 'Its path. Every model in this project reads it before answering (it\'s re-read each time, so edits show up).', '', (v) => v.trim() && this.pinFile(v.trim())));
    try {
      const f = S.attach(p);
      pr.files = (pr.files || []).filter((x) => x !== f.path).concat(f.path);
      this.saveCfg();
      this.say(`Pinned ${f.name} to ${pr.name}.`);
    } catch (e) { this.say(e.message, 6000); }
  }

  visibleChats() {
    return this.cfg.project ? this.chatList.filter((c) => c.project === this.cfg.project) : this.chatList;
  }

  // ── tidy, the folder-tidying squirrel ─────────────────────────────────────────
  tidyPath() {
    const home = require('os').homedir();
    try { const l = fs.readFileSync(path.join(process.env.TIDY_HOME || path.join(home, '.tidy'), 'launcher'), 'utf8').trim(); if (l && fs.existsSync(l)) return l; } catch { /* not installed that way */ }
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      for (const name of process.platform === 'win32' ? ['tidy.cmd', 'tidy.exe'] : ['tidy']) {
        const f = path.join(dir, name);
        try { if (fs.statSync(f).isFile()) return f; } catch { /* keep looking */ }
      }
    }
    return null;
  }

  openTidy(folder) {
    const exe = this.tidyPath();
    if (!exe) return this.pushPage(this.tidyMenu());
    const { spawnSync } = require('child_process');
    this.ui.suspend(() => spawnSync(exe, folder ? [folder] : [], { stdio: 'inherit', shell: process.platform === 'win32' })).then(() => { this.ui.prev = []; this.dirty(); });
  }

  /** The little tools that use your free models. */
  toolsMenu() {
    const me = [process.execPath, path.join(__dirname, '..', 'bin', 'tot.js')];
    const runTool = (args) => {
      const { spawnSync } = require('child_process');
      this.menu = null;
      this.ui.suspend(() => {
        spawnSync(me[0], [me[1], ...args], { stdio: 'inherit' });
        if (args[0] === 'howto') { process.stdout.write('\n  Press Enter to go back to Tree of Thought.'); spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', 'pause >nul'] : ['-c', 'read _'], { stdio: 'inherit' }); }
      }).then(() => { this.ui.prev = []; this.dirty(); });
    };
    return {
      title: 'Tools',
      note: 'Little helpers that use your free models. They also work straight from the terminal: tot cram, tot howto, tidy.',
      items: [
        { label: 'Tidy a folder', hint: 'tidy', desc: this.tidyPath() ? 'an AI that sorts a folder: plans first, only moves, undo' : 'an AI that sorts a folder (installs it first)', run: () => this.openTidy() },
        { label: 'Make flashcards…', hint: 'tot cram', desc: 'from a file of notes, or a topic', run: () => this.pushPage(Object.assign(this.inputPage('Make flashcards', 'A file of notes (its path, or drag it in), or a topic like "the water cycle".', '', (v) => v.trim() && runTool(['cram', v.trim()])), {})) },
        { label: 'Study my flashcards', hint: 'tot cram', desc: "what's due today", run: () => runTool(['cram']) },
        { label: 'How do I… in the terminal?', hint: 'tot howto', desc: 'the command, explained; runs only if you say so', run: () => this.pushPage(this.inputPage('How do I…', 'Say what you want to do, like "unzip photos.zip" or "find big files here".', '', (v) => v.trim() && runTool(['howto', ...v.trim().split(/\s+/)]))) },
      ],
    };
  }

  tidyMenu() {
    let site = '';
    try { site = fs.readFileSync(path.join(St.home(), 'hub'), 'utf8').trim(); } catch { /* from GitHub */ }
    const win = process.platform === 'win32';
    const url = /^https?:\/\//.test(site) ? `${site.replace(/\/+$/, '')}/tidy/install.${win ? 'ps1' : 'sh'}` : `https://raw.githubusercontent.com/dpatel7-dev/tidy/main/install.${win ? 'ps1' : 'sh'}`;
    const cmd = win ? `irm ${url} | iex` : `curl -fsSL ${url} | sh`;
    return {
      title: 'tidy',
      note: 'tidy is a separate app: an AI that tidies a folder for you. It plans first, only moves things (never deletes), and one key puts everything back. It is not installed yet.',
      items: [
        { label: 'Install tidy now', desc: 'takes a few seconds', run: () => {
          const { spawnSync } = require('child_process');
          this.ui.suspend(() => (win ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { stdio: 'inherit' }) : spawnSync('sh', ['-c', cmd], { stdio: 'inherit', env: { ...process.env, TIDY_HUB: /^https?:/.test(site) ? site : '' } })))
            .then(() => { this.ui.prev = []; this.say(this.tidyPath() ? 'tidy is installed. Tab → Tidy a folder to open it.' : "tidy didn't install. Try Project CLI Access (pca) instead.", 7000); });
        } },
        { label: 'Copy the install command', desc: 'to paste in another terminal', run: () => { copy(cmd, this.ui.output); this.say('Copied.'); } },
      ],
    };
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
      filter: true,
      items: [
        { label: 'New chat', hint: 'ctrl+n', run: () => this.newChat() },
        { label: 'Ask every model at once', hint: 'ctrl+g', desc: 'each answer becomes a branch', run: () => { const text = this.ed.text.trim(); this.ed.clear(); this.grove(text); } },
        { label: 'Ask again', hint: 'ctrl+r', desc: m ? `with ${m.name}` : '', run: () => this.retry() },
        { label: 'Edit my last question', hint: 'ctrl+e', desc: 'grows a new branch', run: () => this.edit() },
        { label: 'Open a chat…', run: () => this.pushPage(this.chatsMenu()) },
        { label: 'Search my chats…', hint: '/find', run: () => this.pushPage(this.findMenu('')) },
        { label: 'Projects…', hint: '/project', desc: this.project(this.cfg.project) ? `in ${this.project(this.cfg.project).name}` : 'instructions, files and chats for long work', run: () => this.pushPage(this.projectsMenu()) },
        { label: 'Attach a file…', hint: '/file', desc: this.files.length ? `${this.files.length} attached` : 'or drag one into this window', run: () => this.pushPage(this.inputPage('Attach a file', 'The path of a text or code file. It goes with your next question.', '', (v) => v.trim() && this.attachFile(v.trim()))) },
        { label: 'Save the last answer to a file', hint: '/save', run: () => this.saveAnswer('') },
        { label: 'Plant a model…', desc: 'add one to your garden', run: () => this.pushPage(this.plantMenu('')) },
        { label: 'Set up free AI…', hint: '/free', desc: `${F.SERVICES.filter((x) => this.keys[x.id]).length} of ${F.SERVICES.filter((x) => !x.extra).length} free services · a minute each`, run: () => this.pushPage(this.freeMenu()) },
        { label: 'Models on this computer…', hint: '/local', desc: 'optional: works offline, uses your computer', run: () => this.pushPage(this.localMenu()) },
        ...(m ? [{ label: `Remove ${m.name}`, run: () => this.uproot() }] : []),
        { label: 'API keys…', desc: Object.keys(this.keys).length ? Object.keys(this.keys).join(', ') : 'none yet', run: () => this.pushPage(this.keysMenu()) },
        { label: 'Instructions for every model…', desc: this.cfg.system ? 'set' : 'none', run: () => this.pushPage(this.systemMenu()) },
        { label: `${this.cfg.thoughts ? 'Hide' : 'Show'} the models' thinking`, run: () => this.command('thoughts') },
        { label: `Stand-ins: ${this.cfg.fallback === false ? 'off' : 'on'}`, desc: 'when a model is busy or over its limit, the next one answers', run: () => this.command('fallback') },
        { label: `${this.cfg.sidebar === false ? 'Show' : 'Hide'} the garden sidebar`, hint: 'ctrl+b', run: () => this.command('sidebar') },
        { label: 'Usage: how much is left today?', hint: '/usage', desc: Me.line() || 'tracks your free services', run: () => this.pushPage(this.usageMenu()) },
        { label: 'Colours…', desc: Th.name(), run: () => this.pushPage(this.themeMenu()) },
        { label: 'Copy the last answer', hint: 'ctrl+y', run: () => this.copyAnswer(false) },
        { label: 'Save this chat as Markdown', run: () => this.exportChat() },
        { label: 'Delete this chat', run: () => this.deleteChat() },
        { label: 'Open the dashboard', desc: 'chats as trees, garden, keys, models on this computer', run: () => this.dashboard() },
        { label: 'Which services work on this network?', desc: 'for school or office Wi-Fi', run: () => this.networkPage() },
        { label: 'Tools…', desc: 'tidy a folder · flashcards · terminal help', run: () => this.pushPage(this.toolsMenu()) },
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

  projectsMenu() {
    const cur = this.project(this.cfg.project);
    const items = [];
    if (cur) {
      items.push(
        { label: `Instructions for ${cur.name}…`, desc: cur.instructions ? A.clip(cur.instructions, 40) : 'none yet', run: () => this.pushPage(this.inputPage(`Instructions for ${cur.name}`, 'What every model should know for this project: what it is, how you like answers, what to avoid.', cur.instructions, (v) => { cur.instructions = v.trim(); this.saveCfg(); this.say('Saved the project instructions.'); })) },
        { label: 'Pin a file…', desc: 'every model reads it first', run: () => this.pushPage(this.inputPage(`Pin a file to ${cur.name}`, 'Its path (or drag the file into this window). It is re-read before every answer.', '', (v) => v.trim() && this.pinFile(v.trim()))) },
        ...(cur.files || []).map((f) => ({ label: `  ${path.basename(f)}`, desc: 'pinned · enter unpins', run: () => { cur.files = cur.files.filter((x) => x !== f); this.saveCfg(); this.say(`Unpinned ${path.basename(f)}.`); } })),
        { label: 'Rename this project…', run: () => this.pushPage(this.inputPage('New name', '', cur.name, (v) => { if (v.trim()) { cur.name = v.trim().slice(0, 40); this.saveCfg(); } })) },
        { label: 'Back to everyday chats', desc: 'leave the project', run: () => this.switchProject(null) },
        { label: `Delete ${cur.name}`, desc: 'its chats are kept', run: () => { this.cfg.projects = this.projects.filter((p) => p !== cur); for (const c of St.chats.list().filter((x) => x.project === cur.id)) { const ch = St.chats.load(c.id); if (ch) { ch.project = null; St.chats.save(ch); } } this.chat.project = null; this.switchProject(null); this.say(`Deleted the project. Its chats are with your everyday chats.`); } },
      );
    }
    for (const p of this.projects) if (p !== cur) items.push({ label: p.name, desc: `${St.chats.list().filter((c) => c.project === p.id).length} chats${p.files && p.files.length ? ` · ${p.files.length} pinned` : ''}`, run: () => this.switchProject(p.id) });
    items.push({ label: 'New project…', desc: 'its own instructions, files and chats', run: () => this.pushPage(this.inputPage('Name the project', 'Like "Science fair", "Contrail" or "College essays".', '', (v) => v.trim() && this.switchProject(v.trim()))) });
    return { title: cur ? `Project: ${cur.name}` : 'Projects', note: 'For long work: a project keeps its chats together, and every model in it gets the project\'s instructions and pinned files.', items };
  }

  findMenu(query) {
    const page = { title: 'Search your chats', filter: false, items: [], note: '' };
    if (!query) return this.inputPage('Search your chats', 'Words to look for in every chat (questions and answers).', '', (v) => v.trim() && this.openMenu(this.findMenu(v.trim())));
    const hits = St.chats.search(query);
    page.note = hits.length ? `${hits.length} chat${hits.length === 1 ? '' : 's'} with "${query}"` : `No chat has "${query}" in it.`;
    page.items = hits.slice(0, 200).map((h) => ({ label: h.title, desc: `…${h.hit}…`, run: () => { this.cfg.project = h.project || null; this.openChat(h.id); this.saveCfg(); this.chatList = St.chats.list(); } }));
    return page;
  }

  /** Usage: what each free service has left today, and what to do about it. */
  usageMenu() {
    const sum = Me.summary(this.garden, this.keys);
    const tips = Me.tips(sum, this.keys);
    const n = (x) => (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : String(x));
    const items = sum.rows.map((r) => {
      const left = r.left === null ? (r.perMinute ? `${r.perMinute} a minute, no daily limit` : 'no published limit') : `${r.exact ? '' : '~'}${r.left} left`;
      const mark = r.state === 'out' ? '✗ ' : r.state === 'low' ? '! ' : '✓ ';
      return { label: mark + r.name, desc: `${r.asked} asked today · ${n(r.tokens)} tokens · ${left}${r.refill && r.state !== 'ok' ? ` · refills ${Me.when(r.refill)}` : ''}`, plant: null, run: () => {} };
    });
    const rest = S.usage(St.chats.all()).filter((r) => !F.SERVICES.some((sv) => r.model.startsWith(sv.id + ':')));
    for (const r of rest.slice(0, 8)) items.push({ label: '  ' + r.name, desc: `${r.answers} answers in all · ${n(r.in + r.out)} tokens${r.cost ? ` · $${r.cost.toFixed(4)}` : ''}`, run: () => {} });
    items.push({ label: 'Set up more free AI…', desc: 'more services = more room every day', run: () => this.pushPage(this.freeMenu()) });
    const week = sum.week.map((d) => d.asked);
    const max = Math.max(1, ...week);
    const spark = week.map((v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((v / max) * 7))]).join('');
    return {
      title: 'Usage',
      note: (sum.rows.length ? `${Me.line(sum)}.  last 7 days ${spark}\n` : '') + (tips.length ? tips.join('\n') : ''),
      items,
    };
  }

  /** Free AI in the cloud: one page, a line per service, a minute each. */
  freeMenu() {
    const watching = F.canWatch();
    const page = {
      title: 'Set up free AI',
      note: 'Free accounts with powerful models that run in the cloud (not on your computer). Pick one, make a free key on the page that opens, and click Copy: ' + (watching ? 'Tree of Thought notices by itself.' : 'then paste it here.') + ' The more you add, the more you can ask each day; Auto (free) spreads questions across them.',
      items: [],
    };
    const fill = () => {
      page.items = F.status(this.keys).map((sv) => ({
        label: `${sv.done ? '✓' : ' '} ${sv.name}${sv.extra ? '  (extra)' : ''}`,
        desc: sv.done ? `done · ${sv.allowance}` : `${sv.good} · ${sv.allowance}`,
        keep: true,
        run: () => this.pushPage(this.keyStep(sv, () => fill())),
      }));
    };
    fill();
    page.refresh = fill;
    return page;
  }

  /** One service: open its key page, then wait for the key (copied or pasted). */
  keyStep(sv, after) {
    const page = this.inputPage(`${sv.name}: make a free key`, '', '', (v) => {
      if (stop) stop();
      if (v.trim()) this.plantFree(sv.id, v.trim()).then(after, () => {});
    }, true);
    page.input.stay = true;
    const steps = sv.steps.map((x, i) => `${i + 1}. ${x}`).join('\n');
    const watching = F.canWatch();
    page.note = `Opening ${sv.keyUrl.replace(/^https:\/\//, '')} in your browser. Needs ${sv.needs}.\n${steps}\n${watching ? 'Tree of Thought is watching the clipboard (only on this step): copy the key and it\'s added. Or paste it below.' : 'Then paste it below and press Enter.'}`;
    open(sv.keyUrl);
    let stop = null;
    if (watching) {
      stop = F.watchClipboard(sv.id, (key) => {
        stop = null;
        if (this.menu && this.menu.stack[this.menu.stack.length - 1] === page) this.menuBack();
        this.plantFree(sv.id, key).then(() => { after(); this.dirty(); }, () => {});
      });
      page.onLeave = () => { if (stop) stop(); };
    }
    return page;
  }

  /** Optional: a model that runs on this computer (through Ollama). Works offline; uses your computer. */
  localMenu() {
    const { memoryGB, picks } = S.localPicks();
    const page = { title: 'Models on this computer', loading: true, items: [], note: 'Checking for Ollama…' };
    P.ollamaModels().then((have) => {
      page.loading = false;
      if (!have) {
        page.note = 'Optional. Models that run on your own computer work without internet and keep everything private, but they use your computer and are smaller than the cloud ones (Tab → Set up free AI). They need Ollama, a free app:';
        page.items = [
          { label: '1. Download Ollama', desc: 'ollama.com/download (opens your browser)', keep: true, run: () => { open('https://ollama.com/download'); this.say('Install it like any app, open it once, then come back here and pick step 2.', 8000); } },
          { label: '2. I installed it: check again', keep: true, run: () => { const fresh = this.localMenu(); this.menu.stack[this.menu.stack.length - 1] = fresh; } },
        ];
      } else {
        const got = new Set(have.map((m) => m.name));
        page.note = `This computer has about ${memoryGB} GB of memory. These fit it best (the first is the pick). Downloading takes a while once; after that they're instant, free and unlimited.`;
        page.items = picks.map((p, i) => ({
          label: `${got.has(p.name) ? '✓ ' : ''}${p.name}${i === 0 ? '  (best fit)' : ''}`, desc: `${p.about} · about ${p.gb} GB`, plant: Pl.plantFor({ id: p.name, provider: 'ollama' }),
          run: () => this.pullLocal(picks.slice(i).map((x) => x.name), got),
        }));
        if (have.length) page.items.push({ label: `Already downloaded: ${have.length}`, desc: 'plant them from Tab → Plant a model', run: () => this.pushPage(this.plantMenu('')) });
      }
      this.dirty();
    });
    return page;
  }

  /** Download the first of `names` that works, plant it and switch to it. */
  async pullLocal(names, have = new Set()) {
    for (const name of names) {
      if (have.has(name)) return this.plantLocal(name);
      try {
        this.pulling = { name, pct: 0 };
        this.say(`Downloading ${name}… you can keep chatting meanwhile.`, 4000);
        await P.ollamaPull(name, { onProgress: (p) => { if (p.total) this.pulling = { name, pct: Math.round((100 * p.done) / p.total) }; this.dirty(); } });
        this.pulling = null;
        return this.plantLocal(name);
      } catch (e) {
        this.pulling = null;
        if (!/does not exist|not found|404|manifest/i.test(e.message)) return this.say(e.message, 9000);
        // that name is gone: try the next one
      }
    }
    this.say("Couldn't download any of those. Pick another from ollama.com/library and use: tot pull <name>", 9000);
  }

  plantLocal(name) {
    const m = { provider: 'ollama', id: name, name };
    let i = this.garden.findIndex((g) => keyOf(g) === keyOf(m));
    if (i < 0) { this.garden.push(m); this.cfg.garden = this.garden; i = this.garden.length - 1; }
    this.pickModel(i);
    this.cursor = { kind: 'model', i };
    this.say(`${name} is ready: free, unlimited, and nothing leaves this computer.`, 7000);
  }

  helpMenu() {
    const rows = [
      ['Enter', 'ask'], ['Alt+Enter', 'new line'], ['↑ ↓', 'pick a model or a chat'], ['← →', 'flip between branches (other answers)'],
      ['Ctrl+G', 'ask every model in your garden at once'], ['Ctrl+R', 'ask again'], ['Ctrl+E', 'edit your last question (new branch)'],
      ['Ctrl+Y', 'copy the last answer'], ['Ctrl+N', 'new chat'], ['Esc', 'stop an answer'], ['PgUp PgDn', 'scroll'], ['Tab', 'this menu'],
      ['Ctrl+B', 'hide or show the garden sidebar'],
      ['/free', 'set up free AI in the cloud (a minute per service)'], ['/usage', "what's left today on each free service"],
      ['/file path', 'attach a file to your next question (or drag it in)'], ['/project name', 'switch to (or make) a project'], ['/pin path', 'pin a file to the project'],
      ['/save', 'save the last answer to a file (/save code x.py: just its code)'], ['/find words', 'search every chat'], ['/local', 'optional: a model on this computer'],
      ['/tidy', 'open tidy, the folder-tidying AI'],
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
      if (k.name === 'return') { const v = ed.text; this.menuBack(); page.input.done(v); if (this.menu && !page.input.stay) this.menu = null; return; }
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
    const gone = this.menu.stack.pop();
    if (gone && gone.onLeave) gone.onLeave();
    const under = this.menu.stack[this.menu.stack.length - 1];
    if (under && under.refresh) under.refresh();
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
        case 'b': this.command('sidebar'); break;
        case 'j': this.ed.insert('\n'); break;
        default: this.editKey(this.ed, s, k);
      }
      return this.dirty();
    }
    switch (k.name) {
      case 'return': if (k.meta) this.ed.insert('\n'); else if (empty && !this.garden.length) this.openMenu(this.freeMenu()); else if (empty && this.cursor.kind === 'add') this.openMenu(this.plantMenu('')); else if (empty && this.cursor.kind === 'new') this.newChat(); else this.send(); break;
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
    for (const c of this.visibleChats().slice(0, 30)) out.push({ kind: 'chat', id: c.id });
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
    const side = W >= 72 && this.cfg.sidebar !== false;
    const sideW = side ? Math.max(26, Math.min(34, Math.floor(W * 0.3))) : 0;
    this.sideW = sideW;
    const paneW = side ? W - sideW - 4 : W - 2;
    const editor = this.menu ? null : this.ed.layout(paneW - 4, Math.min(6, Math.max(1, Math.floor(H / 5))));
    const inputH = editor ? editor.lines.length : 1;
    const bodyH = H - 4 - inputH;

    // title bar
    const m = this.model();
    const plant = m ? Pl.plantFor(m) : 'sprout';
    const pr = this.project(this.chat.project);
    const title = (m ? A.paint(Pl.glyph(plant) + ' ', { fg: Pl.color(plant) }) + A.paint(m.name, { bold: true }) + Th.dim(' · ' + whoText(m)) : Th.dim('no model yet')) + (pr ? Th.blossom('  ▸ ' + pr.name) : '');
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
      const ph = this.jobs.size ? 'growing an answer… (esc to stop)'
        : this.files.length ? `Ask about ${this.files.map((f) => f.name).join(', ')}…`
          : m ? `Ask ${F.isAuto(m) ? 'anything' : m.name}…  (tab for the menu)` : 'Press Enter to set up free AI, or paste a key';
      return ' ' + lead + Th.faint(ph);
    }
    return ' ' + lead + text;
  }

  hintLine(W) {
    const t = Th.t();
    if (this.flash) return ' ' + A.paint(A.clip(this.flash.text, W - 2), { fg: t.sun });
    const job = this.jobs.size;
    if (!this.menu && this.pulling) return ' ' + spread(Th.dim(`downloading ${this.pulling.name}: ${this.pulling.pct}%  `) + A.paint(bar(this.pulling.pct / 100, 20), { fg: t.leaf }), Th.dim(`v${pkg.version}`) + ' ', W - 1);
    if (!this.menu && !job && this.files.length) return ' ' + Th.dim(A.clip(`attached: ${this.files.map((f) => f.name).join(', ')} · /unattach removes · Enter asks`, W - 2));
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

    // ── the garden: one or two lines per model, a small plant icon each ──
    const gap = (l, r) => spread(l, r, w - 2);
    out.push(' ' + gap(Th.leaf('Garden', { bold: true }), Th.faint(this.garden.length ? String(this.garden.length) : '')));
    if (this.garden.some(F.isAuto)) {
      if (!this.meterAt || Date.now() - this.meterAt > 15000) { this.meterAt = Date.now(); try { this.meterLine = Me.line(Me.summary(this.garden, this.keys)); } catch { this.meterLine = ''; } }
      if (this.meterLine) out.push(' ' + Th.faint(A.clip(this.meterLine.replace(/^today: /, 'today '), w - 2)));
    }
    out.push('');
    if (!this.garden.length) {
      out.push(Th.dim('  Nothing planted yet.'));
      out.push(Th.dim('  Press Enter to set up'));
      out.push(Th.dim('  free AI in a minute.'));
      out.push('');
    }
    this.garden.forEach((m, i) => {
      const row = { kind: 'model', i };
      const plant = Pl.plantFor(m);
      const chosen = i === (this.cfg.current || 0);
      const here = isCur(row);
      const col = Pl.color(plant);
      const edge = chosen ? A.paint('▌', { fg: col }) : here ? Th.leaf('›') : ' ';
      const busy = [...this.jobs.values()].some((j) => keyOf(j.model) === keyOf(m));
      const name = A.paint(A.clip(m.name, w - 7), chosen ? { bold: true, fg: col } : { fg: here ? t.leaf : t.paper.fg });
      const free = m.provider === 'ollama' || m.free || /:free$/.test(m.id) || F.isAuto(m);
      const who = F.isAuto(m) ? 'picks a free model' : whoText(m).replace(' · via ', ' · ').replace(' · on this computer', ' · this computer');
      mark(row);
      out.push(edge + ' ' + A.paint(Pl.glyph(plant), { fg: col }) + ' ' + name + (busy ? ' ' + Th.sun('•') : ''));
      mark(row);
      out.push((chosen ? A.paint('▌', { fg: col }) : ' ') + '   ' + Th.faint(A.clip(who + (free && !F.isAuto(m) && m.provider !== 'ollama' ? ' · free' : ''), w - 6)));
    });
    { const row = { kind: 'add' }; mark(row); out.push((isCur(row) ? Th.leaf('›') : ' ') + ' ' + Th.leaf('+') + ' ' + Th.dim('Plant a model')); }
    out.push('');
    out.push('');
    // ── chats ──
    const pr = this.project(this.cfg.project);
    out.push(' ' + gap(Th.blossom(pr ? A.clip(pr.name, w - 12) : 'Chats', { bold: true }), Th.faint(pr ? 'project' : '')));
    out.push('');
    for (const c of this.visibleChats().slice(0, 30)) {
      const row = { kind: 'chat', id: c.id };
      const open = c.id === this.chat.id;
      const here = isCur(row);
      const when = Th.faint(require('./tui').ago(c.updated).replace(' ago', ''));
      mark(row);
      out.push((open ? Th.blossom('▌') : here ? Th.blossom('›') : ' ') + ' ' + spread(A.paint(A.clip(c.title, w - 10), open ? { bold: true } : here ? { fg: t.blossom } : {}), when, w - 3));
    }
    { const row = { kind: 'new' }; mark(row); out.push((isCur(row) ? Th.blossom('›') : ' ') + ' ' + Th.blossom('+') + ' ' + Th.dim('New chat')); }

    // keep the highlighted row on screen, and Rowan at the bottom when there's room
    // Rowan sits at the bottom only when everything above still fits
    const room = h - (R.HEIGHT + 1);
    const tree = !this.chat.empty && room >= 10 && out.length <= room;
    let lines = out;
    let first = 0;
    if (out.length > (tree ? room : h)) {
      const want = tree ? room : h;
      const cur = [...rowAt.entries()].filter(([, r]) => isCur(r)).map(([y]) => y);
      const c = cur.length ? cur[cur.length - 1] : 0;
      first = Math.max(0, Math.min(out.length - want, c - Math.floor(want / 2)));
      lines = out.slice(first, first + want);
      if (first + want < out.length) lines[lines.length - 1] = Th.faint('  ↓ more');
      if (first > 0) lines[0] = Th.faint('  ↑ more');
    }
    this.hit = new Map();
    for (const [y, r] of rowAt) if (y >= first && y < first + lines.length) this.hit.set(1 + y - first, r);
    if (tree) {
      while (lines.length < room) lines.push('');
      lines.push('');
      for (const l of this.rowan(bg)) lines.push(' '.repeat(Math.max(0, Math.floor((w - R.WIDTH) / 2))) + l);
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
        for (const f of n.files || []) all.push('  ' + Th.faint('+ ') + Th.dim(f.name) + Th.faint(`  ${size(f.bytes || (f.text || '').length)} attached`));
        continue;
      }
      const plant = Pl.plantFor({ id: String(n.model || '').split(':').slice(1).join(':'), provider: n.provider, name: n.name });
      const took = n.took ? Th.faint(`  ${(n.took / 1000).toFixed(n.took < 10000 ? 1 : 0)}s`) : '';
      all.push(' ' + A.paint(Pl.glyph(plant) + ' ', { fg: Pl.color(plant) }) + A.paint(this.nameOf(n.model, n), { bold: true, fg: Pl.color(plant) }) + took + pos);
      if (n.note) for (const l of Md.plain(n.note, inner)) all.push('  ' + Th.faint(l));
      if (n.trimmed) all.push('  ' + Th.faint(`(this chat is long: the ${n.trimmed} oldest messages after your first were left out so it fits)`));
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
    const title = [center(Th.leaf('Tree of Thought', { bold: true }), w - 1), center(Th.dim('many minds, one garden. every answer is a branch.'), w - 1)];
    const body = [];
    if (m) {
      const plant = Pl.plantFor(m);
      const info = [
        A.paint(Pl.glyph(plant), { fg: Pl.color(plant) }) + ' ' + A.paint(m.name, { bold: true, fg: Pl.color(plant) }),
        '  ' + Th.dim(F.isAuto(m) ? 'picks a free model for each question' : whoText(m)),
        '  ' + Th.faint(priceText(m) + ` · ${this.garden.length} model${this.garden.length === 1 ? '' : 's'} in your garden`),
      ];
      const cw = Math.min(w - 4, Math.max(...info.map((x) => A.vwidth(x))));
      const pad = ' '.repeat(Math.max(0, Math.floor((w - 1 - cw) / 2)));
      for (const l of info) body.push(pad + A.clip(l, w - 3));
      body.push('');
      const tips = [['Enter', 'ask'], ['Ctrl+G', 'ask every model at once'], ['← →', 'flip between their answers'], ['/file', 'attach a file (or drag one in)'], ['Tab', 'menu: projects, free models, keys']];
      for (const [k, d] of tips) body.push(center(Th.leaf(k.padEnd(7)) + ' ' + Th.dim(d.padEnd(32)), w - 1));
      body.push('');
      body.push(center(Th.faint('quick question from any terminal: ') + Th.dim('tot what is osmosis?'), w - 1));
    } else {
      const lines = [
        Th.bold('Plant your first models'), '',
        Th.leaf('Free and powerful') + Th.dim(' (in the cloud, not on your computer):'),
        '   Press ' + Th.bold('Enter') + '. Pick a service, make a free key on the page that opens,',
        '   and click Copy. That\'s it: about a minute each.', '',
        Th.leaf('Already have a key?') + Th.dim(' Just paste it here.'), '',
        Th.dim('Claude and GPT need a paid key: Tab → API keys (OpenRouter is the easy one).'),
        Th.dim('Is a site blocked where you are? Tab → Which services work on this network?'),
      ];
      const cw = Math.max(...lines.map((x) => A.vwidth(x)));
      const pad = ' '.repeat(Math.max(0, Math.floor((w - 1 - cw) / 2)));
      for (const l of lines) body.push(pad + l);
    }
    // Rowan only when the whole tree fits: never half of one
    const withTree = ['', ...tree.map((l) => center(l, w - 1)), '', ...title, '', ...body];
    const noTree = ['', ...title, '', ...body];
    let all = withTree.length <= h ? withTree : noTree.length <= h ? noTree : body.slice(0, h);
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
      const dot = it.plant ? A.paint(Pl.glyph(it.plant) + ' ', { fg: Pl.color(it.plant) }) : '';
      const label = (on ? Th.leaf('› ', { bold: true }) : '  ') + dot + A.paint(it.label, on ? { bold: true } : {}) + (it.hint ? Th.faint('  ' + it.hint) : '');
      const line = spread(label, Th.dim(A.clip(it.desc || '', Math.max(0, w - A.vwidth(label) - 6))), w - 3);
      out.push(' ' + line);
    });
    if (!items.length) out.push('  ' + Th.dim(page.loading ? 'loading…' : 'nothing matches'));
    return out;
  }
}

module.exports = { App, keyOf, priceText };
