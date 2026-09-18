#!/usr/bin/env node
/**
 * Server entry point.
 *
 *   node src/server/cli.ts
 *
 * Serves the current snapshot. Run the collector (`npm run sweep` or
 * `npm run watch`) to populate it; this process never polls the market on its
 * own except for the explicit `/api/order-book` depth lookup.
 */

import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { watchSweep } from '../collector/sweep.ts';
import { Store } from '../collector/store.ts';
import { loadConfig } from '../config.ts';
import { MarketApi } from '../core/api.ts';
import { ScannerService } from '../service.ts';
import { createHttpServer } from './http.ts';

/** Best-effort LAN addresses, so the phone URL is printed rather than hunted. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) out.push(address.address);
    }
  }
  return out;
}

function main(): void {
  const config = loadConfig();
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

  const store = new Store(config.dbPath);
  const api = new MarketApi({
    baseUrl: config.storeBaseUrl,
    currency: config.currency,
    concurrency: config.concurrency,
    minIntervalMs: config.minIntervalMs,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
  const service = new ScannerService(store, api, config);

  const log = (message: string) => console.log(`[server] ${message}`);
  const server = createHttpServer(service, {
    host: config.host,
    port: config.port,
    adminToken: process.env.STARPETS_ADMIN_TOKEN ?? null,
    log,
  });

  const status = service.status();
  log(`listening on http://${config.host}:${config.port}`);
  log(`  dashboard  http://127.0.0.1:${config.port}/`);
  if (config.host === '0.0.0.0') {
    for (const address of lanAddresses()) {
      log(`  on your LAN  http://${address}:${config.port}/  (use this in the Android app)`);
    }
  }
  log(`snapshot: ${status.itemCount} items / ${status.petCount} pets`);
  if (service.isStale()) {
    log('WARNING: snapshot is empty or stale — run `npm run sweep` to refresh');
  }

  if (process.env.AUTO_START_WATCH === 'true' || process.env.RENDER) {
    log(`auto-starting background market sweep watcher (cadence: ${config.intervalMs / 1000}s)...`);
    watchSweep(api, store, {
      currency: config.currency,
      requestBudget: config.requestBudget,
      intervalMs: config.intervalMs,
      historyRetentionMs: config.historyRetentionMs,
      onProgress: (msg) => log(`[watcher] ${msg}`),
    }).catch((err) => log(`watcher error: ${err instanceof Error ? err.message : String(err)}`));
  }

  const shutdown = () => {
    log('shutting down');
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
