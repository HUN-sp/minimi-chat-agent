import { describe, expect, it } from 'vitest';
import { compareValues, joinValue, parseMoney, valueAppearsIn } from '../src/verify/diff.js';

describe('parseMoney', () => {
  it('normalises currency and period', () => {
    expect(parseMoney('$19/mo')).toMatchObject({ amount: 19, currency: 'USD', period: 'month' });
    expect(parseMoney('19 USD per month')).toMatchObject({ amount: 19, currency: 'USD', period: 'month' });
    expect(parseMoney('$300/yr')).toMatchObject({ amount: 25, currency: 'USD', period: 'month' });
    expect(parseMoney('€15 per user per month')).toMatchObject({ amount: 15, currency: 'EUR', basis: 'seat' });
  });

  it('understands per-1M-token API prices', () => {
    const m = parseMoney('$0.30 per 1M input tokens');
    expect(m).toMatchObject({ amount: 0.3, currency: 'USD', basis: '1m_tokens' });
  });

  it('monthly price billed annually stays monthly', () => {
    expect(parseMoney('$25/user/mo billed annually')).toMatchObject({ amount: 25, period: 'month', basis: 'seat' });
  });

  it('free plans and missing numbers', () => {
    expect(parseMoney('Free')).toMatchObject({ amount: 0, free: true });
    expect(parseMoney('contact sales')).toBeNull();
  });

  it('handles thousands separators', () => {
    expect(parseMoney('$1,200 per year')).toMatchObject({ amount: 100, period: 'month' });
  });
});

describe('compareValues', () => {
  it('equal after normalisation', () => {
    expect(compareValues('$19/mo', '19 USD per month').status).toBe('unchanged');
    expect(compareValues('$300/yr', '$25/mo').status).toBe('unchanged');
    expect(compareValues('$0.30 per 1M tokens', '$0.3 / 1M tokens').status).toBe('unchanged');
  });

  it('"billed annually" is a payment cadence, not a yearly price (live HubSpot $9 → $0.75 regression)', () => {
    expect(parseMoney('$9/seat (billed annually)')).toMatchObject({ amount: 9, basis: 'seat' });
    expect(parseMoney('$14 a user billed annually')?.amount).toBe(14);
    expect(parseMoney('$20 per user (annual billing)')?.amount).toBe(20);
    const annual = { prev: { billing: 'annual' as const } };
    expect(compareValues('$9 per seat per month', '$9/seat/mo (billed annually)', annual).status).toBe('unchanged');
    expect(compareValues('$9 per seat per month', '$12/seat/mo (billed annually)', annual).status).toBe('changed');
    // "$9/seat (billed annually)" states no price period. The SAME number for the same unit and billing
    // terms shows no change, so it reads as unchanged (with the gap said); a DIFFERENT number can't be
    // read without the period, so it stays not comparable.
    const same = compareValues('$9 per seat per month', '$9/seat (billed annually)', { ...annual, next: { billing: 'annual' as const } });
    expect(same).toMatchObject({ status: 'unchanged', note: 'same amount; the source does not state the billing period' });
    expect(compareValues('$9 per seat per month', '$12/seat (billed annually)', { ...annual, next: { billing: 'annual' as const } }).status).toBe('cant_verify');
    // …and not when the billing terms are stated on only one side.
    expect(compareValues('$9 per seat per month', '$9/seat', annual).status).toBe('cant_verify');
    // A real yearly price still converts.
    expect(compareValues('$25 per month billed annually', '$300 per year, billed annually').status).toBe('unchanged');
  });

  it('billing terms stated on only one side are unknown, never assumed compatible', () => {
    const r = compareValues('$9 per seat per month', '$9/seat (billed annually)');
    expect(r.status).toBe('cant_verify');
    expect(r.note).toContain('only one side');
    expect(compareValues('$9/seat/mo', '$15/seat/mo', { prev: { billing: 'annual' }, next: { billing: 'monthly' } }).status).toBe('cant_verify');
  });

  it('a value that lost its period, unit or currency is not comparable (no silent assumption)', () => {
    expect(compareValues('$300', '$300 per year').status).toBe('cant_verify');
    expect(compareValues('$25', '$300/yr').status).toBe('cant_verify');
    expect(compareValues('$25', '$30/mo').status).toBe('cant_verify');
    expect(compareValues('$9 per seat per month', '$9 per month').status).toBe('cant_verify');
    expect(compareValues('25 per month', '$25 per month').status).toBe('cant_verify');
  });

  it('precision-aware: small usage prices are not rounded together', () => {
    expect(compareValues('$0.001 per request', '$0.002 per request').status).toBe('changed');
    expect(compareValues('$0.0010 per request', '$0.001 per request').status).toBe('unchanged');
    expect(compareValues('$0.106 per CU-hour', '$0.105 per CU-hour').status).toBe('changed');
    // Rounding is allowed only for a converted yearly price: $100/yr shown as $8.33/mo.
    expect(compareValues('$8.33 per month', '$100 per year').status).toBe('unchanged');
  });

  it('different regions are never compared', () => {
    expect(compareValues('$0.018 per hour in us-east-1', '$0.020 per hour in eu-west-1').status).toBe('cant_verify');
  });

  it('detects a change', () => {
    const r = compareValues('$25 per seat per month', '$29 per seat per month');
    expect(r.status).toBe('changed');
    expect(r.note).toContain('25');
  });

  it("can't verify when the new value is missing or not comparable", () => {
    expect(compareValues('$19/mo', null).status).toBe('cant_verify');
    expect(compareValues('$19 per seat/mo', '$19 per GB-month').status).toBe('cant_verify');
    expect(compareValues('$19/mo', '€19/mo').status).toBe('cant_verify');
  });

  it('non-numeric values compare as text', () => {
    expect(compareValues('Unlimited', 'unlimited').status).toBe('unchanged');
  });
});

describe('describeUnit', () => {
  it('"per GB-month" is a unit, not a monthly period', async () => {
    const { describeUnit } = await import('../src/memory/parseClaims.js');
    expect(describeUnit('$0.35 per GB-month')).toEqual({ unit: 'per GB-month', period: null });
    expect(describeUnit('$25 per month')).toEqual({ unit: null, period: 'month' });
  });
});

describe('joinValue / valueAppearsIn', () => {
  it('joins value, unit and period', () => {
    expect(joinValue({ value: '$20', unit: 'per seat', period: 'month' })).toBe('$20 per seat per month');
  });
  it('checks the number is in the source text', () => {
    expect(valueAppearsIn('$0.30', 'Input price $0.30 per 1M tokens')).toBe(true);
    expect(valueAppearsIn('$15', 'Starter is $15.00 per seat')).toBe(true);
    expect(valueAppearsIn('$0.3', 'Input $0.30 / 1M')).toBe(true);
    expect(valueAppearsIn('$19', 'costs $190 per year')).toBe(false);
  });
});
