/**
 * The service layer. Both consumers of this product — the Android app over
 * HTTP and the MCP server over stdio — sit on top of exactly this, because an
 * MCP server with nothing underneath returns nothing.
 *
 * Read-only by construction: nothing here buys, lists, trades or authenticates.
 * It observes public prices and reports arithmetic.
 */

import type { Store } from './collector/store.ts';
import type { SweepResult } from './collector/sweep.ts';
import { runSweep } from './collector/sweep.ts';
import type { AppConfig } from './config.ts';
import { MarketApi } from './core/api.ts';
import { depthCheck, isUsablePrice } from './core/hygiene.ts';
import { DEFAULT_MARGIN_CONFIG, FUSION_UNITS, evaluateCraft } from './core/margin.ts';
import {
  buildFlips,
  buildOpportunities,
  cheapestNeonAsk,
  cheapestNormalInput,
  neonLadder,
  variantKeys,
} from './core/opportunities.ts';
import type { FlipOpportunity, Opportunity, StoreItem, Verdict } from './core/types.ts';

export interface ScanOptions {
  maxNormalPrice?: number;
  feePct?: number;
  units?: number;
  verdict?: Verdict | 'all';
  limit?: number;
  sortBy?: 'margin' | 'ratio' | 'discount' | 'cheap' | 'demand';
  includeLosses?: boolean;
  /**
   * Keep only these rarities. Default is the money tiers — common and uncommon
   * pets are the bulk of the catalog and the least of the profit, so the
   * default view is the one a trader actually wants.
   */
  rarities?: string[];
  /**
   * Only pets on the marketplace's own most-traded board. This is the answer
   * to "which pets are people actually trading this week" — and it is the
   * marketplace's own answer, not a guess from a third-party site.
   */
  trendingOnly?: boolean;
}

export interface StatusReport {
  ok: boolean;
  storeUrl: string;
  itemCount: number;
  petCount: number;
  lastSweep: ReturnType<Store['latestSweep']>;
  feePct: number;
  breakEvenRatio: number;
  maxNormalPrice: number;
  staleSeconds: number | null;
  /**
   * Rows with generated provenance. Surfaced so the UI can refuse to present
   * invented pets as real ones. Nothing writes this any more, so it should
   * always be zero; it is checked rather than assumed.
   */
  fabricatedItemCount: number;
  /** Rows from the hand-checked reference set: real prices, not swept. */
  verifiedItemCount: number;
  observedItemCount: number;
  coverage: CoverageReport;
}

/**
 * How much of the market this snapshot actually explains.
 *
 * This exists because the honest answer to "why is the profitable list so
 * short?" is almost always a data answer, and the app should say so rather
 * than let a thinned list read as a thin market. It is computed, never
 * asserted: if the highest input ask on hand is $0.04 and the cap is $3.00,
 * then 98.7% of the searchable range has not been observed yet, and
 * `profitableBandUnreached` says so without anyone having to remember it.
 */
export interface CoverageReport {
  itemsTotal: number;
  itemsPriced: number;
  itemsNoData: number;
  petsInCatalog: number;
  /** Pets with both a priced normal input and a priced neon: margin computable. */
  petsEvaluable: number;
  petsInputOnly: number;
  /** Highest cheapest-input ask observed, across every pet. */
  maxInputAskObserved: number;
  /** Highest ask observed at all, of any variant. */
  maxAskObserved: number;
  /** The capital cap: the top of the range the scan is meant to cover. */
  capitalCap: number;
  /** Fraction of the [0, cap] input range actually observed. 0..1 */
  inputRangeCovered: number;
  /**
   * True when nothing we hold reaches the price region where a craft could
   * ever clear the fee. When true, an empty opportunity list is a collection
   * gap, not a market verdict.
   */
  profitableBandUnreached: boolean;
  /** Human-readable band actually reached, e.g. "$0.03 - $0.04". */
  inputBandReached: string;
}

export interface PetDetail {
  summary: Opportunity;
  /** Every neon rung, cheapest first — evidence that all ages were walked. */
  neonLadder: Array<{ age: string | null; price: number; productId: number }>;
  /** Distinct `pumping:flyable:rideable` combinations seen for this pet. */
  variants: string[];
  history: {
    normal: Array<{ ts: number; price: number }>;
    neon: Array<{ ts: number; price: number }>;
  };
}

export type CatalogStatus = 'evaluated' | 'awaiting_neon' | 'awaiting_price' | 'over_cap';

/** One row of the whole-market view, including the pets with no verdict yet. */
export interface CatalogRow {
  slug: string;
  name: string;
  rare: string | null;
  imageUri: string | null;
  inputPrice: number | null;
  normalProductId: number | null;
  inputAge: string | null;
  inputVariant: string | null;
  craftCost: number | null;
  neonPrice: number | null;
  neonAge: string | null;
  neonProductId: number | null;
  neonNet: number | null;
  margin: number | null;
  roiPct: number | null;
  ratio: number | null;
  verdict: Verdict | null;
  status: CatalogStatus;
  flags: string[];
  salesPerWeek: number | null;
  demandScore: number | null;
  inputAvailable: number | null;
  inputBuyable: boolean | null;
  inputDepthPrice: number | null;
  inputDepth4xPrice: number | null;
  inputDepthListingCount: number | null;
  neonAvailable: number | null;
  neonDepthPrice: number | null;
  baseNeonPrice?: number | null;
  rideNeonPrice?: number | null;
  flyRideNeonPrice?: number | null;
  trendRank: number | null;
}

export interface FlipOptions {
  feePct?: number;
  minDiscountPct?: number;
  minMargin?: number;
  maxAsk?: number;
  /** Default true: return only rows that clear the discount floor. */
  watchOnly?: boolean;
  limit?: number;
}

export interface OrderBookReport {
  productId: number;
  units: number;
  enough: boolean;
  available: number;
  costForUnits: number | null;
  effectiveUnitCost: number | null;
  cheapest: number | null;
  cheapest4xPrice: number | null;
  listingCountAtCheapest4x: number | null;
  priceTiers: Array<{ price: number; count: number }>;
  offers: Array<{ id: string; price: number }>;
}

/** If the newest sweep is older than this, the data is called stale. */
const STALE_AFTER_MS = 15 * 60_000;
const OPPORTUNITY_CACHE_MS = 5_000;

export class ScannerService {
  private readonly store: Store;
  private readonly api: MarketApi;
  private readonly config: AppConfig;
  /** Trend rank per pet slug, from the marketplace's own popularity sort. */
  private trendCache: Map<string, number> | null = null;
  private trendAt = 0;

  /**
   * A second client for user-facing live lookups.
   *
   * The collector's client is built to be patient — several retries with long
   * timeouts — which is right for a background sweep and wrong for a button
   * someone is waiting on. Against a blocked host the patient policy left an
   * interactive depth check hanging for over a minute, so interactive calls
   * get short timeouts and a single retry, and fail fast with a clear message.
   */
  private readonly interactiveApi: MarketApi;

  private cache: { key: string; at: number; value: Opportunity[] } | null = null;
  private flipCache: { key: string; at: number; value: FlipOpportunity[] } | null = null;
  private sweepInFlight: Promise<SweepResult> | null = null;

  constructor(store: Store, api: MarketApi, config: AppConfig) {
    this.store = store;
    this.api = api;
    this.config = config;
    this.interactiveApi = new MarketApi({
      baseUrl: api.baseUrl,
      currency: api.currency,
      concurrency: 2,
      minIntervalMs: config.minIntervalMs,
      timeoutMs: 4_000,
      maxRetries: 1,
      // Never wait on a host that has already gone quiet: report and move on.
      retryOnTimeout: false,
      maxConsecutiveFailures: 2,
    });
  }

  /** A key that changes whenever the underlying snapshot changes. */
  private revision(): string {
    const latest = this.store.latestSweep();
    return `${latest?.id ?? 0}:${this.store.itemCount()}:${this.store.petCount()}`;
  }

  /**
   * Join observed demand onto evaluated opportunities, in place.
   *
   * Reads come only from the local `liquidity` table, so this is free and
   * works offline. Enrichment — actually asking the market — is a separate,
   * budgeted operation (`enrichDemand`), because one request per product would
   * otherwise be folded into every scan.
   */
  private attachLiquidity(opportunities: Opportunity[]): void {
    if (opportunities.length === 0) return;
    const ids = opportunities.map((o) => o.neonProductId);
    const map = this.store.liquidityFor(ids);
    for (const o of opportunities) {
      const hit = map.get(o.neonProductId);
      o.salesPerWeek = hit ? hit.salesPerWeek : null;
      o.demandScore =
        hit && hit.salesPerWeek > 0 ? o.margin * hit.salesPerWeek : hit ? 0 : null;
    }
  }

  /**
   * Ask the market for weekly sales on un-enriched pets, within a budget.
   *
   * One request per pet, so this runs on demand rather than on every sweep:
   * the budget makes it safe to call repeatedly, and it always spends itself
   * on pets the caller is actually looking at first (candidates are passed in
   * neon-product-id order by the UI).
   *
   * Returns what was learned so a caller can show immediate feedback.
   */
  async enrichDemand(productIds: number[], budget = 30): Promise<{ enriched: number; remaining: number }> {
    const missing = this.store.liquidityMissing(productIds);
    const batch = missing.slice(0, Math.max(0, budget));

    for (const productId of batch) {
      try {
        const info = await this.interactiveApi.productInfo(productId);
        const sales = info?.numberOfSalesPerWeek;
        this.store.writeLiquidity([
          { productId, salesPerWeek: typeof sales === 'number' && sales >= 0 ? Math.round(sales) : 0, observedAt: Date.now() },
        ]);
      } catch {
        // A blocked host must not burn the whole budget retrying one product;
        // stop and report what was gathered so far.
        break;
      }
    }

    return { enriched: batch.length, remaining: Math.max(0, missing.length - batch.length) };
  }

  /**
   * Depth-verified opportunities, ranked by real tradeability.
   *
   * A craft margin built on the cheapest single listing is arithmetic on a
   * mirage when that listing is one of one. So the evaluation pipeline now
   * ends in a depth pass:
   *
   *   1. build opportunities from the sweep snapshot (cheap, cached);
   *   2. join local depth readings — how many listings the input product
   *      actually has, and what the cheapest 4 cost in total;
   *   3. recompute the margin against the *buyable* price — the per-unit cost
   *      of the cheapest 4 listings — never the lone cheapest;
   *   4. flag anything with fewer listings than a craft needs.
   *
   * `inputDepthPrice` is the honest answer to "what will 4 inputs cost me".
   * Where the book has not been read yet the values stay null: unknown, not
   * zero — and the sweep price remains the fallback, clearly labelled.
   */
  listOpportunities(options: ScanOptions = {}): Opportunity[] {
    const resolved = this.resolveOptions(options);
    const key = `${this.revision()}:${JSON.stringify(resolved)}`;
    const now = Date.now();

    if (this.cache && this.cache.key === key && now - this.cache.at < OPPORTUNITY_CACHE_MS) {
      return this.cache.value;
    }

    const all = buildOpportunities(this.store.currentItems(), {
      margin: {
        feePct: resolved.feePct,
        minReturnOnCapital: this.config.minReturnOnCapital,
      },
      maxNormalPrice: resolved.maxNormalPrice,
      units: resolved.units,
    });

    this.attachLiquidity(all);
    this.attachDepth(all);
    this.attachTrend(all);

    const trending = this.trendingSlugs();
    const filtered = all.filter((o) => {
      if (!resolved.includeLosses && o.margin <= 0) return false;
      if (resolved.verdict !== 'all' && o.verdict !== resolved.verdict) return false;
      if (
        resolved.rarities.length > 0 &&
        !resolved.rarities.includes(String(o.rare ?? '').toLowerCase())
      ) {
        return false;
      }
      if (resolved.trendingOnly && !trending.has(o.petSlug)) return false;
      return true;
    });

    const sorted = sortOpportunities(filtered, resolved.sortBy).slice(0, resolved.limit);
    this.cache = { key, at: now, value: sorted };
    return sorted;
  }

  /** The marketplace's own most-traded board: slugs only, cached briefly. */
  private trendingSlugs(): Set<string> {
    this.loadTrend();
    return new Set(this.trendCache?.keys() ?? []);
  }

  private loadTrend(): void {
    const maxAgeMs = 60 * 60 * 1000;
    if (this.trendCache && Date.now() - this.trendAt < maxAgeMs) return;
    this.trendCache = new Map(
      [...this.store.trendRanks().entries()].map(([slug, v]) => [slug, v.rank])
    );
    this.trendAt = Date.now();
  }

  /**
   * Join the local depth table onto opportunities, in place. Free, offline.
   *
   * When a real book has been read, the margin is recomputed against the
   * *buyable* prices: the per-unit cost of the cheapest 4 inputs, and the
   * book-verified cheapest neon. This is where "one listing at $0.10" stops
   * manufacturing a phantom profit — with a real book the input price is what
   * 4 units actually cost, and with fewer than 4 listings the craft is flagged
   * rather than pretended to be possible.
   */
  private attachDepth(opportunities: Opportunity[]): void {
    if (opportunities.length === 0) return;
    const ids = [
      ...new Set(
        opportunities.flatMap((o) => [o.normalProductId, o.neonProductId])
      ),
    ];
    const map = this.store.depthFor(ids);
    for (const o of opportunities) {
      const input = map.get(o.normalProductId);
      const neon = map.get(o.neonProductId);
      o.inputAvailable = input ? input.available : null;
      o.inputBuyable = input ? input.available >= (input.units || 4) : null;
      o.inputDepthPrice =
        input && input.costForUnits !== null && input.units > 0
          ? input.costForUnits / input.units
          : null;
      o.inputDepth4xPrice = input?.cheapest4xPrice ?? null;
      o.inputDepthListingCount = input?.listingCount4x ?? null;
      o.neonAvailable = neon ? neon.available : null;
      o.neonDepthPrice = neon && neon.available > 0 ? (neon.bookMin ?? o.neonPrice) : null;

      if (o.inputBuyable === false) {
        if (!o.flags.includes('cannot_buy_units')) o.flags.push('cannot_buy_units');
      }

      // Recompute against book-verified prices when they differ.
      // Use the cheapest 4x listing price if available, or effective input depth price.
      const buyPrice = o.inputDepth4xPrice ?? o.inputDepthPrice ?? o.normalPrice;
      const sellPrice = o.neonDepthPrice ?? o.neonPrice;
      if (buyPrice !== null && sellPrice !== null) {
        const recheck = evaluateCraft(
          {
            normalPrice: buyPrice,
            neonPrice: sellPrice,
            normalAge: o.normalAge,
          },
          { feePct: o.feePct, minReturnOnCapital: this.config.minReturnOnCapital }
        );
        o.normalPrice = buyPrice;
        o.neonPrice = sellPrice;
        o.craftCost = input?.costForUnits ?? (buyPrice * 4);
        o.neonNet = recheck.neonNet;
        o.margin = Math.round((o.neonNet - o.craftCost) * 1000) / 1000;
        o.ratio = recheck.ratio;
        o.verdict = (o.inputBuyable ?? true) && o.margin > 0 ? recheck.verdict : 'skip';
        for (const flag of recheck.flags) {
          if (!o.flags.includes(flag)) o.flags.push(flag);
        }
      }
    }
  }

  /** Attach the marketplace's own rank, for the UI's trend badges. */
  private attachTrend(opportunities: Opportunity[]): void {
    this.loadTrend();
    if (!this.trendCache || this.trendCache.size === 0) return;
    for (const o of opportunities) {
      const rank = this.trendCache.get(o.petSlug);
      if (rank !== undefined) o.trendRank = rank;
    }
  }

  /**
   * Refresh the most-traded board from the marketplace's popularity sort.
   */
  async refreshTrending(pages = 2): Promise<{ size: number; observedAt: number }> {
    const seen = new Map<string, number>();
    const observedAt = Date.now();
    for (let page = 1; page <= pages; page++) {
      const result = await this.interactiveApi.listItems({
        filter: { types: [{ type: 'pet' }], price: { min: 0.01 } },
        sort: { popularity: 'desc' },
        page,
        amount: 72,
      });
      for (const item of result.items ?? []) {
        if (!isUsablePrice(item.price)) continue;
        const slug = item.realName || item.name;
        if (!seen.has(slug)) seen.set(slug, seen.size + 1);
      }
    }
    this.store.writeTrend(
      [...seen.entries()].map(([petSlug, rank]) => ({ petSlug, rank, observedAt }))
    );
    this.trendCache = new Map(seen);
    this.trendAt = Date.now();
    return { size: seen.size, observedAt };
  }

  /**
   * Read real order books for the input and neon products of candidates,
   * applying the 4-listing depth rule and calculating true craft costs.
   */
  async verifyDepth(
    productIds: Array<{ normalProductId: number; neonProductId: number }>,
    budget = 40
  ): Promise<{ read: number; remaining: number }> {
    const units = this.config.units;
    const wanted: number[] = [];
    for (const pair of productIds) {
      wanted.push(pair.normalProductId, pair.neonProductId);
    }
    const missing = this.store.depthFor(wanted);
    const toRead: number[] = [];
    for (const id of wanted) {
      if (!missing.has(id) && !toRead.includes(id)) toRead.push(id);
    }
    const batch = toRead.slice(0, Math.max(0, budget));

    for (const productId of batch) {
      try {
        const [book] = await this.interactiveApi.productOffers([productId], { amount: 72 });
        const offers = (book?.offers ?? []).filter((o) => isUsablePrice(o.price));
        const analysis = depthCheck(offers, units);
        this.store.writeDepth({
          productId,
          available: analysis.available,
          costForUnits: analysis.costForUnits,
          units,
          bookMin: analysis.cheapestListingPrice,
          cheapest4xPrice: analysis.cheapest4xListingPrice,
          listingCount4x: analysis.listingCountAtCheapest4x,
          observedAt: Date.now(),
        });
      } catch {
        break;
      }
    }
    this.cache = null;
    return { read: batch.length, remaining: Math.max(0, toRead.length - batch.length) };
  }

  /**
   * Sync the most popular Adopt Me pets directly from StarPets popularity sort.
   *
   * Ensures high-demand pets (Dragonfruit Fox, Dango Penguins, etc.) are always
   * fully populated with their normal and neon variants, live order-book depth,
   * weekly sales velocity, and popularity ranks.
   */
  async syncPopularPets(options: { pages?: number; verifyDepth?: boolean } = {}): Promise<{
    petsSynced: number;
    itemsStored: number;
    topPets: string[];
  }> {
    // Permanently disabled: Zero external calls to StarPets API to prevent rate-limiting/Cloudflare blocks
    return {
      petsSynced: 0,
      itemsStored: 0,
      topPets: [],
    };
  }

  /**
   * Listings priced below their own 7-day average, ranked by discount.
   *
   * Deliberately a separate list from `listOpportunities`: the craft margin is
   * arithmetic on two asks, this is a bet that a buyer exists at the average.
   * Mixing them into one ranking would launder the weaker signal.
   */
  listFlips(options: FlipOptions = {}): FlipOpportunity[] {
    const resolved = {
      feePct: options.feePct ?? this.config.feePct,
      minDiscountPct: options.minDiscountPct ?? 0.15,
      minMargin: options.minMargin ?? 0.01,
      maxAsk: options.maxAsk ?? this.config.maxNormalPrice * 4,
      watchOnly: options.watchOnly ?? true,
      limit: options.limit ?? 60,
    };
    const key = `${this.revision()}:flip:${JSON.stringify(resolved)}`;
    const now = Date.now();

    if (this.flipCache && this.flipCache.key === key && now - this.flipCache.at < OPPORTUNITY_CACHE_MS) {
      return this.flipCache.value;
    }

    const all = buildFlips(this.store.currentItems(), {
      feePct: resolved.feePct,
      minDiscountPct: resolved.minDiscountPct,
      minMargin: resolved.minMargin,
      maxAsk: resolved.maxAsk,
    });

    const value = (resolved.watchOnly ? all.filter((f) => f.verdict === 'watch') : all).slice(
      0,
      resolved.limit
    );
    const demand = this.store.liquidityFor(value.map((f) => f.productId));
    for (const flip of value) {
      flip.salesPerWeek = demand.get(flip.productId)?.salesPerWeek ?? null;
    }
    this.flipCache = { key, at: now, value };
    return value;
  }

  /**
   * Every pet in the snapshot, with whatever can honestly be said about it.
   *
   * `listOpportunities` can only speak about pets that have both a priced
   * input and a priced neon. That silently hides the rest of the market, which
   * reads as "the scanner found nothing" when the truth is "half the catalog has
   * not been priced yet". This reports the whole catalog instead, and labels
   * the reason a pet has no verdict.
   */
  catalog(rarities: string[] = ['rare', 'ultra_rare', 'legendary']): CatalogRow[] {
    const byPet = new Map<string, StoreItem[]>();
    for (const item of this.store.currentItems()) {
      const key = item.realName || item.name;
      const bucket = byPet.get(key);
      if (bucket) bucket.push(item);
      else byPet.set(key, [item]);
    }

    const margin = { feePct: this.config.feePct, minReturnOnCapital: this.config.minReturnOnCapital };
    const rows: CatalogRow[] = [];

    for (const [slug, items] of byPet) {
      const sample = items[0];
      if (!sample) continue;

      const input = cheapestNormalInput(items);
      const neon = cheapestNeonAsk(items);
      const imageUri = items.find((i) => i.imageUri && /^https?:\/\//i.test(i.imageUri))?.imageUri ?? null;

      const base = {
        slug,
        name: sample.name,
        rare: sample.rare,
        imageUri,
        inputPrice: input?.price ?? null,
        normalProductId: input?.productId ?? null,
        inputAge: input?.age ?? null,
        inputVariant: input?.variantKey ?? null,
        neonPrice: neon?.price ?? null,
        neonAge: neon?.age ?? null,
        neonProductId: neon?.productId ?? null,
      };

      const overCap = input !== null && input.price > this.config.maxNormalPrice;

      if (!input || !neon || overCap) {
        rows.push({
          ...base,
          craftCost: input ? input.price * 4 : null,
          neonNet: neon ? Math.round((neon.price * (1 - margin.feePct)) * 1000) / 1000 : null,
          margin: null,
          roiPct: null,
          ratio: null,
          verdict: null,
          status: !input ? 'awaiting_price' : overCap ? 'over_cap' : 'awaiting_neon',
          flags: [],
          salesPerWeek: null,
          demandScore: null,
          inputAvailable: null,
          inputBuyable: null,
          inputDepthPrice: null,
          inputDepth4xPrice: null,
          inputDepthListingCount: null,
          neonAvailable: null,
          neonDepthPrice: null,
          trendRank: null,
        });
        continue;
      }

      const result = evaluateCraft(
        {
          normalPrice: input.price,
          neonPrice: neon.price,
          normalAge: input.age,
          newbornPrice: input.newbornPrice,
          fullGrownPrice: input.fullGrownPrice,
        },
        margin
      );

      const craftCost = input.price * 4;
      const roiPct = craftCost > 0 ? Math.round((result.margin / craftCost) * 1000) / 10 : null;

      rows.push({
        ...base,
        craftCost,
        neonNet: result.neonNet,
        margin: result.margin,
        roiPct,
        ratio: result.ratio,
        verdict: result.verdict,
        status: 'evaluated',
        flags: result.flags,
        salesPerWeek: null,
        demandScore: null,
        inputAvailable: null,
        inputBuyable: null,
        inputDepthPrice: null,
        inputDepth4xPrice: null,
        inputDepthListingCount: null,
        neonAvailable: null,
        neonDepthPrice: null,
        trendRank: null,
      });
    }

    // Demand and depth are joined after evaluation, straight from the local
    // tables. Depth covers BOTH sides: the input book is what proves the
    // "cheapest 4 buyable" price the craft actually depends on.
    const joinIds = [
      ...new Set(
        rows.flatMap((r) => [r.normalProductId, r.neonProductId]).filter((id): id is number => typeof id === 'number')
      ),
    ];
    const demand = this.store.liquidityFor(joinIds);
    const depth = this.store.depthFor(joinIds);
    this.loadTrend();
    const trend = this.trendCache ?? new Map<string, number>();
    for (const row of rows) {
      const hit =
        (row.neonProductId !== null ? demand.get(row.neonProductId) : undefined) ??
        (row.normalProductId !== null ? demand.get(row.normalProductId) : undefined);
      row.salesPerWeek = hit ? hit.salesPerWeek : null;

      const dIn = row.normalProductId === null ? undefined : depth.get(row.normalProductId);
      row.inputAvailable = dIn ? dIn.available : null;
      row.inputBuyable = dIn ? dIn.available >= (dIn.units || 4) : null;
      row.inputDepthPrice =
        dIn && dIn.costForUnits !== null && dIn.units > 0 ? dIn.costForUnits / dIn.units : null;
      row.inputDepth4xPrice = dIn?.cheapest4xPrice ?? null;
      row.inputDepthListingCount = dIn?.listingCount4x ?? null;

      const dNeon = row.neonProductId === null ? undefined : depth.get(row.neonProductId);
      row.neonAvailable = dNeon ? dNeon.available : null;
      row.neonDepthPrice = dNeon && dNeon.available > 0 ? (dNeon.bookMin ?? row.neonPrice) : null;
      row.trendRank = trend.get(row.slug) ?? null;

      // When depth exists, buyable prices win and margin is recomputed
      const effectiveInput = row.inputDepth4xPrice ?? row.inputDepthPrice ?? row.inputPrice;
      const effectiveNeon = row.neonDepthPrice ?? row.neonPrice;

      if (effectiveInput !== null && effectiveNeon !== null) {
        const recheck = evaluateCraft(
          {
            normalPrice: effectiveInput,
            neonPrice: effectiveNeon,
            normalAge: row.inputAge,
            newbornPrice: null,
            fullGrownPrice: null,
          },
          margin
        );
        row.inputPrice = effectiveInput;
        row.neonPrice = effectiveNeon;
        row.craftCost = dIn?.costForUnits ?? (effectiveInput * 4);
        row.neonNet = recheck.neonNet;
        row.margin = Math.round((row.neonNet - row.craftCost) * 1000) / 1000;
        row.roiPct = row.craftCost > 0 ? Math.round((row.margin / row.craftCost) * 1000) / 10 : null;
        row.ratio = recheck.ratio;
        row.verdict = (row.inputBuyable ?? true) && row.margin > 0 ? recheck.verdict : 'skip';
        for (const flag of recheck.flags) {
          if (!row.flags.includes(flag)) row.flags.push(flag);
        }
      }

      if (row.inputBuyable === false && !row.flags.includes('cannot_buy_units')) {
        row.flags.push('cannot_buy_units');
      }

      row.demandScore =
        hit && row.margin !== null && hit.salesPerWeek > 0
          ? row.margin * hit.salesPerWeek
          : hit
            ? 0
            : null;
    }

    const wanted = rarities.map((r) => r.toLowerCase());
    const visible = wanted.length === 0 ? rows : rows.filter((r) => wanted.includes(String(r.rare ?? '').toLowerCase()));

    // Priced-and-profitable first, then the rest of the evaluated set, then the
    // pets we simply have no answer for.
    return visible.sort((a, b) => {
      const rank = (r: CatalogRow) => (r.status === 'evaluated' ? (r.margin ?? 0) > 0 ? 0 : 1 : 2);
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return (b.margin ?? Number.NEGATIVE_INFINITY) - (a.margin ?? Number.NEGATIVE_INFINITY);
    });
  }

  /** Everything the UI needs to state how complete the snapshot is. */
  coverage(): CoverageReport {
    return computeCoverage(
      this.store.currentItems(),
      this.store.petCount(),
      this.config.maxNormalPrice,
      this.config.feePct
    );
  }

  private resolveOptions(options: ScanOptions): Required<ScanOptions> {
    return {
      maxNormalPrice: options.maxNormalPrice ?? this.config.maxNormalPrice,
      feePct: options.feePct ?? this.config.feePct,
      units: options.units ?? this.config.units,
      verdict: options.verdict ?? 'all',
      limit: options.limit ?? 100,
      sortBy: options.sortBy ?? 'margin',
      includeLosses: options.includeLosses ?? false,
      rarities: options.rarities ?? ['rare', 'ultra_rare', 'legendary'],
      trendingOnly: options.trendingOnly ?? false,
    };
  }

  /** One pet, with the evidence behind its verdict. */
  getPet(slug: string): PetDetail | null {
    const items = this.store.itemsForPet(slug);
    if (items.length === 0) return null;

    const summary = this.listOpportunities({ limit: Number.MAX_SAFE_INTEGER, includeLosses: true }).find(
      (o) => o.petSlug === slug
    );
    if (!summary) return null;

    const since = Date.now() - 24 * 60 * 60_000;
    return {
      summary,
      neonLadder: neonLadder(items),
      variants: variantKeys(items),
      history: {
        normal: this.store.history(summary.normalProductId, since),
        neon: this.store.history(summary.neonProductId, since),
      },
    };
  }

  /** Price history for a pet's two sides, for the drift model. */
  history(
    slug: string,
    hours = 24
  ): { normal: Array<{ ts: number; price: number }>; neon: Array<{ ts: number; price: number }> } | null {
    const items = this.store.itemsForPet(slug);
    if (items.length === 0) return null;
    const summary = this.listOpportunities({ limit: Number.MAX_SAFE_INTEGER, includeLosses: true }).find(
      (o) => o.petSlug === slug
    );
    if (!summary) return null;
    const since = Date.now() - hours * 60 * 60_000;
    return {
      normal: this.store.history(summary.normalProductId, since),
      neon: this.store.history(summary.neonProductId, since),
    };
  }

  /** Live order book for one product: the depth check a min price cannot give. */
  async orderBook(productId: number, units = 4): Promise<OrderBookReport> {
    const [book] = await this.interactiveApi.productOffers([productId], { amount: 72 });
    const offers = book?.offers ?? [];
    const depth = depthCheck(offers, units);
    return {
      productId,
      units,
      enough: depth.enough,
      available: depth.available,
      costForUnits: depth.costForUnits,
      effectiveUnitCost: depth.effectiveUnitCost,
      cheapest: depth.cheapestListingPrice,
      cheapest4xPrice: depth.cheapest4xListingPrice,
      listingCountAtCheapest4x: depth.listingCountAtCheapest4x,
      priceTiers: depth.priceTiers,
      offers: offers.map((o) => ({ id: o.id, price: o.price })),
    };
  }

  status(): StatusReport {
    const latest = this.store.latestSweep();
    return {
      ok: this.store.itemCount() > 0,
      storeUrl: this.api.baseUrl,
      itemCount: this.store.itemCount(),
      petCount: this.store.petCount(),
      lastSweep: latest,
      feePct: this.config.feePct,
      breakEvenRatio: 4 / (1 - this.config.feePct),
      maxNormalPrice: this.config.maxNormalPrice,
      staleSeconds: latest?.finishedAt == null ? null : Math.round((Date.now() - latest.finishedAt) / 1000),
      fabricatedItemCount: this.store.countBySource('fabricated'),
      verifiedItemCount: this.store.countBySource('verified'),
      observedItemCount: this.store.countBySource('observed'),
      coverage: this.coverage(),
    };
  }

  isStale(): boolean {
    const latest = this.store.latestSweep();
    if (!latest?.finishedAt) return true;
    return Date.now() - latest.finishedAt > STALE_AFTER_MS;
  }

  /** Trigger a sweep, coalescing concurrent callers onto one run. */
  async triggerSweep(): Promise<SweepResult> {
    if (this.sweepInFlight) return this.sweepInFlight;
    this.sweepInFlight = runSweep(this.api, this.store, {
      currency: this.config.currency,
      minPrice: 0.01,
    }).finally(() => {
      this.sweepInFlight = null;
      this.cache = null;
    });
    return this.sweepInFlight;
  }

  sweeps(limit = 20): ReturnType<Store['recentSweeps']> {
    return this.store.recentSweeps(limit);
  }

  /** The marketplace's own most-traded board, for diagnostics and the UI. */
  trendBoard(): Array<{ slug: string; rank: number }> {
    this.loadTrend();
    return [...(this.trendCache ?? new Map<string, number>()).entries()].map(([slug, rank]) => ({
      slug,
      rank,
    }));
  }

  /** The catalog, as identity records. */
  pets(): Array<{ slug: string; name: string; rare: string | null }> {
    return this.store.petIndex();
  }

  /**
   * Resolve free-form user or model input to a pet slug.
   *
   * Accepts the slug (`dango_penguins`), the display name (`Dango Penguins`),
   * or a distinctive fragment, because a language model will rarely produce the
   * exact slug and an LLM-facing tool that demands one is a bad tool.
   */
  resolvePet(query: string): { slug: string; name: string } | null {
    const index = this.store.petIndex();
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return null;

    const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const target = normalise(query);

    const exact = index.find((p) => p.slug === needle || p.name.toLowerCase() === needle);
    if (exact) return { slug: exact.slug, name: exact.name };

    const normalised = index.find((p) => normalise(p.name) === target || normalise(p.slug) === target);
    if (normalised) return { slug: normalised.slug, name: normalised.name };

    const partial = index.filter((p) => normalise(p.name).includes(target));
    if (partial.length === 1) {
      const only = partial[0] as { slug: string; name: string };
      return { slug: only.slug, name: only.name };
    }
    // Ambiguous input is reported as ambiguous rather than silently guessed.
    return null;
  }

  /** Candidate matches for an ambiguous query, so callers can disambiguate. */
  searchPets(query: string, limit = 10): Array<{ slug: string; name: string; rare: string | null }> {
    const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const target = normalise(query);
    if (target.length === 0) return [];
    return this.store
      .petIndex()
      .filter((p) => normalise(p.name).includes(target))
      .slice(0, limit);
  }

  get defaults(): { feePct: number; maxNormalPrice: number; units: number; breakEvenRatio: number } {
    return {
      feePct: this.config.feePct,
      maxNormalPrice: this.config.maxNormalPrice,
      units: this.config.units,
      breakEvenRatio: 4 / (1 - this.config.feePct),
    };
  }
}

export function computeCoverage(
  items: StoreItem[],
  petsInCatalog: number,
  capitalCap: number,
  feePct: number = DEFAULT_MARGIN_CONFIG.feePct
): CoverageReport {
  const byPet = new Map<string, StoreItem[]>();
  for (const item of items) {
    const key = item.realName || item.name;
    const bucket = byPet.get(key);
    if (bucket) bucket.push(item);
    else byPet.set(key, [item]);
  }

  let petsEvaluable = 0;
  const inputAsks: number[] = [];

  for (const petItems of byPet.values()) {
    const normals = petItems.filter((i) => i.pumping === 'default' && isUsablePrice(i.price));
    const hasNeon = petItems.some((i) => i.pumping === 'neon' && isUsablePrice(i.price));
    if (normals.length > 0) {
      const cheapest = Math.min(...normals.map((i) => i.price));
      inputAsks.push(cheapest);
    }
    if (normals.length > 0 && hasNeon) petsEvaluable += 1;
  }

  const asks = items.filter((i) => isUsablePrice(i.price)).map((i) => i.price);
  const maxInputAskObserved = inputAsks.length > 0 ? Math.max(...inputAsks) : 0;
  const maxAskObserved = asks.length > 0 ? Math.max(...asks) : 0;

  // Exact best case: pair the highest neon ask we hold with the cheapest input
  // we hold. A craft clears the fee only when `neon x (1 - fee) > units x input`.
  // If even that best pairing fails, then no arrangement of the data on hand
  // could have produced a profit, so an empty list is a collection gap and not
  // a verdict about the market.
  const minInputAsk = inputAsks.length > 0 ? Math.min(...inputAsks) : 0;
  const profitableBandUnreached =
    asks.length > 0 &&
    minInputAsk > 0 &&
    maxAskObserved * (1 - feePct) <= FUSION_UNITS * minInputAsk;

  const band =
    inputAsks.length === 0
      ? 'none'
      : `$${Math.min(...inputAsks).toFixed(2)} - $${maxInputAskObserved.toFixed(2)}`;

  return {
    itemsTotal: items.length,
    itemsPriced: asks.length,
    itemsNoData: items.length - asks.length,
    petsInCatalog,
    petsEvaluable,
    petsInputOnly: Math.max(0, inputAsks.length - petsEvaluable),
    maxInputAskObserved,
    maxAskObserved,
    capitalCap,
    inputRangeCovered: capitalCap > 0 ? Math.min(1, maxInputAskObserved / capitalCap) : 0,
    profitableBandUnreached,
    inputBandReached: band,
  };
}

function sortOpportunities(list: Opportunity[], sortBy: ScanOptions['sortBy']): Opportunity[] {
  const copy = [...list];
  switch (sortBy) {
    case 'ratio':
      // Highest multiple of the break-even ratio: the most robust way to rank,
      // because it is independent of absolute price and of position size.
      return copy.sort((a, b) => b.ratio / b.breakEvenRatio - a.ratio / a.breakEvenRatio);
    case 'discount':
      // Cheapest normal relative to its own 7-day average: a real dip.
      return copy.sort((a, b) => discount(b) - discount(a));
    case 'cheap':
      // Lowest capital at risk first: the same profit on less exposure.
      return copy.sort((a, b) => a.craftCost - b.craftCost);
    case 'demand':
      // Profit weighted by observed turnover. Pets with no demand reading yet
      // rank below measured ones (they are unknown, not worthless) but above
      // measured losers, so the sort never hides a real edge behind missing
      // data.
      return copy.sort((a, b) => demandKey(b) - demandKey(a));
    case 'margin':
    default:
      return copy.sort((a, b) => b.margin - a.margin);
  }
}
/**
 * Sort key for demand ranking. Three bands, and the bands are the point:
 *
 *   2e6+  measured AND profitable per week  — act on these first
 *   1e6+  profitable but unmeasured          — promising, demand unknown
 *   below everything else                  — measured-no-demand and losers
 *
 * A pet with no sales reading is *unknown*, not worthless, so it must not be
 * ranked against measured data as though zero sales were observed. Equally, a
 * pet measured to have no demand is known-bad and belongs below the unknowns,
 * because "no sales recorded" is stronger evidence than "nobody has looked".
 */
function demandKey(o: Opportunity): number {
  if (o.demandScore !== null && o.demandScore !== undefined && o.demandScore > 0) {
    return 2e6 + o.demandScore;
  }
  if (o.margin > 0) {
    return (o.demandScore === null || o.demandScore === undefined ? 1e6 : 0) + o.margin;
  }
  return -1e6 + o.margin;
}

/** How far below its own 7-day average the input ask sits, as a fraction. */
function discount(opportunity: Opportunity): number {
  const avg = opportunity.normalAvgPrice;
  if (avg === null || avg <= 0) return 0;
  return (avg - opportunity.normalPrice) / avg;
}

export { DEFAULT_MARGIN_CONFIG };
