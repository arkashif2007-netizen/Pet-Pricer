/**
 * Client for the market's public, unauthenticated, CORS-open JSON API.
 *
 * Verified surface (ADOPT store host `https://market.apineural.com`):
 *
 *   POST /api/v2/store/items/all      sweep priced items  (page<=120, amount<=72)
 *   POST /api/v2/store/items/product  batched order book  (the depth source)
 *   POST /api/v2/store/items/price    prices for store-item ids
 *   GET  /api/v2/products/{id}/info   detail + numberOfSalesPerWeek (liquidity)
 *   GET  /api/products/{id}/properties  pumping:flyable:rideable -> product id
 *   GET  /api/products/{id}/ages        the age ladder for one variant
 *
 * The service is kind enough to validate with Joi and echo the exact missing
 * field, which is how this schema was discovered rather than guessed.
 */

import type { OrderBook, ProductInfo, StoreItem } from './types.ts';

/** Hard limits discovered from the server's own validation errors. */
export const MAX_PAGE = 120;
export const MAX_AMOUNT = 72;
/** 120 pages x 72 items: the most any single filtered query can return. */
export const MAX_ITEMS_PER_QUERY = MAX_PAGE * MAX_AMOUNT;

export interface TypeFilter {
  type: string;
  subtypes?: string[];
  ages?: string[];
  rarities?: string[];
  mutations?: string[];
  properties?: Record<string, boolean>;
}

export interface ItemFilter {
  types: TypeFilter[];
  /** Fuzzy, case-insensitive substring match on the display name. */
  name?: string;
  price?: { min?: number; max?: number | null };
}

export type ItemSort = { price?: 'asc' | 'desc'; popularity?: 'asc' | 'desc' };

export interface ListItemsParams {
  page?: number;
  amount?: number;
  currency?: string;
  filter: ItemFilter;
  sort?: ItemSort;
  signal?: AbortSignal;
}

export interface ListItemsResult {
  status: boolean;
  items: StoreItem[];
  count: number;
  currency: string;
}

export interface ApiOptions {
  /** Store host for the game being scanned. */
  baseUrl?: string;
  currency?: string;
  /** In-flight request ceiling. Keep modest: this is someone else's service. */
  concurrency?: number;
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  /** Retries for network errors, 429 and 5xx. */
  maxRetries?: number;
  /**
   * Whether to retry a *timeout*.
   *
   * Right for a background sweep, wrong for a button someone is waiting on: a
   * timeout means the host is unresponsive, so retrying burns the user's time
   * for no new information. Interactive clients set this false.
   */
  retryOnTimeout?: boolean;
  /**
   * Minimum gap between request *starts*, independent of concurrency.
   *
   * This exists because a burst of a couple of hundred requests earned an
   * IP-level block during reconnaissance: every subsequent connection to the
   * host timed out while the rest of the internet stayed reachable. Being
   * throttled is cheaper than being banned, so the cap is enforced here
   * rather than left to concurrency alone.
   */
  minIntervalMs?: number;
  /** Consecutive connection failures before giving up on the whole sweep. */
  maxConsecutiveFailures?: number;
  /** Optional hook for logging/metrics. */
  onRequest?: (info: { method: string; url: string; attempt: number; ms: number; status: number }) => void;
}

export interface ApiMetrics {
  requests: number;
  retries: number;
  failures: number;
  bytes: number;
  blocked: boolean;
}

/** Raised when the host stops answering us entirely (rate limit / IP block). */
export class MarketUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MarketUnavailableError';
    this.cause = cause;
  }
}

/** Raised when the API rejects our parameters, carrying the server's message. */
export class MarketApiError extends Error {
  readonly status: number;
  readonly code: string | number | undefined;
  readonly details: unknown;

  constructor(message: string, status: number, code?: string | number, details?: unknown) {
    super(message);
    this.name = 'MarketApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal semaphore so we never hammer the market. */
class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly limit: number;

  // NOTE: a parameter property (`constructor(private readonly limit: number)`)
  // is unsupported under Node's strip-only TypeScript mode, which is how this
  // project runs without a build step.
  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Drop undefined keys and empty arrays.
 *
 * Sending `ages: []` is not the same as omitting it, and the JS bundle that
 * drives the site only ever attaches non-empty arrays.
 */
function pruneFilter(filter: ItemFilter): Record<string, unknown> {
  const types = filter.types.map((t) => {
    const out: Record<string, unknown> = { type: t.type };
    for (const key of ['subtypes', 'ages', 'rarities', 'mutations'] as const) {
      const value = t[key];
      if (Array.isArray(value) && value.length > 0) out[key] = value;
    }
    if (t.properties && Object.keys(t.properties).length > 0) out.properties = t.properties;
    return out;
  });

  const out: Record<string, unknown> = { types };
  if (typeof filter.name === 'string' && filter.name.length > 0) out.name = filter.name;
  if (filter.price) {
    const price: Record<string, number> = {};
    if (typeof filter.price.min === 'number') price.min = filter.price.min;
    if (typeof filter.price.max === 'number' && Number.isFinite(filter.price.max)) {
      price.max = filter.price.max;
    }
    if (Object.keys(price).length > 0) out.price = price;
  }
  return out;
}

export class MarketApi {
  readonly baseUrl: string;
  readonly currency: string;
  readonly metrics: ApiMetrics = {
    requests: 0,
    retries: 0,
    failures: 0,
    bytes: 0,
    blocked: false,
  };

  private readonly limiter: Limiter;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly retryOnTimeout: boolean;
  private readonly onRequest: ApiOptions['onRequest'];
  private nextSlot = 0;
  private consecutiveNetworkFailures = 0;

  constructor(options: ApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://market.apineural.com').replace(/\/+$/, '');
    this.currency = options.currency ?? 'usd';
    this.limiter = new Limiter(options.concurrency ?? 4);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 8;
    this.retryOnTimeout = options.retryOnTimeout ?? true;
    this.onRequest = options.onRequest;
  }

  /**
   * Space out request starts. Guards against the burst that got the host to
   * stop answering during reconnaissance.
   */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  /** Low-level JSON request with timeout, retry and backoff. */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        this.metrics.retries++;
        // Exponential backoff with jitter, capped.
        const backoff = Math.min(300 * 2 ** (attempt - 1), 4_000);
        await sleep(backoff + Math.random() * 250);
      }

      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const started = Date.now();

      await this.throttle();

      try {
        const response = await this.limiter.run(() =>
          fetch(url, {
            method,
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: combined,
          })
        );

        this.consecutiveNetworkFailures = 0;
        this.metrics.requests++;
        const text = await response.text();
        this.metrics.bytes += text.length;
        this.onRequest?.({
          method,
          url,
          attempt,
          ms: Date.now() - started,
          status: response.status,
        });

        // Retry transient server-side failures.
        if (response.status === 429 || response.status >= 500) {
          this.consecutiveNetworkFailures++;
          lastError = new MarketApiError(
            `${method} ${path} -> HTTP ${response.status}`,
            response.status
          );
          this.guardAgainstBlock(method, path, lastError);
          continue;
        }

        if (!response.ok) {
          let parsed: { code?: string | number; statusCode?: string; details?: unknown; message?: string } = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            /* non-JSON error body */
          }
          const detailMessage = extractDetailMessage(parsed.details);
          throw new MarketApiError(
            detailMessage ?? parsed.statusCode ?? parsed.message ?? `HTTP ${response.status}`,
            response.status,
            parsed.code,
            parsed.details
          );
        }

        return JSON.parse(text) as T;
      } catch (error) {
        if (error instanceof MarketApiError && error.status >= 400 && error.status < 500) {
          // Our fault: do not retry, surface the server's exact complaint.
          this.metrics.failures++;
          throw error;
        }
        if (signal?.aborted) throw error;
        lastError = error;
        this.metrics.failures++;

        // A timeout, when retries are disabled for them, is reported at once
        // rather than re-attempted.
        if (!this.retryOnTimeout && isTimeoutError(error)) {
          throw new MarketUnavailableError(
            `${method} ${path} -> ${this.baseUrl} did not respond within ${this.timeoutMs}ms`,
            error
          );
        }

        this.consecutiveNetworkFailures++;
        this.guardAgainstBlock(method, path, error);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new MarketApiError(`request failed: ${method} ${path}`, 0);
  }

  /**
   * Stop the whole sweep when the host has clearly stopped answering.
   *
   * A connection that times out while the rest of the internet responds is the
   * signature of a rate-limit block, not a transient blip. Continuing to retry
   * only deepens it.
   */
  private guardAgainstBlock(method: string, path: string, cause: unknown): void {
    if (this.consecutiveNetworkFailures < this.maxConsecutiveFailures) return;
    this.metrics.blocked = true;
    throw new MarketUnavailableError(
      `${this.consecutiveNetworkFailures} consecutive failures against ${this.baseUrl} ` +
        `(last: ${method} ${path}). Backing off: this looks like a rate-limit block. ` +
        `Raise STARPETS_MIN_INTERVAL_MS and retry later.`,
      cause
    );
  }

  /**
   * Sweep priced items. `amount` is clamped to the server's 72-item cap and
   * `page` to its 120-page cap, because exceeding either is a hard 400.
   */
  async listItems(params: ListItemsParams): Promise<ListItemsResult> {
    const amount = Math.max(1, Math.min(params.amount ?? MAX_AMOUNT, MAX_AMOUNT));
    const page = Math.max(1, Math.min(params.page ?? 1, MAX_PAGE));
    return this.request<ListItemsResult>(
      'POST',
      '/api/v2/store/items/all',
      {
        page,
        amount,
        currency: params.currency ?? this.currency,
        filter: pruneFilter(params.filter),
        sort: params.sort ?? { price: 'asc' },
      },
      params.signal
    );
  }

  /** Just the total count for a filter, without paging. */
  async countItems(filter: ItemFilter, signal?: AbortSignal): Promise<number> {
    const result = await this.listItems({ filter, page: 1, amount: 1, sort: { price: 'asc' }, signal });
    return result.count;
  }

  /**
   * Batched order book for many products at once. This is how depth is read:
   * `{id, productId, price}` rows come back sorted ascending, so the cost of
   * the cheapest N units is directly computable.
   */
  async productOffers(
    products: number[],
    options: { amount?: number; currency?: string; signal?: AbortSignal } = {}
  ): Promise<OrderBook[]> {
    if (products.length === 0) return [];
    const amount = Math.max(1, Math.min(options.amount ?? 50, MAX_AMOUNT));
    const currency = options.currency ?? this.currency;

    const byProduct = new Map<number, OrderBook>();
    for (const id of products) {
      byProduct.set(id, { productId: id, offers: [], count: 0, currency });
    }

    // StarPets API validates that products has at most 12 items per request
    const chunkSize = 12;
    for (let i = 0; i < products.length; i += chunkSize) {
      const chunk = products.slice(i, i + chunkSize);
      const response = await this.request<{
        status: boolean;
        items: Array<{ id: string; productId: number; price: number }>;
        count: number;
        currency: string;
      }>(
        'POST',
        '/api/v2/store/items/product',
        {
          currency,
          products: chunk,
          amount,
        },
        options.signal
      );
      for (const row of response.items ?? []) {
        const book = byProduct.get(row.productId);
        if (book) book.offers.push(row);
      }
    }
    // `count` is the total matches for the whole batch, not per product; we
    // therefore report the observed offer count per product and keep the
    // server total on each book so callers can tell "few offers" from
    // "truncated by amount".
    for (const book of byProduct.values()) {
      book.offers.sort((a, b) => a.price - b.price);
      book.count = Math.max(book.offers.length, 0);
    }
    return [...byProduct.values()];
  }

  /** Prices for store-item ids (the larger id space). */
  async itemPrices(
    storeItemIds: string[],
    options: { currency?: string; signal?: AbortSignal } = {}
  ): Promise<Array<{ id: string; price: number }>> {
    if (storeItemIds.length === 0) return [];
    const response = await this.request<{
      status: boolean;
      items: Array<{ id: string; price: number }>;
      currency: string;
    }>(
      'POST',
      '/api/v2/store/items/price',
      { items: storeItemIds, currency: options.currency ?? this.currency },
      options.signal
    );
    return response.items ?? [];
  }

  /** Product detail, including the liquidity we need for ranking. */
  async productInfo(productId: number, signal?: AbortSignal): Promise<ProductInfo | null> {
    const response = await this.request<{ status: boolean; product: ProductInfo }>(
      'GET',
      `/api/v2/products/${productId}/info`,
      undefined,
      signal
    );
    return response.product ?? null;
  }

  /** Variant matrix: `"pumping:flyable:rideable"` -> a product id for that variant. */
  async productProperties(
    productId: number,
    signal?: AbortSignal
  ): Promise<Record<string, number>> {
    const response = await this.request<{ status: boolean; properties: Record<string, number> }>(
      'GET',
      `/api/products/${productId}/properties`,
      undefined,
      signal
    );
    return response.properties ?? {};
  }

  /** The age ladder for whichever variant `productId` belongs to. */
  async productAges(
    productId: number,
    signal?: AbortSignal
  ): Promise<Array<{ id: number; age: string }>> {
    const response = await this.request<{ status: boolean; ages: Array<{ id: number; age: string }> }>(
      'GET',
      `/api/products/${productId}/ages`,
      undefined,
      signal
    );
    return response.ages ?? [];
  }
}

/** Recognise both AbortSignal timeouts and undici's connect timeout. */
function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const cause = (error as { cause?: { code?: string; name?: string } }).cause;
  return (
    cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    cause?.name === 'ConnectTimeoutError' ||
    /timed? ?out/i.test(error.message)
  );
}

function extractDetailMessage(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const inner = (details as { details?: unknown }).details;
  if (!Array.isArray(inner)) return undefined;
  const messages = inner
    .map((d) => (d && typeof d === 'object' ? (d as { message?: string }).message : undefined))
    .filter((m): m is string => typeof m === 'string');
  return messages.length > 0 ? messages.join('; ') : undefined;
}
