#!/usr/bin/env node
/**
 * Collector CLI.
 *
 *   node src/collector/cli.ts sweep          one budgeted cycle (resumable)
 *   node src/collector/cli.ts sweep --full   one unbounded pass (see warning)
 *   node src/collector/cli.ts watch          budgeted cycles on a cadence
 *   node src/collector/cli.ts stats          snapshot, queue depth and coverage
 *
 * `sweep` is budgeted by default. That is not timidity: the host stops
 * answering after roughly 50 requests, so a single-pass full sweep is not
 * possible. Each cycle spends a fixed budget, checkpoints its position in the
 * database, and the next cycle resumes exactly where it stopped.
 * `--full` exists for a local/staging host without that ceiling.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../config.ts';
import { MarketApi } from '../core/api.ts';
import { DEFAULT_MARGIN_CONFIG } from '../core/margin.ts';
import { buildOpportunities } from '../core/opportunities.ts';
import { DEFAULT_REQUEST_BUDGET, runBudgetedCycle, runSweep, watchSweep } from './sweep.ts';
import { Store } from './store.ts';

function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return new Store(path);
}

function makeApi(config: ReturnType<typeof loadConfig>): MarketApi {
  return new MarketApi({
    baseUrl: config.storeBaseUrl,
    currency: config.currency,
    concurrency: config.concurrency,
    minIntervalMs: config.minIntervalMs,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'sweep';
  const full = args.includes('--full');
  const config = loadConfig();
  const budgetArg = args.find((a) => a.startsWith('--budget='));
  const parsedBudget = budgetArg ? Number(budgetArg.split('=')[1]) : NaN;
  const requestBudget = Number.isFinite(parsedBudget)
    ? Math.max(1, parsedBudget)
    : config.requestBudget || DEFAULT_REQUEST_BUDGET;
  const store = openStore(config.dbPath);
  const api = makeApi(config);
  const log = (message: string) => console.log(`[collector] ${message}`);

  try {
    if (command === 'sweep') {
      if (full) {
        log(`UNBOUNDED sweep of ${config.storeBaseUrl} — this will very likely get you blocked`);
        const result = await runSweep(api, store, { currency: config.currency, onProgress: log });
        log(
          `done: ${result.itemCount} items / ${result.petCount} pets, ${result.bands} bands, ` +
            `${result.requests} requests, ${(result.durationMs / 1000).toFixed(1)}s`
        );
        if (result.failedBands.length > 0) log(`WARNING failed bands: ${result.failedBands.join(', ')}`);
        if (result.aborted) log('aborted early');
      } else {
        log(`budgeted cycle of ${config.storeBaseUrl} (budget ${requestBudget} requests)`);
        const result = await runBudgetedCycle(api, store, {
          currency: config.currency,
          requestBudget,
          onProgress: log,
        });
        log(
          `cycle: +${result.itemCount} items / ${result.petCount} pets, ${result.tasksDone} tasks, ` +
            `${result.requests} requests in ${(result.durationMs / 1000).toFixed(1)}s`
        );
        log(
          result.complete
            ? 'QUEUE EMPTY — the catalog is fully covered'
            : `queue depth ${result.queueDepth} tasks remaining (~${result.queueDepth} requests)`
        );
      }
      report(store, config);
      return;
    }

    if (command === 'watch') {
      log(
        `watching every ${config.intervalMs / 1000}s, ${requestBudget} requests per cycle — ` +
          'progress is checkpointed, so this resumes across restarts'
      );
      await watchSweep(api, store, {
        currency: config.currency,
        requestBudget,
        intervalMs: config.intervalMs,
        historyRetentionMs: config.historyRetentionMs,
        onProgress: log,
      });
      return;
    }

    if (command === 'stats') {
      report(store, config);
      const state = store.loadSweepState();
      log(
        `queue: ${state.queue.length} task(s); ${state.tasksDone} done over ${state.cycles} cycle(s)`
      );
      if (state.queue.length > 0) {
        const next = state.queue
          .slice(0, 3)
          .map((t) => (t.page === null ? `probe $${t.band.min}` : `page ${t.page}`))
          .join(', ');
        log(`next up: ${next}`);
      }
      if (state.lastFullCycleAt) {
        log(`last full pass: ${new Date(state.lastFullCycleAt).toISOString()}`);
      }
      if (state.truncated.length > 0) {
        log(`WARNING unsplittable bands: ${state.truncated.join(', ')}`);
      }
      for (const sweep of store.recentSweeps(5)) {
        log(`sweep #${sweep.id} ${sweep.status} ${sweep.itemsSeen} items ${sweep.requests} req ${sweep.durationMs ?? 0}ms`);
      }
      return;
    }

    console.error(`unknown command: ${command}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

function report(store: Store, config: ReturnType<typeof loadConfig>): void {
  const items = store.currentItems();
  const opportunities = buildOpportunities(items, {
    margin: { ...DEFAULT_MARGIN_CONFIG, feePct: config.feePct, minReturnOnCapital: config.minReturnOnCapital },
    maxNormalPrice: config.maxNormalPrice,
    units: config.units,
  });

  const craft = opportunities.filter((o) => o.verdict === 'craft').length;
  const marginal = opportunities.filter((o) => o.verdict === 'marginal').length;
  const skip = opportunities.filter((o) => o.verdict === 'skip').length;
  const best = [...opportunities].sort((a, b) => b.margin - a.margin).slice(0, 5);
  const be = (4 / (1 - config.feePct)).toFixed(3);

  console.log('');
  console.log(`snapshot: ${items.length} priced items across ${store.petCount()} pets`);
  console.log(`verdicts: craft=${craft} marginal=${marginal} skip=${skip}`);
  console.log(`fee=${(config.feePct * 100).toFixed(0)}%  break-even ratio=${be}x  cap=$${config.maxNormalPrice}`);

  if (best.length > 0) {
    console.log('');
    console.log('top candidates by margin:');
    for (const o of best) {
      console.log(
        `  ${o.petName.padEnd(26)} normal $${o.normalPrice.toFixed(2)} (${o.normalAge ?? 'n/a'}) ` +
          `neon $${o.neonPrice.toFixed(2)} (${o.neonAge ?? 'n/a'}) ` +
          `ratio ${o.ratio.toFixed(2)}x margin ${o.margin >= 0 ? '+' : ''}$${o.margin.toFixed(3)} ${o.verdict}`
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
