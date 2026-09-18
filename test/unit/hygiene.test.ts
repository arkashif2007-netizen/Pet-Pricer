import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  depthCheck,
  distinct,
  isUsableItem,
  isUsablePrice,
  median,
  rejectOutlierAsks,
} from '../../src/core/hygiene.ts';

describe('zero is "no data", never a price', () => {
  it('rejects 0, negatives, NaN and infinities', () => {
    assert.equal(isUsablePrice(0), false);
    assert.equal(isUsablePrice(-1), false);
    assert.equal(isUsablePrice(Number.NaN), false);
    assert.equal(isUsablePrice(Number.POSITIVE_INFINITY), false);
    assert.equal(isUsablePrice('0.5'), false);
    assert.equal(isUsablePrice(null), false);
  });

  it('accepts any genuinely positive ask', () => {
    assert.equal(isUsablePrice(0.01), true);
    assert.equal(isUsablePrice(3.07), true);
  });

  it('gates items on their price', () => {
    assert.equal(isUsableItem({ price: 0 }), false);
    assert.equal(isUsableItem({ price: 0.64 }), true);
  });
});

describe('median', () => {
  it('handles odd, even and empty inputs', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.ok(Number.isNaN(median([])));
  });
});

describe('rejectOutlierAsks', () => {
  it('drops the $416 listing that sat beside $0.83 offers', () => {
    const book = [0.83, 0.86, 0.94, 0.94, 0.96, 1.03, 1.51, 2.6, 416];
    const { kept, rejected } = rejectOutlierAsks(book);
    assert.ok(kept.includes(0.83));
    assert.deepEqual(rejected, [416]);
  });

  it('keeps a legitimately wide spread: an order of magnitude is normal', () => {
    // Regression: a MAD-based rule wrongly rejected the ordinary $2.60 ask
    // here, because a densely-packed cheap book has a tiny median deviation.
    const book = [0.83, 0.86, 0.94, 0.94, 0.96, 1.03, 1.51, 2.6, 416];
    const { kept } = rejectOutlierAsks(book);
    assert.ok(kept.includes(2.6), '2.60 is 2.7x the median and must survive');
    assert.ok(kept.includes(1.51));
  });

  it('does not reject a large multiple of a tiny median', () => {
    // $5 against a $0.01 median is 500x, but only $5: real spread, not junk.
    const { rejected } = rejectOutlierAsks([0.01, 0.011, 0.012, 0.013, 5]);
    assert.deepEqual(rejected, []);
  });

  it('ignores zero-priced placeholders entirely', () => {
    const { kept } = rejectOutlierAsks([0, 0, 1, 1.1, 1.2, 1.3]);
    assert.equal(kept.length, 4);
    assert.equal(kept.includes(0), false);
  });

  it('keeps a flat book intact (no spread to reason about)', () => {
    const flat = [0.08, 0.08, 0.08, 0.08, 0.08];
    assert.deepEqual(rejectOutlierAsks(flat).kept, flat);
  });

  it('leaves small books alone rather than guessing', () => {
    assert.deepEqual(rejectOutlierAsks([0.83, 416]).rejected, []);
  });
});

describe('depthCheck', () => {
  it('requires 4 units, not 1', () => {
    const thin = [
      { id: 'a', productId: 1, price: 0.83 },
      { id: 'b', productId: 1, price: 0.86 },
    ];
    const result = depthCheck(thin, 4);
    assert.equal(result.enough, false);
    assert.equal(result.costForUnits, null);
  });

  it('sums the cheapest N asks when depth is sufficient', () => {
    const book = [3.07, 3.07, 3.07, 3.14, 4.1].map((price, i) => ({
      id: String(i),
      productId: 1,
      price,
    }));
    const result = depthCheck(book, 4);
    assert.equal(result.enough, true);
    assert.ok(Math.abs((result.costForUnits ?? 0) - (3.07 * 3 + 3.14)) < 1e-9);
  });

  it('does not count zero-priced rows as depth', () => {
    const book = [
      { id: 'a', productId: 1, price: 0 },
      { id: 'b', productId: 1, price: 0 },
      { id: 'c', productId: 1, price: 0 },
      { id: 'd', productId: 1, price: 0 },
    ];
    assert.equal(depthCheck(book, 4).enough, false);
  });
});

describe('distinct', () => {
  it('deduplicates', () => {
    assert.deepEqual(distinct(['a', 'b', 'a']), ['a', 'b']);
  });
});
