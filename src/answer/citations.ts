// Citation validator: every [Sn] must map to evidence actually retrieved this turn.
// Invalid IDs are removed, so the model can't invent sources.

export interface CitationResult {
  text: string;
  used: string[]; // valid IDs in order of first use
  dropped: string[]; // invalid IDs removed
}

// [S1] · [S1, S3] · [S1][S2] · 【S1】 · [S1†L3] (gpt-oss sometimes emits its native format)
const GROUP = /([ \t]*)[[【]\s*((?:S\d+[^\]】,;]*?\s*[,;]?\s*)+)[\]】]/g;

export function validateCitations(text: string, valid: Set<string>): CitationResult {
  const used: string[] = [];
  const dropped: string[] = [];
  const cleaned = text
    .replace(/[​-‍⁠﻿]/g, '') // zero-width chars ("[​S5]") would hide a citation from the checks
    .replace(/[ \t]*\[\s*<?\/?\s*(memory|diff|search_results|resolved_dates|now|tool|context)\s*>?\s*\]/gi, ''); // pseudo-citations
  const out = cleaned.replace(GROUP, (_m, lead: string, inner: string) => {
    const ids = (inner.match(/S\d+/g) ?? []).filter((id, i, arr) => arr.indexOf(id) === i);
    const ok = ids.filter((id) => valid.has(id));
    for (const id of ids) {
      if (valid.has(id)) {
        if (!used.includes(id)) used.push(id);
      } else if (!dropped.includes(id)) dropped.push(id);
    }
    return ok.length ? lead + ok.map((id) => `[${id}]`).join('') : '';
  });
  // Any other 【…】 marker (gpt-oss native citation syntax, e.g. "【diff】") is not a valid citation.
  return { text: out.replace(/[ \t]*【[^】]*】/g, ''), used, dropped };
}
