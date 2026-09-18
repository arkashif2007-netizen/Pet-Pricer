import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../collector/store.ts';
import { loadConfig } from '../config.ts';
import { MarketApi } from '../core/api.ts';
import { ScannerService } from '../service.ts';

let serviceInstance: ScannerService | null = null;
let syncInProgress = false;
let lastSync = 0;

export const syncStateInstance = {
  lastSyncedAt: Date.now(),
  nextSyncAt: Date.now() + 5 * 60_000,
  isSyncing: false,
};

export function getService(): ScannerService {
  if (serviceInstance) return serviceInstance;

  let dbPath = ':memory:';
  try {
    const tmpDir = process.env.TMPDIR || process.env.TEMP || '/tmp';
    const tmpDb = join(tmpDir, 'starpets.sqlite');
    if (!existsSync(tmpDb)) {
      const seedCandidates = [
        join(process.cwd(), 'data', 'starpets.sqlite'),
        join(process.cwd(), 'starpets.sqlite'),
      ];
      for (const seed of seedCandidates) {
        if (existsSync(seed)) {
          try {
            copyFileSync(seed, tmpDb);
            break;
          } catch {}
        }
      }
    }
    dbPath = existsSync(tmpDb) ? tmpDb : ':memory:';
  } catch {
    dbPath = ':memory:';
  }

  const config = loadConfig();
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

export function triggerBackgroundSyncIfNeeded(service: ScannerService, log: (msg: string) => void = console.log): void {
  const now = Date.now();
  if (!syncInProgress && (now - lastSync > 10 * 60_000 || service.isStale())) {
    syncInProgress = true;
    lastSync = now;
    service
      .syncPopularPets({ pages: 1, verifyDepth: false })
      .then(() => {
        syncStateInstance.lastSyncedAt = Date.now();
        syncStateInstance.nextSyncAt = Date.now() + 5 * 60_000;
        log('[auto-sync] Completed non-blocking background refresh');
      })
      .catch((err) => {
        log(`[auto-sync] warning: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        syncInProgress = false;
      });
  }
}
