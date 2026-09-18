/**
 * The below-average signal.
 *
 * This is the weaker of the two signals the scanner reports, and the tests are
 * mostly about the ways it could lie:
 *
 *  - `avgPrice` is emitted equal to the current ask on a large share of the
 *    catalog. Treating that as "priced at its average" would manufacture a 0%
 *    discount; treating it as a real signal would manufacture a fake edge.
 *  - The sell-side fee applies to the *exit*, so it has to come off the
 *    proceeds before the margin means anything.
 *  - A big percentage off a very cheap pet is not the same as a real edge, so
 *    the discount floor and the absolute-margin floor are separate gates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlips } from '../../src/core/opportunities.ts';
import type { StoreItem } from '../../src/core/types.ts';

function item(partial: Partial<StoreItem> & { id: number; price: number; avgPrice: number | null }): StoreItem {
  return {
    goodId: 'x',
    name: 'Test Pet',
    type: 'pet',
    realName: 'test_pet',
    imageId: null,
    imageUri: null,
    subtype: null,
    age: 'newborn',
    rare: 'rare',
    pumping: 'default',
    flyable: false,
    rideable: false,
    bonuses: 0,
    ...partial,
  } as StoreItem;
}

test('a row priced below its own average is reported with the fee taken off the exit', () => {
  const flips = buildFlips([item({ id: 1, price: 0.05, avgPrice: 0.16 })], { feePct: 0.25 });
  assert.equal(flips.length, 1);

  const [flip] = flips;
  assert.ok(flip);
  // 0.16 * 0.75 = 0.12, minus the 0.05 ask.
  assert.equal(Number(flip.netProceeds.toFixed(4)), 0.12);
  assert.equal(Number(flip.margin.toFixed(4)), 0.07);
  assert.equal(flip.verdict, 'watch');
});

test('an average equal to the ask carries no signal and is dropped, not scored as 0% off', () => {
  const flips = buildFlips([item({ id: 1, price: 0.05, avgPrice: 0.05 })], { feePct: 0.25 });
  assert.equal(flips.length, 0);
});

test('a row priced at or above its average is not a flip', () => {
  const flips = buildFlips(
    [
      item({ id: 1, price: 0.2, avgPrice: 0.1 }),
      item({ id: 2, price: 0.1, avgPrice: 0.1 }),
    ],
    { feePct: 0.25 }
  );
  assert.equal(flips.length, 0);
});

test('rows with no usable average are skipped rather than treated as free money', () => {
  const flips = buildFlips(
    [
      item({ id: 1, price: 0.05, avgPrice: null }),
      item({ id: 2, price: 0.05, avgPrice: 0 }),
      item({ id: 3, price: 0, avgPrice: 0.5 }),
    ],
    { feePct: 0.25 }
  );
  assert.equal(flips.length, 0);
});

test('the fee decides whether a discount is an edge or a loss', () => {
  const items = [item({ id: 1, price: 0.08, avgPrice: 0.1 })];

  // 0.1 * 0.75 = 0.075, below the 0.08 ask: a "20% discount" that loses money.
  const noFee = buildFlips(items, { feePct: 0, minDiscountPct: 0.15 });
  assert.equal(noFee.length, 1);
  assert.equal(noFee[0]?.verdict, 'watch');

  const withFee = buildFlips(items, { feePct: 0.25, minDiscountPct: 0.15 });
  assert.equal(withFee.length, 1);
  assert.equal(withFee[0]?.verdict, 'weak');
  assert.ok((withFee[0]?.margin ?? 0) < 0);
});

test('the discount floor and the absolute-margin floor are enforced separately', () => {
  // 28.6% off, but the fee leaves only half a cent of margin. Clearing the
  // percentage floor is not enough on its own.
  const tiny = buildFlips([item({ id: 1, price: 0.1, avgPrice: 0.14 })], { feePct: 0.25 });
  assert.equal(tiny.length, 1);
  assert.ok((tiny[0]?.discountPct ?? 0) > 0.15, 'it does clear the percentage floor');
  assert.equal(tiny[0]?.verdict, 'weak', 'a percentage on a trivial amount is not a trade');

  const sizeable = buildFlips([item({ id: 2, price: 0.11, avgPrice: 0.33 })], { feePct: 0.25 });
  assert.equal(sizeable[0]?.verdict, 'watch');
});

test('a low discount never earns a watch even when the margin is large', () => {
  const flips = buildFlips([item({ id: 1, price: 0.9, avgPrice: 1.0 })], {
    feePct: 0,
    minDiscountPct: 0.15,
  });
  assert.equal(flips.length, 1);
  assert.equal(flips[0]?.verdict, 'weak');
});

test('results are ranked by discount, then by absolute margin', () => {
  const flips = buildFlips(
    [
      item({ id: 1, price: 0.5, avgPrice: 1.0 }), // 50%
      item({ id: 2, price: 0.05, avgPrice: 0.2 }), // 75%
      item({ id: 3, price: 0.4, avgPrice: 1.0 }), // 60%
    ],
    { feePct: 0 }
  );
  assert.deepEqual(
    flips.map((f) => f.productId),
    [2, 3, 1]
  );
});

test('the capital cap bounds the ask, so a cheap band can be scanned alone', () => {
  const items = [
    item({ id: 1, price: 0.05, avgPrice: 0.2 }),
    item({ id: 2, price: 9.0, avgPrice: 20 }),
  ];
  assert.equal(buildFlips(items, { feePct: 0, maxAsk: 3 }).length, 1);
  assert.equal(buildFlips(items, { feePct: 0, maxAsk: 30 }).length, 2);
});

test('sibling count says how much of the pet is under its average, not just this rung', () => {
  const flips = buildFlips(
    [
      item({ id: 1, price: 0.05, avgPrice: 0.2 }),
      item({ id: 2, price: 0.06, avgPrice: 0.2, age: 'reborn' }),
      item({ id: 3, price: 0.07, avgPrice: 0.2, age: 'twinkle' }),
    ],
    { feePct: 0 }
  );
  assert.equal(flips.length, 3);
  assert.deepEqual(
    flips.map((f) => f.siblingsBelow).sort(),
    [2, 2, 2]
  );
});

test('a non-http image uri is dropped rather than rendered as a broken tile', () => {
  const flips = buildFlips(
    [
      item({ id: 1, price: 0.05, avgPrice: 0.2, imageUri: 'abc123' }),
      item({ id: 2, price: 0.05, avgPrice: 0.2, imageUri: 'https://cdn.example/x.webp' }),
    ],
    { feePct: 0 }
  );
  assert.equal(flips[0]?.imageUri, null);
  assert.equal(flips[1]?.imageUri, 'https://cdn.example/x.webp');
});
