# 🌳 Tree of Thought

**Many AI models in one terminal garden. Every answer is a branch.**

Tree of Thought (`tot`) is a full-screen terminal chat for AI models — the same
look and feel as [gossip](https://github.com/dpatel7-dev/gossip), grown for
talking to models instead of people. Your models live in a **garden** on the
left, each with its own little plant. Ask one, or ask them **all at once** and
flip between their answers. Edit a question and the old conversation stays:
it becomes a branch of the tree. Rowan, the tree in the corner, thinks along
with you, and blossoms when an answer is done.

```
╭─ tree of thought ─────────┬─ ✿ Claude … · OpenRouter ─────────────────────╮
│ GARDEN  8                 │  you  3:44 PM                                 │
│▌✿✿ Claude …               │   what's a good name for a cat?               │
│ ✿✿ GPT …                  │                                               │
│ ✿✿ Gemini …               │  ✿ GPT …  0.8s  ‹ 2 of 8 ›                    │
│ + Plant a model           │   How about **Pixel**? …                      │
│ CHATS                     │                                               │
│ › name a cat     just now │   branches: Claude ✓ · GPT ✓ · Gemini ✓  ← →  │
│ + New chat         [tree] ├───────────────────────────────────────────────┤
│                           │ › Ask GPT …                                   │
╰───────────────────────────┴───────────────────────────────────────────────╯
```

## Install

macOS and Linux:

```sh
curl -fsSL https://djp7.pythonanywhere.com/tot/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://djp7.pythonanywhere.com/tot/install.ps1 | iex
```

(Or straight from GitHub: `curl -fsSL https://raw.githubusercontent.com/dpatel7-dev/Terminal-Of-Though-ToT-/main/install.sh | sh`.)
Nothing to set up beforehand: if you don't have Node.js 18+, the installer puts a private copy inside `~/.tot`.

## Plant your first models

You need a key from at least one AI service. The easy one is **OpenRouter** —
one key reaches Claude, GPT, Gemini, Grok, DeepSeek, Llama, Mistral, Qwen and
hundreds more:

1. Make a key at <https://openrouter.ai/keys> (add a few dollars of credit, or use its free models).
2. Run `tot`, press **Tab → API keys → OpenRouter**, and paste it.
   (Or in your terminal: `tot key openrouter sk-or-…`)
3. Your garden fills with the strongest recent model from each maker.

Free options: **Google AI Studio** and **Groq** have free tiers, and
**[Ollama](https://ollama.com)** runs models on your own computer for nothing —
if Ollama is running, Tree of Thought finds it by itself.

| Service | Key from |
| --- | --- |
| OpenRouter | <https://openrouter.ai/keys> |
| OpenAI | <https://platform.openai.com/api-keys> |
| Anthropic | <https://console.anthropic.com/settings/keys> |
| Google AI Studio | <https://aistudio.google.com/apikey> |
| Groq | <https://console.groq.com/keys> |
| Hugging Face | <https://huggingface.co/settings/tokens> |
| Ollama | no key — <https://ollama.com/download> |

Keys stay on your computer, in `~/.tot/keys.json` (readable only by you).

## Keys

| Key | What it does |
| --- | --- |
| `Enter` | Ask (Alt+Enter for a new line) |
| `↑` `↓` | Pick a model from your garden, or a chat |
| `Ctrl+G` | **Ask every model in your garden at once** — each answer is a branch |
| `←` `→` | Flip between branches (the other answers) |
| `Ctrl+E` | Edit your last question — it grows a new branch, the old one stays |
| `Ctrl+R` | Ask again with the current model |
| `Ctrl+Y` | Copy the last answer (`/copy code` copies just its code) |
| `Ctrl+N` | New chat |
| `Esc` | Stop an answer |
| `PgUp` `PgDn` / wheel | Scroll |
| `Tab` | The menu: models, keys, colours, instructions, chats |

Commands work too: `/model gemini`, `/add`, `/key openrouter …`, `/system Answer briefly.`,
`/thoughts` (show what thinking models are thinking), `/theme meadow`, `/export`, `/help`.

## From the shell

```sh
tot ask "explain recursion like I'm five"
tot ask -m gemini "and in one sentence?"
git diff | tot ask "review this change"
tot garden          # your models
tot models claude   # every model your keys can use
tot keys            # which keys are saved
tot update          # newest version
tot uninstall       # remove it (--all also deletes chats and keys)
```

## Colours

`grove` (dark forest, the default) · `meadow` (light) · `autumn`.
Tree of Thought paints its own background, so it looks the same in every terminal,
and gives your terminal its own colours back when you leave.

## Every model gets a plant

Maple, fern, tulip, lotus, cactus, mushroom, lavender, bamboo, pine, moonflower,
sunflower, rose, acorn (models on your own computer) and sprout (everyone else).
They're original pixel drawings, chosen by the model's name — not anyone's logo.

## Part of a family

- [gossip](https://github.com/dpatel7-dev/gossip) — end-to-end encrypted terminal chat
- [pigeon](https://github.com/dpatel7-dev/pigeon) — move files between your devices
- [Project CLI Access](https://github.com/dpatel7-dev/Project-CLI-Access) — one command to open them all

Development: `npm test` (no dependencies; Node 18+). `node dev/fake-ai.js 8787` runs a pretend AI
service; point Tree of Thought at it with `TOT_URL_OPENROUTER=http://127.0.0.1:8787`.
