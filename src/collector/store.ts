/**
 * Persistence, on Node's built-in `node:sqlite` so there is no native build
 * step and no external database to run.
 *
 * Two tables carry the product:
 *  - `items` is the current snapshot, one row per priced product+age.
 *  - `price_history` is the time series, which is what turns a price scanner
 *    into a drift model: ageing a pet takes hours-to-days, during which the
 *    neon price moves. Volatility comes free from polling.
 */

import { DatabaseSync } from 'node:sqlite';
import { decodeQueue, encodeQueue, type WorkItem } from '../core/bands.ts';
import type { StoreItem } from '../core/types.ts';

export interface SweepState {
  /** Remaining work, cheapest band first. */
  queue: WorkItem[];
  tasksDone: number;
  cycles: number;
  lastCycleAt: number | null;
  lastFullCycleAt: number | null;
  truncated: string[];
}

export interface SweepRecord {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  requests: number;
  itemsSeen: number;
  bands: number;
  status: 'running' | 'ok' | 'error';
  error: string | null;
  durationMs: number | null;
}

export interface PricePoint {
  ts: number;
  price: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  product_id  INTEGER PRIMARY KEY,
  pet_slug    TEXT    NOT NULL,
  pet_name    TEXT    NOT NULL,
  rare        TEXT,
  pumping     TEXT    NOT NULL,
  age         TEXT,
  flyable     INTEGER NOT NULL,
  rideable    INTEGER NOT NULL,
  price       REAL    NOT NULL,
  avg_price   REAL,
  bonuses     INTEGER,
  image_uri   TEXT,
  -- Provenance, recorded rather than inferred.
  --
  -- 'observed'  : a price the collector read from the market.
  -- 'verified'  : a hand-checked reference row (the four gold-standard pets),
  --               transcribed from confirmed prices. Real, but not swept.
  -- 'fabricated': generated data. Nothing should ever write this; it exists as
  --               a named slot so the UI can refuse to present it as real
  --               instead of a plausible fake shipping silently.
  source      TEXT    NOT NULL DEFAULT 'observed',
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_pet    ON items(pet_slug);
CREATE INDEX IF NOT EXISTS idx_items_pump   ON items(pumping);
CREATE INDEX IF NOT EXISTS idx_items_price  ON items(price);

CREATE TABLE IF NOT EXISTS price_history (
  product_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  price      REAL    NOT NULL,
  PRIMARY KEY (product_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_hist_ts ON price_history(ts);

CREATE TABLE IF NOT EXISTS sweeps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  requests   INTEGER NOT NULL DEFAULT 0,
  items_seen INTEGER NOT NULL DEFAULT 0,
  bands      INTEGER NOT NULL DEFAULT 0,
  status     TEXT    NOT NULL DEFAULT 'running',
  error      TEXT
);

-- Resumable progress for a budgeted sweep. One row, keyed to id = 1.
--
-- This table exists because the host blocks after roughly 50 requests, so a
-- complete sweep is impossible in one pass. The queue is checkpointed after
-- every request, so an abort costs at most the request in flight.
CREATE TABLE IF NOT EXISTS sweep_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  queue               TEXT    NOT NULL DEFAULT '[]',
  tasks_done          INTEGER NOT NULL DEFAULT 0,
  cycles              INTEGER NOT NULL DEFAULT 0,
  last_cycle_at       INTEGER,
  last_full_cycle_at  INTEGER,
  truncated           TEXT    NOT NULL DEFAULT '[]'
);

-- Observed demand, one row per product.
--
-- numberOfSalesPerWeek comes from a per-product endpoint, so enriching the
-- whole catalog is its own request budget, separate from the price sweep. It
-- is stored here rather than recomputed so the ranking works offline and the
-- values carry a timestamp: a sale count from three weeks ago is not a
-- demand reading.
CREATE TABLE IF NOT EXISTS liquidity (
  product_id     INTEGER PRIMARY KEY,
  sales_per_week INTEGER NOT NULL,
  observed_at    INTEGER NOT NULL
);

-- Real order-book depth per product, from the batched offers endpoint.
--
-- The sweep's price is the cheapest single listing. That number cannot tell
-- you whether a craft is possible: one listing at $0.10 with no second is a
-- mirage for a four-unit craft. This table records what the book actually
-- holds: how many offers, and what the cheapest few of them cost.
CREATE TABLE IF NOT EXISTS depth (
  product_id     INTEGER PRIMARY KEY,
  available      INTEGER NOT NULL,
  cost_for_units REAL,
  units          INTEGER NOT NULL,
  book_min       REAL,
  cheapest_4x_price REAL,
  listing_count_4x INTEGER,
  observed_at    INTEGER NOT NULL
);

-- The marketplace's own most-traded ranking, from its popularity sort.
-- One row per pet slug with its position; replaced wholesale on refresh.
CREATE TABLE IF NOT EXISTS trend (
  pet_slug     TEXT PRIMARY KEY,
  rank         INTEGER NOT NULL,
  observed_at  INTEGER NOT NULL
);
`;

/**
 * Bring an older database up to the current schema.
 *
 * SQLite cannot add a column conditionally, so the column list is inspected
 * first. Without this an existing snapshot would keep working while silently
 * reporting every row's provenance as the default.
 */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => String(c.name)));
  if (!names.has('source')) {
    db.exec("ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT 'observed'");
  }

  const depthColumns = db.prepare('PRAGMA table_info(depth)').all() as Array<{ name: string }>;
  const depthNames = new Set(depthColumns.map((c) => String(c.name)));
  if (!depthNames.has('cheapest_4x_price')) {
    db.exec('ALTER TABLE depth ADD COLUMN cheapest_4x_price REAL;');
  }
  if (!depthNames.has('listing_count_4x')) {
    db.exec('ALTER TABLE depth ADD COLUMN listing_count_4x INTEGER;');
  }
}

const toNum = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Upsert the current snapshot and append the same rows to history. */
  writeItems(items: StoreItem[], ts: number): void {
    const upsert = this.db.prepare(`
      INSERT INTO items (
        product_id, pet_slug, pet_name, rare, pumping, age, flyable, rideable,
        price, avg_price, bonuses, image_uri, source, first_seen, last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        price      = excluded.price,
        avg_price  = excluded.avg_price,
        age        = excluded.age,
        pumping    = excluded.pumping,
        flyable    = excluded.flyable,
        rideable   = excluded.rideable,
        rare       = excluded.rare,
        bonuses    = excluded.bonuses,
        image_uri  = excluded.image_uri,
        -- A real observation always outranks a transcribed reference row.
        source     = CASE WHEN excluded.source = 'observed' THEN 'observed' ELSE items.source END,
        last_seen  = excluded.last_seen
    `);
    const history = this.db.prepare(`
      INSERT INTO price_history (product_id, ts, price) VALUES (?, ?, ?)
      ON CONFLICT(product_id, ts) DO UPDATE SET price = excluded.price
    `);

    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        upsert.run(
          item.id,
          item.realName || item.name,
          item.name,
          item.rare ?? null,
          item.pumping,
          item.age ?? null,
          item.flyable ? 1 : 0,
          item.rideable ? 1 : 0,
          item.price,
          toNum(item.avgPrice),
          toNum(item.bonuses) ?? 0,
          item.imageUri ?? null,
          item.source ?? 'observed',
          ts,
          ts
        );
        history.run(item.id, ts, item.price);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Everything currently known, in the shape the opportunity builder wants. */
  currentItems(): StoreItem[] {
    const rows = this.db
      .prepare(
        `SELECT product_id, pet_slug, pet_name, rare, pumping, age, flyable, rideable,
                price, avg_price, bonuses, image_uri, source
         FROM items`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: Number(row.product_id),
      goodId: '',
      name: String(row.pet_name),
      type: 'pet',
      realName: String(row.pet_slug),
      imageId: null,
      imageUri: row.image_uri === null || row.image_uri === undefined ? null : String(row.image_uri),
      subtype: null,
      age: row.age === null || row.age === undefined ? null : String(row.age),
      rare: row.rare === null || row.rare === undefined ? null : String(row.rare),
      pumping: String(row.pumping),
      flyable: Number(row.flyable) === 1,
      rideable: Number(row.rideable) === 1,
      price: Number(row.price),
      avgPrice: row.avg_price === null || row.avg_price === undefined ? null : Number(row.avg_price),
      bonuses: Number(row.bonuses ?? 0),
      source: row.source === null || row.source === undefined ? 'observed' : String(row.source),
    }));
  }

  itemsForPet(petSlug: string): StoreItem[] {
    return this.currentItems().filter((i) => i.realName === petSlug);
  }

  /** Distinct pets in the snapshot: the catalog, for fuzzy name resolution. */
  petIndex(): Array<{ slug: string; name: string; rare: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT pet_slug AS slug, MAX(pet_name) AS name, MAX(rare) AS rare
         FROM items GROUP BY pet_slug ORDER BY pet_slug`
      )
      .all() as Array<{ slug: string; name: string; rare: string | null }>;
    return rows.map((r) => ({ slug: String(r.slug), name: String(r.name), rare: r.rare ?? null }));
  }

  /**
   * Rows whose provenance is `source`, straight from the recorded column.
   *
   * This used to infer fabrication from a reserved id range, which misfired the
   * moment the hand-verified reference rows landed in that same range: real,
   * confirmed prices were labelled "must not be traded on". Provenance is now
   * written down, not guessed.
   */
  countBySource(source: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM items WHERE source = ?').get(source) as {
      n: number;
    };
    return Number(row.n);
  }

  /** Record observed demand for products, replacing any previous reading. */
  writeLiquidity(rows: Array<{ productId: number; salesPerWeek: number; observedAt: number }>): void {
    const upsert = this.db.prepare(`
      INSERT INTO liquidity (product_id, sales_per_week, observed_at) VALUES (?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        sales_per_week = excluded.sales_per_week,
        observed_at    = excluded.observed_at
    `);
    this.db.exec('BEGIN');
    try {
      for (const row of rows) upsert.run(row.productId, row.salesPerWeek, row.observedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Demand map for product ids. Missing ids are simply absent — callers must
   * distinguish "not enriched yet" from "zero sales".
   */
  liquidityFor(productIds: Array<number>): Map<number, { salesPerWeek: number; observedAt: number }> {
    const out = new Map<number, { salesPerWeek: number; observedAt: number }>();
    for (let i = 0; i < productIds.length; i += 500) {
      const chunk = productIds.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT product_id, sales_per_week, observed_at FROM liquidity WHERE product_id IN (${placeholders})`)
        .all(...chunk) as Array<{ product_id: number; sales_per_week: number; observed_at: number }>;
      for (const row of rows) {
        out.set(Number(row.product_id), {
          salesPerWeek: Number(row.sales_per_week),
          observedAt: Number(row.observed_at),
        });
      }
    }
    return out;
  }

  /** Product ids that have never been enriched, cheapest-side first. */
  liquidityMissing(productIds: Array<number>): number[] {
    const have = this.liquidityFor(productIds);
    return productIds.filter((id) => !have.has(id));
  }

  /** Persist a read order book for one product. */
  writeDepth(row: {
    productId: number;
    available: number;
    costForUnits: number | null;
    units: number;
    bookMin: number | null;
    cheapest4xPrice?: number | null;
    listingCount4x?: number | null;
    observedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO depth (product_id, available, cost_for_units, units, book_min, cheapest_4x_price, listing_count_4x, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           available         = excluded.available,
           cost_for_units    = excluded.cost_for_units,
           units             = excluded.units,
           book_min          = excluded.book_min,
           cheapest_4x_price = excluded.cheapest_4x_price,
           listing_count_4x  = excluded.listing_count_4x,
           observed_at       = excluded.observed_at`
      )
      .run(
        row.productId,
        row.available,
        row.costForUnits,
        row.units,
        row.bookMin,
        row.cheapest4xPrice ?? null,
        row.listingCount4x ?? null,
        row.observedAt
      );
  }

  /** Depth map for product ids; absent means never read. */
  depthFor(productIds: Array<number>): Map<
    number,
    {
      available: number;
      costForUnits: number | null;
      units: number;
      bookMin: number | null;
      cheapest4xPrice: number | null;
      listingCount4x: number | null;
    }
  > {
    const out = new Map<
      number,
      {
        available: number;
        costForUnits: number | null;
        units: number;
        bookMin: number | null;
        cheapest4xPrice: number | null;
        listingCount4x: number | null;
      }
    >();
    for (let i = 0; i < productIds.length; i += 500) {
      const chunk = productIds.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT product_id, available, cost_for_units, units, book_min, cheapest_4x_price, listing_count_4x
           FROM depth WHERE product_id IN (${placeholders})`
        )
        .all(...chunk) as Array<Record<string, unknown>>;
      for (const row of rows) {
        out.set(Number(row.product_id), {
          available: Number(row.available),
          costForUnits: row.cost_for_units === null || row.cost_for_units === undefined ? null : Number(row.cost_for_units),
          units: Number(row.units),
          bookMin: row.book_min === null || row.book_min === undefined ? null : Number(row.book_min),
          cheapest4xPrice: row.cheapest_4x_price === null || row.cheapest_4x_price === undefined ? null : Number(row.cheapest_4x_price),
          listingCount4x: row.listing_count_4x === null || row.listing_count_4x === undefined ? null : Number(row.listing_count_4x),
        });
      }
    }
    return out;
  }

  /** Replace the whole trending table with a fresh ranking. */
  writeTrend(rows: Array<{ petSlug: string; rank: number; observedAt: number }>): void {
    this.db.exec('DELETE FROM trend');
    const insert = this.db.prepare(
      'INSERT INTO trend (pet_slug, rank, observed_at) VALUES (?, ?, ?)'
    );
    this.db.exec('BEGIN');
    try {
      for (const row of rows) insert.run(row.petSlug, row.rank, row.observedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Trend rank per pet slug. Absent means the pet is not on the board. */
  trendRanks(): Map<string, { rank: number; observedAt: number }> {
    const rows = this.db
      .prepare('SELECT pet_slug, rank, observed_at FROM trend')
      .all() as Array<{ pet_slug: string; rank: number; observed_at: number }>;
    const out = new Map<string, { rank: number; observedAt: number }>();
    for (const row of rows) {
      out.set(String(row.pet_slug), { rank: Number(row.rank), observedAt: Number(row.observed_at) });
    }
    return out;
  }

  petCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT pet_slug) AS n FROM items')
      .get() as { n: number };
    return Number(row.n);
  }

  itemCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
    return Number(row.n);
  }

  /** Price series for one product, oldest first. */
  history(productId: number, sinceTs = 0, limit = 2_000): PricePoint[] {
    const rows = this.db
      .prepare(
        `SELECT ts, price FROM price_history
         WHERE product_id = ? AND ts >= ?
         ORDER BY ts ASC
         LIMIT ?`
      )
      .all(productId, sinceTs, limit) as Array<{ ts: number; price: number }>;
    return rows.map((r) => ({ ts: Number(r.ts), price: Number(r.price) }));
  }

  startSweep(startedAt: number): number {
    const result = this.db
      .prepare(`INSERT INTO sweeps (started_at, status) VALUES (?, 'running')`)
      .run(startedAt);
    return Number(result.lastInsertRowid);
  }

  finishSweep(
    id: number,
    patch: {
      finishedAt: number;
      requests: number;
      itemsSeen: number;
      bands: number;
      status: 'ok' | 'error';
      error?: string | null;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE sweeps
         SET finished_at = ?, requests = ?, items_seen = ?, bands = ?, status = ?, error = ?
         WHERE id = ?`
      )
      .run(
        patch.finishedAt,
        patch.requests,
        patch.itemsSeen,
        patch.bands,
        patch.status,
        patch.error ?? null,
        id
      );
  }

  latestSweep(): SweepRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sweeps ORDER BY id DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const startedAt = Number(row.started_at);
    const finishedAt = row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at);
    return {
      id: Number(row.id),
      startedAt,
      finishedAt,
      requests: Number(row.requests),
      itemsSeen: Number(row.items_seen),
      bands: Number(row.bands),
      status: String(row.status) as SweepRecord['status'],
      error: row.error === null || row.error === undefined ? null : String(row.error),
      durationMs: finishedAt === null ? null : finishedAt - startedAt,
    };
  }

  recentSweeps(limit = 20): SweepRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sweeps ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const startedAt = Number(row.started_at);
      const finishedAt = row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at);
      return {
        id: Number(row.id),
        startedAt,
        finishedAt,
        requests: Number(row.requests),
        itemsSeen: Number(row.items_seen),
        bands: Number(row.bands),
        status: String(row.status) as SweepRecord['status'],
        error: row.error === null || row.error === undefined ? null : String(row.error),
        durationMs: finishedAt === null ? null : finishedAt - startedAt,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Resumable budgeted-sweep state
  // ---------------------------------------------------------------------

  loadSweepState(): SweepState {
    this.db
      .prepare('INSERT OR IGNORE INTO sweep_state (id) VALUES (1)')
      .run();
    const row = this.db.prepare('SELECT * FROM sweep_state WHERE id = 1').get() as Record<
      string,
      unknown
    >;
    return {
      queue: decodeQueue(String(row.queue ?? '[]')),
      tasksDone: Number(row.tasks_done ?? 0),
      cycles: Number(row.cycles ?? 0),
      lastCycleAt: row.last_cycle_at == null ? null : Number(row.last_cycle_at),
      lastFullCycleAt: row.last_full_cycle_at == null ? null : Number(row.last_full_cycle_at),
      truncated: JSON.parse(String(row.truncated ?? '[]')) as string[],
    };
  }

  saveSweepQueue(queue: WorkItem[], truncated: string[] = []): void {
    this.db
      .prepare(
        `INSERT INTO sweep_state (id, queue, truncated) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET queue = excluded.queue, truncated = excluded.truncated`
      )
      .run(encodeQueue(queue), JSON.stringify(truncated));
  }

  /** Record the end of one budgeted cycle (which may be a full pass or not). */
  finishSweepCycle(at: number, tasksDone: number, complete: boolean): void {
    this.db
      .prepare(
        `UPDATE sweep_state
         SET cycles = cycles + 1,
             tasks_done = tasks_done + ?,
             last_cycle_at = ?,
             last_full_cycle_at = CASE WHEN ? THEN ? ELSE last_full_cycle_at END
         WHERE id = 1`
      )
      .run(tasksDone, at, complete ? 1 : 0, at);
  }

  /**
   * Drop history older than the retention window. Unbounded per-sweep history
   * grows at ~40k rows every few minutes, which is not sustainable.
   */
  pruneHistory(olderThanTs: number): number {
    const result = this.db.prepare('DELETE FROM price_history WHERE ts < ?').run(olderThanTs);
    return Number(result.changes);
  }

  /** Remove rows not seen in the last `staleAfterMs`, so delisted items vanish. */
  pruneStaleItems(now: number, staleAfterMs: number): number {
    const result = this.db
      .prepare('DELETE FROM items WHERE last_seen < ?')
      .run(now - staleAfterMs);
    return Number(result.changes);
  }
}
