/**
 * HTTP JSON API. This is the one surface both clients sit on: the Android app
 * talks to it directly, and the MCP server wraps it with tools.
 *
 * Reads are served entirely from the local snapshot, so the app stays
 * responsive and the market is only ever contacted by the collector (and by
 * the single explicit `/api/order-book` call, which needs live depth).
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarketApiError, MarketUnavailableError } from '../core/api.ts';
import type { FlipOptions, ScannerService, ScanOptions } from '../service.ts';
import type { Verdict } from '../core/types.ts';
import { dashboardHtml } from './dashboard.ts';

export interface HttpServerOptions {
  port: number;
  /**
   * Bind address. Defaults to loopback; pass `0.0.0.0` to reach it from a
   * phone on the same network (as the Android app requires).
   */
  host?: string;
  /** Bearer token required on mutating routes. Optional but recommended. */
  adminToken?: string | null;
  log?: (message: string) => void;
}

const VERDICTS: readonly Verdict[] = ['craft', 'marginal', 'skip'];

export interface SyncState {
  lastSyncedAt: number;
  nextSyncAt: number;
  isSyncing: boolean;
}

export function createHttpServer(service: ScannerService, options: HttpServerOptions): Server {
  const log = options.log ?? (() => {});
  const syncState: SyncState = {
    lastSyncedAt: Date.now(),
    nextSyncAt: Date.now() + 5 * 60_000,
    isSyncing: false,
  };

  // 5-minute real-time background sync worker
  const runBackgroundSync = async () => {
    if (syncState.isSyncing) return;
    syncState.isSyncing = true;
    try {
      log('[auto-sync] Running 5-minute StarPets popular items refresh...');
      await service.syncPopularPets({ pages: 2, verifyDepth: true });
      syncState.lastSyncedAt = Date.now();
      syncState.nextSyncAt = syncState.lastSyncedAt + 5 * 60_000;
      log(`[auto-sync] Refresh complete. Next sync at ${new Date(syncState.nextSyncAt).toLocaleTimeString()}`);
    } catch (err) {
      log(`[auto-sync] Warning: sync failed: ${err instanceof Error ? err.message : String(err)}`);
      syncState.nextSyncAt = Date.now() + 60_000;
    } finally {
      syncState.isSyncing = false;
    }
  };

  const timer = setInterval(runBackgroundSync, 5 * 60_000);
  // Unref so server can exit gracefully in tests if needed
  if (timer.unref) timer.unref();

  const server = createServer((req, res) => {
    void handle(service, req, res, options, log, syncState).catch((error: unknown) => {
      const { status, body } = mapError(error);
      log(`error ${status}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
    });
  });

  server.listen(options.port, options.host ?? '127.0.0.1');
  return server;
}

async function handle(
  service: ScannerService,
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions,
  log: (message: string) => void,
  syncState: SyncState
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const started = Date.now();

  // The Android client is a separate process; allow it to call us directly.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  try {
    // A browser dashboard, so the scanner is testable from any device on the
    // network without reading raw JSON.
    if (method === 'GET' && path === '/') {
      sendHtml(res, 200, dashboardHtml());
      return;
    }

    if (method === 'GET' && (path === '/logo.jpg' || path === '/logo.png' || path === '/assets/logo.jpg')) {
      const logoPath = join(process.cwd(), 'assets', 'logo.jpg');
      if (existsSync(logoPath)) {
        const data = readFileSync(logoPath);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(data);
        return;
      }
    }

    if (method === 'GET' && path === '/health') {
      const status = service.status();
      sendJson(res, 200, { ...status, stale: service.isStale() });
      return;
    }

    if (method === 'GET' && path === '/api/status') {
      sendJson(res, 200, { ...service.status(), stale: service.isStale(), defaults: service.defaults });
      return;
    }

    if (method === 'GET' && path === '/api/opportunities') {
      const scan = parseScanOptions(url.searchParams);
      const opportunities = service.listOpportunities(scan);
      sendJson(res, 200, {
        count: opportunities.length,
        breakEvenRatio: 4 / (1 - (scan.feePct ?? service.defaults.feePct)),
        opportunities,
      });
      return;
    }

    if (method === 'GET' && path === '/api/pets') {
      // Catalog listing: identity and price only, no evidence payloads.
      const scan = parseScanOptions(url.searchParams);
      const pets = service.listOpportunities({ ...scan, includeLosses: true }).map((o) => ({
        slug: o.petSlug,
        name: o.petName,
        rare: o.rare,
        imageUri: o.imageUri,
        normalPrice: o.normalPrice,
        neonPrice: o.neonPrice,
        margin: o.margin,
        ratio: o.ratio,
        breakEvenRatio: o.breakEvenRatio,
        verdict: o.verdict,
      }));
      sendJson(res, 200, { count: pets.length, pets });
      return;
    }

    if (method === 'GET' && path === '/api/flips') {
      const flips = service.listFlips(parseFlipOptions(url.searchParams));
      sendJson(res, 200, {
        count: flips.length,
        feePct: numberParam(url.searchParams, 'feePct') ?? service.defaults.feePct,
        flips,
      });
      return;
    }

    if (method === 'GET' && path === '/api/coverage') {
      sendJson(res, 200, service.coverage());
      return;
    }

    if (method === 'GET' && path === '/api/catalog') {
      // The whole market, including the pets that have no verdict yet. The
      // board needs this so a thin profitable list reads as a data gap rather
      // than as an empty market.
      const rarities = parseRarities(url.searchParams);
      const rows = service.catalog(rarities ?? undefined);
      sendJson(res, 200, { count: rows.length, rows, pets: rows });
      return;
    }

    if (method === 'POST' && path === '/api/demand') {
      // Enrich weekly-sales data within a request budget. The body is an
      // explicit id list so the client can prioritise what it is showing.
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readJsonBody(req);
      const ids = Array.isArray(body?.productIds)
        ? body.productIds.filter((n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
        : [];
      if (ids.length === 0) {
        sendJson(res, 400, { error: 'invalid_product_ids', hint: 'body must be {"productIds":[...]}' });
        return;
      }
      const budget = typeof body?.budget === 'number' && Number.isFinite(body.budget) ? Math.min(Math.max(1, Math.floor(body.budget)), 50) : 30;
      const result = await service.enrichDemand(ids.slice(0, 500), budget);
      sendJson(res, 200, result);
      return;
    }

    if (method === 'POST' && path === '/api/trending') {
      // Refresh the marketplace's own most-traded board. Two requests cover
      // the top ~150; cheap enough to click, so it is gated like the sweep.
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const result = await service.refreshTrending(2);
      sendJson(res, 200, result);
      return;
    }


    if (method === 'GET' && path === '/api/trending') {
      const rows = [...service.trendBoard()]
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 150);
      sendJson(res, 200, { count: rows.length, pets: rows });
      return;
    }

    if (method === 'POST' && path === '/api/verify-depth') {
      // Read real order books for candidates: how many listings exist and what
      // the cheapest 4 cost together. This is what makes the input price
      // buyable rather than theoretical.
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readJsonBody(req);
      const pairs = Array.isArray(body?.pairs)
        ? body.pairs.filter(
            (p: unknown): p is { normalProductId: number; neonProductId: number } =>
              p !== null && typeof p === 'object' &&
              typeof (p as { normalProductId?: unknown }).normalProductId === 'number' &&
              typeof (p as { neonProductId?: unknown }).neonProductId === 'number'
          )
        : [];
      const budget = typeof body?.budget === 'number' && Number.isFinite(body.budget) ? Math.min(Math.max(1, Math.floor(body.budget)), 50) : 24;
      const result = await service.verifyDepth(pairs.slice(0, 200), budget);
      sendJson(res, 200, result);
      return;
    }

    if (method === 'GET' && path === '/api/sweeps') {
      sendJson(res, 200, { sweeps: service.sweeps(Number(url.searchParams.get('limit') ?? 20)) });
      return;
    }

    const petMatch = /^\/api\/pets\/([^/]+)(\/history)?$/.exec(path);
    if (method === 'GET' && petMatch) {
      const slug = decodeURIComponent(petMatch[1] as string);
      const hours = Number(url.searchParams.get('hours') ?? 24);

      if (petMatch[2]) {
        const history = service.history(slug, Number.isFinite(hours) ? hours : 24);
        if (!history) {
          sendJson(res, 404, { error: 'pet_not_found', slug });
          return;
        }
        sendJson(res, 200, { slug, hours, ...history });
        return;
      }

      const detail = service.getPet(slug);
      if (!detail) {
        sendJson(res, 404, { error: 'pet_not_found', slug });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (method === 'GET' && path === '/api/order-book') {
      const productId = Number(url.searchParams.get('productId'));
      const units = Number(url.searchParams.get('units') ?? 4);
      if (!Number.isInteger(productId) || productId <= 0) {
        sendJson(res, 400, { error: 'invalid_product_id' });
        return;
      }
      sendJson(res, 200, await service.orderBook(productId, Number.isFinite(units) ? units : 4));
      return;
    }

    if (method === 'POST' && path === '/api/scan') {
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const result = await service.triggerSweep();
      sendJson(res, 200, {
        itemCount: result.itemCount,
        petCount: result.petCount,
        bands: result.bands,
        requests: result.requests,
        durationMs: result.durationMs,
        aborted: result.aborted,
        failedBands: result.failedBands,
      });
      return;
    }

    if (method === 'POST' && path === '/api/sync-popular') {
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      syncState.isSyncing = true;
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        const pages = Number(body?.pages ?? 2);
        const resData = await service.syncPopularPets({ pages, verifyDepth: true });
        syncState.lastSyncedAt = Date.now();
        syncState.nextSyncAt = syncState.lastSyncedAt + 5 * 60_000;
        sendJson(res, 200, {
          success: true,
          ...resData,
          lastSyncedAt: syncState.lastSyncedAt,
          nextSyncAt: syncState.nextSyncAt,
        });
      } finally {
        syncState.isSyncing = false;
      }
      return;
    }

    if (method === 'GET' && path === '/api/sync-status') {
      const now = Date.now();
      const remainingSec = Math.max(0, Math.round((syncState.nextSyncAt - now) / 1000));
      sendJson(res, 200, {
        lastSyncedAt: syncState.lastSyncedAt,
        nextSyncAt: syncState.nextSyncAt,
        secondsRemaining: remainingSec,
        isSyncing: syncState.isSyncing,
      });
      return;
    }

    sendJson(res, 404, { error: 'not_found', path });
  } finally {
    log(`${method} ${path} ${Date.now() - started}ms`);
  }
}

/**
 * Turn internal failures into honest status codes.
 *
 * A blocked market host is a 503, not a 500: it is an upstream condition the
 * caller can wait out, and conflating it with a server bug would hide exactly
 * the operational problem this project has to be loud about.
 */
function mapError(error: unknown): { status: number; body: unknown } {
  if (error instanceof MarketUnavailableError) {
    return {
      status: 503,
      body: {
        error: 'market_unavailable',
        message: error.message,
        hint:
          'The market host is rate-limiting or unreachable. Every snapshot-based ' +
          'endpoint still works; only this live lookup is affected.',
      },
    };
  }
  if (error instanceof MarketApiError) {
    return {
      status: 502,
      body: { error: 'market_error', message: error.message, upstreamStatus: error.status },
    };
  }
  return {
    status: 500,
    body: { error: 'internal_error', message: error instanceof Error ? error.message : String(error) },
  };
}

/**
 * Rarity list from `?rarity=rare,ultra_rare,legendary`.
 *
 * Returns null when the parameter is absent, so the caller's default applies;
 * `rarity=all` or `rarity=` means no filter. Anything unrecognised is kept as
 * a literal — the market may add tiers this build has not seen.
 */
export function parseRarities(params: URLSearchParams): string[] | null {
  const raw = params.get('rarity');
  if (raw === null || raw.trim() === '') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'all' || trimmed === 'any') return [];
  const parts = trimmed
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${token}`;
}

/**
 * Read a numeric query parameter, preserving absence.
 *
 * `Number(null)` is `0`, which silently turned an omitted `feePct` into a
 * **0% fee** — reporting three of the four verified pets as profitable when
 * three of them are losses once the real 25% fee applies. Absence must stay
 * absent so the configured default is used.
 */
function numberParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function parseFlipOptions(params: URLSearchParams): FlipOptions {
  const options: FlipOptions = {};

  const feePct = numberParam(params, 'feePct');
  if (feePct !== null && feePct >= 0) options.feePct = feePct > 1 ? feePct / 100 : feePct;

  const minDiscountPct = numberParam(params, 'minDiscountPct');
  if (minDiscountPct !== null && minDiscountPct >= 0) {
    options.minDiscountPct = minDiscountPct > 1 ? minDiscountPct / 100 : minDiscountPct;
  }

  const maxAsk = numberParam(params, 'maxAsk');
  if (maxAsk !== null && maxAsk > 0) options.maxAsk = maxAsk;

  const limit = numberParam(params, 'limit');
  if (limit !== null && Number.isInteger(limit) && limit > 0) options.limit = Math.min(limit, 5_000);

  // Flipping the filter is how the UI shows the near-misses behind the list.
  if (params.get('watchOnly') === 'false') options.watchOnly = false;
  if (params.get('watchOnly') === 'true') options.watchOnly = true;

  return options;
}

export function parseScanOptions(params: URLSearchParams): ScanOptions {
  const scan: ScanOptions = {};

  const maxNormalPrice = numberParam(params, 'maxNormalPrice');
  if (maxNormalPrice !== null && maxNormalPrice > 0) scan.maxNormalPrice = maxNormalPrice;

  const feePct = numberParam(params, 'feePct');
  // Accept both 0.25 and 25 as "25%".
  if (feePct !== null && feePct >= 0) scan.feePct = feePct > 1 ? feePct / 100 : feePct;

  const units = numberParam(params, 'units');
  if (units !== null && Number.isInteger(units) && units > 1) scan.units = units;

  const verdict = params.get('verdict');
  if (verdict === 'all' || (verdict && (VERDICTS as readonly string[]).includes(verdict))) {
    scan.verdict = verdict as Verdict | 'all';
  }

  const limit = numberParam(params, 'limit');
  if (limit !== null && Number.isInteger(limit) && limit > 0) scan.limit = Math.min(limit, 5_000);

  const sortBy = params.get('sort');
  if (
    sortBy === 'margin' ||
    sortBy === 'ratio' ||
    sortBy === 'discount' ||
    sortBy === 'cheap' ||
    sortBy === 'demand'
  ) {
    scan.sortBy = sortBy;
  }

  const rarities = parseRarities(params);
  if (rarities !== null) scan.rarities = rarities;

  if (params.get('includeLosses') === 'true') scan.includeLosses = true;

  return scan;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    // The dashboard is generated fresh each request; never let a proxy pin it.
    'Cache-Control': 'no-store',
  });
  res.end(html);
}
