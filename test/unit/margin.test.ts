import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MARGIN_CONFIG,
  breakEvenRatio,
  evaluateCraft,
  netProceeds,
  opportunityScore,
} from '../../src/core/margin.ts';

/**
 * These fixtures are the four pets whose prices were verified directly against
 * the market's own structured data. They are the regression guard: a margin
 * engine that gets these wrong would send real money into a losing craft.
 */
const VERIFIED = [
  { name: 'Dragonfruit Fox', normal: 0.83, neon: 4.78, margin: 0.265, ratio: 5.759 },
  { name: 'Sushi Penguin', normal: 0.47, neon: 2.21, margin: -0.2225, ratio: 4.7021 },
  { name: 'Dango Penguins', normal: 0.72, neon: 3.07, margin: -0.5775, ratio: 4.2639 },
  { name: 'Three Blind Mice', normal: 0.08, neon: 0.22, margin: -0.155, ratio: 2.75 },
];

const close = (a: number, b: number, epsilon = 1e-4): boolean => Math.abs(a - b) < epsilon;

describe('breakEvenRatio', () => {
  it('is 4/(1-fee): 5.333x at a 25% fee', () => {
    assert.ok(close(breakEvenRatio(0.25), 5.333333));
  });

  it('is 4x with no fee and unbounded as the fee approaches 100%', () => {
    assert.ok(close(breakEvenRatio(0), 4));
    assert.ok(breakEvenRatio(0.9) > 39);
  });

  it('rejects an impossible fee', () => {
    assert.throws(() => breakEvenRatio(1), RangeError);
    assert.throws(() => breakEvenRatio(-0.1), RangeError);
  });

  it('is exactly the point where margin crosses zero', () => {
    const be = breakEvenRatio(0.25);
    const atBreakEven = evaluateCraft({ normalPrice: 1, neonPrice: be });
    assert.ok(close(atBreakEven.margin, 0, 1e-9), `expected ~0, got ${atBreakEven.margin}`);
    assert.equal(atBreakEven.profitable, false);

    const justAbove = evaluateCraft({ normalPrice: 1, neonPrice: be + 0.01 });
    assert.equal(justAbove.profitable, true);
  });
});

describe('netProceeds', () => {
  it('nets a 25% fee off the ask', () => {
    assert.ok(close(netProceeds(4.78, 0.25), 3.585));
  });
});

describe('evaluateCraft against the verified pets', () => {
  for (const pet of VERIFIED) {
    it(`${pet.name}: margin ${pet.margin >= 0 ? '+' : ''}${pet.margin}`, () => {
      const result = evaluateCraft({ normalPrice: pet.normal, neonPrice: pet.neon });
      assert.ok(
        close(result.margin, pet.margin, 1e-3),
        `${pet.name}: expected ${pet.margin}, got ${result.margin}`
      );
      assert.ok(
        close(result.ratio, pet.ratio, 1e-3),
        `${pet.name}: expected ratio ${pet.ratio}, got ${result.ratio}`
      );
      assert.equal(result.profitable, pet.margin > 0);
    });
  }

  it('calls Dragonfruit Fox a craft and the other three a skip', () => {
    const verdicts = VERIFIED.map((pet) =>
      evaluateCraft({ normalPrice: pet.normal, neonPrice: pet.neon }).verdict
    );
    // Three of four flip to loss-making once the seller's 25% fee applies.
    assert.deepEqual(verdicts, ['craft', 'skip', 'skip', 'skip']);
  });

  it('flags the fee as the cause when it erases a positive gross spread', () => {
    // Sushi Penguin is +$0.33 gross before fees and -$0.22 after them.
    const gross = 2.21 - 4 * 0.47;
    assert.ok(gross > 0, 'precondition: positive gross spread');

    const result = evaluateCraft({ normalPrice: 0.47, neonPrice: 2.21 });
    assert.ok(result.flags.includes('fee_erases_margin'));
    assert.ok(result.flags.includes('below_break_even_ratio'));
  });
});

describe('verdict thresholds', () => {
  it('marks a positive but thin margin as marginal, not craft', () => {
    // margin ~0.01 on 4.00 of capital => 0.25% return, well under 5%.
    const result = evaluateCraft({ normalPrice: 1, neonPrice: 4.01 / 0.75 });
    assert.ok(result.margin > 0);
    assert.equal(result.verdict, 'marginal');
    assert.ok(result.returnOnCapital < DEFAULT_MARGIN_CONFIG.minReturnOnCapital);
  });

  it('honours a raised return-on-capital bar', () => {
    const result = evaluateCraft(
      { normalPrice: 0.83, neonPrice: 4.78 },
      { feePct: 0.25, minReturnOnCapital: 0.5 }
    );
    assert.equal(result.verdict, 'marginal');
  });
});

describe('tier gap and labour', () => {
  it('reports a verified inversion', () => {
    const result = evaluateCraft({
      normalPrice: 0.47,
      neonPrice: 2.21,
      newbornPrice: 0.53,
      fullGrownPrice: 0.5,
    });
    assert.ok(close(result.tierGap, -0.03));
    assert.ok(result.flags.includes('full_grown_cheaper_than_newborn'));
  });

  it('flags ageing as unpaid when the ladder is flat', () => {
    // Three Blind Mice: newborn through full-grown were all $0.08.
    const result = evaluateCraft({
      normalPrice: 0.08,
      neonPrice: 0.22,
      newbornPrice: 0.08,
      fullGrownPrice: 0.08,
    });
    assert.ok(result.flags.includes('ageing_unpaid'));
  });
});

describe('opportunityScore', () => {
  it('prefers margin multiplied by turnover', () => {
    // $0.10 on 200/week must beat $0.30 on 2/week.
    assert.ok(opportunityScore(0.1, 200) > opportunityScore(0.3, 2));
  });

  it('falls back to raw margin when velocity is unknown', () => {
    assert.equal(opportunityScore(0.3, null), 0.3);
    assert.equal(opportunityScore(0.3, 0), 0.3);
  });

  it('keeps losses ranked below any profit', () => {
    assert.ok(opportunityScore(-0.1, 1_000) < 0);
  });
});
