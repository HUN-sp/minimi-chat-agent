# Design

## How it works

One Node/TypeScript process serves the chat and streams answers. It uses free tiers: Groq (`gpt-oss-120b`) for the model, Tavily for search, SQLite for memory. Each turn has one time limit (25 s by default); searching stops 8 s early so there is always time to answer.

1. **Dates and memory are handled in code.** "Monday" or "last Tuesday" becomes a date range in the user's time zone. Past conversations on those dates and topics are retrieved and given to the model. If a date is ambiguous and both days match, both are shown and the model asks which one was meant.
2. **One tool: `web_search`.** Results are deduplicated and rated (vendor's own site or third-party, decided by domain with a recorded reason). Pages are cut into pieces that always keep the product heading and table header, so a price never loses its product name.
3. **Every answer is stored with what it used:** the values it stated, the sources behind them, and the date. Values without a supporting source are kept but never used as a baseline.
4. **Re-checks are compared in code.** For "has it changed?", the code re-opens the pages the earlier answer cited, searches only the websites it used, and looks for news since that date. It compares each stored value with today's value for the same plan, currency, unit and billing terms. The comparison table is shown first; the model writes the rest, and a guard removes any earlier value or verdict it makes up.
5. **The answer is checked before it is shown.** Citations must point to real results, prices must appear in the cited source, and "Confirmed" is removed where they don't.

## Why

The hard questions are "what did we say, when, and is it still true?" Search alone can't answer them. They need a record of what was said, kept separate from what sources say today, and a comparison of the two that can be trusted. So memory and comparison are code, and the model is used for what it is good at: choosing searches and writing the answer.

While building, the model attributed one product's price to another, rebuilt past answers from today's pages, and wrote "nothing changed" above rows it couldn't check. Each of these became a code check with a test. The agent is deliberately cautious: "can't verify" is a valid answer, and a wrong "unchanged" is worse than an honest "I couldn't check".

## Considered and rejected

- **Letting the model decide "did it change?"**: a reworded sentence looks like a change, and the model can invent the earlier value.
- **Memory as a tool:** it would cost an extra model call per question. Injecting memory keeps web search the only tool.
- **One date-filtered search for re-checks:** it drops undated pricing pages, which are usually the current ones.
- **Treating any page with the brand in its domain, or suggested by the model, as official:** that promotes third-party sites.
- **Reading memory back from the answer's text:** formatting changed what was remembered, so values are stored as structured records instead.
- **Multi-agent setups, LangChain, Postgres or vector search:** more latency and setup, with no gain on these questions.

## Another week

- An evaluation set measuring speed, correctness against the sources, and how often the agent correctly says "I don't know".
- Recognising renamed plans (for example Salesforce "Essentials" → "Starter").
- Code checks for statements other than prices (versions, limits, billing models).
- Getting the model to cite sources every time, instead of only flagging answers that don't.
