/**
 * Persistence, with dual-mode support:
 * - Built-in `node:sqlite` when available (local Node 22+ runs).
 * - High-speed in-memory store with seed data for serverless (Vercel, AWS Lambda, Node 20).
 *
 * Two tables carry the product:
 *  - `items` is the current snapshot, one row per priced product+age.
 *  - `price_history` is the time series, which is what turns a price scanner
 *    into a drift model: ageing a pet takes hours-to-days, during which the
 *    neon price moves. Volatility comes free from polling.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeQueue, encodeQueue, type WorkItem } from '../core/bands.ts';
import type { StoreItem } from '../core/types.ts';

const require = createRequire(import.meta.url);
let DatabaseSyncClass: any = null;
try {
  DatabaseSyncClass = require('node:sqlite')?.DatabaseSync;
} catch {
  DatabaseSyncClass = null;
}

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

CREATE TABLE IF NOT EXISTS sweep_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  queue               TEXT    NOT NULL DEFAULT '[]',
  tasks_done          INTEGER NOT NULL DEFAULT 0,
  cycles              INTEGER NOT NULL DEFAULT 0,
  last_cycle_at       INTEGER,
  last_full_cycle_at  INTEGER,
  truncated           TEXT    NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS liquidity (
  product_id     INTEGER PRIMARY KEY,
  sales_per_week INTEGER NOT NULL,
  observed_at    INTEGER NOT NULL
);

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

CREATE TABLE IF NOT EXISTS trend (
  pet_slug     TEXT PRIMARY KEY,
  rank         INTEGER NOT NULL,
  observed_at  INTEGER NOT NULL
);
`;

function migrate(db: any): void {
  try {
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
  } catch {}
}

const toNum = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export class Store {
  private readonly db: any = null;

  // In-memory fallback structures
  private itemsMap = new Map<number, StoreItem>();
  private historyMap = new Map<number, PricePoint[]>();
  private sweepsList: SweepRecord[] = [];
  private liquidityMap = new Map<number, { salesPerWeek: number; observedAt: number }>();
  private depthMap = new Map<
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
  private trendMap = new Map<string, { rank: number; observedAt: number }>();
  private sweepState: SweepState = {
    queue: [],
    tasksDone: 0,
    cycles: 0,
    lastCycleAt: null,
    lastFullCycleAt: null,
    truncated: [],
  };

  constructor(path = ':memory:') {
    if (DatabaseSyncClass) {
      try {
        this.db = new DatabaseSyncClass(path);
        try {
          this.db.exec('PRAGMA journal_mode = WAL;');
          this.db.exec('PRAGMA synchronous = NORMAL;');
        } catch {}
        this.db.exec(SCHEMA);
        migrate(this.db);
        return;
      } catch {
        this.db = null;
      }
    }
    this.loadSeed();
  }

  private loadSeed(): void {
    const candidates = [
      join(process.cwd(), 'data', 'seed.json'),
      join(process.cwd(), 'seed.json'),
      join(process.cwd(), 'public', 'seed.json'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          const raw = JSON.parse(readFileSync(p, 'utf8'));
          if (Array.isArray(raw.items)) {
            for (const r of raw.items) {
              this.itemsMap.set(Number(r.product_id), {
                id: Number(r.product_id),
                goodId: '',
                name: String(r.pet_name),
                type: 'pet',
                realName: String(r.pet_slug),
                imageId: null,
                imageUri: r.image_uri ? String(r.image_uri) : null,
                subtype: null,
                age: r.age ? String(r.age) : null,
                rare: r.rare ? String(r.rare) : null,
                pumping: String(r.pumping),
                flyable: Number(r.flyable) === 1,
                rideable: Number(r.rideable) === 1,
                price: Number(r.price),
                avgPrice: r.avg_price ? Number(r.avg_price) : null,
                bonuses: Number(r.bonuses ?? 0),
                source: r.source ? String(r.source) : 'observed',
              });
            }
          }
          if (Array.isArray(raw.liquidity)) {
            for (const l of raw.liquidity) {
              this.liquidityMap.set(Number(l.product_id), {
                salesPerWeek: Number(l.sales_per_week),
                observedAt: Number(l.observed_at),
              });
            }
          }
          if (Array.isArray(raw.depth)) {
            for (const d of raw.depth) {
              this.depthMap.set(Number(d.product_id), {
                available: Number(d.available),
                costForUnits: d.cost_for_units ? Number(d.cost_for_units) : null,
                units: Number(d.units),
                bookMin: d.book_min ? Number(d.book_min) : null,
                cheapest4xPrice: d.cheapest_4x_price ? Number(d.cheapest_4x_price) : null,
                listingCount4x: d.listing_count_4x ? Number(d.listing_count_4x) : null,
              });
            }
          }
          if (Array.isArray(raw.trend)) {
            for (const t of raw.trend) {
              this.trendMap.set(String(t.pet_slug), {
                rank: Number(t.rank),
                observedAt: Number(t.observed_at),
              });
            }
          }
          if (Array.isArray(raw.sweeps)) {
            this.sweepsList = raw.sweeps.map((s: any) => ({
              id: Number(s.id),
              startedAt: Number(s.started_at),
              finishedAt: s.finished_at ? Number(s.finished_at) : null,
              requests: Number(s.requests),
              itemsSeen: Number(s.items_seen),
              bands: Number(s.bands),
              status: s.status,
              error: s.error ?? null,
              durationMs: s.finished_at ? Number(s.finished_at) - Number(s.started_at) : null,
            }));
          }
          break;
        } catch {}
      }
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
    }
  }

  /** Upsert the current snapshot and append the same rows to history. */
  writeItems(items: StoreItem[], ts: number): void {
    if (this.db) {
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
        return;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    for (const item of items) {
      this.itemsMap.set(item.id, { ...item });
      const pts = this.historyMap.get(item.id) ?? [];
      pts.push({ ts, price: item.price });
      this.historyMap.set(item.id, pts);
    }
  }

  /** Everything currently known, in the shape the opportunity builder wants. */
  currentItems(): StoreItem[] {
    if (this.db) {
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

    return Array.from(this.itemsMap.values());
  }

  itemsForPet(petSlug: string): StoreItem[] {
    return this.currentItems().filter((i) => i.realName === petSlug);
  }

  /** Distinct pets in the snapshot: the catalog, for fuzzy name resolution. */
  petIndex(): Array<{ slug: string; name: string; rare: string | null }> {
    if (this.db) {
      const rows = this.db
        .prepare(
          `SELECT pet_slug AS slug, MAX(pet_name) AS name, MAX(rare) AS rare
           FROM items GROUP BY pet_slug ORDER BY pet_slug`
        )
        .all() as Array<{ slug: string; name: string; rare: string | null }>;
      return rows.map((r) => ({ slug: String(r.slug), name: String(r.name), rare: r.rare ?? null }));
    }

    const unique = new Map<string, { slug: string; name: string; rare: string | null }>();
    for (const item of this.itemsMap.values()) {
      const slug = item.realName || item.name;
      if (!unique.has(slug)) {
        unique.set(slug, { slug, name: item.name, rare: item.rare ?? null });
      }
    }
    return Array.from(unique.values()).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  countBySource(source: string): number {
    if (this.db) {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM items WHERE source = ?').get(source) as {
        n: number;
      };
      return Number(row.n);
    }

    let count = 0;
    for (const item of this.itemsMap.values()) {
      if ((item.source ?? 'observed') === source) count++;
    }
    return count;
  }

  /** Record observed demand for products, replacing any previous reading. */
  writeLiquidity(rows: Array<{ productId: number; salesPerWeek: number; observedAt: number }>): void {
    if (this.db) {
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
        return;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    for (const row of rows) {
      this.liquidityMap.set(row.productId, { salesPerWeek: row.salesPerWeek, observedAt: row.observedAt });
    }
  }

  liquidityFor(productIds: Array<number>): Map<number, { salesPerWeek: number; observedAt: number }> {
    if (this.db) {
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

    const out = new Map<number, { salesPerWeek: number; observedAt: number }>();
    for (const id of productIds) {
      const val = this.liquidityMap.get(id);
      if (val) out.set(id, val);
    }
    return out;
  }

  liquidityMissing(productIds: Array<number>): number[] {
    const have = this.liquidityFor(productIds);
    return productIds.filter((id) => !have.has(id));
  }

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
    if (this.db) {
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
      return;
    }

    this.depthMap.set(row.productId, {
      available: row.available,
      costForUnits: row.costForUnits,
      units: row.units,
      bookMin: row.bookMin,
      cheapest4xPrice: row.cheapest4xPrice ?? null,
      listingCount4x: row.listingCount4x ?? null,
    });
  }

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
    if (this.db) {
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
    for (const id of productIds) {
      const val = this.depthMap.get(id);
      if (val) out.set(id, val);
    }
    return out;
  }

  writeTrend(rows: Array<{ petSlug: string; rank: number; observedAt: number }>): void {
    if (this.db) {
      this.db.exec('DELETE FROM trend');
      const insert = this.db.prepare(
        'INSERT INTO trend (pet_slug, rank, observed_at) VALUES (?, ?, ?)'
      );
      this.db.exec('BEGIN');
      try {
        for (const row of rows) insert.run(row.petSlug, row.rank, row.observedAt);
        this.db.exec('COMMIT');
        return;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    this.trendMap.clear();
    for (const row of rows) {
      this.trendMap.set(row.petSlug, { rank: row.rank, observedAt: row.observedAt });
    }
  }

  trendRanks(): Map<string, { rank: number; observedAt: number }> {
    if (this.db) {
      const rows = this.db
        .prepare('SELECT pet_slug, rank, observed_at FROM trend')
        .all() as Array<{ pet_slug: string; rank: number; observed_at: number }>;
      const out = new Map<string, { rank: number; observedAt: number }>();
      for (const row of rows) {
        out.set(String(row.pet_slug), { rank: Number(row.rank), observedAt: Number(row.observed_at) });
      }
      return out;
    }

    return new Map(this.trendMap);
  }

  petCount(): number {
    if (this.db) {
      const row = this.db
        .prepare('SELECT COUNT(DISTINCT pet_slug) AS n FROM items')
        .get() as { n: number };
      return Number(row.n);
    }

    const slugs = new Set<string>();
    for (const item of this.itemsMap.values()) {
      slugs.add(item.realName || item.name);
    }
    return slugs.size;
  }

  itemCount(): number {
    if (this.db) {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
      return Number(row.n);
    }

    return this.itemsMap.size;
  }

  history(productId: number, sinceTs = 0, limit = 2_000): PricePoint[] {
    if (this.db) {
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

    const pts = this.historyMap.get(productId) ?? [];
    return pts.filter((p) => p.ts >= sinceTs).slice(0, limit);
  }

  startSweep(startedAt: number): number {
    if (this.db) {
      const result = this.db
        .prepare(`INSERT INTO sweeps (started_at, status) VALUES (?, 'running')`)
        .run(startedAt);
      return Number(result.lastInsertRowid);
    }

    const id = this.sweepsList.length + 1;
    this.sweepsList.push({
      id,
      startedAt,
      finishedAt: null,
      requests: 0,
      itemsSeen: 0,
      bands: 0,
      status: 'running',
      error: null,
      durationMs: null,
    });
    return id;
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
    if (this.db) {
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
      return;
    }

    const s = this.sweepsList.find((x) => x.id === id);
    if (s) {
      s.finishedAt = patch.finishedAt;
      s.requests = patch.requests;
      s.itemsSeen = patch.itemsSeen;
      s.bands = patch.bands;
      s.status = patch.status;
      s.error = patch.error ?? null;
      s.durationMs = patch.finishedAt - s.startedAt;
    }
  }

  latestSweep(): SweepRecord | null {
    if (this.db) {
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

    return this.sweepsList.length > 0 ? this.sweepsList[this.sweepsList.length - 1] ?? null : null;
  }

  recentSweeps(limit = 20): SweepRecord[] {
    if (this.db) {
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

    return [...this.sweepsList].reverse().slice(0, limit);
  }

  loadSweepState(): SweepState {
    if (this.db) {
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

    return { ...this.sweepState };
  }

  saveSweepQueue(queue: WorkItem[], truncated: string[] = []): void {
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO sweep_state (id, queue, truncated) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET queue = excluded.queue, truncated = excluded.truncated`
        )
        .run(encodeQueue(queue), JSON.stringify(truncated));
      return;
    }

    this.sweepState.queue = [...queue];
    this.sweepState.truncated = [...truncated];
  }

  finishSweepCycle(at: number, tasksDone: number, complete: boolean): void {
    if (this.db) {
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
      return;
    }

    this.sweepState.cycles++;
    this.sweepState.tasksDone += tasksDone;
    this.sweepState.lastCycleAt = at;
    if (complete) this.sweepState.lastFullCycleAt = at;
  }

  pruneHistory(olderThanTs: number): number {
    if (this.db) {
      const result = this.db.prepare('DELETE FROM price_history WHERE ts < ?').run(olderThanTs);
      return Number(result.changes);
    }
    return 0;
  }

  pruneStaleItems(now: number, staleAfterMs: number): number {
    if (this.db) {
      const result = this.db
        .prepare('DELETE FROM items WHERE last_seen < ?')
        .run(now - staleAfterMs);
      return Number(result.changes);
    }
    return 0;
  }
}
