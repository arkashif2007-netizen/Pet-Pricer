import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeQueue, encodeQueue, expandBand, fullRange, queueDepth } from '../../src/core/bands.ts';
import type { WorkItem } from '../../src/core/bands.ts';

const ITEMS_PER_QUERY = 120 * 72;

describe('work queue serialisation', () => {
  it('round-trips probes and page tasks', () => {
    const queue: WorkItem[] = [
      { band: { min: 0.01, max: null }, page: null },
      { band: { min: 0.02, max: 0.09 }, page: 7 },
      { band: { min: 4, max: 16 }, page: 120 },
    ];
    assert.deepEqual(decodeQueue(encodeQueue(queue)), queue);
  });

  it('keeps an unbounded top as null rather than falling over', () => {
    const queue: WorkItem[] = [{ band: { min: 16, max: null }, page: null }];
    const decoded = decodeQueue(encodeQueue(queue));
    assert.equal(decoded[0]?.band.max, null);
  });

  it('survives corrupt state by starting over instead of throwing', () => {
    // Losing progress is bad; refusing to boot is worse.
    assert.deepEqual(decodeQueue('not json'), []);
    assert.deepEqual(decodeQueue(''), []);
    assert.deepEqual(decodeQueue('{"a":1}'), []);
    assert.deepEqual(decodeQueue('[[1]]'), []);
  });

  it('reports depth', () => {
    assert.equal(queueDepth([]), 0);
    assert.equal(queueDepth([{ band: fullRange(), page: null }]), 1);
  });
});

describe('expandBand', () => {
  it('returns nothing for an empty band', () => {
    assert.deepEqual(expandBand({ min: 1, max: 2 }, 0, ITEMS_PER_QUERY), []);
  });

  it('enqueues the remaining pages, ascending, never re-asking page 1', () => {
    // count 297 -> 5 pages; page 1 was the probe, so 2..5 remain.
    const items = expandBand({ min: 3, max: 3.2 }, 297, ITEMS_PER_QUERY);
    assert.ok(Array.isArray(items));
    assert.deepEqual(
      (items as WorkItem[]).map((t) => t.page),
      [2, 3, 4, 5]
    );
  });

  it('puts the cheaper half ahead of the dearer half when splitting', () => {
    // Ordering matters: a budgeted sweep is usually interrupted long before
    // the expensive tail, and the cheap bands are the ones worth refreshing.
    const items = expandBand({ min: 0.01, max: null }, ITEMS_PER_QUERY + 1, ITEMS_PER_QUERY) as WorkItem[];
    assert.equal(items.length, 2);
    assert.equal(items[0]?.band.min, 0.01);
    assert.ok((items[0]?.band.max ?? 0) < 1);
    assert.ok((items[1]?.band.min ?? 0) >= (items[0]?.band.max ?? 0));
    assert.equal(items[0]?.page, null, 'both halves are frontier probes');
    assert.equal(items[1]?.page, null);
  });

  it('flags a band it cannot divide', () => {
    assert.equal(expandBand({ min: 2, max: 2 }, ITEMS_PER_QUERY + 1, ITEMS_PER_QUERY), 'unsplittable');
  });

  it('never asks for more pages than the market allows', () => {
    const items = expandBand({ min: 0.01, max: 1 }, ITEMS_PER_QUERY, ITEMS_PER_QUERY) as WorkItem[];
    assert.equal(items.length, 119, 'page 1 is the probe; pages 2..120 remain');
    assert.equal(Math.max(...items.map((t) => t.page ?? 0)), 120);
  });
});
