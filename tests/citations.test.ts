import { describe, expect, it } from 'vitest';
import { validateCitations } from '../src/answer/citations.js';

const valid = new Set(['S1', 'S2', 'S3']);

describe('validateCitations', () => {
  it('keeps valid citations and records order', () => {
    const r = validateCitations('Price is $5 [S2]. Also [S1].', valid);
    expect(r.text).toBe('Price is $5 [S2]. Also [S1].');
    expect(r.used).toEqual(['S2', 'S1']);
    expect(r.dropped).toEqual([]);
  });

  it('drops invented ids', () => {
    const r = validateCitations('Claim [S9]. Other [S1, S7].', valid);
    expect(r.text).toBe('Claim. Other [S1].');
    expect(r.dropped).toEqual(['S9', 'S7']);
  });

  it('normalises grouped and native formats', () => {
    expect(validateCitations('A [S1, S3] B 【S2】', valid).text).toBe('A [S1][S3] B [S2]');
    expect(validateCitations('A [S1†L3-L5]', valid).text).toBe('A [S1]');
  });

  it('leaves non-citation brackets alone', () => {
    expect(validateCitations('see [docs](https://x.y) and [note]', valid).text).toBe('see [docs](https://x.y) and [note]');
  });

  it('keeps list indentation', () => {
    expect(validateCitations('-  a\n    - b [S9]', valid).text).toBe('-  a\n    - b');
  });
});

describe('validateCitations: model quirks seen live', () => {
  it('zero-width characters inside brackets', () => {
    const r = validateCitations('price [​S3]', new Set(['S3']));
    expect(r.text).toBe('price [S3]');
    expect(r.used).toEqual(['S3']);
  });
  it('pseudo-citations to memory / diff blocks', () => {
    expect(validateCitations('as you were told [Memory]. cannot confirm [<diff>].', new Set()).text).toBe('as you were told. cannot confirm.');
  });
});
