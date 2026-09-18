/**
 * Coverage reporting.
 *
 * The point of this report is to stop a thin profitable list from reading as a
 * thin market. These tests pin the two claims it makes:
 *
 *  1. The band actually reached is measured, not asserted.
 *  2. `profitableBandUnreached` is an exact statement about the data on hand,
 *     not a guess: it is true only when no pairing of the highest neon ask with
 *     the cheapest input ask could clear the fee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCoverage } from '../../src/service.ts';
import type { StoreItem } from '../../src/core/types.ts';

function item(partial: Partial<StoreItem> & { id: number; price: number }): StoreItem {
  return {
    goodId: 'x',
    name: partial.realName ?? 'Test Pet',
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
    avgPrice: null,
    bonuses: 0,
    ...partial,
  } as StoreItem;
}

test('a snapshot that never reached the profitable band says so, exactly', () => {
  // The real observed shape: inputs $0.03-0.04, neons topping out at $0.11.
  // Best case 0.11 * 0.75 = 0.0825 against 4 * 0.03 = 0.12, so nothing here
  // could ever have shown a profit at any ratio.
  const items = [
    item({ id: 1, price: 0.03, realName: 'cheap_pet', name: 'Cheap Pet' }),
    item({ id: 2, price: 0.11, realName: 'cheap_pet', name: 'Cheap Pet', pumping: 'neon' }),
    item({ id: 3, price: 0.04, realName: 'dearer_pet', name: 'Dearer Pet' }),
    item({ id: 4, price: 0.08, realName: 'dearer_pet', name: 'Dearer Pet', pumping: 'neon' }),
  ];
  const coverage = computeCoverage(items, 2, 3, 0.25);

  assert.equal(coverage.profitableBandUnreached, true);
  assert.equal(coverage.petsEvaluable, 2);
  assert.equal(coverage.maxInputAskObserved, 0.04);
  assert.equal(coverage.maxAskObserved, 0.11);
  assert.equal(coverage.inputBandReached, '$0.03 - $0.04');
  assert.ok(coverage.inputRangeCovered < 0.02);
});

test('one affordable pairing is enough to clear the flag', () => {
  const items = [
    item({ id: 1, price: 0.5 }),
    item({ id: 2, price: 4.0, pumping: 'neon' }),
  ];
  const coverage = computeCoverage(items, 1, 3, 0.25);
  // 4.0 * 0.75 = 3.0 > 4 * 0.03... but the cheapest input here is 0.5, and
  // 4 * 0.5 = 2.0 < 3.0, so a profit is arithmetically reachable.
  assert.equal(coverage.profitableBandUnreached, false);
});

test('a zero-priced neon cannot rescue the flag, because 0 is not a price', () => {
  const items = [
    item({ id: 1, price: 0.03 }),
    item({ id: 2, price: 0, pumping: 'neon' }),
  ];
  const coverage = computeCoverage(items, 1, 3, 0.25);
  assert.equal(coverage.itemsNoData, 1);
  assert.equal(coverage.itemsPriced, 1);
  assert.equal(coverage.maxAskObserved, 0.03);
  assert.equal(coverage.profitableBandUnreached, true);
});

test('pets are counted as evaluable only with both sides priced', () => {
  const items = [
    item({ id: 1, price: 1, realName: 'both' }),
    item({ id: 2, price: 6, realName: 'both', pumping: 'neon' }),
    item({ id: 3, price: 1, realName: 'input_only' }),
    item({ id: 4, price: 0, realName: 'input_only', pumping: 'neon' }),
    item({ id: 5, price: 0, realName: 'nothing' }),
  ];
  const coverage = computeCoverage(items, 3, 3, 0.25);

  assert.equal(coverage.petsInCatalog, 3);
  assert.equal(coverage.petsEvaluable, 1);
  assert.equal(coverage.petsInputOnly, 1);
  assert.equal(coverage.itemsTotal, 5);
  assert.equal(coverage.itemsNoData, 2);
});

test('the cap drives the coverage fraction, so it is a statement about the cap', () => {
  const items = [item({ id: 1, price: 1.5 })];
  assert.equal(computeCoverage(items, 1, 3, 0.25).inputRangeCovered, 0.5);
  assert.equal(computeCoverage(items, 1, 1.5, 0.25).inputRangeCovered, 1);
});

test('an empty snapshot reports nothing rather than a divide-by-zero band', () => {
  const coverage = computeCoverage([], 0, 3, 0.25);
  assert.equal(coverage.itemsTotal, 0);
  assert.equal(coverage.maxAskObserved, 0);
  assert.equal(coverage.inputBandReached, 'none');
  assert.equal(coverage.profitableBandUnreached, false);
});
