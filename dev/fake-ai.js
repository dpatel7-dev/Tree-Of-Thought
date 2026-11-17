'use strict';
// A pretend AI service for tests: OpenAI-style (/models, /chat/completions)
// and Anthropic-style (/messages), streaming answers word by word.
//   node dev/fake-ai.js 8787   (then TOT_URL_OPENROUTER=http://127.0.0.1:8787)

const http = require('http');

const NOW = Math.floor(Date.now() / 1000);
const MODELS = [
  ['anthropic/claude-test-opus', 'Anthropic: Claude Test Opus', 15, 75, 0],
  ['anthropic/claude-test-haiku', 'Anthropic: Claude Test Haiku', 1, 5, 10],
  ['openai/gpt-test', 'OpenAI: GPT Test', 5, 20, 3],
  ['google/gemini-test-pro', 'Google: Gemini Test Pro', 2, 12, 5],
  ['deepseek/deepseek-test', 'DeepSeek: DeepSeek Test', 0.3, 1.2, 2],
  ['x-ai/grok-test', 'xAI: Grok Test', 3, 15, 4],
  ['meta-llama/llama-test-400b', 'Meta: Llama Test 400B', 0.2, 0.6, 30],
  ['mistralai/mistral-test-large', 'Mistral: Mistral Test Large', 2, 6, 8],
  ['qwen/qwen-test-max', 'Qwen: Qwen Test Max', 1.6, 6.4, 6],
  ['openai/gpt-test:free', 'OpenAI: GPT Test (free)', 0, 0, 3],
  ['google/gemini-test-image', 'Google: Gemini Test Image', 1, 30, 1],
].map(([id, name, pin, pout, daysAgo]) => ({
  id, name, created: NOW - daysAgo * 86400, context_length: 200000,
  pricing: { prompt: String(pin / 1e6), completion: String(pout / 1e6) },
  architecture: { output_modalities: /image/.test(id) ? ['image'] : ['text'] },
}));

const OLLAMA = ['llama-test:3b'];

// what a free service's key sees (groq, nvidia, google keys in tests)
const FREE_MODELS = ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'qwen/qwen3-32b', 'llama-3.3-70b-versatile', 'whisper-large-v3',
  'deepseek-ai/deepseek-v3.2', 'gemini-9.9-flash', 'gemini-9.9-pro', 'gemini-9.9-flash-image', 'text-embedding-x', 'meta-llama/llama-guard-4']
  .map((id, i) => ({ id, created: NOW - i * 1000, context_length: 131072 }));
const asked = {};

function answerFor(model, question) {
  if (/fail/i.test(question)) return null;
  const who = model.split('/').pop();
  return `**${who}** here. You asked: _${question.slice(0, 60)}_\n\n- first point\n- second point\n\n\`\`\`js\nconsole.log("hi from ${who}");\n\`\`\`\n\nThat's my answer.`;
}

function start(port = 0, { delay = 8 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const auth = req.headers.authorization || req.headers['x-api-key'] || '';
      if (/bad-key/.test(auth)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid API key' } })); }
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: /gsk_|nvapi-|AIza/.test(auth) ? FREE_MODELS : MODELS })); }
      // a pretend Ollama too
      if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: OLLAMA.map((name) => ({ name, size: 2e9, details: { family: 'llama' } })) })); }
      if (req.url === '/api/pull') {
        const want = JSON.parse(body || '{}').model;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (/nope/.test(want)) return res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n');
        for (const done of [0, 5e8, 1e9]) { res.write(JSON.stringify({ status: 'pulling layer', total: 1e9, completed: done }) + '\n'); await new Promise((r) => setTimeout(r, delay)); }
        OLLAMA.push(want);
        return res.end(JSON.stringify({ status: 'success' }) + '\n');
      }
      if (req.url === '/api/delete') { const want = JSON.parse(body || '{}').model; const i = OLLAMA.indexOf(want); if (i >= 0) OLLAMA.splice(i, 1); res.writeHead(200); return res.end(); }
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { /* bad */ }
      seen.push({ url: req.url, body: j, headers: req.headers });
      const msgs = j.messages || [];
      const q = String((msgs.filter((m) => m.role === 'user').pop() || {}).content || '');
      if (/busy/i.test(q) && /opus/i.test(j.model || '')) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day' } })); }
      if (/limit me/i.test(q) && /gpt-oss/i.test(j.model || '')) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '1000' }); return res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests per day (RPD): Limit 1000, Used 1000' } })); }
      asked[j.model] = (asked[j.model] || 0) + 1;
      const sys = String((msgs.find((m) => m.role === 'system') || {}).content || j.system || '');
      const text = /flashcards/i.test(sys) ? JSON.stringify({ title: 'Cells', cards: [{ q: 'What is the powerhouse of the cell?', a: 'The mitochondria.' }, { q: 'What controls the cell?', a: 'The nucleus.' }, { q: 'What surrounds the cell?', a: 'The cell membrane.' }] })
        : /terminal command|terminal commands/i.test(sys) ? JSON.stringify(/delete/.test(q) ? { command: 'rm -rf ./old', what: 'Deletes the old folder.', parts: [{ text: 'rm', means: 'remove' }], risk: 'safe' } : { command: 'unzip photos.zip -d photos', what: 'Unzips photos.zip into a folder called photos.', parts: [{ text: 'unzip', means: 'opens a zip' }, { text: '-d photos', means: 'into the folder photos' }], risk: 'safe' })
          : answerFor(j.model || '', q);
      if (text === null) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'the model fell over' } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': String(1000 - asked[j.model]), 'x-ratelimit-reset-requests': '1m26.4s' });
      const anthropic = req.url.endsWith('/messages');
      const words = text.split(/(?<= )/);
      if (anthropic) res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 12 } } })}\n\n`);
      else res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'Let me think about it. ' } }] })}\n\n`);
      for (const w of words) {
        if (res.destroyed) return;
        res.write(anthropic
          ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: w } })}\n\n`
          : `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, delay));
      }
      if (anthropic) res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: words.length } })}\n\n`);
      else res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: words.length } })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, seen })));
}

module.exports = { start, MODELS, FREE_MODELS, asked };

if (require.main === module) start(Number(process.argv[2]) || 8787, { delay: 40 }).then((f) => console.log(`fake AI service on ${f.url}`));
