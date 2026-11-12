# minimi: a chat agent with web search and time-aware memory

A chat agent that searches the live web **and remembers what it told you, when, and from which source**, so it can answer:

- "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"

It runs at **$0**: Groq's free tier for the LLM (`openai/gpt-oss-120b`), Tavily's free tier for search, and a local SQLite file for memory. The design is in [`DESIGN.md`](DESIGN.md) (one page).

## Quick start

Requires **Node 22.13+**, the first version where the built-in `node:sqlite` works without a flag. It has been run on Node 24; other versions have not been tested. There is no native build step.

```bash
npm install
cp .env.example .env          # add GROQ_API_KEY and TAVILY_API_KEY (both free, no card)
npm run dev                   # http://localhost:3000
```

If a key is missing, the server still starts and tells you which one to add.

**Speed.** Every turn has one deadline (25 s by default, `TURN_DEADLINE_MS`). Searching stops 8 s before it so there is always time to answer. If the deadline hits, you get what was already validated, marked incomplete; the turn is not left waiting. In a handful of live runs on the free tier, a plain lookup took about 4–5 s and a re-check of 4–5 products about 4–7 s, with the code-rendered comparison appearing before the model's text. That is a few runs, not a benchmark: the Groq free tier (8k tokens/minute) can still slow back-to-back turns.

### Try the memory features

A fresh install has no history, so the agent will honestly say it has no record of "Monday". The fastest way to test recall is to load **known** past conversations straight into a separate database. It is instant, uses no API credits, and gives the same memory every time:

```bash
DB_PATH=data/test.db npm run seed:fixtures   # dates relative to today: "Monday", "last Tuesday", "3 Nov" resolve to real days
DB_PATH=data/test.db npm run dev             # start the server on the same database
```

It prints each question to ask and what a correct reply looks like. The five fixtures (in `scripts/fixtures.ts`) are:
- a CRM shortlist with four stored prices (two from vendor pages, two third-party) and one item never priced;
- Postgres hosting on the Tuesday *before* last Tuesday, with three stored non-price statements;
- an unrelated cold email on last Tuesday, so "last Tuesday" is genuinely ambiguous;
- Gemini prices with one deliberately altered value (flagged DEMO DATA);
- a turn whose answer failed.

`npm run seed` instead replays scripted questions through the live pipeline with the clock set back (about 3 minutes and 15+ Tavily credits; it can hit rate limits). `--demo-change` alters one stored price, flagged as demo data.

Turn on **Debug** (top right) to see the resolved dates, the injected memory, every search, the code-computed comparison rows, the timings and the call counts.

### Other scripts

```bash
npm test                      # vitest: 163 tests, incl. full turns with scripted model + search (tests/integration.test.ts)
npm run typecheck
npm run ask -- "question"     # one turn from the CLI: prints the stream, debug summary, memory written, telemetry
bash scripts/e2e.sh           # the sample questions + abstention + small talk, paced for the free tier
FAKE_NOW=2026-11-11T10:00:00 npm run dev   # freeze the clock (dates resolve deterministically)
```

## How a turn works

```
browser (vanilla JS, SSE)  →  POST /api/chat {message, conversationId, tz}
  one Deadline per turn: every search and model call gets its abort signal
  1. time/resolve.ts       "Monday", "last Tuesday", "3 Nov" → local-date windows (code, ~0 ms)
  2. agent/router.ts       memory? change? pure recall? launches? small talk? (regex, no LLM hop)
  3. memory/retrieve.ts    all conversations, INCLUDING this one → <memory> block, or an explicit absence
       └ pure recall, nothing found → answer straight from retrieval, no model call
       └ re-check              → searches + code comparison run BEFORE the model (prefetch)
  4. search/tool.ts        parallel Tavily calls → dedupe, heading-aware excerpts, tiers (publisher relationships)
       └ evidence/observations.ts   what each source states: prices (plan, unit, terms) + announcements, with dates
       └ verify/reverify.ts         stored answer assertion vs official observation → comparison rows (code)
  5. agent/loop.ts         validated comparison streams first; Groq gpt-oss-120b writes the rest (one tool, web_search)
  6. answer/narrative.ts   strips the model's Then/Now tables, unsupported verdicts, unrecorded earlier values
     answer/*              invalid [Sn] dropped; prices the cited source doesn't state are flagged
  7. memory/assertions.ts  answer ↔ observation links, non-price statements, items, constraints → SQLite,
                           written BEFORE the final event
```

**Memory is not a tool.** The harness injects it, so `web_search` stays the only tool and memory questions cost no extra LLM round-trip.

**Call paths.**

| Kind of turn | Model calls |
|---|---|
| Small talk | 1, with no tools |
| "What did I ask on X?" with nothing stored | 0 |
| Ordinary research | about 2 (decide to search, then answer) |
| Re-check | usually 1 after the prefetch; at most 1 extra search round |

A small JSON model call happens only when code cannot read a needed value from an official page. It is one batched call, inside the deadline.

## What code guarantees (and what it doesn't)

| Guarantee | Enforced by |
|---|---|
| A "Then" value is a stored **answer assertion** (entity, plan, attribute, terms, date). Today's sources never establish what we said earlier. | `verify/reverify.ts` builds the rows; `answer/narrative.ts` and `answer/thenCheck.ts` strip anything else |
| No baseline → "No earlier value recorded; cannot compare." Never "Unchanged". | `notRecordedRow`, narrative guard |
| **Official** means the domain *is* the brand (hubspot.com) or is in a small parent-company table (Gemini → google.dev), with the reason recorded. Model-suggested domains, stored URLs and brand-containing domains (salesforceben.com) are never promoted. | `search/credibility.ts` |
| A different plan is never substituted. A currency, unit, billing period, billing term or region stated on only one side is "not comparable". | `lookupCurrent`, `compareValues` |
| Precision-aware equality: $0.001 → $0.002 is a change. Rounding is tolerated only for a converted yearly price. | `verify/diff.ts` |
| "Differs from our earlier answer" is kept apart from "Changed". Changed needs evidence that the vendor's own statement changed. | `buildRow` |
| Official pages dated before the anchor, conflicting official sources, and third-party baselines stay visibly uncertain. | `lookupCurrent`, `buildRow` |
| Publication date, fetch date (the original one on a cache hit) and effective/event date stay distinct. | `search/cache.ts`, `evidence/observations.ts` |
| The verdict sentence is computed from the rows: never "nothing changed" above rows that couldn't be verified, never "still correct" while earlier non-price statements are unchecked. | `headline()`, narrative guard |
| Memory reflects the delivered answer: table, prose and bullets store the same facts. Unsupported prices are kept but never used as baselines. | `memory/assertions.ts` |
| Ambiguous dates with equally plausible matches show both dates, and the model is told to ask. Failed turns keep the question, never a fake answer. | `memory/retrieve.ts` |

**What code does not guarantee:** that every generated sentence is true. Non-price statements are listed for the model to judge against today's sources, not verified by code. Conservative results are deliberate. On real pricing pages, many rows end as "Can't verify" or "Not comparable" because the page doesn't name the plan, or states terms the stored value didn't.

## Free-tier limits and cost

- **Groq:** 8,000 tokens/minute per model. The whole request (system prompt, memory, history, tool results and the tool definition) is fitted under about 5.8k tokens. Older search excerpts are shortened first; source headers and the comparison block never are. On a 429, the client waits only if `retry-after` is short (≤ 6 s) and fits the time left; otherwise it moves on to `gpt-oss-20b` (a separate bucket). There is one pass over the chain, with no minute-long second round. Optional fallbacks: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`.
- **Tavily:** about 1,000 free credits a month, and every call is `search_depth: "basic"` (1 credit). A lookup costs 1–4 credits. A re-check costs 2 per product, or 3 when the question asks about launches (current page + news + vendor release notes). Results are cached in memory for 15 minutes.

## Layout

```
src/server.ts              Hono routes: POST /api/chat (SSE), GET /api/conversations[/:id], GET /api/health, static client
src/config.ts              env, model chain, budgets (turn deadline, answer reserve), FAKE_NOW
src/agent/                 loop.ts (turn + persistence), deadline.ts, prompt.ts, router.ts
src/time/                  resolve.ts (date windows), tz.ts (Intl helpers)
src/memory/                db.ts (schema), retrieve.ts, assertions.ts (memory writer), parseClaims.ts
src/evidence/              observations.ts (what each source states)
src/search/                tool.ts (web_search), tavily.ts, postprocess.ts, credibility.ts, cache.ts
src/verify/                reverify.ts (comparison + rendering), diff.ts, support.ts
src/answer/                narrative.ts, thenCheck.ts, citations.ts, autocite.ts, labels.ts
src/llm/client.ts          OpenAI SDK → Groq (+ fallbacks), deadline-bound retries, JSON mode with zod
public/                    index.html, app.js, style.css (no build step)
scripts/                   fixtures.ts + seed-fixtures.ts, seed.ts, ask.ts, e2e.sh
tests/                     vitest suites (unit + integration)
```

## Known limitations

- Single user, no auth. All conversations share one memory.
- Retrieval is keyword-based (FTS5/BM25 + stored entity names) with no embeddings, so it misses paraphrases.
- Observation extraction and routing are English-language heuristics.
- Announcement detection matches at the brand level, so it can surface loosely related posts. The text and dates are shown so you can judge them.
- Latency and answer quality have been checked on a few live runs, not measured with an evaluation set.
