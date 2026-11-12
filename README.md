# minimi: a chat agent with web search and time-aware memory

A chat agent with one tool, **web search**, that also **remembers what you asked and when**. It can answer questions like:

- "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?"

It runs on free tiers: Groq (`openai/gpt-oss-120b`) for the model, Tavily for search, and a local SQLite file for memory. The design and its reasoning are in [`DESIGN.md`](DESIGN.md).

## Quick start

Requires **Node 22.13 or newer** (the first version where the built-in `node:sqlite` works without a flag). It has been run on Node 24.

```bash
npm install
cp .env.example .env    # add GROQ_API_KEY and TAVILY_API_KEY (both have free tiers)
npm run dev             # http://localhost:3000
```

If a key is missing, the server still starts and says which key to add.

Turn on **Debug** (top right of the chat) to see, for each turn: the resolved dates, the memory given to the model, every search, the code-computed comparison, and the timings.

## Try the memory features

A fresh install has no history, so the agent will say it has no record of "Monday". To test recall, load five known past conversations into a separate database (no API calls, dates are set relative to today):

```bash
DB_PATH=data/test.db npm run seed:fixtures
DB_PATH=data/test.db npm run dev
```

The fixtures are:

| Day (relative to today) | Conversation |
|---|---|
| Last Monday | A CRM shortlist: 4 stored prices (2 from vendor pages, 2 from third-party sites) and one item never priced |
| The Tuesday before last | Postgres hosting: Neon and Supabase prices stored, AWS RDS named without a price |
| Last Tuesday | An unrelated cold email, so "last Tuesday" is genuinely ambiguous |
| Last Friday | Gemini API prices, with one value deliberately altered and flagged as demo data |
| Last Sunday | A question whose answer failed: the question is remembered, but there are no earlier values |

The seed command prints the questions to ask and what a correct reply looks like.

## How a turn works

1. **Dates.** Phrases like "Monday" or "last Tuesday" are turned into date ranges in the user's time zone, in code (`time/resolve.ts`).
2. **Routing.** Simple rules decide whether the message is small talk, a memory question, or a "has it changed?" question (`agent/router.ts`). No model call is spent on this.
3. **Memory.** Past conversations are searched by date and topic (SQLite full-text search) and given to the model as context. Memory is not a tool, so web search stays the only tool and recall costs no extra model call (`memory/retrieve.ts`).
4. **Re-check.** For "has it changed?", or the same question asked again when the earlier answer stated prices, the code first re-opens the pages the earlier answer cited and searches only the websites it used, plus news since that date. It then compares the stored values with today's sources and shows the comparison before the model writes anything (`verify/reverify.ts`).
5. **Search.** The model can call `web_search`. Results are deduplicated, rated (official vendor page or third-party), and cut into pieces that always keep the product heading and table header, so a price never loses its product name (`search/`).
6. **Checks on the answer.** Citations must point to real results; prices must appear in the cited source; a "Confirmed" label is removed where they don't (`answer/`).
7. **Save.** The answer is stored with the sources and values it used, before the reply completes, so later questions can be checked against it (`memory/assertions.ts`).

| Kind of question | Model calls |
|---|---|
| Small talk | 1, with no tools |
| "What did I ask on X?" with nothing stored | 0 (answered from memory search) |
| Ordinary research | About 2 (decide to search, then answer) |
| Re-check | Usually 1 (the searches and comparison run before the model) |

Every turn has one time limit (25 s by default, `TURN_DEADLINE_MS`). Searching stops 8 s before it so there is always time to answer; if time runs out, what was already checked is shown and marked incomplete.

## What the code guarantees

- **"Then" values come only from memory.** A past value is one the agent actually stored. Today's pages are never used to reconstruct what was said before.
- **"Now" values must be current.** A vendor's live pricing or docs page counts if it was updated within the last year. An article (blog post, news, changelog) counts only if it was published on or after the earlier answer.
- **Like is compared with like.** Same plan, currency, unit and billing terms. A different plan is never substituted, and there is no rounding.
- **"Changed" needs evidence.** A value that differs from the earlier answer is shown as "differs from our earlier answer" unless a source shows the vendor changed it after that date.
- **Official means the vendor's own site**, decided by domain with a recorded reason. Third-party sources are shown as "Reported", never "Confirmed".
- **"Confirmed" requires the cited page to state the value.**
- **No blanket "nothing changed"** above rows that could not be checked.

What the code does **not** guarantee: that every sentence the model writes is true. Statements other than prices are listed for the reader, not verified by code. The agent is deliberately cautious: when a page doesn't name the plan or states different terms, the row says "can't verify" instead of guessing.

## Measured on live runs (12 Nov 2026, free tiers)

| Run | Total time | Search credits | Result |
|---|---|---|---|
| Postgres re-check (3 stored prices) | 10.1 s | 7 | All 3 prices verified unchanged on the vendors' own sites |
| CRM re-check (5 items) | 5.2 s | 16 | 1 verified; the others had third-party or renamed plans, or no earlier value |
| Price lookup (Gemini 2.5 Flash) on a fresh install | about 11 s | — | Correct price, cited to Google's pricing page |

These are single runs, not a benchmark. The Groq free tier (8,000 tokens per minute) can slow down questions asked back to back.

## Free-tier limits

- **Groq:** 8,000 tokens per minute per model. Each request is kept under about 5,800 tokens (older search excerpts are shortened first). On a rate limit, it waits only if the wait is 6 s or less, otherwise it switches to `gpt-oss-20b`. Optional fallbacks: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`.
- **Tavily:** every search uses `search_depth: "basic"` (1 credit). Re-opening earlier pages costs 1 credit per 5 pages. Results are cached in memory for 15 minutes.

## Known limitations

- Single user, no login. All conversations share one memory.
- Memory search is by keyword (no embeddings), so it can miss paraphrases.
- Date and intent rules are written for English.
- Plan renames are not recognised (for example Salesforce "Essentials" → "Starter").
- Prices that a website draws with scripts are invisible to the page reader, so they can't be verified.
- The model sometimes writes an answer without citations. This is flagged in the answer, not fixed.
- The word "release" counts as time-sensitive, so a writing request that mentions it triggers an unnecessary search.
- Latency and accuracy have been checked on a few live runs, not measured with an evaluation set.

## Scripts

```bash
npm test                     # 179 tests (vitest), including full turns with a scripted model and search
npm run typecheck
npm run ask -- "question"    # one turn from the command line, with a debug summary
npm run seed                 # replay scripted questions through the live pipeline (uses API credits)
FAKE_NOW=2026-11-11T10:00:00 npm run dev   # freeze the clock for date testing
```

## Project layout

```
src/server.ts      HTTP routes: POST /api/chat (streaming), conversations, health, static client
src/config.ts      environment, models, time and size budgets, FAKE_NOW
src/agent/         the turn (loop.ts), time limit, prompt, routing, clarifying replies
src/time/          date phrases → date ranges, time-zone helpers
src/memory/        SQLite schema, memory search, what gets stored from each answer
src/search/        web_search tool, Tavily client, excerpts, source rating, cache
src/evidence/      what each source states (prices, announcements), with dates
src/verify/        then-vs-now comparison, value matching, source support checks
src/answer/        checks on the model's answer: citations, labels, freshness, grounding
src/llm/           model client with fallbacks and retries
public/            the chat UI (plain HTML, CSS and JavaScript, no build step)
scripts/           fixtures, seeding, command-line ask, end-to-end script
tests/             unit and integration tests
```
