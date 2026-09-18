/**
 * Data-hygiene helpers.
 *
 * Every rule here exists because it caught a real error during reconnaissance:
 *  - `price === 0` is the market's "no data" sentinel, not a free pet. Reading
 *    it as a price manufactures an infinite margin on the normal side and a
 *    catastrophic fake loss on the neon side.
 *  - Raw minima are polluted by placeholder asks (a real $416 Dragonfruit Fox
 *    listing sat in the same book as $0.83 offers).
 *  - A craft needs 4 units. A single cheap listing is not an opportunity.
 */

import type { ProductOffer, StoreItem } from './types.ts';

/** The market uses 0 as "unpriced". Never treat it as a real ask. */
export function isUsablePrice(price: unknown): price is number {
  return typeof price === 'number' && Number.isFinite(price) && price > 0;
}

export function isUsableItem(item: Pick<StoreItem, 'price'>): boolean {
  return isUsablePrice(item.price);
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

export interface OutlierOptions {
  /** Reject asks above this multiple of the median... */
  factor?: number;
  /** ...but only when they also exceed the median by this many currency units. */
  absoluteFloor?: number;
}

/**
 * Reject asks that are implausibly far above the typical level.
 *
 * A spread-based rule (median absolute deviation) was tried first and was
 * wrong for a price book: on the real Dragonfruit Fox book it rejected a
 * perfectly ordinary $2.60 ask alongside the absurd $416 one, because the MAD
 * of a densely-packed cheap book is tiny. Order books legitimately span an
 * order of magnitude.
 *
 * So rejection requires *both* conditions: proportionally enormous relative to
 * the median, and absolutely large. A $5 ask against a $0.01 median is a real
 * spread; a $416 ask against a $0.96 median is a placeholder.
 */
export function rejectOutlierAsks(
  values: number[],
  options: OutlierOptions = {}
): { kept: number[]; rejected: number[] } {
  const factor = options.factor ?? 100;
  const absoluteFloor = options.absoluteFloor ?? 25;

  const usable = values.filter(isUsablePrice);
  if (usable.length < 4) return { kept: usable, rejected: [] };

  const med = median(usable);
  if (!Number.isFinite(med) || med <= 0) return { kept: usable, rejected: [] };

  const proportionalCeiling = med * factor;
  const kept: number[] = [];
  const rejected: number[] = [];
  for (const v of usable) {
    const absurd = v > proportionalCeiling && v - med > absoluteFloor;
    (absurd ? rejected : kept).push(v);
  }
  return { kept, rejected };
}

/**
 * Do we have enough depth to actually buy `units`?
 *
 * Cheap listings are consumed within minutes by other people running the same
 * arithmetic, so a min price with depth 1 is not a real opportunity.
 */
export interface DepthAnalysis {
  enough: boolean;
  available: number;
  costForUnits: number | null;
  effectiveUnitCost: number | null;
  cheapestListingPrice: number | null;
  cheapest4xListingPrice: number | null;
  listingCountAtCheapest4x: number | null;
  priceTiers: Array<{ price: number; count: number }>;
}

/**
 * Do we have enough depth to actually buy `units`?
 *
 * Implements the user's 4-listing rule:
 * If $0.10 is listed but only 1 available, it is not the usable cheapest.
 * If $0.20 has 4 listings, then $0.20 is the cheapest 4x listing price.
 * Also computes exact cost to acquire `units` (sum of cheapest N asks).
 */
export function depthCheck(
  offers: ProductOffer[],
  units = 4
): DepthAnalysis {
  const usable = offers
    .filter((o) => isUsablePrice(o.price))
    .map((o) => o.price)
    .sort((a, b) => a - b);

  const available = usable.length;
  const slice = usable.slice(0, units);
  const enough = slice.length >= units;
  const costForUnits = enough ? slice.reduce((sum, p) => sum + p, 0) : null;
  const effectiveUnitCost = costForUnits !== null && units > 0 ? costForUnits / units : null;
  const cheapestListingPrice = usable.length > 0 ? usable[0] ?? null : null;

  // Group by price to find price tier with >= units
  const countsByPrice = new Map<number, number>();
  for (const p of usable) {
    countsByPrice.set(p, (countsByPrice.get(p) ?? 0) + 1);
  }

  const priceTiers: Array<{ price: number; count: number }> = [];
  for (const [price, count] of countsByPrice.entries()) {
    priceTiers.push({ price, count });
  }
  priceTiers.sort((a, b) => a.price - b.price);

  let cheapest4xListingPrice: number | null = null;
  let listingCountAtCheapest4x: number | null = null;

  // Check single tier with count >= units first
  for (const tier of priceTiers) {
    if (tier.count >= units) {
      cheapest4xListingPrice = tier.price;
      listingCountAtCheapest4x = tier.count;
      break;
    }
  }

  // If no single tier has units, but cumulative offers >= units, take the ceiling price
  if (cheapest4xListingPrice === null && enough) {
    const ceilingPrice = slice[units - 1] ?? null;
    cheapest4xListingPrice = ceilingPrice;
    listingCountAtCheapest4x = ceilingPrice !== null ? countsByPrice.get(ceilingPrice) ?? 0 : null;
  }

  return {
    enough,
    available,
    costForUnits,
    effectiveUnitCost,
    cheapestListingPrice,
    cheapest4xListingPrice,
    listingCountAtCheapest4x,
    priceTiers,
  };
}

/** Count distinct values (used for "how many age rungs are actually priced"). */
export function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}
