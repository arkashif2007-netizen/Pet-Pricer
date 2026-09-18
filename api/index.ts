import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from '../src/collector/store.ts';
import { loadConfig } from '../src/config.ts';
import { MarketApi } from '../src/core/api.ts';
import { ScannerService } from '../src/service.ts';
import { handle } from '../src/server/http.ts';

let serviceInstance: ScannerService | null = null;
let lastSync = 0;

const syncStateInstance = {
  lastSyncedAt: Date.now(),
  nextSyncAt: Date.now() + 5 * 60_000,
  isSyncing: false,
};

function getService(): ScannerService {
  if (serviceInstance) return serviceInstance;
  const config = loadConfig();
  const dbPath = process.env.VERCEL ? '/tmp/starpets.sqlite' : config.dbPath;
  const store = new Store(dbPath);
  const api = new MarketApi({
    baseUrl: config.storeBaseUrl,
    currency: config.currency,
    concurrency: config.concurrency,
    minIntervalMs: config.minIntervalMs,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
  serviceInstance = new ScannerService(store, api, config);
  return serviceInstance;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const service = getService();
  const log = (msg: string) => console.log(`[vercel] ${msg}`);

  // On serverless, auto-sync popular items if snapshot is empty or older than 5 minutes
  const now = Date.now();
  if (now - lastSync > 5 * 60_000 || service.isStale()) {
    try {
      lastSync = now;
      await service.syncPopularPets({ pages: 2, verifyDepth: false });
      syncStateInstance.lastSyncedAt = now;
      syncStateInstance.nextSyncAt = now + 5 * 60_000;
    } catch (err) {
      log(`auto-sync warning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await handle(service, req, res, { port: 8787 }, log, syncStateInstance);
}
