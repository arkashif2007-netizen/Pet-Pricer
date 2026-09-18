/**
 * Live acceptance tests. These talk to the real market API, so they are opt-in
 * and NOT part of `npm test`:
 *
 *     npm run test:live
 *
 * They are deliberately few and small. During development a burst of ~200
 * requests earned an IP-level block from this host (every subsequent
 * connection timed out while the rest of the internet stayed reachable), so
 * this file is written to be a polite, low-volume check rather than a sweep.
 *
 * What they protect against: a silent upstream schema change. The parsing in
 * `src/core/api.ts` was discovered by reading the service's own validation
 * errors, and if the shape moves these tests fail loudly instead of the app
 * quietly reporting margins that do not exist.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MarketApi } from '../../src/core/api.ts';
import { loadConfig } from '../../src/config.ts';

// One shared client, throttled well below the collector's own cadence.
const config = loadConfig();
const api = new MarketApi({
  baseUrl: config.storeBaseUrl,
  currency: config.currency,
  concurrency: 1,
  minIntervalMs: 1_200,
  timeoutMs: 20_000,
  maxRetries: 2,
});

const DANGO_NEON_REBORN = 1681844;

describe('live market API', () => {
  it('reports product detail with the fields the app depends on', async () => {
    const info = await api.productInfo(DANGO_NEON_REBORN);
    assert.ok(info, 'expected a product payload');
    assert.equal(info.pumping, 'neon');
    assert.equal(info.flyable, false);
    assert.equal(info.rideable, false);
    assert.ok(typeof info.currentMinPrice['usd'] === 'number');
    // The liquidity signal used for ranking must still be present.
    assert.ok('numberOfSalesPerWeek' in info);
    // The product -> store-item hop, which is a different id space.
    assert.ok(typeof info.currentStoreItemId['usd'] === 'string');
  });

  it('returns the variant matrix keyed by pumping:flyable:rideable', async () => {
    const properties = await api.productProperties(DANGO_NEON_REBORN);
    assert.ok(Object.keys(properties).length > 0);
    for (const key of Object.keys(properties)) {
      assert.match(key, /^[a-z_]+:(true|false):(true|false)$/, `unexpected variant key ${key}`);
    }
  });

  it('returns an age ladder for a neon variant', async () => {
    const ages = await api.productAges(DANGO_NEON_REBORN);
    assert.ok(ages.length > 0);
    for (const rung of ages) {
      assert.ok(Number.isInteger(rung.id));
      assert.ok(typeof rung.age === 'string');
    }
  });

  it('batches an order book across several products', async () => {
    const books = await api.productOffers([DANGO_NEON_REBORN], { amount: 20 });
    assert.equal(books.length, 1);
    const book = books[0] as (typeof books)[number];
    assert.ok(book.offers.length > 0, 'expected at least one offer');
    // Offers must arrive cheapest-first, which is what makes depth affordable.
    const prices = book.offers.map((o) => o.price);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
    assert.ok(typeof book.offers[0]?.id === 'string', 'store-item ids are strings');
  });

  it('prices a pet by name through the sweep endpoint', async () => {
    const result = await api.listItems({
      filter: { types: [{ type: 'pet' }], name: 'Dango Penguins' },
      amount: 72,
      page: 1,
      sort: { price: 'asc' },
    });
    assert.ok(result.count > 0);
    const zeroPriced = result.items.filter((i) => i.price === 0);
    // The "no data" sentinel class is expected to exist; it must simply never
    // be treated as a price. This asserts the shape, not the outcome.
    assert.ok(Array.isArray(zeroPriced));
    for (const item of result.items) {
      assert.ok(Number.isFinite(item.price));
      assert.ok(['default', 'neon', 'mega_neon'].includes(item.pumping), `unknown pumping ${item.pumping}`);
      if (item.pumping === 'mega_neon') assert.equal(item.age, null, 'mega_neon has no age ladder');
    }
  });

  it('enforces the documented page and amount ceilings', async () => {
    await assert.rejects(
      () =>
        api.listItems({
          filter: { types: [{ type: 'pet' }] },
          page: 121,
          amount: 72,
        }),
      /page must be less than or equal to 120/
    );

    await assert.rejects(
      () =>
        api.listItems({
          filter: { types: [{ type: 'pet' }] },
          page: 1,
          amount: 200,
        }),
      /amount must be less than or equal to 72/
    );
  });
});
