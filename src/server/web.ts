/**
 * Web Standard Request/Response API router.
 * Runs natively on Netlify Functions (v2), Cloudflare Workers, Node, Deno, and Bun.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScannerService } from '../service.ts';
import { dashboardHtml } from './dashboard.ts';
import { parseScanOptions, parseFlipOptions, parseRarities, type SyncState } from './http.ts';
import { MarketApiError, MarketUnavailableError } from '../core/api.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

export async function handleWebRequest(
  service: ScannerService,
  req: Request,
  options: {
    adminToken?: string | null;
    log?: (msg: string) => void;
    syncState?: SyncState;
  } = {}
): Promise<Response> {
  const method = req.method.toUpperCase();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const log = options.log ?? (() => {});

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    // 1. Web Dashboard
    if (method === 'GET' && (path === '/' || path === '/dashboard')) {
      return htmlResponse(dashboardHtml());
    }

    // 2. Logo Asset
    if (method === 'GET' && (path === '/logo.jpg' || path === '/logo.png' || path === '/assets/logo.jpg')) {
      const candidates = [
        join(process.cwd(), 'assets', 'logo.jpg'),
        join(process.cwd(), 'public', 'logo.jpg'),
      ];
      for (const logoPath of candidates) {
        if (existsSync(logoPath)) {
          const data = readFileSync(logoPath);
          return new Response(data, {
            status: 200,
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'public, max-age=86400',
              ...CORS_HEADERS,
            },
          });
        }
      }
      return jsonResponse({ error: 'logo_not_found' }, 404);
    }

    // 3. Health & Status
    if (method === 'GET' && (path === '/health' || path === '/api/health')) {
      return jsonResponse({ ...service.status(), stale: service.isStale() });
    }

    if (method === 'GET' && path === '/api/status') {
      return jsonResponse({ ...service.status(), stale: service.isStale(), defaults: service.defaults });
    }

    // 4. Opportunities
    if (method === 'GET' && path === '/api/opportunities') {
      const scan = parseScanOptions(url.searchParams);
      const opportunities = service.listOpportunities(scan);
      return jsonResponse({
        count: opportunities.length,
        breakEvenRatio: 4 / (1 - (scan.feePct ?? service.defaults.feePct)),
        opportunities,
      });
    }

    // 5. Pets Catalog
    if (method === 'GET' && path === '/api/pets') {
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
      return jsonResponse({ count: pets.length, pets });
    }

    // 6. Flips
    if (method === 'GET' && path === '/api/flips') {
      const flips = service.listFlips(parseFlipOptions(url.searchParams));
      return jsonResponse({
        count: flips.length,
        feePct: Number(url.searchParams.get('feePct')) || service.defaults.feePct,
        flips,
      });
    }

    // 7. Coverage
    if (method === 'GET' && path === '/api/coverage') {
      return jsonResponse(service.coverage());
    }

    // 8. Catalog
    if (method === 'GET' && path === '/api/catalog') {
      const rarities = parseRarities(url.searchParams);
      const rows = service.catalog(rarities ?? undefined);
      return jsonResponse({ count: rows.length, rows, pets: rows });
    }

    // 9. Trending
    if (method === 'GET' && path === '/api/trending') {
      const rows = [...service.trendBoard()]
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 150);
      return jsonResponse({ count: rows.length, pets: rows });
    }

    if (method === 'POST' && path === '/api/trending') {
      const result = await service.refreshTrending(2);
      return jsonResponse(result);
    }

    // 10. Demand
    if (method === 'POST' && path === '/api/demand') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const ids = Array.isArray(body?.productIds)
        ? body.productIds.filter((n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
        : [];
      if (ids.length === 0) {
        return jsonResponse({ error: 'invalid_product_ids', hint: 'body must be {"productIds":[...]}' }, 400);
      }
      const budget = typeof body?.budget === 'number' && Number.isFinite(body.budget) ? Math.min(Math.max(1, Math.floor(body.budget)), 50) : 30;
      const result = await service.enrichDemand(ids.slice(0, 500), budget);
      return jsonResponse(result);
    }

    // 11. Depth Verification
    if (method === 'POST' && path === '/api/verify-depth') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
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
      return jsonResponse(result);
    }

    // 12. Sweeps
    if (method === 'GET' && path === '/api/sweeps') {
      return jsonResponse({ sweeps: service.sweeps(Number(url.searchParams.get('limit') ?? 20)) });
    }

    // 13. Pet Details & History
    const petMatch = /^\/api\/pets\/([^/]+)(\/history)?$/.exec(path);
    if (method === 'GET' && petMatch) {
      const slug = decodeURIComponent(petMatch[1] as string);
      const hours = Number(url.searchParams.get('hours') ?? 24);

      if (petMatch[2]) {
        const history = service.history(slug, Number.isFinite(hours) ? hours : 24);
        if (!history) {
          return jsonResponse({ error: 'pet_not_found', slug }, 404);
        }
        return jsonResponse({ slug, hours, ...history });
      }

      const detail = service.getPet(slug);
      if (!detail) {
        return jsonResponse({ error: 'pet_not_found', slug }, 404);
      }
      return jsonResponse(detail);
    }

    // 14. Live Order Book
    if (method === 'GET' && path === '/api/order-book') {
      const productId = Number(url.searchParams.get('productId'));
      const units = Number(url.searchParams.get('units') ?? 4);
      if (!Number.isInteger(productId) || productId <= 0) {
        return jsonResponse({ error: 'invalid_product_id' }, 400);
      }
      return jsonResponse(await service.orderBook(productId, Number.isFinite(units) ? units : 4));
    }

    // 15. Trigger Scan
    if (method === 'POST' && path === '/api/scan') {
      const result = await service.triggerSweep();
      return jsonResponse(result);
    }

    // 16. Sync Popular
    if (method === 'POST' && path === '/api/sync-popular') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const pages = Number(body?.pages ?? 2);
      const resData = await service.syncPopularPets({ pages, verifyDepth: true });
      return jsonResponse({ success: true, ...resData });
    }

    // 17. Sync Status
    if (method === 'GET' && path === '/api/sync-status') {
      const syncState = options.syncState ?? { lastSyncedAt: Date.now(), nextSyncAt: Date.now() + 300_000, isSyncing: false };
      const now = Date.now();
      const remainingSec = Math.max(0, Math.round((syncState.nextSyncAt - now) / 1000));
      return jsonResponse({
        lastSyncedAt: syncState.lastSyncedAt,
        nextSyncAt: syncState.nextSyncAt,
        secondsRemaining: remainingSec,
        isSyncing: syncState.isSyncing,
      });
    }

    return jsonResponse({ error: 'not_found', path }, 404);
  } catch (error: unknown) {
    if (error instanceof MarketUnavailableError) {
      return jsonResponse(
        {
          error: 'market_unavailable',
          message: error.message,
          hint: 'The market host is rate-limiting or unreachable. Snapshot endpoints still work.',
        },
        503
      );
    }
    if (error instanceof MarketApiError) {
      return jsonResponse(
        { error: 'market_error', message: error.message, upstreamStatus: error.status },
        502
      );
    }
    return jsonResponse(
      { error: 'internal_error', message: error instanceof Error ? error.message : String(error) },
      500
    );
  }
}
