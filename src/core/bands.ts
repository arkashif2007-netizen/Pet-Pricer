/**
 * Price-band planning.
 *
 * The market caps any single filtered query at `page <= 120` with
 * `amount <= 72`, so one filter can yield at most 8,640 items — while the
 * Adopt Me pet catalog spans far more than that. Partitioning by
 * `filter.price` is the way through.
 *
 * Two hard-won details:
 *
 *  1. **Splitting must be geometric, not arithmetic.** Item density is
 *     violently front-loaded: an unfiltered ascending query's page 120 stops
 *     at $0.60. An arithmetic bisect of [0, 500] would spin.
 *
 *  2. **The floor must be above zero.** `price === 0` is the market's "no
 *     data" sentinel and accounts for roughly half the catalog. Sweeping from
 *     zero subdivides an enormous band of worthless placeholders forever —
 *     observed live as a band of `$0.00-$0.00` still holding 18,527 items.
 */

export interface Band {
  min: number;
  /** `null` means unbounded above. */
  max: number | null;
}

/**
 * Lowest price worth sweeping. Anything at or below this is the "no data"
 * placeholder class, never a real ask.
 */
export const MIN_SWEEP_PRICE = 0.01;

export function fullRange(minPrice: number = MIN_SWEEP_PRICE): Band {
  return { min: minPrice, max: null };
}

/**
 * Next split point for a band that is too large to page through.
 *
 * Geometric when both ends are known; an aggressive multiple when the top is
 * unbounded, so the open tail is divided in a handful of steps rather than
 * dozens. Returns a value that is **strictly** inside the band, or fails by
 * returning `min`, which `planBand` treats as unsplittable.
 */
export function midpoint(min: number, max: number | null): number {
  if (max === null) return min === 0 ? 1 : Math.max(min * 4, min + 0.01);
  if (!(max > min)) return min;

  let mid = min <= 0 ? max / 2 : Math.sqrt(min * max);
  if (!Number.isFinite(mid) || mid <= min || mid >= max) mid = (min + max) / 2;
  if (!Number.isFinite(mid) || mid <= min || mid >= max) return min;
  return mid;
}

export function splitBand(band: Band): { left: Band; right: Band } | null {
  const mid = midpoint(band.min, band.max);
  const splittable = mid > band.min && (band.max === null || mid < band.max);
  if (!splittable) return null;
  return {
    left: { min: band.min, max: mid },
    right: { min: mid, max: band.max },
  };
}

export type BandDecision =
  | { kind: 'empty' }
  | { kind: 'page'; pages: number }
  | { kind: 'split'; left: Band; right: Band }
  | { kind: 'unsplittable' };

/**
 * Decide what to do with a band once its total count is known. Pure, so the
 * sweep's control flow is unit-testable without touching the network.
 */
export function planBand(band: Band, count: number, itemsPerQuery: number): BandDecision {
  if (count <= 0) return { kind: 'empty' };
  if (count > itemsPerQuery) {
    const split = splitBand(band);
    return split ? { kind: 'split', ...split } : { kind: 'unsplittable' };
  }
  // The market's own page ceiling is 120; never ask for more.
  return { kind: 'page', pages: Math.min(Math.ceil(count / 72), 120) };
}

/** Human-readable band label, for logs and sweep records. */
export function bandLabel(band: Band): string {
  const lo = band.min.toFixed(2);
  return band.max === null ? `>=$${lo}` : `$${lo}-$${band.max.toFixed(2)}`;
}

/**
 * One unit of sweep work.
 *
 * `page === null` is the *frontier probe*: fetch page 1 of the band to learn
 * its total count, which is what decides whether the band is paged, split, or
 * already exhausted.
 */
export interface WorkItem {
  band: Band;
  page: number | null;
}

/**
 * Expand a frontier probe into the remaining work for that band.
 *
 * Left (cheaper) is placed ahead of right, so the cheaper half is refined
 * first. That ordering is only a tie-break — it decides the order of work
 * *within* one tier, never which tier runs first. See `prioritiseQueue`, which
 * is what stops a budgeted sweep from grinding the cheapest sliver of the
 * market to dust while the rest is never looked at.
 */
export function expandBand(
  band: Band,
  count: number,
  itemsPerQuery: number
): WorkItem[] | 'unsplittable' {
  const decision = planBand(band, count, itemsPerQuery);

  if (decision.kind === 'empty') return [];
  if (decision.kind === 'unsplittable') return 'unsplittable';

  if (decision.kind === 'split') {
    // Left (cheaper) is placed ahead of right so it is consumed first.
    return [
      { band: decision.left, page: null },
      { band: decision.right, page: null },
    ];
  }

  const pages: WorkItem[] = [];
  for (let page = 2; page <= decision.pages; page++) pages.push({ band, page });
  return pages;
}

/**
 * Serialise a queue compactly.
 *
 * Page tasks for one band are collapsed into a single range entry, because
 * persisting 120 near-identical rows per band would dominate the state row and
 * make every checkpoint expensive.
 */
export function encodeQueue(queue: WorkItem[]): string {
  return JSON.stringify(
    queue.map((item) => (item.page === null ? [item.band.min, item.band.max, null] : [item.band.min, item.band.max, item.page]))
  );
}

export function decodeQueue(raw: string): WorkItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<[number, number | null, number | null]>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row) => Array.isArray(row) && row.length === 3)
      .map((row) => ({
        band: { min: Number(row[0]), max: row[1] === null ? null : Number(row[1]) },
        page: row[2] === null ? null : Number(row[2]),
      }));
  } catch {
    return [];
  }
}

/**
 * All frontier probes ahead of all page fills.
 *
 * THIS IS THE FIX FOR THE WORST BUG THIS COLLECTOR HAD.
 *
 * The queue used to be consumed in insertion order, and expansion inserted the
 * cheaper half first. A budgeted sweep therefore ground the bottom of the price
 * range all the way down before it ever looked higher up — and since the host
 * blocks after roughly 50 requests, it never did. A full live run collected
 * 2,664 items whose inputs topped out at $0.83 and whose neons topped out at
 * $0.11, from which the honest conclusion is "nothing is profitable", while the
 * truth was "the profitable half of the market was never fetched".
 *
 * The cheap end is not the interesting end. A craft needs an input under the
 * capital cap *and* a neon above `4 x input / (1 - fee)`, so the expensive part
 * of the book is at least as relevant as the cheap part — a $100 neon made from
 * a $3 input is the single best trade the scan can find.
 *
 * Probing is one request per band and collects real items as it goes, so a
 * probe-first pass maps the entire price range in a few dozen requests. Page
 * fills are expensive and only make sense once the shape is known.
 *
 * Ordering within the probe tier is preserved (cheapest first), so behaviour
 * that was already relied upon — cheap bands refreshing most often — is
 * unchanged. Only the interleaving is fixed.
 */
export function prioritiseQueue(queue: WorkItem[]): WorkItem[] {
  const probes: WorkItem[] = [];
  const pages: WorkItem[] = [];
  for (const item of queue) {
    if (item.page === null) probes.push(item);
    else pages.push(item);
  }
  return probes.concat(pages);
}

/** How many separate requests the remaining queue will take at minimum. */
export function queueDepth(queue: WorkItem[]): number {
  return queue.length;
}
