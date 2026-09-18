import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOpportunities,
  cheapestNeonAsk,
  cheapestNormalInput,
  neonLadder,
  variantKeys,
} from '../../src/core/opportunities.ts';
import type { StoreItem } from '../../src/core/types.ts';

let nextId = 1;

function item(partial: Partial<StoreItem> & { price: number }): StoreItem {
  return {
    id: partial.id ?? nextId++,
    goodId: 'g',
    name: partial.name ?? 'Dango Penguins',
    type: 'pet',
    realName: partial.realName ?? 'dango_penguins',
    imageId: null,
    imageUri: null,
    subtype: null,
    age: partial.age ?? 'newborn',
    rare: partial.rare ?? 'legendary',
    pumping: partial.pumping ?? 'default',
    flyable: partial.flyable ?? false,
    rideable: partial.rideable ?? false,
    price: partial.price,
    avgPrice: partial.avgPrice ?? null,
    bonuses: partial.bonuses ?? 0,
  };
}

describe('zero prices are ignored, not minimised', () => {
  it('never picks a $0 normal, which would mean an infinite margin', () => {
    const side = cheapestNormalInput([
      item({ price: 0, age: 'newborn' }),
      item({ price: 0.72, age: 'newborn' }),
    ]);
    assert.equal(side?.price, 0.72);
  });

  it('skips a $0 rung when choosing the cheapest neon', () => {
    const neon = cheapestNeonAsk([
      item({ price: 0, pumping: 'neon', age: 'twinkle' }),
      item({ price: 3.07, pumping: 'neon', age: 'reborn' }),
    ]);
    assert.equal(neon?.price, 3.07);
  });

  it('returns null when every candidate is unpriced', () => {
    assert.equal(cheapestNormalInput([item({ price: 0 })]), null);
    assert.equal(cheapestNeonAsk([item({ price: 0, pumping: 'neon' })]), null);
  });
});

describe('the neon ladder is not ordered', () => {
  it('walks every rung instead of assuming reborn is cheapest', () => {
    // Three Blind Mice, as observed: reborn 0.22, twinkle 0 (no data),
    // sparkle 1.41, flare 1.20, sunshine 0.63, luminous 0.34.
    const rungs = [
      item({ price: 0.22, pumping: 'neon', age: 'reborn' }),
      item({ price: 0, pumping: 'neon', age: 'twinkle' }),
      item({ price: 1.41, pumping: 'neon', age: 'sparkle' }),
      item({ price: 1.2, pumping: 'neon', age: 'flare' }),
      item({ price: 0.63, pumping: 'neon', age: 'sunshine' }),
      item({ price: 0.34, pumping: 'neon', age: 'luminous' }),
    ];
    assert.equal(cheapestNeonAsk(rungs)?.price, 0.22);
    assert.deepEqual(
      neonLadder(rungs).map((r) => r.price),
      [0.22, 0.34, 0.63, 1.2, 1.41]
    );
  });

  it('finds the cheapest rung even when it is not the base age', () => {
    const rungs = [
      item({ price: 4.8, pumping: 'neon', age: 'reborn' }),
      item({ price: 3.07, pumping: 'neon', age: 'luminous' }),
    ];
    assert.equal(cheapestNeonAsk(rungs)?.price, 3.07);
    assert.equal(cheapestNeonAsk(rungs)?.age, 'luminous');
  });
});

describe('attribute matching', () => {
  it('compares the age ladder only inside one attribute combination', () => {
    // A cheap Full-Grown in a *different* variant must not be read as an
    // inversion of this variant's Newborn.
    const side = cheapestNormalInput([
      item({ price: 2.0, age: 'newborn', flyable: false, rideable: false }),
      item({ price: 2.5, age: 'full_grown', flyable: false, rideable: false }),
      item({ price: 0.5, age: 'full_grown', flyable: true, rideable: true }),
    ]);
    // The globally cheapest input is the flyable one at 0.50...
    assert.equal(side?.price, 0.5);
    assert.equal(side?.variantKey, 'default:true:true');
    // ...and because that variant has no newborn rung, no inversion is inferred.
    assert.equal(side?.newbornPrice, null);
  });

  it('reports an inversion when newborn and full-grown come from the same variant', () => {
    const items = [
      item({ price: 2.0, age: 'newborn', flyable: false, rideable: false }),
      item({ price: 1.5, age: 'full_grown', flyable: false, rideable: false }),
      item({ price: 9.0, age: 'newborn', flyable: true, rideable: true }),
    ];
    const side = cheapestNormalInput(items);
    assert.equal(side?.variantKey, 'default:false:false');
    assert.equal(side?.newbornPrice, 2.0);
    assert.equal(side?.fullGrownPrice, 1.5);

    const [opportunity] = buildOpportunities(
      [...items, item({ price: 6, pumping: 'neon', age: 'reborn' })],
      { maxNormalPrice: 100, margin: { feePct: 0, minReturnOnCapital: 0 } }
    );
    assert.ok(opportunity?.flags.includes('full_grown_cheaper_than_newborn'));
  });

  it('exposes both ends of a flat ladder, which is unpaid ageing', () => {
    // Three Blind Mice: newborn through full-grown were all $0.08, so ageing
    // six rungs moved the price by zero cents.
    const side = cheapestNormalInput([
      item({ price: 0.08, age: 'newborn' }),
      item({ price: 0.08, age: 'full_grown' }),
    ]);
    assert.equal(side?.newbornPrice, 0.08);
    assert.equal(side?.fullGrownPrice, 0.08);
    assert.equal((side?.fullGrownPrice ?? 0) - (side?.newbornPrice ?? 0), 0);
    assert.equal(side?.rungCount, 2);
  });

  it('lists the distinct attribute combinations present', () => {
    assert.deepEqual(
      variantKeys([
        item({ price: 1, flyable: false, rideable: false }),
        item({ price: 1, flyable: true, rideable: false }),
        item({ price: 1, pumping: 'neon' }),
      ]),
      ['default:false:false', 'default:true:false', 'neon:false:false']
    );
  });
});

describe('buildOpportunities on the verified pets', () => {
  const fixture: StoreItem[] = [
    // Dragonfruit Fox: 4 x 0.83 = 3.32 vs neon 4.78 -> +0.265 after 25% fee.
    item({ name: 'Dragonfruit Fox', realName: 'dragonfruit_fox', price: 0.83, age: 'newborn' }),
    item({ name: 'Dragonfruit Fox', realName: 'dragonfruit_fox', price: 0.83, age: 'full_grown' }),
    item({ name: 'Dragonfruit Fox', realName: 'dragonfruit_fox', price: 4.78, age: 'reborn', pumping: 'neon' }),
    // A real 416-dollar outlier must not disturb the minimum.
    item({ name: 'Dragonfruit Fox', realName: 'dragonfruit_fox', price: 416, age: 'newborn' }),
    // Sushi Penguin: 4 x 0.47 = 1.88 vs neon 2.21 -> -0.2225.
    item({ name: 'Sushi Penguin', realName: 'sushi_penguin', price: 0.47, age: 'newborn' }),
    item({ name: 'Sushi Penguin', realName: 'sushi_penguin', price: 2.21, age: 'reborn', pumping: 'neon' }),
    // Dango Penguins: 4 x 0.72 = 2.88 vs neon 3.07 -> -0.5775.
    item({ name: 'Dango Penguins', realName: 'dango_penguins', price: 0.72, age: 'newborn' }),
    item({ name: 'Dango Penguins', realName: 'dango_penguins', price: 0, age: 'twinkle', pumping: 'neon' }),
    item({ name: 'Dango Penguins', realName: 'dango_penguins', price: 3.07, age: 'reborn', pumping: 'neon' }),
    // Three Blind Mice: 4 x 0.08 = 0.32 vs neon 0.22 -> -0.155.
    item({ name: 'Three Blind Mice', realName: 'three_blind_mice', price: 0.08, age: 'newborn' }),
    item({ name: 'Three Blind Mice', realName: 'three_blind_mice', price: 0.22, age: 'reborn', pumping: 'neon' }),
  ];

  const opportunities = buildOpportunities(fixture, { maxNormalPrice: 100 });
  const byName = new Map(opportunities.map((o) => [o.petName, o]));

  it('evaluates every pet that has both sides', () => {
    assert.equal(opportunities.length, 4);
  });

  it('reproduces the verified margins and verdicts', () => {
    const expected: Array<[string, number, string]> = [
      ['Dragonfruit Fox', 0.265, 'craft'],
      ['Sushi Penguin', -0.2225, 'skip'],
      ['Dango Penguins', -0.5775, 'skip'],
      ['Three Blind Mice', -0.155, 'skip'],
    ];
    for (const [name, margin, verdict] of expected) {
      const found = byName.get(name);
      assert.ok(found, `missing ${name}`);
      assert.ok(Math.abs(found.margin - margin) < 1e-3, `${name}: ${found.margin} != ${margin}`);
      assert.equal(found.verdict, verdict, `${name} verdict`);
    }
  });

  it('ignores the $416 outlier when choosing the input', () => {
    assert.equal(byName.get('Dragonfruit Fox')?.normalPrice, 0.83);
  });

  it('reports the break-even ratio on every row', () => {
    for (const opportunity of opportunities) {
      assert.ok(Math.abs(opportunity.breakEvenRatio - 5.333333) < 1e-4);
    }
  });

  it('flags the pet that has a zero-priced rung', () => {
    assert.ok(byName.get('Dango Penguins')?.flags.includes('no_data_zero_price'));
  });

  it('respects the capital cap on the input side', () => {
    const capped = buildOpportunities(fixture, { maxNormalPrice: 0.5 });
    assert.deepEqual(
      capped.map((o) => o.petName).sort(),
      ['Sushi Penguin', 'Three Blind Mice']
    );
  });

  it('excludes a pet that is missing one side entirely', () => {
    const only = buildOpportunities([item({ price: 1 })], {});
    assert.equal(only.length, 0);
  });
});
