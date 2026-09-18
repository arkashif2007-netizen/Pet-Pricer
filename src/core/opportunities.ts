/**
 * Turn a flat bag of priced items into evaluated craft opportunities.
 *
 * The rules encoded here are the ones that repeatedly cost real money when
 * done by hand during reconnaissance:
 *
 *  1. `price === 0` is "no data". It must never enter a minimum, or the
 *     normal side reports a free pet (infinite margin) and the neon side
 *     reports a fake loss.
 *  2. The input side compares like-for-like. A cheaper Full-Grown is usually
 *     not an inversion at all, it is a *different product* (non-flyable,
 *     non-rideable, different pumping), so the input tiers are only compared
 *     inside one attribute-matched variant.
 *  3. The neon side compares on price alone, across every age rung and every
 *     attribute combination, because the age ladder is not monotonic
 *     (observed: reborn $0.22, twinkle $0, flare $1.20, sparkle $1.41).
 */

import { isUsablePrice, median } from './hygiene.ts';
import { DEFAULT_MARGIN_CONFIG, FUSION_UNITS, evaluateCraft } from './margin.ts';
import type { MarginConfig } from './margin.ts';
import type { Flag, FlipOpportunity, Opportunity, StoreItem } from './types.ts';

export interface BuildOptions {
  margin?: MarginConfig;
  /**
   * Capital cap on the *input* side. Bounds capital per craft, not
   * profitability: a $0.08 pet and a $2.90 pet are identical in ratio terms.
   */
  maxNormalPrice?: number;
  /** Units consumed per craft. 4 for neon. */
  units?: number;
  /**
   * A rung priced below `median / factor` while its peers are stable is
   * suspect. Default 12 keeps genuinely cheap rungs while catching the
   * placeholder-class values that can manufacture fake margins.
   */
  lowOutlierFactor?: number;
}

interface VariantBucket {
  key: string;
  byAge: Map<string, StoreItem>;
}

/**
 * Cheapest attribute-matched normal input for one pet, plus the age ladder
 * needed for the labour-value context.
 */
interface NormalSide {
  price: number;
  productId: number;
  age: string | null;
  variantKey: string;
  newbornPrice: number | null;
  fullGrownPrice: number | null;
  avgPrice: number | null;
  rungCount: number;
  suspiciousLow: boolean;
  rejectedHighCount: number;
  zeroPriceCount: number;
}

const AGE_ALIASES_NEWBORN = ['newborn', 'default'];
const AGE_ALIASES_FULL_GROWN = ['full_grown', 'fullgrown', 'full-grown'];

export function buildOpportunities(items: StoreItem[], options: BuildOptions = {}): Opportunity[] {
  const margin = options.margin ?? DEFAULT_MARGIN_CONFIG;
  const units = options.units ?? FUSION_UNITS;
  const maxNormalPrice = options.maxNormalPrice ?? Number.POSITIVE_INFINITY;
  const lowOutlierFactor = options.lowOutlierFactor ?? 12;

  const byPet = new Map<string, StoreItem[]>();
  for (const item of items) {
    const key = item.realName || item.name;
    const bucket = byPet.get(key);
    if (bucket) bucket.push(item);
    else byPet.set(key, [item]);
  }

  const out: Opportunity[] = [];

  for (const [petSlug, petItems] of byPet) {
    const sample = petItems[0];
    if (!sample) continue;

    const zeroPriceCount = petItems.filter((i) => !isUsablePrice(i.price)).length;
    const normal = cheapestNormalInput(petItems, lowOutlierFactor);
    const neon = cheapestNeonAsk(petItems);

    if (!normal || !neon) continue;
    if (normal.price > maxNormalPrice) continue;

    const result = evaluateCraft(
      {
        normalPrice: normal.price,
        neonPrice: neon.price,
        normalAge: normal.age,
        newbornPrice: normal.newbornPrice,
        fullGrownPrice: normal.fullGrownPrice,
      },
      margin
    );

    const flags: Flag[] = [...result.flags];
    if (zeroPriceCount > 0) flags.push('no_data_zero_price');
    if (normal.suspiciousLow) flags.push('outlier_ask_rejected');
    if (normal.rejectedHighCount > 0 && !flags.includes('outlier_ask_rejected')) {
      flags.push('outlier_ask_rejected');
    }

    out.push({
      petSlug,
      petName: sample.name,
      rare: sample.rare,
      currency: 'usd',
      normalPrice: normal.price,
      normalProductId: normal.productId,
      normalAge: normal.age,
      craftCost: normal.price * units,
      neonPrice: neon.price,
      neonProductId: neon.productId,
      neonAge: neon.age,
      neonNet: result.neonNet,
      margin: result.margin,
      ratio: result.ratio,
      breakEvenRatio: result.breakEvenRatio,
      tierGap: result.tierGap,
      feePct: margin.feePct,
      normalAvgPrice: normal.avgPrice,
      neonAvgPrice: neon.avgPrice,
      normalVariant: normal.variantKey,
      neonVariant: neon.variant,
      imageUri: bestImage(petItems),
      verdict: result.verdict,
      flags,
      // Demand, depth and trend are joined later, from the local tables, by
      // the service layer. The engine deals in prices only.
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

  return out;
}

/**
 * The market's own thumbnail for a pet, preferring a real http(s) URI.
 *
 * The feed emits the same image for every variant of a pet, so any priced row
 * will do; we prefer one whose URI actually looks like a URL rather than an
 * opaque id.
 */
function bestImage(items: StoreItem[]): string | null {
  for (const item of items) {
    const uri = item.imageUri;
    if (uri && /^https?:\/\//i.test(uri)) return uri;
  }
  return null;
}

/**
 * Pick the cheapest normal input.
 *
 * Buckets by attribute combination first so `newborn` is never compared with a
 * cheaper but incomparable `full_grown` from a different variant. Within the
 * winning combination, the age ladder gives `tierGap` — the market value of
 * ageing, which on cheap pets turns out to be approximately zero.
 */
export function cheapestNormalInput(
  items: StoreItem[],
  lowOutlierFactor = 12
): NormalSide | null {
  const normals = items.filter((i) => i.pumping === 'default' && isUsablePrice(i.price));
  if (normals.length === 0) return null;

  const buckets = new Map<string, VariantBucket>();
  for (const item of normals) {
    const key = `${item.pumping}:${item.flyable}:${item.rideable}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, byAge: new Map() };
      buckets.set(key, bucket);
    }
    const ageKey = item.age ?? '__none__';
    const existing = bucket.byAge.get(ageKey);
    if (!existing || item.price < existing.price) bucket.byAge.set(ageKey, item);
  }

  let best: { bucket: VariantBucket; cheapest: StoreItem } | null = null;
  for (const bucket of buckets.values()) {
    for (const item of bucket.byAge.values()) {
      if (!best || item.price < best.cheapest.price) best = { bucket, cheapest: item };
    }
  }
  if (!best) return null;

  const rungs = [...best.bucket.byAge.values()].filter((i) => isUsablePrice(i.price));
  const prices = rungs.map((i) => i.price);
  const med = median(prices);

  // A rung far below its own peers is the shape of a placeholder price. Note
  // it rather than silently trusting it.
  const suspiciousLow =
    rungs.length >= 3 && Number.isFinite(med) && med > 0 && best.cheapest.price < med / lowOutlierFactor;

  const findAge = (aliases: string[]): number | null => {
    for (const rung of rungs) {
      if (rung.age && aliases.includes(rung.age.toLowerCase())) return rung.price;
    }
    return null;
  };

  return {
    price: best.cheapest.price,
    productId: best.cheapest.id,
    age: best.cheapest.age,
    variantKey: best.bucket.key,
    newbornPrice: findAge(AGE_ALIASES_NEWBORN),
    fullGrownPrice: findAge(AGE_ALIASES_FULL_GROWN),
    avgPrice: isUsablePrice(best.cheapest.avgPrice) ? best.cheapest.avgPrice : null,
    rungCount: rungs.length,
    suspiciousLow,
    rejectedHighCount: 0,
    zeroPriceCount: 0,
  };
}

export interface FlipOptions {
  feePct?: number;
  /**
   * Minimum discount to the 7-day average before a listing is worth a look.
   * 15% is deliberately not small: below that, ordinary ask noise produces
   * 'opportunities' that vanish the moment you try to act on them.
   */
  minDiscountPct?: number;
  /** Minimum net margin in absolute currency, to kill sub-cent noise. */
  minMargin?: number;
  /** Capital cap on the ask, per unit. */
  maxAsk?: number;
}

/**
 * Listings priced below their own 7-day average.
 *
 * HYGIENE, and this is the whole difficulty of the signal: on a large share of
 * the catalog `avgPrice` is emitted equal to the current ask. When the two are
 * identical the average carries no information at all, so those rows are
 * dropped rather than scored as a 0% discount — and identical-value rows are
 * counted so the caller can see how much of the book is in that state.
 *
 * A row only earns `watch` when it clears the discount floor *and* nets a
 * positive margin after the sell-side fee. Everything else that is merely
 * below its average lands in `weak`, which is a watchlist, not a trade.
 */
export function buildFlips(items: StoreItem[], options: FlipOptions = {}): FlipOpportunity[] {
  const feePct = options.feePct ?? DEFAULT_MARGIN_CONFIG.feePct;
  const minDiscountPct = options.minDiscountPct ?? 0.15;
  const minMargin = options.minMargin ?? 0.01;
  const maxAsk = options.maxAsk ?? Number.POSITIVE_INFINITY;

  /** How many rungs of each pet sit below their own average, for context. */
  const belowByPet = new Map<string, number>();
  for (const item of items) {
    if (!isUsablePrice(item.price) || !isUsablePrice(item.avgPrice)) continue;
    if (item.price >= item.avgPrice) continue;
    const key = item.realName || item.name;
    belowByPet.set(key, (belowByPet.get(key) ?? 0) + 1);
  }

  const out: FlipOpportunity[] = [];

  for (const item of items) {
    if (!isUsablePrice(item.price) || !isUsablePrice(item.avgPrice)) continue;
    if (item.price > maxAsk) continue;

    const ask = item.price;
    const marketAvg = item.avgPrice;
    const discountPct = (marketAvg - ask) / marketAvg;
    if (discountPct <= 0) continue;

    const netProceeds = marketAvg * (1 - feePct);
    const margin = netProceeds - ask;
    const flags: Flag[] = [];

    // The average being exactly the ask means it is a copy of the current
    // price, not an average. Such a row can never be a real discount.
    if (marketAvg === ask) continue;

    const petKey = item.realName || item.name;
    const siblingsBelow = Math.max(0, (belowByPet.get(petKey) ?? 1) - 1);

    const clearsFloor = discountPct >= minDiscountPct && margin >= minMargin;
    if (!clearsFloor) flags.push('below_break_even_ratio');

    out.push({
      petSlug: item.realName || item.name,
      petName: item.name,
      rare: item.rare,
      currency: 'usd',
      imageUri: item.imageUri && /^https?:\/\//i.test(item.imageUri) ? item.imageUri : null,
      productId: item.id,
      pumping: item.pumping,
      age: item.age,
      flyable: item.flyable,
      rideable: item.rideable,
      variant: `${item.pumping}:${item.flyable}:${item.rideable}`,
      ask,
      marketAvg,
      feePct,
      netProceeds,
      margin,
      discountPct,
      siblingsBelow,
      verdict: clearsFloor ? 'watch' : 'weak',
      flags,
      salesPerWeek: null,
    });
  }

  // Biggest discount first, then the widest absolute spread: a 60% discount on
  // a $0.03 pet is worth less than 40% on a $0.80 one.
  return out.sort((a, b) => b.discountPct - a.discountPct || b.margin - a.margin);
}

/**
 * Cheapest neon ask, across every age rung and every attribute combination.
 *
 * Walking every rung is mandatory: the ladder is not ordered, and on one
 * verified pet the cheapest rung was `reborn` at $3.07 while `luminous` sat at
 * $4.80 and `sunshine` at $4.58.
 */
export function cheapestNeonAsk(
  items: StoreItem[]
): { price: number; productId: number; age: string | null; avgPrice: number | null; variant: string } | null {
  let best: StoreItem | null = null;
  for (const item of items) {
    if (item.pumping !== 'neon') continue;
    if (!isUsablePrice(item.price)) continue;
    if (!best || item.price < best.price) best = item;
  }
  return best
    ? {
        price: best.price,
        productId: best.id,
        age: best.age,
        avgPrice: isUsablePrice(best.avgPrice) ? best.avgPrice : null,
        variant: `${best.pumping}:${best.flyable}:${best.rideable}`,
      }
    : null;
}

/** Every neon rung for a pet, for the "walk all ages" evidence in the UI. */
export function neonLadder(items: StoreItem[]): Array<{ age: string | null; price: number; productId: number }> {
  return items
    .filter((i) => i.pumping === 'neon' && isUsablePrice(i.price))
    .sort((a, b) => a.price - b.price)
    .map((i) => ({ age: i.age, price: i.price, productId: i.id }));
}

/** Distinct attribute combinations present for a pet, for diagnostics. */
export function variantKeys(items: StoreItem[]): string[] {
  return [...new Set(items.map((i) => `${i.pumping}:${i.flyable}:${i.rideable}`))].sort();
}
