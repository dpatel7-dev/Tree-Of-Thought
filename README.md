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

(Or straight from GitHub: `curl -fsSL https://raw.githubusercontent.com/dpatel7-dev/Tree-Of-Thought/main/install.sh | sh`.)
Nothing to set up beforehand: if you don't have Node.js 18+, the installer puts a private copy inside `~/.tot`.

## Quick questions

Don't need the whole garden? Just ask from any terminal:

```sh
tot what is osmosis?
tot -m claude "rewrite this sentence to sound friendlier: ..."
cat notes.md | tot summarise this in five bullet points
```

The answer prints right there. Ask a follow-up, or press Enter to finish. Every
quick question is saved as a chat, so it's in your garden later. The dashboard
has the same quick-question bar at the top.

## Free AI, set up in a minute

Lots of AI services give you a free allowance once you make a free account and
a key (no card): Groq, NVIDIA, Google Gemini, Mistral, OpenRouter, Ollama Cloud
and more (the [awesome-freellm-apis](https://github.com/open-free-llm-api/awesome-freellm-apis)
list keeps track of them). The models run on their computers, not yours, and
include big ones like DeepSeek, Kimi K2, GPT-OSS 120B, Qwen3 Coder, Gemini Flash
and Mistral Large.

```sh
tot free
```

For each service, a page opens; sign in, make a key and click **Copy**. Tree
of Thought notices the copied key by itself (or paste it), checks it, and
plants that service's best free models. You can also just paste a key into
`tot` (or run `tot gsk_…`), or use the dashboard's **free AI** tab.

**Auto (free)** becomes your default: for every question it picks the best
free model that still has room today, a fast one for quick questions and a
coding one for code, and moves on when one runs out. Each service has its own
limits, but together they add up to a lot. (Claude and GPT themselves aren't
free anywhere; for those you need a paid key, under **Tab → API keys**.)

One account per service: making extra accounts to get more free use breaks
their rules (and Groq, for one, counts limits per organisation anyway).

### Usage

`tot usage` (or **Tab → Usage**, or the dashboard's **usage** tab) shows what
each free service has left today, using the numbers the services send back
after every answer, when it refills, which models are resting after hitting a
limit, the last seven days, and tips like which service to add next. The
garden shows a one-line summary too ("today: 23 asked · plenty left").

### Models on this computer (optional)

`tot local` downloads a model to run on your own computer with
[Ollama](https://ollama.com/download). It works offline and keeps everything
private, but it uses your computer and is smaller than the cloud models.

## Plant your first models

For the big online models you need a key from at least one AI service. The easy one is **OpenRouter** —
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
| Mistral | <https://console.mistral.ai/api-keys> |
| Cerebras | <https://cloud.cerebras.ai> |
| Ollama | no key — <https://ollama.com/download> |
| Other service | any OpenAI-compatible address (set it in the dashboard) |

Keys stay on your computer, in `~/.tot/keys.json` (readable only by you).

### On a school or office network

Some networks block some AI services (or the websites where you get their keys).

- **See what works here:** `tot check` (or **Tab → Which services work on this network?**,
  or the dashboard's **Network check**). It tests every service and its key website.
- **Keys work anywhere:** a key you made at home keeps working on any network where the
  service itself gets through.
- **Models on your own computer need no internet at all:** install
  [Ollama](https://ollama.com/download), then `tot pull llama3.2` (or use **This computer**
  in the dashboard), and plant it in your garden.

## Stand-ins: answers even when a model is busy

If the model you asked is busy, over its limit (free tiers have daily limits),
out of credit or can't be reached, the next model in your garden answers
instead, and you're told who stepped in ("Claude hit its limit, so DeepSeek
answered instead"). Free cloud models are tried first. A model that hit its
daily limit rests until it refills. Turn it off in **Tab →
Stand-ins** or the dashboard's settings.

## For long projects

- **Projects** (`/project Science fair`, or **Tab → Projects**): a project keeps
  its chats together and has its own instructions, and you can **pin files** to
  it (`/pin notes.md`). Every model reads the instructions and pinned files before
  answering, re-reading the files each time so your edits show up.
- **Attach files** to a question: `/file essay.md`, or just drag a file into the
  window. Text and code files up to 200 KB.
- **Save an answer**: `/save` writes the last answer to a Markdown file;
  `/save code app.py` saves just its code.
- **Search everything**: `/find mitochondria` searches every question and answer.
- **Long chats keep working**: when a chat gets longer than a model can read,
  the oldest messages (after your first) are left out, and you're told.
- **Usage**: `/usage` or `tot usage` shows how much you've used each model.
- **Ctrl+B** hides the garden for more room.
- **Tools** (Tab → Tools): little helpers that use your free models:
  - `tot cram notes.md` makes flashcards from your notes (or a topic) and quizzes
    you right in the terminal, bringing cards back less often as you learn them.
  - `tot howto unzip photos.zip` gives the terminal command for what you want and
    explains every part. Nothing runs unless you say so; risky commands need a
    typed "yes", and a few (wiping disks, deleting your home folder) are refused.
  - [tidy](https://github.com/dpatel7-dev/tidy), the AI that tidies a folder.

## The dashboard

`tot dashboard` (or **Tab → Open the dashboard**) opens your garden in the browser:

- **Ask**: a quick-question bar at the top (answers stream in, and are saved as chats).
- **Chats** drawn as trees: every dot is a message, click one to read its branch. Press `/` to search every chat.
- **Garden**: plant, uproot and reorder models, with every model your keys can reach.
- **Free models**: the best fits for this computer, one click to download and plant.
- **Projects**: instructions and pinned files for each project.
- **Usage**, **Keys** (it never shows them back), **Network check** and **Settings**.

It runs only on your computer, and tot picks up whatever you change there right away.

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
tot "explain recursion like I'm five"
tot -m gemini "and in one sentence?"
git diff | tot review this change
tot -f essay.md "what's my weakest paragraph?"
tot free            # a free model that runs on this computer
tot usage           # how much you've used each model
tot garden          # your models
tot models claude   # every model your keys can use
tot keys            # which keys are saved
tot dashboard       # chats, garden, keys and settings in the browser
tot check           # which services this network lets through
tot pull llama3.2   # download a model to run on this computer (with Ollama)
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
