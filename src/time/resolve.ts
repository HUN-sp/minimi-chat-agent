// Deterministic temporal resolver: turns "Monday", "last Tuesday", "3 November", "last week"
// into concrete local-date windows in the user's timezone. Runs before the LLM (≈0 ms).
//
// Weekday phrases and fuzzy ranges are handled by explicit rules (their semantics are the
// subtle part). Absolute dates ("3 November", "Nov 3rd", "2026-11-03") go through chrono-node.
// Ambiguous phrases return several candidate windows sharing a `group`; retrieval settles
// which one is meant by checking which window actually contains a matching conversation.

import * as chrono from 'chrono-node';
import {
  type CivilDate,
  WEEKDAY_NAMES,
  addDays,
  civilDateIn,
  compareCivil,
  isoDate,
  prettyDate,
  startOfCivilDay,
  weekday,
} from './tz.js';

export interface DateWindow {
  phrase: string; // the text that produced it
  label: string; // human label, e.g. "Mon 9 Nov 2026"
  from: string; // YYYY-MM-DD inclusive (local)
  to: string; // YYYY-MM-DD inclusive (local)
  start: string; // ISO UTC instant, inclusive
  end: string; // ISO UTC instant, exclusive
  confidence: number;
  group: number; // windows from the same phrase share a group (= alternatives)
  isToday?: boolean;
}

interface Span {
  phrase: string;
  index: number;
  length: number;
  candidates: { from: CivilDate; to: CivilDate; confidence: number }[];
  isToday?: boolean;
}

const WD = WEEKDAY_NAMES.join('|');
const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function mondayOf(c: CivilDate): CivilDate {
  return addDays(c, -((weekday(c) + 6) % 7));
}

/** Most recent occurrence of weekday `wd` strictly before `today`. */
function prevWeekday(today: CivilDate, wd: number): CivilDate {
  let back = (weekday(today) - wd + 7) % 7;
  if (back === 0) back = 7;
  return addDays(today, -back);
}

function day(c: CivilDate, confidence = 1) {
  return { from: c, to: c, confidence };
}

function ruleSpans(text: string, today: CivilDate): Span[] {
  const spans: Span[] = [];
  const add = (m: RegExpExecArray, candidates: Span['candidates'], isToday = false) =>
    spans.push({ phrase: m[0].trim(), index: m.index, length: m[0].length, candidates, isToday });
  let m: RegExpExecArray | null;

  // Weekdays: "last Tuesday", "this Monday", "on Monday", "Monday"
  const wdRe = new RegExp(`\\b(?:(last|this|past|previous|on)\\s+)?(${WD})s?\\b`, 'gi');
  while ((m = wdRe.exec(text))) {
    const qual = (m[1] ?? '').toLowerCase();
    const wd = WEEKDAY_NAMES.indexOf(m[2].toLowerCase());
    const prev = prevWeekday(today, wd);
    if (qual === 'this') {
      const thisWeek = addDays(mondayOf(today), (wd + 6) % 7);
      if (compareCivil(thisWeek, today) <= 0) add(m, [day(thisWeek)]);
      continue;
    }
    if (qual === 'last' || qual === 'past' || qual === 'previous') {
      // "last Tuesday" said on a Wednesday: yesterday, or the week before? English speakers disagree.
      const sameWeek = compareCivil(prev, mondayOf(today)) >= 0;
      add(m, sameWeek ? [day(prev, 0.55), day(addDays(prev, -7), 0.45)] : [day(prev, 0.85), day(addDays(prev, -7), 0.15)]);
      continue;
    }
    // Plain "Monday" / "on Monday": most recent past one. Said on the same weekday, it's
    // probably a week ago (they would say "today"), but keep today as an alternative.
    if (wd === weekday(today)) add(m, [day(prev, 0.6), day(today, 0.4)]);
    else add(m, [day(prev)]);
  }

  const simple: [RegExp, () => Span['candidates'], boolean?][] = [
    [/\bthe day before yesterday\b/gi, () => [day(addDays(today, -2))]],
    [/\byesterday\b/gi, () => [day(addDays(today, -1))]],
    [/\b(?:earlier today|today|this (?:morning|afternoon|evening))\b/gi, () => [day(today)], true],
    [/\b(?:a )?couple (?:of )?days ago\b/gi, () => [{ from: addDays(today, -3), to: addDays(today, -1), confidence: 0.7 }]],
    [/\b(?:a )?few days ago\b/gi, () => [{ from: addDays(today, -6), to: addDays(today, -2), confidence: 0.6 }]],
    [/\b(?:the other day|recently)\b/gi, () => [{ from: addDays(today, -10), to: addDays(today, -1), confidence: 0.4 }]],
    [/\b(?:last|previous|past) week\b/gi, () => {
      const mon = addDays(mondayOf(today), -7);
      return [{ from: mon, to: addDays(mon, 6), confidence: 0.8 }];
    }],
    [/\b(?:earlier )?this week\b/gi, () => [{ from: mondayOf(today), to: today, confidence: 0.9 }]],
    [/\blast month\b/gi, () => {
      const first = { y: today.m === 1 ? today.y - 1 : today.y, m: today.m === 1 ? 12 : today.m - 1, d: 1 };
      return [{ from: first, to: addDays({ y: today.y, m: today.m, d: 1 }, -1), confidence: 0.8 }];
    }],
    [/\bthis month\b/gi, () => [{ from: { y: today.y, m: today.m, d: 1 }, to: today, confidence: 0.8 }]],
  ];
  for (const [re, fn, isToday] of simple) {
    while ((m = re.exec(text))) add(m, fn(), isToday);
  }

  // "3 days ago", "two weeks ago"
  const agoRe = /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week)s?\s+ago\b/gi;
  while ((m = agoRe.exec(text))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1].toLowerCase()];
    if (m[2].toLowerCase() === 'day') {
      const c = addDays(today, -n);
      add(m, [{ from: addDays(c, -1), to: addDays(c, 1), confidence: 0.7 }]);
    } else {
      const mon = addDays(mondayOf(today), -7 * n);
      add(m, [{ from: mon, to: addDays(mon, 6), confidence: 0.6 }]);
    }
  }
  return spans;
}

function chronoSpans(text: string, today: CivilDate, taken: Span[]): Span[] {
  const ref = { instant: new Date(Date.UTC(today.y, today.m - 1, today.d, 12)), timezone: 'UTC' };
  const out: Span[] = [];
  for (const r of chrono.parse(text, ref, { forwardDate: false })) {
    const overlaps = taken.some((s) => r.index < s.index + s.length && s.index < r.index + r.text.length);
    if (overlaps) continue;
    // Only real calendar dates: "3 November", "Nov 3", "2026-11-03". Skip bare times and weekdays.
    if (!r.start.isCertain('day') || !r.start.isCertain('month')) continue;
    let from: CivilDate = { y: r.start.get('year')!, m: r.start.get('month')!, d: r.start.get('day')! };
    // Without an explicit year, always use the most recent past occurrence.
    if (!r.start.isCertain('year')) {
      from = { ...from, y: today.y };
      if (compareCivil(from, today) > 0) from = { ...from, y: today.y - 1 };
    }
    let to = from;
    if (r.end && r.end.isCertain('day')) {
      to = { y: r.end.get('year') ?? from.y, m: r.end.get('month')!, d: r.end.get('day')! };
      if (!r.end.isCertain('year')) to = { ...to, y: from.y };
    }
    out.push({ phrase: r.text, index: r.index, length: r.text.length, candidates: [{ from, to, confidence: 0.95 }] });
  }
  return out;
}

/** Resolve all date expressions in `text` relative to `now` in `tz`. Future-only windows are dropped. */
export function resolveDates(text: string, now: Date, tz: string): DateWindow[] {
  const today = civilDateIn(now, tz);
  const rules = ruleSpans(text, today);
  const spans = [...rules, ...chronoSpans(text, today, rules)].sort((a, b) => a.index - b.index);

  // "Is it still correct today?" — a "today" next to a real past date is not a memory anchor.
  const hasOther = spans.some((s) => !s.isToday);
  const kept = hasOther ? spans.filter((s) => !s.isToday) : spans;

  const windows: DateWindow[] = [];
  kept.forEach((s, group) => {
    for (const c of s.candidates) {
      if (compareCivil(c.from, today) > 0) continue; // future: not memory
      const to = compareCivil(c.to, today) > 0 ? today : c.to;
      const label = compareCivil(c.from, to) === 0 ? prettyDate(c.from) : `${prettyDate(c.from)} – ${prettyDate(to)}`;
      windows.push({
        phrase: s.phrase,
        label,
        from: isoDate(c.from),
        to: isoDate(to),
        start: startOfCivilDay(c.from, tz).toISOString(),
        end: startOfCivilDay(addDays(to, 1), tz).toISOString(),
        confidence: c.confidence,
        group,
        ...(s.isToday ? { isToday: true } : {}),
      });
    }
  });
  return windows;
}
