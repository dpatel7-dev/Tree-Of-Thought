'use strict';
// Getting an answer, dependably. Used by the garden and by `tot "question"`.
//
// If the model is busy, over its limit or can't be reached (and hasn't started
// answering), the next model in your garden answers instead - models on this
// computer first, since they have no limits - and you're told who stepped in.
// Long chats are trimmed to what the model can read.

const P = require('./providers');
const S = require('./smart');

/**
 * Resolves with { text, thought, usage, model (who actually answered), trimmed, tried: [{ model, why }] }.
 * onSwitch(nextModel, { model, why }) is called before another model takes over.
 */
async function answer({ model, garden = [], keys = {}, messages, system, signal, onText = () => {}, onThought = () => {}, onSwitch = () => {}, fallback = true, maxTries = 3 }) {
  let m = model;
  const tried = [];
  for (;;) {
    let wrote = false;
    const { messages: fit, trimmed } = S.fitMessages(messages, S.budgetFor(m));
    try {
      const r = await P.chat({
        provider: m.provider, key: keys[m.provider], model: m.id, messages: fit, system, signal,
        onText: (t) => { wrote = true; onText(t); }, onThought,
      });
      return { ...r, model: m, trimmed, tried };
    } catch (e) {
      if (!fallback || wrote || !S.retryable(e) || (signal && signal.aborted)) { e.tried = tried; throw e; }
      S.rest(m);
      tried.push({ model: m, why: S.whyShort(e), error: e.message });
      const next = tried.length < maxTries ? S.fallbacks(garden, model, tried.map((x) => x.model))[0] : null;
      if (!next) { e.tried = tried; throw e; }
      onSwitch(next, tried[tried.length - 1]);
      m = next;
    }
  }
}

/** "Claude hit its limit, so Gemma answered" */
function switchNote(tried, who) {
  if (!tried || !tried.length) return '';
  const names = tried.map((t) => `${t.model.name} ${t.why}`);
  return `${names.join(', and ')}, so ${who.name} answered instead.`;
}

module.exports = { answer, switchNote };
