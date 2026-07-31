# Ferrum

**A spreadsheet that fills itself in, running on your own computer.**

Each column can ask an AI, run a rule, call a website, ask an app you have connected, or send a
research agent off to find the answer. It runs on your machine, against your own AI account, and
there are no credits to buy.

Eleven kinds of column. Six of them cost nothing at all, and the ones that spend say so everywhere
they appear — because the number you need is the one you get before you press Start, not after.

An open alternative to Clay, Bitscale and Freckle.

```
Node 24  ·  SQLite  ·  React  ·  127.0.0.1 by default  ·  1,000,000+ rows per table
```

This is **v1 alpha** (`1.0.0-alpha.1`). It does the work described below today, but the database
schema and the HTTP API can still change between alpha releases: an upgrade may ask you to migrate
or to start a fresh database. Copy your SQLite file before upgrading, and pin a commit if something
you build depends on it.

---

## Quick start

```bash
git clone https://github.com/athm793/ferrum.git
cd ferrum
npm install

npm start          # the engine, on http://127.0.0.1:4317
npm run web:dev    # the grid, on http://localhost:4318  (second terminal)
```

Open `http://localhost:4318`, make a table, and add a column. To use a hosted AI, paste an
OpenRouter key into Settings. To use a local one, start Ollama or LM Studio and Ferrum will find it.

Your data lives in one SQLite file you can copy, back up or delete. Nothing is uploaded anywhere.

---

## What a column can be

| Column | What it does | Cost |
|---|---|---|
| **Typed in** | A plain value. Paste it, import a CSV, or let a webhook send it. | Free |
| **A rule** | Describe a job in one sentence and Ferrum writes a rule for it. Tidy a value, or decide which rows are worth paying for. | Free, on every row, forever |
| **Read a linked table** | Read a value from the row this row links to. Enrich a company once and every contact reads the same answer. | Free |
| **Count a linked table** | A number about everything on the other side of a link: how many, the total, the most recent. Counted in SQL, not asked of a model. | Free |
| **Wait a while** | Hold each row for a set time before the next column runs. Rows still run concurrently. | Free |
| **Ask the AI** | One question per row, on the model you pick. | One AI call per row |
| **Call a website** | Any web service you have a key for. Ready-made setups for HubSpot, Pipedrive, Attio, Instantly, Smartlead and lemlist. | Billed by whoever you call |
| **Ask a connected app** | An MCP app answers the column. Apps that run on your own computer are free and send nothing anywhere; a research agent can call their tools too. | Free locally, otherwise the app's price |
| **Research agent** | Searches the web and keeps digging, within limits you set. | Capped per row, in dollars |
| **Try one, then the next** | Ordered steps that stop at the first answer good enough to keep, so you pay only for the steps used. Steps are ordinary columns, so email, phone and AI waterfalls are one feature rather than three. | Only the steps it reached |
| **Send it to another table** | Copy rows into another table, turning a list into records. Previewed before it writes, and matched on a key, so running twice updates rather than duplicates. | Free |

### Rules are written once, then locked to what you approved

You describe what a column should do in plain English. Ferrum writes the rule and waits for you to
approve it. Approval is locked to the exact rule you approved: change one character and it stops and
asks again.

If you would rather not deal with a rule at all, there is a filter you build from dropdowns instead,
with 20 tests and nested and/or.

---

## It costs what your AI costs, and nothing more

Ferrum does not sell credits, so it has no reason to let you overspend. The guards below are grouped
by when they act. They are on from the first run unless the line says you have to turn it on or set
a number yourself:

**Before you press Start**

- The price is worked out first, over every row the run will really touch rather than the rows on
  your screen. If a model has no published price, the run does not start.
- Run ten rows first, spread across the whole table, and forecast the rest from what they actually
  cost. With fewer than three usable rows it refuses to forecast.
- Over $25 the Start button stays dead until you type the amount in yourself.

**Rows that never reach a paid column**

- Rows whose inputs have not changed are skipped. Add 300 leads to a table of 12,000 and you pay
  for 300.
- A rule can decide which rows are worth running on, in one pass over the whole table, before any
  paid column starts.
- If your question names a column and that column is empty, the row is dropped before a single word
  is sent.
- The same question asked again reuses the saved answer, from any table, for 30 days.

**Ceilings**

- Every AI cell has a $0.05 limit before you touch a setting, and every cell's web searching is
  capped at $0.003 and one search. All three are changeable.
- You can set a dollar limit per run, per table, and per column.
- Reaching a limit **pauses**. The rows already filled keep their answers, and carrying on picks up
  where it stopped.
- Nothing moves you to a more expensive AI on its own. A cheap column that is unsure keeps its
  answer and waits for you.

**It gets cheaper over time**

- A column can try a cheap AI first and send only the unsure rows to the expensive one, when you
  say so.
- Run a local AI and every row costs nothing.
- After about 40 answered rows, Ferrum can study your column's own answers and write a rule that
  does the same job for free. The rule is graded only on rows it never saw, and saved switched off
  until you approve it.

One caveat worth stating: the savings figure Ferrum reports covers AI and research-agent columns.
Savings on calls to other websites are real but are not in that number, so the total is lower than
the truth, never higher.

---

## Bring your own AI

**On your computer, free per row:** Ollama, LM Studio, llama.cpp, LocalAI, vLLM, Modular MAX, Jan,
GPT4All, LiteLLM and AnythingLLM. Ferrum probes for them and lists whatever models they are serving.
Nothing leaves the machine, and the address is checked to make sure it really is local.

**Hosted, billed to your own account:** OpenRouter, OpenAI, Anthropic, Google Gemini, Mistral,
DeepSeek, Groq, xAI, Together AI, Fireworks AI, Cerebras, Moonshot, Perplexity, DeepInfra, Nebius,
Hyperbolic, Novita, SambaNova, Cohere, AI21 and Z.AI. Around 300 models with live prices come
through OpenRouter; the rest take a direct key.

Ferrum adds nothing on top of what they charge you.

---

## Configuration

**API keys are not environment variables.** They are stored in the data directory as
`provider-keys.json`, written `0600` and ACL'd on Windows, and set in Settings inside the app.

Environment variables are documented in [`.env.example`](.env.example), which is loaded
automatically if present:

| Variable | What it does |
|---|---|
| `FERRUM_DATA_DIR` | Where the database and keys live |
| `FERRUM_DB` | Override the database path alone |
| `PORT` | Engine port, default 4317 |
| `FERRUM_HOST` | Address to listen on, default `127.0.0.1`. Anything else turns on shared mode — see below |
| `OLLAMA_URL`, `LMSTUDIO_URL`, `LLAMACPP_URL`, `VLLM_URL`, `JAN_URL`, `GPT4ALL_URL`, `LITELLM_URL`, `ANYTHINGLLM_URL` | Point at a local AI runtime on a non-default port. `LLAMACPP_URL` also covers LocalAI, `VLLM_URL` also covers Modular MAX — each pair shares a port, so it is one address each |
| `FERRUM_DEV_SCRIPTS` | Set to `1` to allow `POST /api/scripts/run-direct`, which runs code nobody reviewed. Only the benchmark scripts in `scripts/` need it; leave it unset on any engine you actually use |

`CLAYCODE_DATA_DIR`, `CLAYCODE_DB` and `CLAYCODE_HOST` are accepted as aliases.

### Sharing one Ferrum with other people

By default Ferrum listens on `127.0.0.1`, so only your own machine can reach it and there is no
sign-in. Set `FERRUM_HOST` to an address other machines can reach (`0.0.0.0`, or one interface) and
it switches to shared mode: accounts, sign-in and per-person access come on, managed on the People
screen.

Two things to know before you do it:

- **A fresh shared instance is open until somebody claims it.** Sign-in only exists once the first
  account is created, so between starting the engine and creating that account, anyone who can reach
  the address has full access to every table and every saved key. The engine prints this on boot.
  Claim it immediately, from the machine you started it on.
- **Sessions travel in a cookie, and Ferrum does not terminate TLS.** Put it behind HTTPS — a reverse
  proxy, a VPN, or a private network — before you give the address to anyone.

### Where your data lives

`%LOCALAPPDATA%\ferrum` on Windows, `~/.local/share/ferrum` elsewhere. Deliberately not inside a
synced folder, because SQLite and file-sync clients corrupt each other; Ferrum warns you if it
detects one. CSV uploads stage in the system temp directory, not in your data directory.

---

## What is in it

The grid, with server-side search, sort, filters and saved views. CSV import and export. A run
engine you can pause, resume and cancel. AI, research-agent and web-call columns. Connected apps
over MCP, either running on your own computer or reached over the web, answering a column directly
or handed to a research agent as tools. Waterfalls that try several sources in order. JSON answers
expanded into their own columns. Sending rows to another table or a CRM. Scheduled runs, and columns
that fill themselves as data arrives. Webhook ingest. Duplicate detection. Undo and redo. A command
palette. A record page for reading one row at a time. Per-column validation. Copy and paste that
round-trips with Excel and Sheets. Workbook templates. And an assistant that configures a column
from a sentence of description.

---

## Performance

Measured on a 1,000,000-row by 6-column table:

| | |
|---|---|
| CSV import | 24.5s for 6M cells, about 40,800 rows/sec |
| Database size | 702 MB |
| Scrolling to any row | ~9 ms, flat from row 0 to row 999,000 |

Three design decisions came out of that benchmark and are worth knowing if you work on the code:
cells are keyed by integer pairs rather than text ids, the row count is cached rather than counted
per scroll, and row virtualisation is hand-rolled because browsers cap element height and a stock
virtualiser cannot address a million rows.

---

## Development

```bash
npm test           # 1,056 tests across 78 files, each with its own database
npm run typecheck  # both TypeScript projects, server and browser
npm run web:build  # production build of the grid
```

CI runs all of these on every push and pull request.

```
src/          the engine: storage, runs, columns, providers, agent loop
src/agent/    the per-cell executor and the research-agent tool loop
src/http/     web-call columns, with a guard against internal addresses
src/runtime/  the sandboxed rule runners
src/setup/    the AI that configures a column from a description
web/src/      the React grid, the column editor, settings
```

Contributions are welcome. Please run `npm test` and `npm run typecheck` before opening a pull
request. Found a security problem? Report it privately — see [`SECURITY.md`](SECURITY.md).

---

## Licence

[Apache License 2.0](LICENSE). Use it, change it, ship it commercially. It comes with an explicit
patent grant, and it asks that you keep the notice and say what you changed.
