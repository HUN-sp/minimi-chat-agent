# Design

**How it works.** One Node/TypeScript process streams chat over SSE on free tiers: Groq `gpt-oss-120b`, Tavily and SQLite. Each turn has one deadline (25 s by default). Every search and model call gets its abort signal, and searching stops 8 s early so there is time to answer.

1. **Dates and memory, in code.** "Monday" and "last Tuesday" become windows in the user's timezone. Retrieval searches every conversation, including the current one, and dedupes recent history by message ID. A topic match settles an ambiguous date; on a tie, both dates are shown and the model asks which one.
2. **One tool, `web_search`.** Results are deduped and tiered. Each page is cut into self-contained chunks that repeat the product heading and the table's header row, so a price never travels without its product. "Official" requires the domain to *be* the brand, or a small parent-company table, and the reason is recorded. Code extracts **observations** from each source: prices (plan, unit, billing terms) and announcements, each with evidence text and publication, fetch and effective dates.
3. **Call paths.** Small talk gets no tools. "What did I ask on X?" with nothing stored is answered from retrieval with no model call. Research takes about two model calls. A re-check runs its searches and comparison before the model, then usually needs one model call. A small model only reads values code couldn't, in one batched call within the deadline; its quotes must appear verbatim, under the right product.
4. **Comparisons are rendered by code.** "Then" is a stored answer assertion; "Now" is an official observation for the same plan with comparable currency, unit and terms, from a live vendor page updated within a year or an article published after the earlier answer. A re-check goes back to the earlier answer's own sources: it re-opens the pages it cited and searches only the websites it used. Plans are never substituted, terms stated on only one side mean "can't verify", and there is no rounding tolerance. Code streams the verdict, table, announcements and earlier non-price statements first. The model writes only what remains, and a guard strips its Then/Now tables, unsupported verdicts and unrecorded earlier values.
5. **Memory is written before the turn completes.** The delivered answer is linked to the observations it cited, so tables, prose and bullets store the same facts. Unsupported prices and non-price statements are flagged and never used as baselines. Shortlists, constraints and failed questions are kept.

**Why.** The hard questions are "what did we say, when, and is it still true?" Answering them means keeping what was said separate from what a source states, and comparing the two in code. During building, the model attributed one product's price to another, rebuilt past answers from today's pages, and wrote "nothing changed" above unverifiable rows. Each failure became a structural check with a test. The checks enforce specific invariants, not the correctness of every sentence. "Can't verify" is deliberate, and an undated page only shows what it said when fetched.

**Considered and rejected.**
- A single date-filtered search: drops undated pricing pages.
- Model-suggested or brand-containing domains as proof of ownership.
- Parsing answer markdown as memory: formatting changed what was remembered.
- LLM-judged "did it change?": rewording looks like change.
- A `recall` tool, multi-agent setups, LangChain, Postgres or vectors: extra latency, opacity or setup cost, with no gain on these questions.

**Another week.**
- A live evaluation set measuring latency, correctness against inspected sources, citation support and abstention.
- Plan renames (Salesforce Essentials → Starter) and prices that pages draw with scripts, which page readers can't see.
- Code checks for non-price statements (versions, limits, billing models).
- Hybrid topic retrieval, if the measurements justify it.
