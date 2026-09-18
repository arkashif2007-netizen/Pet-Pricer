/**
 * Domain types for the Starpets margin scanner.
 *
 * The market's own vocabulary is preserved deliberately: `pumping` is the axis
 * that carries neon-ness (NOT `age`), and every (pet, pumping, flyable,
 * rideable, age) tuple is its own product with its own price.
 */

/** Neon-ness. `mega_neon` has no age ladder. */
export type Pumping = 'default' | 'neon' | 'mega_neon';

/** The three attribute axes that make two offers different products. */
export interface VariantKey {
  pumping: string;
  flyable: boolean;
  rideable: boolean;
}

export const variantKeyString = (v: VariantKey): string =>
  `${v.pumping}:${v.flyable}:${v.rideable}`;

/**
 * A single priced offer as returned by `POST /api/v2/store/items/all`.
 *
 * HYGIENE: `price === 0` means "no data", never "$0.00". It is a placeholder
 * the market emits for unpriced variants, not a free pet.
 */
export interface StoreItem {
  /** Product id. Stable across sweeps; unique per variant+age. */
  id: number;
  goodId: string;
  /** Display name, e.g. "Dango Penguins". */
  name: string;
  type: string;
  /** URL slug, e.g. "dango_penguins". The stable joining key. */
  realName: string;
  imageId: string | null;
  imageUri: string | null;
  subtype: string | null;
  /** Age rung. `null` for mega_neon, which has no ladder. */
  age: string | null;
  rare: string | null;
  pumping: string;
  flyable: boolean;
  rideable: boolean;
  /** Lowest current ask in the requested currency. 0 => no data. */
  price: number;
  /** 7-day average ask. 0 => no data. */
  avgPrice: number | null;
  bonuses: number;
  /**
   * Where this row came from. Recorded, never inferred: `observed` from a
   * sweep, `verified` for the hand-checked reference pets, `fabricated` for
   * generated data that must not be presented as real.
   */
  source?: string;
}

/** One seller's offer for a product, from `POST /api/v2/store/items/product`. */
export interface ProductOffer {
  /** Store-item id (a different, larger id space than product ids). */
  id: string;
  productId: number;
  price: number;
}

export interface OrderBook {
  productId: number;
  offers: ProductOffer[];
  /** Total number of offers the market reports for this product. */
  count: number;
  currency: string;
}

/** `GET /api/v2/products/{id}/info` — product detail plus liquidity. */
export interface ProductInfo {
  id: number;
  goodId: string;
  name: string;
  type: string;
  realName: string;
  age: string | null;
  rare: string | null;
  pumping: string;
  flyable: boolean;
  rideable: boolean;
  currentStoreItemId: Record<string, string>;
  currentMinPrice: Record<string, number>;
  /** Liquidity: how many units actually cleared this week. */
  numberOfSalesPerWeek: number | null;
  avgPriceForWeek: Record<string, number>;
  bonuses: Record<string, number>;
  imageUri?: string | null;
}

/**
 * The marketplace's own most-traded board.
 *
 * `market.apineural.com` is the same service behind starpets.gg (same CDN,
 * same data), so its popularity sort is the marketplace's own answer to
 * "which pets are people trading right now" — no third-party scrape needed.
 */
export interface TrendEntry {
  slug: string;
  name: string;
  rare: string | null;
  imageUri: string | null;
  rank: number;
}
export type Verdict = 'craft' | 'marginal' | 'skip';

/** Reasons attached to an opportunity so the UI never has to guess. */
export type Flag =
  | 'no_data_zero_price'
  | 'fee_erases_margin'
  | 'below_break_even_ratio'
  | 'thin_depth'
  | 'full_grown_cheaper_than_newborn'
  | 'ageing_unpaid'
  | 'outlier_ask_rejected'
  | 'low_liquidity'
  | 'capital_over_cap'
  /** The 7-day average equals the current ask, so it carries no signal. */
  | 'avg_price_equals_ask'
  /** Only one rung past the 7-day average exists; the average is likely stale. */
  | 'average_only_signal'
  /** The input product has fewer listings than a craft needs. */
  | 'cannot_buy_units';

/** A fully-evaluated craft candidate for one pet. */
export interface Opportunity {
  petSlug: string;
  petName: string;
  rare: string | null;
  currency: string;

  /** Cheapest attribute-matched normal input, across all ages. */
  normalPrice: number;
  normalProductId: number;
  normalAge: string | null;

  /** Cost to acquire the 4 inputs. */
  craftCost: number;

  /** Cheapest neon ask, across all ages and attributes. */
  neonPrice: number;
  neonProductId: number;
  neonAge: string | null;

  /** Neon ask after the marketplace's sell-side fee. */
  neonNet: number;

  /** neonNet - craftCost. The number the app exists to show. */
  margin: number;

  /** neonPrice / normalPrice. Compared against breakEvenRatio. */
  ratio: number;
  /** 4 / (1 - fee). Anything at or below this is a guaranteed loss. */
  breakEvenRatio: number;

  /** Spread across the age ladder for the baseline normal variant. */
  tierGap: number;
  /** Fee used for `neonNet`, so the UI never has to guess it. */
  feePct: number;

  /**
   * The market's own 7-day average ask for each side. Comparing an ask to its
   * own average is free information from the sweep: a cheapest-normal well
   * below its average is a stronger signal than price alone.
   */
  normalAvgPrice: number | null;
  neonAvgPrice: number | null;

  /** Attribute identity of the winning input, so the card can be exact. */
  normalVariant: string;
  neonVariant: string;
  /** Real CDN thumbnail, straight from the market. Null when the feed omits it. */
  imageUri: string | null;

  verdict: Verdict;
  flags: Flag[];

  /**
   * Weekly sales for the neon side, when demand has been enriched. `null`
   * means we have not asked the market yet — absence is preserved rather than
   * read as zero, because zero would rank the pet as unsellable on no evidence.
   */
  salesPerWeek: number | null;
  /**
   * `margin × salesPerWeek`: the expected weekly profit if the whole margin is
   * realised once per sale. Only meaningful when `salesPerWeek` is present.
   */
  demandScore: number | null;

  /**
   * Depth-verified input side, from the real order book.
   *
   * `available` is how many listings actually exist for the winning input
   * product; `costForUnits` is the total cost of the cheapest 4 of them, which
   * is the only input price that means anything for a craft. `null` values
   * mean the book has not been read yet — unknown, not zero.
   */
  inputAvailable: number | null;
  /** True when at least `units` listings exist: you can actually buy 4. */
  inputBuyable: boolean | null;
  /** Per-unit cost of the cheapest 4 listings (costForUnits / units). */
  inputDepthPrice: number | null;
  /** The lowest price tier that actually has at least 4 listings available. */
  inputDepth4xPrice: number | null;
  /** Number of listings available at that cheapest 4x price tier. */
  inputDepthListingCount: number | null;
  /** How many real listings the neon book holds, when read. */
  neonAvailable: number | null;
  /** Book-verified cheapest neon ask, when the live book disagrees with the sweep. */
  neonDepthPrice: number | null;

  /** Rank in the marketplace's own most-traded list; null when unranked. */
  trendRank: number | null;
}

/**
 * A listing priced below its own 7-day average.
 *
 * This is a *different* claim from the craft margin and must not be conflated
 * with it. The craft margin is arithmetic on two asks and needs no assumption
 * about demand. This one assumes a buyer exists at the market average, which
 * the snapshot cannot prove — the cheapest ask being below the average is
 * itself evidence that sellers are competing downward.
 *
 * So it is reported as a watchlist signal with its confidence attached, never
 * as a realised profit.
 */
export type FlipVerdict = 'watch' | 'weak';

export interface FlipOpportunity {
  petSlug: string;
  petName: string;
  rare: string | null;
  currency: string;
  imageUri: string | null;

  productId: number;
  pumping: string;
  age: string | null;
  flyable: boolean;
  rideable: boolean;
  variant: string;

  /** Current cheapest ask for this exact product. */
  ask: number;
  /** The market's own 7-day average ask. */
  marketAvg: number;
  feePct: number;
  /** `marketAvg * (1 - fee)` — what selling at the average would net. */
  netProceeds: number;
  /** `netProceeds - ask`. Only meaningful if a buyer at the average exists. */
  margin: number;
  /** `(marketAvg - ask) / marketAvg`. */
  discountPct: number;

  /** How many other rungs of this pet are also under their average. */
  siblingsBelow: number;

  verdict: FlipVerdict;
  flags: Flag[];
  salesPerWeek: number | null;
}
