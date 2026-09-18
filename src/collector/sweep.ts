/**
 * The sweep: walk every priced Adopt Me pet item, working around the
 * market's hard `page <= 120` cap by recursively partitioning on price.
 *
 * A naive "just page through everything" sweep silently truncates: an
 * unfiltered ascending query bottoms out at $0.60 by page 120, so every neon
 * (which is the entire point of the product) is invisible. The band recursion
 * is what makes the result complete.
 */

import { MAX_ITEMS_PER_QUERY, MarketApi, MarketUnavailableError } from '../core/api.ts';
import {
  MIN_SWEEP_PRICE,
  type Band,
  type WorkItem,
  bandLabel,
  expandBand,
  fullRange,
  planBand,
  prioritiseQueue,
} from '../core/bands.ts';
import type { StoreItem } from '../core/types.ts';
import type { Store } from './store.ts';

export interface SweepOptions {
  currency?: string;
  pageSize?: number;
  /** Safety valve against a pathological partition loop. */
  maxBands?: number;
  /**
   * Lowest price to sweep. Defaults above zero: `price === 0` is the "no data"
   * sentinel for roughly half the catalog and can never be an opportunity.
   */
  minPrice?: number;
  /** How many bands may fail before the sweep is considered unusable. */
  maxFailedBands?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface SweepResult {
  items: StoreItem[];
  itemCount: number;
  petCount: number;
  bands: number;
  requests: number;
  durationMs: number;
  failedBands: string[];
  /** True when the host stopped answering and the sweep was abandoned. */
  aborted: boolean;
}

/** Sweep the whole catalog for one game and return deduplicated items. */
export async function sweepOnce(api: MarketApi, options: SweepOptions = {}): Promise<SweepResult> {
  const currency = options.currency ?? api.currency;
  const pageSize = Math.min(options.pageSize ?? 72, 72);
  const maxBands = options.maxBands ?? 400;
  const maxFailedBands = options.maxFailedBands ?? 25;
  const log = options.onProgress ?? (() => {});
  const startedAt = Date.now();

  const stack: Band[] = [fullRange(options.minPrice ?? MIN_SWEEP_PRICE)];
  const collected = new Map<number, StoreItem>();
  const failedBands: string[] = [];
  let bands = 0;
  let aborted = false;

  const baseFilter = (band: Band) => ({
    types: [{ type: 'pet' }],
    price: { min: band.min, max: band.max },
  });

  while (stack.length > 0) {
    if (options.signal?.aborted) break;
    if (bands >= maxBands) {
      log(`stopping: reached maxBands (${maxBands})`);
      break;
    }
    const band = stack.pop();
    if (!band) break;
    bands++;

    try {
      const first = await api.listItems({
        filter: baseFilter(band),
        page: 1,
        amount: pageSize,
        currency,
        sort: { price: 'asc' },
        signal: options.signal,
      });

      // Reuse the count query's page rather than refetching it.
      for (const item of first.items ?? []) collected.set(item.id, item);

      const decision = planBand(band, first.count ?? 0, MAX_ITEMS_PER_QUERY);

      if (decision.kind === 'empty') continue;

      if (decision.kind === 'unsplittable') {
        // Should be unreachable now that the sweep floor is above zero, but if
        // it ever happens we page what we can and say so rather than looping.
        failedBands.push(bandLabel(band));
        log(`WARNING band ${bandLabel(band)} cannot be split (count ${first.count}); paging best-effort`);
        await pageBand(api, band, currency, pageSize, collected, 120, options.signal);
        continue;
      }

      if (decision.kind === 'split') {
        stack.push(decision.right, decision.left);
        continue;
      }

      // Pages 2..N; page 1 is already collected above.
      const total = decision.pages;
      log(`band ${bandLabel(band)}: count=${first.count} pages=${total}`);
      for (let page = 2; page <= total; page++) {
        if (options.signal?.aborted) break;
        const result = await api.listItems({
          filter: baseFilter(band),
          page,
          amount: pageSize,
          currency,
          sort: { price: 'asc' },
          signal: options.signal,
        });
        for (const item of result.items ?? []) collected.set(item.id, item);
      }
    } catch (error) {
      // A block is not a per-band problem: stop immediately rather than
      // deepening it with hundreds more attempts.
      if (error instanceof MarketUnavailableError) {
        log(`ABORT: ${error.message}`);
        aborted = true;
        break;
      }
      failedBands.push(bandLabel(band));
      log(`band ${bandLabel(band)} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (failedBands.length >= maxFailedBands) {
        log(`ABORT: ${failedBands.length} bands failed`);
        aborted = true;
        break;
      }
    }
  }

  const items = [...collected.values()];
  const pets = new Set(items.map((i) => i.realName));
  return {
    items,
    itemCount: items.length,
    petCount: pets.size,
    bands,
    requests: api.metrics.requests,
    durationMs: Date.now() - startedAt,
    failedBands,
    aborted,
  };
}

async function pageBand(
  api: MarketApi,
  band: Band,
  currency: string,
  pageSize: number,
  into: Map<number, StoreItem>,
  maxPage: number,
  signal?: AbortSignal
): Promise<void> {
  for (let page = 2; page <= maxPage; page++) {
    if (signal?.aborted) break;
    const result = await api.listItems({
      filter: { types: [{ type: 'pet' }], price: { min: band.min, max: band.max } },
      page,
      amount: pageSize,
      currency,
      sort: { price: 'asc' },
      signal,
    });
    if ((result.items ?? []).length === 0) break;
    for (const item of result.items) into.set(item.id, item);
  }
}

/** Sweep and persist. Records a sweeps row so staleness is observable. */
export async function runSweep(
  api: MarketApi,
  store: Store,
  options: SweepOptions = {}
): Promise<SweepResult> {
  const startedAt = Date.now();
  const sweepId = store.startSweep(startedAt);
  try {
    const result = await sweepOnce(api, options);
    const finishedAt = Date.now();
    // Persist whatever was seen. A partial sweep still refreshes prices for
    // the items it did reach, which beats discarding them.
    store.writeItems(result.items, finishedAt);
    store.finishSweep(sweepId, {
      finishedAt,
      requests: result.requests,
      itemsSeen: result.itemCount,
      bands: result.bands,
      status: result.aborted ? 'error' : 'ok',
      error: result.aborted
        ? `aborted after ${result.failedBands.length} failed bands`
        : null,
    });
    return result;
  } catch (error) {
    store.finishSweep(sweepId, {
      finishedAt: Date.now(),
      requests: api.metrics.requests,
      itemsSeen: 0,
      bands: 0,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// -------------------------------------------------------------------------
// Budgeted, resumable sweeping
// -------------------------------------------------------------------------

/**
 * Requests allowed per cycle.
 *
 * Measured, not guessed: the host stops answering after roughly **50** requests
 * in a window. Two attempts to sweep at scale were cut short at ~52 requests,
 * the second while pacing at only 0.45 req/s — so the limit is on volume, not
 * on rate, and pacing alone does not avoid it. 35 leaves deliberate headroom
 * for retries and for the rest of the app's occasional calls.
 */
export const DEFAULT_REQUEST_BUDGET = 35;

export interface BudgetedSweepOptions extends SweepOptions {
  /** Maximum requests this cycle may spend. */
  requestBudget?: number;
  /** Start a fresh pass when the queue drains (the normal watch behaviour). */
  restartWhenComplete?: boolean;
}

export interface BudgetedCycleResult {
  itemCount: number;
  petCount: number;
  requests: number;
  tasksDone: number;
  queueDepth: number;
  /** True when the queue drained: the catalog was fully covered this cycle. */
  complete: boolean;
  durationMs: number;
  aborted: boolean;
  truncated: string[];
}

/**
 * One budgeted slice of a sweep, resumable across process restarts.
 *
 * The host's ~50-request ceiling makes a single-pass full sweep impossible, so
 * progress is checkpointed in the database and successive cycles walk the
 * catalog. Because the queue is consumed cheapest-band first, the pets that
 * matter under a capital cap are refreshed most often while the expensive tail
 * fills in over hours.
 */
export async function runBudgetedCycle(
  api: MarketApi,
  store: Store,
  options: BudgetedSweepOptions = {}
): Promise<BudgetedCycleResult> {
  const budget = Math.max(1, options.requestBudget ?? DEFAULT_REQUEST_BUDGET);
  const pageSize = Math.min(options.pageSize ?? 72, 72);
  const currency = options.currency ?? api.currency;
  const minPrice = options.minPrice ?? MIN_SWEEP_PRICE;
  const log = options.onProgress ?? (() => {});
  const restart = options.restartWhenComplete ?? true;

  const startedAt = Date.now();
  const startRequests = api.metrics.requests;
  const sweepId = store.startSweep(startedAt);

  const state = store.loadSweepState();
  const truncated = new Set(state.truncated);

  // An empty queue means the previous pass finished; begin a fresh one.
  const loaded = state.queue.slice();
  if (loaded.length === 0) loaded.push({ band: fullRange(minPrice), page: null });

  // Probes before pages, including on resume: a queue checkpointed by an older
  // build may still be ordered depth-first, and re-normalising it here is what
  // lets such a queue finish mapping the range instead of resuming the grind.
  const queue: WorkItem[] = prioritiseQueue(loaded);

  const collected = new Map<number, StoreItem>();
  let tasksDone = 0;
  let aborted = false;

  try {
    while (queue.length > 0 && api.metrics.requests - startRequests < budget) {
      if (options.signal?.aborted) break;

      // Pick the earliest frontier probe, wherever it sits.
      //
      // Selection has to happen here rather than by normalising the array,
      // because expansions are appended: the very next probe lands *behind*
      // any pages already queued, and indexing position 0 would quietly resume
      // the depth-first grind this was meant to fix. (It did exactly that —
      // a 35-request cycle spent itself filling $0.01-$0.16 while the probes
      // for $0.16-$2.56 sat in the queue unrun.)
      const probeIndex = queue.findIndex((item) => item.page === null);
      const taskIndex = probeIndex === -1 ? 0 : probeIndex;

      // Peek rather than pop: the checkpoint below keeps the in-flight task
      // queued, so a crash or block re-does one idempotent page fetch instead
      // of losing it.
      const task = queue[taskIndex] as WorkItem;

      const result = await api.listItems({
        filter: { types: [{ type: 'pet' }], price: { min: task.band.min, max: task.band.max } },
        page: task.page ?? 1,
        amount: pageSize,
        currency,
        sort: { price: 'asc' },
        signal: options.signal,
      });

      for (const item of result.items ?? []) collected.set(item.id, item);

      if (task.page === null) {
        const expansion = expandBand(task.band, result.count ?? 0, MAX_ITEMS_PER_QUERY);
        if (expansion === 'unsplittable') {
          truncated.add(bandLabel(task.band));
          log(`band ${bandLabel(task.band)} cannot be split (count ${result.count}); best-effort paging`);
          for (let page = 120; page >= 2; page--) queue.push({ band: task.band, page });
        } else if (expansion.length > 0) {
          log(`band ${bandLabel(task.band)}: count=${result.count} -> ${expansion.length} task(s)`);
          // Append, never front-load.
          //
          // Front-loading is what made a budgeted sweep behave depth-first: the
          // children of the band just probed were placed ahead of every sibling
          // still waiting, so the sweep refined $0.01-$0.04 to exhaustion —
          // pages included — before it ever asked what a $20 pet costs. A live
          // run spent its entire budget there and concluded nothing was
          // profitable, having seen a maximum ask of $0.11.
          //
          // Appending makes the probes breadth-first: every band at the current
          // level is mapped before any one of them is refined, so a few dozen
          // requests buy a picture of the whole price range.
          queue.push(...expansion);
        }
      }

      // Success: retire the task and checkpoint immediately.
      queue.splice(taskIndex, 1);
      tasksDone++;
      store.saveSweepQueue(prioritiseQueue(queue), [...truncated]);
    }
  } catch (error) {
    if (error instanceof MarketUnavailableError) {
      // Expected, not exceptional: the queue is already checkpointed, so the
      // next cycle simply continues where this one stopped.
      log(`budget/block reached: ${error.message}`);
      aborted = true;
    } else {
      store.finishSweep(sweepId, {
        finishedAt: Date.now(),
        requests: api.metrics.requests - startRequests,
        itemsSeen: collected.size,
        bands: tasksDone,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const finishedAt = Date.now();
  const complete = queue.length === 0 && !aborted;

  // Persist everything this cycle observed, even when interrupted: partial
  // progress is real progress, and a stale row is worse than a fresh one.
  store.writeItems([...collected.values()], finishedAt);
  store.saveSweepQueue(queue, [...truncated]);
  store.finishSweepCycle(finishedAt, tasksDone, complete);
  store.finishSweep(sweepId, {
    finishedAt,
    requests: api.metrics.requests - startRequests,
    itemsSeen: collected.size,
    bands: tasksDone,
    status: aborted ? 'error' : 'ok',
    error: aborted ? 'request budget exhausted; resuming next cycle' : null,
  });

  if (complete && restart) {
    log('full pass complete; queue reseeded for the next pass');
  }

  return {
    itemCount: collected.size,
    petCount: new Set([...collected.values()].map((i) => i.realName)).size,
    requests: api.metrics.requests - startRequests,
    tasksDone,
    queueDepth: queue.length,
    complete,
    durationMs: finishedAt - startedAt,
    aborted,
    truncated: [...truncated],
  };
}

/**
 * Poll forever at the cadence the market can actually honour.
 *
 * Two independent ceilings shape this: the site serves category data from a
 * 4-minute CDN cache, so polling faster yields identical bytes; and the host
 * blocks after roughly 50 requests, so each cycle spends a small, fixed budget
 * and resumes from a checkpoint on the next one.
 */
export async function watchSweep(
  api: MarketApi,
  store: Store,
  options: BudgetedSweepOptions & {
    intervalMs?: number;
    historyRetentionMs?: number;
    staleItemMs?: number;
    onCycle?: (result: SweepResult) => void;
  } = {}
): Promise<never> {
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  const retention = options.historyRetentionMs ?? 14 * 24 * 60 * 60_000;
  const stale = options.staleItemMs ?? 30 * 60_000;
  const log = options.onProgress ?? (() => {});
  let backoffMs = intervalMs;

  for (;;) {
    try {
      const result = await runBudgetedCycle(api, store, options);
      const now = Date.now();
      store.pruneStaleItems(now, stale);
      const pruned = store.pruneHistory(now - retention);

      log(
        `cycle done: +${result.itemCount} items / ${result.petCount} pets in ` +
          `${(result.durationMs / 1000).toFixed(1)}s over ${result.requests} requests; ` +
          `queue depth ${result.queueDepth}${result.complete ? ' (full pass complete)' : ''}` +
          (pruned > 0 ? ` (pruned ${pruned} history rows)` : '')
      );
      store.pruneStaleItems(now, stale);

      // A block means the host stopped answering, not that anything is wrong
      // with us: wait longer, but the queue means we lose no work.
      backoffMs = result.aborted ? Math.min(backoffMs * 2, 30 * 60_000) : intervalMs;
      if (result.aborted && backoffMs > intervalMs) {
        log(`waiting ${Math.round(backoffMs / 1000)}s before the next cycle`);
      }

      options.onCycle?.({
        items: [],
        itemCount: result.itemCount,
        petCount: result.petCount,
        bands: result.tasksDone,
        requests: result.requests,
        durationMs: result.durationMs,
        failedBands: [],
        aborted: result.aborted,
      });
    } catch (error) {
      log(`cycle failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
}
