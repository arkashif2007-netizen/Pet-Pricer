/**
 * The margin engine.
 *
 * The whole product collapses to one inequality:
 *
 *     margin = neon_ask * (1 - fee) - 4 * normal_ask  >  0
 *       =>  neon_ask / normal_ask  >  4 / (1 - fee)
 *
 * So the break-even is a *ratio*, independent of the pet and of absolute
 * price. For the configured 25% sell-side fee that is 5.333x. That is what
 * makes scanning hundreds of pets tractable: it is a ratio screen first, and
 * only the survivors need order-book depth analysis.
 */

import type { Flag, Verdict } from './types.ts';

/** Units of the normal pet consumed to make one neon. */
export const FUSION_UNITS = 4;

export interface MarginConfig {
  /** Sell-side marketplace fee as a fraction, e.g. 0.25 for 25%. */
  feePct: number;
  /** Minimum return on deployed capital before a craft is called 'craft'. */
  minReturnOnCapital: number;
}

export const DEFAULT_MARGIN_CONFIG: MarginConfig = {
  feePct: 0.25,
  minReturnOnCapital: 0.05,
};

/**
 * neon/normal ratio at which the craft exactly breaks even.
 * `4 / (1 - feePct)`.
 */
export function breakEvenRatio(feePct: number): number {
  if (!Number.isFinite(feePct) || feePct < 0 || feePct >= 1) {
    throw new RangeError(`feePct must be in [0, 1), got ${feePct}`);
  }
  return FUSION_UNITS / (1 - feePct);
}

/** What actually lands in your pocket when a neon sells at `ask`. */
export function netProceeds(ask: number, feePct: number): number {
  return ask * (1 - feePct);
}

export interface CraftInput {
  /** Cheapest attribute-matched normal input ask. */
  normalPrice: number;
  /** Cheapest neon ask across all ages and attributes. */
  neonPrice: number;
  /** Age of the cheapest normal, and the baseline / full-grown asks if known. */
  normalAge?: string | null;
  newbornPrice?: number | null;
  fullGrownPrice?: number | null;
}

export interface CraftResult {
  craftCost: number;
  neonNet: number;
  margin: number;
  ratio: number;
  breakEvenRatio: number;
  /** full-grown minus newborn for the baseline normal variant. */
  tierGap: number;
  returnOnCapital: number;
  profitable: boolean;
  flags: Flag[];
  verdict: Verdict;
}

/**
 * Evaluate one craft candidate. Pure: no I/O, no clock, no randomness.
 */
export function evaluateCraft(
  input: CraftInput,
  config: MarginConfig = DEFAULT_MARGIN_CONFIG
): CraftResult {
  const { normalPrice, neonPrice } = input;
  const flags: Flag[] = [];

  const craftCost = normalPrice * FUSION_UNITS;
  const neonNet = netProceeds(neonPrice, config.feePct);
  const margin = neonNet - craftCost;
  const ratio = normalPrice > 0 ? neonPrice / normalPrice : Number.POSITIVE_INFINITY;
  const be = breakEvenRatio(config.feePct);
  const returnOnCapital = craftCost > 0 ? margin / craftCost : 0;

  const newborn = input.newbornPrice ?? null;
  const fullGrown = input.fullGrownPrice ?? null;
  const tierGap =
    newborn !== null && fullGrown !== null && newborn > 0 ? fullGrown - newborn : 0;

  const profitable = margin > 0;

  if (!profitable) {
    flags.push('fee_erases_margin');
    if (ratio > 0 && ratio <= be) flags.push('below_break_even_ratio');
  }

  // A verified inversion: full-grown asking less than newborn for the same
  // attribute-matched variant. Real, but usually a different product unless
  // the attributes match exactly — callers must only pass matched asks.
  if (tierGap < 0) flags.push('full_grown_cheaper_than_newborn');

  // Ageing moved the price by (almost) nothing, so the labour is unpaid and
  // the entire margin is the 4->1 fusion edge.
  if (newborn !== null && fullGrown !== null && Math.abs(tierGap) < 0.02) {
    flags.push('ageing_unpaid');
  }

  let verdict: Verdict;
  if (!profitable) {
    verdict = 'skip';
  } else if (returnOnCapital < config.minReturnOnCapital) {
    flags.push('thin_depth');
    verdict = 'marginal';
  } else {
    verdict = 'craft';
  }

  return {
    craftCost,
    neonNet,
    margin,
    ratio,
    breakEvenRatio: be,
    tierGap,
    returnOnCapital,
    profitable,
    flags,
    verdict,
  };
}

/**
 * Rank score that respects turnover.
 *
 * A $0.10 margin on something selling 200x/week beats $0.30 on something
 * selling twice. Without velocity the ranking points at items that can never
 * actually be sold.
 */
export function opportunityScore(margin: number, salesPerWeek: number | null): number {
  if (margin <= 0) return margin; // keep losses grouped at the bottom
  if (salesPerWeek === null || salesPerWeek <= 0) return margin;
  return margin * salesPerWeek;
}
