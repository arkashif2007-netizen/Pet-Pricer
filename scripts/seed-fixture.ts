#!/usr/bin/env node
/**
 * Seed a database with known data, so the server, the MCP tools and the
 * Android app can be exercised without touching the market.
 *
 *   node scripts/seed-fixture.ts                     the four verified pets
 *   node scripts/seed-fixture.ts --db data/x.sqlite  merge into a real snapshot
 *
 * The four verified pets are transcribed from prices confirmed against the
 * market's own structured data, so they double as a smoke test: the fixture
 * must reproduce `craft / skip / skip / skip` at a 25% fee.
 *
 * THERE IS DELIBERATELY NO GENERATOR HERE ANY MORE.
 *
 * This script used to be able to synthesise a catalog of invented pets
 * ("Ancient Owl 193", "Cursed Slime 681") with plausible-looking prices, for
 * sizing the UI. That shipped: the dashboard ended up serving 5,493 fabricated
 * rows ranked above the real ones, which is worse than an empty screen, because
 * an empty screen is honest and a confident fake profit is not. Any fact this
 * file writes must now be traced to the market's own observed data.
 *
 * To fill the UI at scale, collect real data (`npm run sweep`) instead.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store } from '../src/collector/store.ts';
import { buildOpportunities } from '../src/core/opportunities.ts';
import type { StoreItem } from '../src/core/types.ts';

interface PetSpec {
  name: string;
  slug: string;
  rare: string;
  normal: number;
  neon: number;
  /** Extra rungs, so the age ladder is visible in the UI. */
  normalRungs?: Array<[string, number]>;
  neonRungs?: Array<[string, number]>;
  /** Zero-priced placeholder rows, to exercise the no-data path. */
  zeroRungs?: Array<[string, string]>;
  /**
   * The market's real CDN thumbnail, when one was captured during
   * reconnaissance. Real art matters here: a fixture without it renders as a
   * blank tile and makes a working app look broken.
   */
  imageUri?: string;
}

const VERIFIED: PetSpec[] = [
  {
    name: 'Dragonfruit Fox',
    slug: 'dragonfruit_fox',
    rare: 'legendary',
    normal: 0.83,
    neon: 4.78,
    normalRungs: [
      ['newborn', 0.83],
      ['junior', 0.9],
      ['full_grown', 0.83],
    ],
    neonRungs: [
      ['reborn', 4.78],
      ['flare', 4.8],
      ['luminous', 7.42],
    ],
  },
  {
    name: 'Sushi Penguin',
    slug: 'sushi_penguin',
    rare: 'legendary',
    normal: 0.47,
    neon: 2.21,
    normalRungs: [
      ['newborn', 0.47],
      ['junior', 0.53],
      ['teen', 0.52],
      ['post_teen', 0.51],
      ['full_grown', 0.5],
    ],
    neonRungs: [
      ['reborn', 2.21],
      ['flare', 3.39],
      ['luminous', 2.95],
    ],
    zeroRungs: [
      ['neon', 'twinkle'],
      ['neon', 'sparkle'],
      ['neon', 'sunshine'],
    ],
  },
  {
    name: 'Dango Penguins',
    slug: 'dango_penguins',
    rare: 'legendary',
    imageUri: 'https://cdn.starpets.gg/AM/610x610/dango_penguins_1762533667915.webp',
    normal: 0.72,
    neon: 3.07,
    normalRungs: [
      ['newborn', 0.72],
      ['full_grown', 0.86],
    ],
    neonRungs: [
      ['reborn', 3.07],
      ['twinkle', 4.0],
      ['flare', 4.0],
      ['sunshine', 4.58],
      ['luminous', 4.8],
    ],
  },
  {
    name: 'Three Blind Mice',
    slug: 'three_blind_mice',
    rare: 'common',
    normal: 0.08,
    neon: 0.22,
    normalRungs: [
      ['newborn', 0.08],
      ['junior', 0.08],
      ['teen', 0.1],
      ['full_grown', 0.08],
    ],
    neonRungs: [
      ['reborn', 0.22],
      ['sparkle', 1.41],
      ['flare', 1.2],
      ['sunshine', 0.63],
      ['luminous', 0.34],
    ],
  },
];

/**
 * A fixture id range far from real product ids (which are ~1.7M), so the
 * fixture can be merged into a real snapshot without overwriting live rows.
 */
const FIXTURE_ID_BASE = 900_000_000;
let nextId = FIXTURE_ID_BASE;

function makeItem(spec: PetSpec, partial: Partial<StoreItem> & { price: number }): StoreItem {
  return {
    id: nextId++,
    goodId: 'fixture',
    name: spec.name,
    type: 'pet',
    realName: spec.slug,
    imageId: null,
    imageUri: spec.imageUri ?? null,
    // Hand-checked prices, transcribed from confirmed market data: real, but
    // not swept. Provenance is recorded so the UI can say which is which.
    source: 'verified',
    subtype: null,
    age: 'newborn',
    rare: spec.rare,
    pumping: 'default',
    flyable: false,
    rideable: false,
    avgPrice: null,
    bonuses: 0,
    ...partial,
  };
}

function fixtureItems(): StoreItem[] {
  const items: StoreItem[] = [];
  for (const spec of VERIFIED) {
    for (const [age, price] of spec.normalRungs ?? [['newborn', spec.normal] as [string, number]]) {
      items.push(makeItem(spec, { age, price, avgPrice: price * 1.08 }));
    }
    for (const [age, price] of spec.neonRungs ?? [['reborn', spec.neon] as [string, number]]) {
      items.push(makeItem(spec, { age, price, pumping: 'neon', avgPrice: price * 1.1 }));
    }
    for (const [pumping, age] of spec.zeroRungs ?? []) {
      // price 0 => "no data", the sentinel that must never be minimised.
      items.push(makeItem(spec, { age, price: 0, pumping, avgPrice: 0 }));
    }
  }
  return items;
}

function main(): void {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf('--db');
  const dbPath = dbIndex >= 0 ? (args[dbIndex + 1] as string) : './data/fixture.sqlite';
  const items = fixtureItems();

  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const store = new Store(dbPath);
  const now = Date.now();
  const sweepId = store.startSweep(now);
  store.writeItems(items, now);
  store.finishSweep(sweepId, {
    finishedAt: now,
    requests: 0,
    itemsSeen: items.length,
    bands: 1,
    status: 'ok',
  });

  console.log(`seeded ${items.length} fixture items into ${dbPath}`);
  console.log(`database now holds ${store.itemCount()} items across ${store.petCount()} pets`);

  {
    // Evaluate the whole database, but only assert on the four verified pets:
    // this fixture is often merged into a real snapshot, and the other pets in
    // that snapshot are real data whose verdicts are not ours to pin.
    const fixtureSlugs = new Set(VERIFIED.map((spec) => spec.slug));
    const all = buildOpportunities(store.currentItems(), { maxNormalPrice: 1_000 });
    const fixture = all.filter((o) => fixtureSlugs.has(o.petSlug)).sort((a, b) => b.margin - a.margin);

    for (const o of fixture) {
      console.log(
        `  ${o.petName.padEnd(20)} normal $${o.normalPrice.toFixed(2)} neon $${o.neonPrice.toFixed(2)} ` +
          `margin ${o.margin >= 0 ? '+' : ''}$${o.margin.toFixed(3)} ratio ${o.ratio.toFixed(2)}x -> ${o.verdict}`
      );
    }

    const verdicts = fixture.map((o) => o.verdict).sort();
    const expected = ['craft', 'skip', 'skip', 'skip'];
    console.log(
      verdicts.join(',') === expected.join(',')
        ? 'fixture verdicts match the verified set (craft / skip / skip / skip at a 25% fee)'
        : `WARNING: fixture verdicts are ${verdicts.join(',')}, expected ${expected.join(',')}`
    );
  }
  store.close();
}

main();
