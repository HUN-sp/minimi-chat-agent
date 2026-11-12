import { describe, expect, it } from 'vitest';
import { resolveDates } from '../src/time/resolve.js';

// Wednesday 11 Nov 2026, 10:00 in London (UTC+0 in November)
const NOW = new Date('2026-11-11T10:00:00Z');
const TZ = 'Europe/London';
const dates = (text: string, now = NOW, tz = TZ) => resolveDates(text, now, tz).map((w) => (w.from === w.to ? w.from : `${w.from}..${w.to}`));

describe('resolveDates', () => {
  it('"Monday" is the most recent past Monday', () => {
    expect(dates('On Monday we shortlisted 5 CRM tools')).toEqual(['2026-11-09']);
  });

  it('"3 November" is this year when already past', () => {
    expect(dates('What did I ask you on 3 November? Is your answer still correct today?')).toEqual(['2026-11-03']);
  });

  it('"last Tuesday" said on a Wednesday yields two candidates', () => {
    const ws = resolveDates('Last Tuesday I asked about Postgres hosting', NOW, TZ);
    expect(ws.map((w) => w.from)).toEqual(['2026-11-10', '2026-11-03']);
    expect(new Set(ws.map((w) => w.group)).size).toBe(1);
  });

  it('"last Tuesday" said the following Monday is unambiguous-ish (prev week first)', () => {
    const ws = resolveDates('last Tuesday', new Date('2026-11-16T10:00:00Z'), TZ);
    expect(ws[0].from).toBe('2026-11-10');
    expect(ws[0].confidence).toBeGreaterThan(0.8);
  });

  it('absolute dates in other formats', () => {
    expect(dates('I asked about Gemini API price on 5 Nov')).toEqual(['2026-11-05']);
    expect(dates('what about Nov 5th?')).toEqual(['2026-11-05']);
    expect(dates('on 2026-11-02')).toEqual(['2026-11-02']);
  });

  it('a month-day later than today rolls back a year', () => {
    expect(dates('on December 5')).toEqual(['2025-12-05']);
  });

  it('fuzzy phrases become ranges', () => {
    expect(dates('last week')).toEqual(['2026-11-02..2026-11-08']);
    expect(dates('a few days ago')).toEqual(['2026-11-05..2026-11-09']);
    expect(dates('yesterday')).toEqual(['2026-11-10']);
    expect(dates('earlier this week')).toEqual(['2026-11-09..2026-11-11']);
  });

  it('no dates in plain questions', () => {
    expect(dates('What is the current Gemini API pricing?')).toEqual([]);
    expect(dates('hi there')).toEqual([]);
    expect(dates('compare 5 CRM tools for a 20-person team')).toEqual([]);
  });

  it('"today" alone is kept; "today" next to a past date is dropped', () => {
    expect(dates('what did I ask today?')).toEqual(['2026-11-11']);
  });

  it('is timezone aware: late evening in New York is still the previous day', () => {
    // 03:00 UTC on Thu 12 Nov = 22:00 Wed 11 Nov in New York
    const ws = resolveDates('yesterday', new Date('2026-11-12T03:00:00Z'), 'America/New_York');
    expect(ws[0].from).toBe('2026-11-10');
    expect(ws[0].start).toBe('2026-11-10T05:00:00.000Z');
    expect(ws[0].end).toBe('2026-11-11T05:00:00.000Z');
  });

  it('future dates are ignored', () => {
    expect(dates('this Friday')).toEqual([]);
  });
});
