import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_SWEEP_PRICE,
  bandLabel,
  fullRange,
  midpoint,
  planBand,
  splitBand,
} from '../../src/core/bands.ts';

const ITEMS_PER_QUERY = 120 * 72;

describe('sweep floor', () => {
  it('starts above zero, because 0 is the "no data" sentinel', () => {
    // Regression: sweeping from 0 subdivided a band of 18,527 zero-priced
    // placeholder rows forever, producing a `$0.00-$0.00` band.
    assert.ok(fullRange().min > 0);
    assert.equal(fullRange().min, MIN_SWEEP_PRICE);
    assert.equal(fullRange().max, null);
  });
});

describe('midpoint', () => {
  it('splits geometrically between known bounds', () => {
    // Geometric beats arithmetic when item density is front-loaded.
    assert.equal(midpoint(1, 4), 2);
    assert.equal(midpoint(4, 16), 8);
  });

  it('steps aggressively when the top is unbounded', () => {
    assert.equal(midpoint(0, null), 1);
    assert.equal(midpoint(1, null), 4);
    assert.ok(midpoint(4, null) > 4);
  });

  it('always returns a point strictly inside the band', () => {
    for (const [min, max] of [
      [0.01, 0.02],
      [0.01, 100],
      [1, 1.0000001],
      [0, 1],
      [5, 5.000001],
    ] as Array<[number, number]>) {
      const mid = midpoint(min, max);
      const inside = mid > min && mid < max;
      const unsplittable = mid === min;
      assert.ok(inside || unsplittable, `midpoint(${min}, ${max}) = ${mid} is neither inside nor a refusal`);
    }
  });

  it('refuses to split a band it cannot divide', () => {
    assert.equal(splitBand({ min: 1, max: 1 }), null);
  });
});

describe('planBand', () => {
  it('treats a zero count as empty', () => {
    assert.deepEqual(planBand({ min: 0.01, max: 1 }, 0, ITEMS_PER_QUERY), { kind: 'empty' });
  });

  it('pages a band that fits, capped at the market page limit', () => {
    assert.deepEqual(planBand({ min: 3, max: 3.2 }, 297, ITEMS_PER_QUERY), {
      kind: 'page',
      pages: 5, // ceil(297 / 72)
    });
    assert.deepEqual(planBand({ min: 0.01, max: 1 }, ITEMS_PER_QUERY, ITEMS_PER_QUERY), {
      kind: 'page',
      pages: 120,
    });
  });

  it('splits a band larger than one query can return', () => {
    const decision = planBand({ min: 0.01, max: null }, ITEMS_PER_QUERY + 1, ITEMS_PER_QUERY);
    assert.equal(decision.kind, 'split');
    if (decision.kind === 'split') {
      assert.equal(decision.left.min, 0.01);
      assert.equal(decision.right.max, null);
      assert.ok(decision.right.min > decision.left.min);
    }
  });
});

describe('the partition covers the catalog', () => {
  /**
   * This is the load-bearing test. The sweep's only job is to see every priced
   * item exactly once while staying inside the market's 120-page ceiling, and
   * that is a property worth proving rather than assuming. It runs the real
   * planner against a catalog shaped like the real one: a dense cheap zone
   * with a long, thin tail (~22k items, the priced universe once zero-priced
   * placeholders are excluded).
   */
  it('visits every priced item exactly once and terminates', () => {
    const prices: number[] = [];
    const segment = (count: number, lo: number, hi: number) => {
      for (let i = 0; i < count; i++) {
        // Log-spaced, so the density profile matches a real market.
        prices.push(lo * (hi / lo) ** ((i + 0.5) / count));
      }
    };
    segment(10_000, 0.01, 0.6);
    segment(8_000, 0.6, 3);
    segment(3_000, 3, 20);
    segment(1_000, 20, 500);

    const inBand = (band: { min: number; max: number | null }): number[] => {
      const hits: number[] = [];
      for (let i = 0; i < prices.length; i++) {
        const price = prices[i] as number;
        if (price >= band.min && (band.max === null || price < band.max)) hits.push(i);
      }
      return hits;
    };

    const stack = [fullRange()];
    const visited = new Set<number>();
    let steps = 0;
    let pagedBands = 0;

    while (stack.length > 0) {
      const band = stack.pop();
      if (!band) break;
      steps++;
      assert.ok(steps < 500, `partition did not terminate (>= ${steps} steps)`);

      const members = inBand(band);
      const decision = planBand(band, members.length, ITEMS_PER_QUERY);

      if (decision.kind === 'empty') continue;
      assert.notEqual(decision.kind, 'unsplittable', `unsplittable band ${bandLabel(band)}`);
      if (decision.kind === 'unsplittable') continue;

      if (decision.kind === 'split') {
        // The split must actually shrink the band, or we would never converge.
        assert.ok(decision.left.max !== null && decision.left.max > decision.left.min);
        stack.push(decision.left, decision.right);
        continue;
      }

      pagedBands++;
      assert.ok(
        members.length <= ITEMS_PER_QUERY,
        `band ${bandLabel(band)} held ${members.length} items, over the query ceiling`
      );
      // The market refuses page > 120, so a band that needs more is unreadable.
      assert.ok(decision.pages <= 120, `band ${bandLabel(band)} needs ${decision.pages} pages`);
      for (const index of members) visited.add(index);
    }

    assert.equal(visited.size, prices.length, 'every priced item must be swept exactly once');
    assert.ok(pagedBands > 1, 'expected the catalog to require more than one band');
  });
});

describe('bandLabel', () => {
  it('renders bounded and open bands', () => {
    assert.equal(bandLabel({ min: 0.01, max: 1 }), '$0.01-$1.00');
    assert.equal(bandLabel({ min: 16, max: null }), '>=$16.00');
  });
});
