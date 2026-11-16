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
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: MODELS })); }
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
      const text = answerFor(j.model || '', q);
      if (text === null) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'the model fell over' } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
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

module.exports = { start, MODELS };

if (require.main === module) start(Number(process.argv[2]) || 8787, { delay: 40 }).then((f) => console.log(`fake AI service on ${f.url}`));
