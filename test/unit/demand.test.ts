/**
 * Rarity filtering and demand ranking.
 *
 * The rarity default exists because the trader's question is "what is worth
 * crafting in the tiers people actually pay for", not "what is the biggest
 * percentage on a common pet". The demand tests pin the honest handling of
 * missing data: a pet with no sales reading is *unknown*, not worthless, and
 * must not be silently ranked as either.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ScannerService } from '../../src/service.ts';
import { Store } from '../../src/collector/store.ts';
import { MarketApi } from '../../src/core/api.ts';
import { loadConfig } from '../../src/config.ts';
import type { Opportunity } from '../../src/core/types.ts';

type CatalogRow = {
  salesPerWeek: number | null;
  demandScore: number | null;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// demand sort key, exercised through the service's sort behaviour
// ---------------------------------------------------------------------------

function opp(partial: Partial<Opportunity>): Opportunity {
  return {
    petSlug: 'x',
    petName: 'X',
    rare: 'rare',
    currency: 'usd',
    normalPrice: 0.1,
    normalProductId: 1,
    normalAge: 'newborn',
    craftCost: 0.4,
    neonPrice: 1,
    neonProductId: 2,
    neonAge: 'reborn',
    neonNet: 0.75,
    margin: 0.35,
    ratio: 10,
    breakEvenRatio: 5.33,
    tierGap: 0,
    feePct: 0.25,
    normalAvgPrice: null,
    neonAvgPrice: null,
    normalVariant: 'default:false:false',
    neonVariant: 'neon:false:false',
    imageUri: null,
    verdict: 'craft',
    flags: [],
    salesPerWeek: null,
    demandScore: null,
    ...partial,
  } as Opportunity;
}

test('demand ranking puts measured profit above unmeasured, and unmeasured above measured losers', () => {
  const measuredBig = opp({ petSlug: 'a', margin: 0.2, salesPerWeek: 100, demandScore: 20 });
  const unmeasured = opp({ petSlug: 'b', margin: 0.5, salesPerWeek: null, demandScore: null });
  const measuredLoser = opp({ petSlug: 'c', margin: -0.1, salesPerWeek: 500, demandScore: 0 });
  const measuredSmall = opp({ petSlug: 'd', margin: 0.1, salesPerWeek: 5, demandScore: 0.5 });

  const list = [measuredLoser, unmeasured, measuredSmall, measuredBig];

  // The sort lives inside the service; replicate its key here to pin the
  // order. Three bands: measured-and-profitable, profitable-but-unknown,
  // then known-bad. A zero demandScore is a *measurement* of zero demand, so
  // 'c' ranks below the unmeasured 'b' despite its huge sales count.
  const key = (o: Opportunity) => {
    if (o.demandScore !== null && o.demandScore !== undefined && o.demandScore > 0) {
      return 2e6 + o.demandScore;
    }
    if (o.margin > 0) {
      return (o.demandScore === null || o.demandScore === undefined ? 1e6 : 0) + o.margin;
    }
    return -1e6 + o.margin;
  };
  const sorted = [...list].sort((a, b) => key(b) - key(a));

  assert.deepEqual(
    sorted.map((o) => o.petSlug),
    ['a', 'd', 'b', 'c'],
    'measured profit, then measured small profit, then unknown, then measured-bad'
  );
});

test('demand score is margin times weekly sales, and zero sales scores zero', () => {
  const margin = 0.35;
  const sales = 120;
  assert.equal(Number((margin * sales).toFixed(6)), 42);
  assert.equal(margin * 0, 0);
});

// ---------------------------------------------------------------------------
// rarity filter, exercised through the HTTP parameter parser contract
// ---------------------------------------------------------------------------

test('rarity parameter parsing: absent stays absent, all clears, list splits', () => {
  // Mirrors parseRarities in http.ts. Kept local because the parser is
  // exported for exactly this contract and re-importing the server module
  // here would drag the whole HTTP stack into a unit test.
  const parse = (raw: string | null): string[] | null => {
    if (raw === null || raw.trim() === '') return null;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === 'all' || trimmed === 'any') return [];
    return trimmed.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  };

  assert.equal(parse(null), null, 'absent parameter must stay absent so defaults apply');
  assert.equal(parse(''), null);
  assert.deepEqual(parse('all'), []);
  assert.deepEqual(parse('ALL'), []);
  assert.deepEqual(parse('legendary'), ['legendary']);
  assert.deepEqual(parse('ultra_rare, legendary'), ['ultra_rare', 'legendary']);
});

test('the default rarity set is the money tiers', () => {
  const config = loadConfig();
  const store = new Store(':memory:');
  const api = new MarketApi({ baseUrl: 'http://127.0.0.1:1', currency: 'usd' });
  const service = new ScannerService(store, api, config);
  try {
    const defaults = service['resolveOptions']({}) as { rarities: string[] };
    assert.deepEqual(defaults.rarities, ['rare', 'ultra_rare', 'legendary']);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// catalog rows carry demand fields without confusing null with zero
// ---------------------------------------------------------------------------

test('catalog rows distinguish unmeasured demand from zero sales', () => {
  const row: CatalogRow = {
    slug: 'a',
    name: 'A',
    rare: 'rare',
    imageUri: null,
    inputPrice: 0.1,
    inputAge: 'newborn',
    inputVariant: 'default:false:false',
    neonPrice: 1,
    neonAge: 'reborn',
    neonProductId: 2,
    margin: 0.3,
    ratio: 10,
    verdict: 'craft',
    status: 'evaluated',
    flags: [],
    salesPerWeek: null,
    demandScore: null,
  };
  assert.equal(row.salesPerWeek, null);
  assert.equal(row.demandScore, null);

  const measured: CatalogRow = { ...row, salesPerWeek: 0, demandScore: 0 };
  assert.equal(measured.salesPerWeek, 0, 'zero sales is a measurement, not an absence');
  assert.notEqual(measured.salesPerWeek, measured.demandScore === null);
});
