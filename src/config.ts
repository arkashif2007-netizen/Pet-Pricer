/**
 * Configuration. Every value is overridable by environment variable so the
 * service can be retuned without a rebuild.
 */

import { DEFAULT_MARGIN_CONFIG } from './core/margin.ts';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export interface AppConfig {
  /** ADOPT store host. Override to point at a staging host. */
  storeBaseUrl: string;
  currency: string;
  concurrency: number;
  /** Minimum gap between request starts. The politeness floor. */
  minIntervalMs: number;
  /**
   * Requests a single sweep cycle may spend.
   *
   * Measured, not guessed: the host stops answering after roughly 50 requests
   * in a window, and it did so even when pacing at 0.45 req/s — so the ceiling
   * is on volume, not rate. 35 leaves headroom for retries. Progress is
   * checkpointed, so a small budget costs nothing but time.
   */
  requestBudget: number;
  timeoutMs: number;
  maxRetries: number;

  /**
   * Marketplace sell-side fee as a fraction. The user's account shows 25%;
   * this is config, not a guess, because it varies by tier and currency.
   */
  feePct: number;
  /** Capital cap on the cheapest normal input. */
  maxNormalPrice: number;
  /** Units consumed per craft. */
  units: number;
  /** Minimum return on deployed capital before a craft is called 'craft'. */
  minReturnOnCapital: number;

  dbPath: string;
  /** Bind address for the HTTP API. `0.0.0.0` exposes it to the LAN. */
  host: string;
  port: number;
  /** Poll cadence. The market's own CDN cache is 240s, so below that is waste. */
  intervalMs: number;
  historyRetentionMs: number;
}

export function loadConfig(): AppConfig {
  return {
    storeBaseUrl: str('STARPETS_STORE_URL', 'https://market.apineural.com'),
    currency: str('STARPETS_CURRENCY', 'usd'),
    concurrency: num('STARPETS_CONCURRENCY', 4),
    minIntervalMs: num('STARPETS_MIN_INTERVAL_MS', 250),
    requestBudget: num('STARPETS_REQUEST_BUDGET', 35),
    timeoutMs: num('STARPETS_TIMEOUT_MS', 20_000),
    maxRetries: num('STARPETS_MAX_RETRIES', 4),

    feePct: num('STARPETS_FEE_PCT', DEFAULT_MARGIN_CONFIG.feePct),
    maxNormalPrice: num('STARPETS_MAX_NORMAL_PRICE', 3),
    units: num('STARPETS_UNITS', 4),
    minReturnOnCapital: num('STARPETS_MIN_ROC', DEFAULT_MARGIN_CONFIG.minReturnOnCapital),

    dbPath: str('STARPETS_DB', './data/starpets.sqlite'),
    host: str('STARPETS_HOST', process.env.HOST || '0.0.0.0'),
    port: num('STARPETS_PORT', num('PORT', 8787)),
    intervalMs: num('STARPETS_INTERVAL_MS', 5 * 60_000),
    historyRetentionMs: num('STARPETS_HISTORY_RETENTION_MS', 14 * 24 * 60 * 60_000),
  };
}
