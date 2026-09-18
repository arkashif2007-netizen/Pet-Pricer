import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/collector/store.ts';
import { loadConfig } from '../src/config.ts';
import { MarketApi } from '../src/core/api.ts';
import { ScannerService } from '../src/service.ts';
import { handle } from '../src/server/http.ts';

let serviceInstance: ScannerService | null = null;
let syncInProgress = false;
let lastSync = 0;

const syncStateInstance = {
  lastSyncedAt: Date.now(),
  nextSyncAt: Date.now() + 5 * 60_000,
  isSyncing: false,
};

function getService(): ScannerService {
  if (serviceInstance) return serviceInstance;

  let dbPath = ':memory:';
  try {
    if (process.env.VERCEL) {
      const tmpDir = '/tmp';
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
    } else {
      const config = loadConfig();
      dbPath = config.dbPath;
    }
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

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const log = (msg: string) => console.log(`[vercel] ${msg}`);

  try {
    // Normalize Vercel internal rewrite paths to root
    if (req.url) {
      const u = req.url;
      if (u === '/api' || u === '/api/' || u === '/api/index.ts' || u === '/api/index') {
        req.url = '/';
      } else if (u.startsWith('/api?') || u.startsWith('/api/?') || u.startsWith('/api/index.ts?') || u.startsWith('/api/index?')) {
        const query = u.substring(u.indexOf('?'));
        req.url = '/' + query;
      }
    }

    const service = getService();

    // Trigger non-blocking background refresh if needed (never block the user request)
    const now = Date.now();
    if (!syncInProgress && (now - lastSync > 10 * 60_000 || service.isStale())) {
      syncInProgress = true;
      lastSync = now;
      service
        .syncPopularPets({ pages: 1, verifyDepth: false })
        .then(() => {
          syncStateInstance.lastSyncedAt = Date.now();
          syncStateInstance.nextSyncAt = Date.now() + 5 * 60_000;
        })
        .catch((err) => {
          log(`auto-sync warning: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          syncInProgress = false;
        });
    }

    await handle(service, req, res, { port: 8787 }, log, syncStateInstance);
  } catch (err) {
    log(`Fatal handler error: ${err instanceof Error ? err.stack : String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'internal_server_error',
          message: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        })
      );
    }
  }
}
