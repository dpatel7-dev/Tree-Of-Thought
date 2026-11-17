'use strict';
// Getting an answer, dependably. Used by the garden, `tot "question"`, the
// dashboard and the little tools (cram, howto).
//
// - Auto (free) picks one of your free cloud models for each question: the
//   strongest one with room left (a fast one for quick questions, a coding one
//   for code), using the usage tracker (meter.js).
// - If a model is busy, over its limit or can't be reached (and hasn't started
//   answering), the next one answers instead, and you're told who stepped in.
// - Long chats are trimmed to what the model can read.
// - Every answer is counted, so you can see how much is left (tot usage).

const P = require('./providers');
const S = require('./smart');
const F = require('./free');
const M = require('./meter');

/** What kind of question this is, from the last thing you said. */
function sizeUp(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = String((last && last.content) || '');
  return {
    quick: messages.length <= 2 && text.length < 400 && !/```|\nFile: /.test(text),
    code: /```|\b(code|function|bug|error|exception|python|javascript|typescript|java|c\+\+|rust|html|css|sql|regex|compile|script|stack ?trace)\b/i.test(text),
    long: text.length > 60000,
  };
}

/** Your free cloud models, best first for this question (Auto's choice is the first). */
function rank(garden, keys, kind, s = M.load()) {
  const pool = garden.filter((m) => F.isCloudFree(m) && keys[m.provider]);
  const score = (m) => {
    const tags = m.tags || [];
    let x = (m.power || 5) * 10;
    if (kind.quick && tags.includes('fast')) x += 30; // a quick question wants a quick answer
    if (kind.code && tags.includes('code')) x += 15;
    if (kind.long && tags.includes('long')) x += 40;
    x += M.headroom(m, s) * 25;
    if (M.blocked(m, s)) x -= 1000;
    if (S.isResting(m)) x -= 400;
    return x;
  };
  return pool.map((m, i) => ({ m, i, x: score(m) })).sort((a, b) => b.x - a.x || a.i - b.i).map((r) => r.m);
}

/**
 * Resolves with { text, thought, usage, model (who actually answered), trimmed, tried: [{ model, why }] }.
 * onSwitch(nextModel, { model, why }) is called before another model takes over
 * (and once at the start when Auto picks, with why = null).
 */
async function answer({ model, garden = [], keys = {}, messages, system, signal, onText = () => {}, onThought = () => {}, onSwitch = () => {}, fallback = true, maxTries = 3 }) {
  let queue;
  if (F.isAuto(model)) {
    queue = rank(garden, keys, sizeUp(messages));
    if (!queue.length) throw new P.ApiError('Auto (free) needs free models first. Run: tot free   (or press Tab → Set up free AI). It takes about a minute.');
    onSwitch(queue[0], null);
    maxTries = Math.max(maxTries, 5);
  } else {
    queue = [model, ...(fallback ? S.fallbacks(garden.filter((g) => !F.isAuto(g)), model) : [])];
  }
  const tried = [];
  for (let n = 0; n < queue.length; n++) {
    const m = queue[n];
    if (n > 0 && F.isAuto(model) && M.blocked(m)) continue; // known to be used up: don't even ask
    let wrote = false;
    const { messages: fit, trimmed } = S.fitMessages(messages, S.budgetFor(m));
    try {
      const r = await P.chat({
        provider: m.provider, key: keys[m.provider], model: m.id, messages: fit, system, signal,
        onText: (t) => { wrote = true; onText(t); }, onThought,
      });
      M.record(m, { usage: r.usage, headers: r.headers });
      return { ...r, model: m, trimmed, tried };
    } catch (e) {
      if (e.name !== 'AbortError') M.record(m, { error: e, headers: e.headers });
      const last = n + 1 >= queue.length || tried.length + 1 >= maxTries;
      if ((!fallback && !F.isAuto(model)) || wrote || !S.retryable(e) || (signal && signal.aborted) || last) { e.tried = tried; throw e; }
      S.rest(m);
      tried.push({ model: m, why: S.whyShort(e), error: e.message });
      const next = queue.slice(n + 1).find((x) => !(F.isAuto(model) && M.blocked(x)));
      if (!next) { e.tried = tried; throw e; }
      onSwitch(next, tried[tried.length - 1]);
    }
  }
  throw new P.ApiError('No model could answer right now. Try again in a minute (tot usage shows what is left).');
}

/** "Claude hit its limit, so Gemma answered" */
function switchNote(tried, who) {
  if (!tried || !tried.length) return '';
  const names = tried.map((t) => `${t.model.name} ${t.why}`);
  return `${names.join(', and ')}, so ${who.name} answered instead.`;
}

module.exports = { answer, switchNote, rank, sizeUp };
