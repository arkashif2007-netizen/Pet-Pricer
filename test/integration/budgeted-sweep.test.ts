import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Store } from '../../src/collector/store.ts';
import { runBudgetedCycle } from '../../src/collector/sweep.ts';
import { MarketApi, MarketUnavailableError } from '../../src/core/api.ts';
import type { StoreItem } from '../../src/core/types.ts';

/**
 * The load-bearing operational test.
 *
 * The real host stops answering after roughly 50 requests in a window, so a
 * single-pass full sweep is impossible. This proves the budgeted design works:
 * several interrupted cycles must still cover the catalog, with no work lost
 * when the process restarts mid-sweep.
 *
 * The fake models the block as a *per-window* ceiling that recovers between
 * cycles — which is what the live host actually did (it unblocked after a
 * pause). A single global ceiling would be unrepresentative and would make the
 * sweep permanently unfinishable, which is the bug this test guards against.
 */

interface FakeRow {
  id: number;
  price: number;
  name: string;
}

class BlockingFakeMarket {
  readonly metrics = { requests: 0, retries: 0, failures: 0, bytes: 0, blocked: false };
  readonly catalog: FakeRow[];

  private readonly ceiling: number;
  private windowRequests = 0;

  // Explicit fields rather than parameter properties: the latter are
  // unsupported under Node's strip-only TypeScript mode.
  constructor(catalog: FakeRow[], ceiling: number) {
    this.catalog = catalog;
    this.ceiling = ceiling;
  }

  /** The rate-limit window rolled over: the host answers again. */
  resetWindow(): void {
    this.windowRequests = 0;
    this.metrics.blocked = false;
  }

  async listItems(params: {
    page?: number;
    amount?: number;
    filter: { price?: { min?: number; max?: number | null } };
  }): Promise<{ status: boolean; items: StoreItem[]; count: number; currency: string }> {
    if (this.windowRequests >= this.ceiling) {
      this.metrics.requests++;
      this.metrics.blocked = true;
      throw new MarketUnavailableError('simulated IP block');
    }
    this.windowRequests++;
    this.metrics.requests++;

    const min = params.filter.price?.min ?? 0;
    const max = params.filter.price?.max ?? null;
    const matching = this.catalog
      .filter((row) => row.price >= min && (max === null || row.price < max))
      .sort((a, b) => a.price - b.price);

    const page = params.page ?? 1;
    const amount = params.amount ?? 72;
    const slice = matching.slice((page - 1) * amount, page * amount);

    return {
      status: true,
      items: slice.map(toStoreItem),
      count: matching.length,
      currency: 'usd',
    };
  }
}

/** Stable ids, because the real API returns stable product ids. */
function toStoreItem(row: FakeRow): StoreItem {
  return {
    id: row.id,
    goodId: 'fake',
    name: row.name,
    type: 'pet',
    realName: row.name.toLowerCase().replace(/\s+/g, '_'),
    imageId: null,
    imageUri: null,
    subtype: null,
    age: 'newborn',
    rare: 'rare',
    pumping: 'default',
    flyable: false,
    rideable: false,
    price: row.price,
    avgPrice: row.price * 1.05,
    bonuses: 0,
  };
}

/** A catalog with a realistic price spread, small enough to reason about. */
function buildCatalog(size: number, priceSpan = 500): FakeRow[] {
  const rows: FakeRow[] = [];
  for (let i = 0; i < size; i++) {
    // Distinct prices, log-ish spread, no accidental ties.
    const price = Number((0.02 + (i % priceSpan) * 0.004).toFixed(4)) + i * 1e-7;
    rows.push({ id: 10_000 + i, price, name: `Pet ${i}` });
  }
  return rows;
}

describe('budgeted sweep resumes and completes', () => {
  it('covers the whole catalog across several interrupted cycles', async () => {
    const catalog = buildCatalog(4_000);
    const store = new Store(':memory:');
    try {
      // The ceiling is deliberately *below* the budget, so cycles are cut short
      // by the block rather than by the budget. That is the hostile case and
      // the one that must still make forward progress.
      const market = new BlockingFakeMarket(catalog, 6);
      const budget = 10;

      let cycles = 0;
      let abortedCycles = 0;
      let complete = false;

      while (!complete && cycles < 300) {
        cycles++;
        market.resetWindow();
        const result = await runBudgetedCycle(market as unknown as MarketApi, store, {
          requestBudget: budget,
          pageSize: 72,
          minPrice: 0.01,
        });
        if (result.aborted) abortedCycles++;
        complete = result.complete;

        assert.ok(
          result.requests <= budget + 1,
          `cycle ${cycles} spent ${result.requests} requests against a budget of ${budget}`
        );
      }

      assert.ok(complete, `the sweep must eventually cover the catalog (stopped after ${cycles} cycles)`);
      assert.ok(cycles > 1, 'the test is only meaningful if more than one cycle was needed');
      assert.ok(abortedCycles > 0, 'the fake host should have interrupted at least one cycle');

      // Coverage: every catalog row must have been observed.
      const stored = store.currentItems();
      const storedIds = new Set(stored.map((i) => i.id));
      for (const row of catalog) {
        assert.ok(storedIds.has(row.id), `row ${row.id} ($${row.price}) was never collected`);
      }

      assert.equal(store.loadSweepState().queue.length, 0, 'the queue must drain');
      assert.ok(store.loadSweepState().lastFullCycleAt !== null, 'a full pass must be timestamped');
    } finally {
      store.close();
    }
  });

  it('loses no work when the process restarts mid-sweep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'starpets-resume-'));
    const dbPath = join(dir, 'resume.sqlite');
    const catalog = buildCatalog(2_000);

    try {
      const market = new BlockingFakeMarket(catalog, 25);

      // Process one: spend a small budget, then die.
      const storeA = new Store(dbPath);
      const firstResult = await runBudgetedCycle(market as unknown as MarketApi, storeA, {
        requestBudget: 5,
        minPrice: 0.01,
      });
      const queueAfterCycle = storeA.loadSweepState().queue.length;
      const itemsAfterCycle = storeA.itemCount();
      const cyclesAfterCycle = storeA.loadSweepState().cycles;
      storeA.close();

      assert.ok(!firstResult.complete, 'the first cycle should not finish the catalog');
      assert.ok(queueAfterCycle > 0, 'progress must be checkpointed before shutdown');
      assert.ok(itemsAfterCycle > 0, 'items fetched before the break must be persisted');

      // Process two: a completely fresh Store over the same file.
      market.resetWindow();
      const storeB = new Store(dbPath);
      try {
        const resumed = storeB.loadSweepState();
        assert.equal(resumed.queue.length, queueAfterCycle, 'the queue must survive a restart');
        assert.equal(storeB.itemCount(), itemsAfterCycle, 'collected items must survive a restart');
        assert.equal(resumed.cycles, cyclesAfterCycle, 'cycle count must survive a restart');

        // And it must be able to carry on from where the previous process died.
        const continued = await runBudgetedCycle(market as unknown as MarketApi, storeB, {
          requestBudget: 5,
          minPrice: 0.01,
        });
        assert.ok(continued.tasksDone > 0, 'a resumed cycle must make progress');
        assert.ok(
          continued.queueDepth < queueAfterCycle,
          'a resumed cycle must consume queued work, not restart it'
        );
      } finally {
        storeB.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops on its own budget without needing to be blocked', async () => {
    const catalog = buildCatalog(3_000);
    const market = new BlockingFakeMarket(catalog, 10_000);
    const store = new Store(':memory:');
    try {
      const result = await runBudgetedCycle(market as unknown as MarketApi, store, {
        requestBudget: 5,
        minPrice: 0.01,
      });
      // Two distinct exit paths: an orderly budget stop (aborted = false) must
      // not be confused with a block, because only the latter should back off.
      assert.equal(result.aborted, false, 'a budget stop is not a block');
      assert.equal(result.complete, false);
      assert.equal(result.requests, 5);
      assert.ok(result.queueDepth > 0, 'remaining work must stay queued');
      assert.ok(store.loadSweepState().queue.length > 0);
      assert.equal(store.loadSweepState().lastFullCycleAt, null);
    } finally {
      store.close();
    }
  });

  it('reaches the expensive end of the market inside a tiny budget', async () => {
    // THE REGRESSION THIS EXISTS FOR.
    //
    // The sweep used to expand depth-first: the children of a band were placed
    // ahead of every waiting sibling, so a budgeted cycle refined the cheapest
    // band to exhaustion before looking anywhere else. A real run spent its
    // whole budget below $0.11, and since the host blocks after ~50 requests it
    // never recovered — the collector reported "nothing is profitable" while
    // the profitable half of the book had simply never been fetched.
    //
    // The cheap end is not the interesting end: a craft needs an input under
    // the cap AND a neon at over 5x it, so a $2 pet and a $20 neon matter at
    // least as much as a $0.03 pet. A budget must therefore sample the whole
    // range, not drill one corner of it.
    const catalog: FakeRow[] = [];
    // A log-spread across four orders of magnitude: $0.03 to $300.
    for (let i = 0; i < 3_000; i++) {
      const price = Number((0.03 * Math.pow(10, (i / 3_000) * 4)).toFixed(4)) + i * 1e-7;
      catalog.push({ id: 50_000 + i, price, name: `Pet ${i}` });
    }

    const market = new BlockingFakeMarket(catalog, 10_000);
    const store = new Store(':memory:');
    try {
      const result = await runBudgetedCycle(market as unknown as MarketApi, store, {
        requestBudget: 16,
        minPrice: 0.01,
      });

      assert.equal(result.aborted, false, 'the budget, not a block, should stop this cycle');

      const observed = store.currentItems().map((i) => i.price);
      assert.ok(observed.length > 0, 'the cycle must observe something');

      // Measured on this catalog, breadth-first sampling reaches: $0.07 at 4
      // requests, $0.18 at 8, $0.42 at 12, $1.03 at 16, $2.49 at 20. Under the
      // old depth-first order the figure stayed near $0.10 no matter the
      // budget, because a single cheap band was being filled page by page.
      const max = Math.max(...observed);
      assert.ok(
        max > 1,
        `16 requests must sample above $1, not stall near the cheapest band (max observed: $${max.toFixed(4)})`
      );

      // The default cycle budget is 35, so the first real cycle reaches well
      // past this. Guard that the budget is still respected exactly.
      assert.ok(result.requests <= 16, `the cycle must respect its budget (spent ${result.requests})`);
    } finally {
      store.close();
    }
  });

  it('marks a full pass complete and timestamps it', async () => {
    const catalog = buildCatalog(200);
    const market = new BlockingFakeMarket(catalog, 10_000);
    const store = new Store(':memory:');
    try {
      const result = await runBudgetedCycle(market as unknown as MarketApi, store, {
        requestBudget: 500,
        minPrice: 0.01,
      });
      assert.equal(result.complete, true);
      assert.equal(result.queueDepth, 0);
      assert.ok(store.loadSweepState().lastFullCycleAt !== null);
      assert.equal(store.itemCount(), catalog.length, 'a complete pass must store every row');
    } finally {
      store.close();
    }
  });
});
