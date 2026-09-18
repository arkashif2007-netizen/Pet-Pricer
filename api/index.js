// src/server/service-singleton.ts
import { existsSync as existsSync2, copyFileSync } from "node:fs";
import { join as join2 } from "node:path";

// src/collector/store.ts
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// src/core/bands.ts
var MIN_SWEEP_PRICE = 0.01;
function fullRange(minPrice = MIN_SWEEP_PRICE) {
  return { min: minPrice, max: null };
}
function midpoint(min, max) {
  if (max === null) return min === 0 ? 1 : Math.max(min * 4, min + 0.01);
  if (!(max > min)) return min;
  let mid = min <= 0 ? max / 2 : Math.sqrt(min * max);
  if (!Number.isFinite(mid) || mid <= min || mid >= max) mid = (min + max) / 2;
  if (!Number.isFinite(mid) || mid <= min || mid >= max) return min;
  return mid;
}
function splitBand(band) {
  const mid = midpoint(band.min, band.max);
  const splittable = mid > band.min && (band.max === null || mid < band.max);
  if (!splittable) return null;
  return {
    left: { min: band.min, max: mid },
    right: { min: mid, max: band.max }
  };
}
function planBand(band, count, itemsPerQuery) {
  if (count <= 0) return { kind: "empty" };
  if (count > itemsPerQuery) {
    const split = splitBand(band);
    return split ? { kind: "split", ...split } : { kind: "unsplittable" };
  }
  return { kind: "page", pages: Math.min(Math.ceil(count / 72), 120) };
}
function bandLabel(band) {
  const lo = band.min.toFixed(2);
  return band.max === null ? `>=$${lo}` : `$${lo}-$${band.max.toFixed(2)}`;
}
function encodeQueue(queue) {
  return JSON.stringify(
    queue.map((item) => item.page === null ? [item.band.min, item.band.max, null] : [item.band.min, item.band.max, item.page])
  );
}
function decodeQueue(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => Array.isArray(row) && row.length === 3).map((row) => ({
      band: { min: Number(row[0]), max: row[1] === null ? null : Number(row[1]) },
      page: row[2] === null ? null : Number(row[2])
    }));
  } catch {
    return [];
  }
}

// src/collector/store.ts
var require2 = createRequire(import.meta.url);
var DatabaseSyncClass = null;
try {
  DatabaseSyncClass = require2("node:sqlite")?.DatabaseSync;
} catch {
  DatabaseSyncClass = null;
}
var SCHEMA = `
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
function migrate(db) {
  try {
    const columns = db.prepare("PRAGMA table_info(items)").all();
    const names = new Set(columns.map((c) => String(c.name)));
    if (!names.has("source")) {
      db.exec("ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT 'observed'");
    }
    const depthColumns = db.prepare("PRAGMA table_info(depth)").all();
    const depthNames = new Set(depthColumns.map((c) => String(c.name)));
    if (!depthNames.has("cheapest_4x_price")) {
      db.exec("ALTER TABLE depth ADD COLUMN cheapest_4x_price REAL;");
    }
    if (!depthNames.has("listing_count_4x")) {
      db.exec("ALTER TABLE depth ADD COLUMN listing_count_4x INTEGER;");
    }
  } catch {
  }
}
var toNum = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
var Store = class {
  db = null;
  // In-memory fallback structures
  itemsMap = /* @__PURE__ */ new Map();
  historyMap = /* @__PURE__ */ new Map();
  sweepsList = [];
  liquidityMap = /* @__PURE__ */ new Map();
  depthMap = /* @__PURE__ */ new Map();
  trendMap = /* @__PURE__ */ new Map();
  sweepState = {
    queue: [],
    tasksDone: 0,
    cycles: 0,
    lastCycleAt: null,
    lastFullCycleAt: null,
    truncated: []
  };
  constructor(path = ":memory:") {
    const isServerless = !!(process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
    if (!isServerless && DatabaseSyncClass && path !== ":memory-force:") {
      try {
        this.db = new DatabaseSyncClass(path);
        try {
          this.db.exec("PRAGMA journal_mode = WAL;");
          this.db.exec("PRAGMA synchronous = NORMAL;");
        } catch {
        }
        this.db.exec(SCHEMA);
        migrate(this.db);
        return;
      } catch {
        this.db = null;
      }
    }
    this.loadSeed();
  }
  loadSeed() {
    let raw = null;
    try {
      raw = require2("../../data/seed.json");
    } catch {
      const candidates = [
        join(process.cwd(), "data", "seed.json"),
        join(process.cwd(), "public", "seed.json"),
        join(process.cwd(), "seed.json")
      ];
      for (const p of candidates) {
        if (existsSync(p)) {
          try {
            raw = JSON.parse(readFileSync(p, "utf8"));
            if (raw) break;
          } catch {
          }
        }
      }
    }
    if (!raw) return;
    if (Array.isArray(raw.items)) {
      for (const r of raw.items) {
        this.itemsMap.set(Number(r.product_id), {
          id: Number(r.product_id),
          goodId: "",
          name: String(r.pet_name),
          type: "pet",
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
          source: r.source ? String(r.source) : "observed"
        });
      }
    }
    if (Array.isArray(raw.liquidity)) {
      for (const l of raw.liquidity) {
        this.liquidityMap.set(Number(l.product_id), {
          salesPerWeek: Number(l.sales_per_week),
          observedAt: Number(l.observed_at)
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
          listingCount4x: d.listing_count_4x ? Number(d.listing_count_4x) : null
        });
      }
    }
    if (Array.isArray(raw.trend)) {
      for (const t of raw.trend) {
        this.trendMap.set(String(t.pet_slug), {
          rank: Number(t.rank),
          observedAt: Number(t.observed_at)
        });
      }
    }
    if (Array.isArray(raw.sweeps)) {
      this.sweepsList = raw.sweeps.map((s) => ({
        id: Number(s.id),
        startedAt: Number(s.started_at),
        finishedAt: s.finished_at ? Number(s.finished_at) : null,
        requests: Number(s.requests),
        itemsSeen: Number(s.items_seen),
        bands: Number(s.bands),
        status: s.status,
        error: s.error ?? null,
        durationMs: s.finished_at ? Number(s.finished_at) - Number(s.started_at) : null
      }));
    }
  }
  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
      }
    }
  }
  /** Upsert the current snapshot and append the same rows to history. */
  writeItems(items, ts) {
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
      this.db.exec("BEGIN");
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
            item.source ?? "observed",
            ts,
            ts
          );
          history.run(item.id, ts, item.price);
        }
        this.db.exec("COMMIT");
        return;
      } catch (error) {
        this.db.exec("ROLLBACK");
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
  currentItems() {
    if (this.db) {
      const rows = this.db.prepare(
        `SELECT product_id, pet_slug, pet_name, rare, pumping, age, flyable, rideable,
                  price, avg_price, bonuses, image_uri, source
           FROM items`
      ).all();
      return rows.map((row) => ({
        id: Number(row.product_id),
        goodId: "",
        name: String(row.pet_name),
        type: "pet",
        realName: String(row.pet_slug),
        imageId: null,
        imageUri: row.image_uri === null || row.image_uri === void 0 ? null : String(row.image_uri),
        subtype: null,
        age: row.age === null || row.age === void 0 ? null : String(row.age),
        rare: row.rare === null || row.rare === void 0 ? null : String(row.rare),
        pumping: String(row.pumping),
        flyable: Number(row.flyable) === 1,
        rideable: Number(row.rideable) === 1,
        price: Number(row.price),
        avgPrice: row.avg_price === null || row.avg_price === void 0 ? null : Number(row.avg_price),
        bonuses: Number(row.bonuses ?? 0),
        source: row.source === null || row.source === void 0 ? "observed" : String(row.source)
      }));
    }
    return Array.from(this.itemsMap.values());
  }
  itemsForPet(petSlug) {
    return this.currentItems().filter((i) => i.realName === petSlug);
  }
  /** Distinct pets in the snapshot: the catalog, for fuzzy name resolution. */
  petIndex() {
    if (this.db) {
      const rows = this.db.prepare(
        `SELECT pet_slug AS slug, MAX(pet_name) AS name, MAX(rare) AS rare
           FROM items GROUP BY pet_slug ORDER BY pet_slug`
      ).all();
      return rows.map((r) => ({ slug: String(r.slug), name: String(r.name), rare: r.rare ?? null }));
    }
    const unique = /* @__PURE__ */ new Map();
    for (const item of this.itemsMap.values()) {
      const slug = item.realName || item.name;
      if (!unique.has(slug)) {
        unique.set(slug, { slug, name: item.name, rare: item.rare ?? null });
      }
    }
    return Array.from(unique.values()).sort((a, b) => a.slug.localeCompare(b.slug));
  }
  countBySource(source) {
    if (this.db) {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE source = ?").get(source);
      return Number(row.n);
    }
    let count = 0;
    for (const item of this.itemsMap.values()) {
      if ((item.source ?? "observed") === source) count++;
    }
    return count;
  }
  /** Record observed demand for products, replacing any previous reading. */
  writeLiquidity(rows) {
    if (this.db) {
      const upsert = this.db.prepare(`
        INSERT INTO liquidity (product_id, sales_per_week, observed_at) VALUES (?, ?, ?)
        ON CONFLICT(product_id) DO UPDATE SET
          sales_per_week = excluded.sales_per_week,
          observed_at    = excluded.observed_at
      `);
      this.db.exec("BEGIN");
      try {
        for (const row of rows) upsert.run(row.productId, row.salesPerWeek, row.observedAt);
        this.db.exec("COMMIT");
        return;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    for (const row of rows) {
      this.liquidityMap.set(row.productId, { salesPerWeek: row.salesPerWeek, observedAt: row.observedAt });
    }
  }
  liquidityFor(productIds) {
    if (this.db) {
      const out2 = /* @__PURE__ */ new Map();
      for (let i = 0; i < productIds.length; i += 500) {
        const chunk = productIds.slice(i, i + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = this.db.prepare(`SELECT product_id, sales_per_week, observed_at FROM liquidity WHERE product_id IN (${placeholders})`).all(...chunk);
        for (const row of rows) {
          out2.set(Number(row.product_id), {
            salesPerWeek: Number(row.sales_per_week),
            observedAt: Number(row.observed_at)
          });
        }
      }
      return out2;
    }
    const out = /* @__PURE__ */ new Map();
    for (const id of productIds) {
      const val = this.liquidityMap.get(id);
      if (val) out.set(id, val);
    }
    return out;
  }
  liquidityMissing(productIds) {
    const have = this.liquidityFor(productIds);
    return productIds.filter((id) => !have.has(id));
  }
  writeDepth(row) {
    if (this.db) {
      this.db.prepare(
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
      ).run(
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
      listingCount4x: row.listingCount4x ?? null
    });
  }
  depthFor(productIds) {
    if (this.db) {
      const out2 = /* @__PURE__ */ new Map();
      for (let i = 0; i < productIds.length; i += 500) {
        const chunk = productIds.slice(i, i + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = this.db.prepare(
          `SELECT product_id, available, cost_for_units, units, book_min, cheapest_4x_price, listing_count_4x
             FROM depth WHERE product_id IN (${placeholders})`
        ).all(...chunk);
        for (const row of rows) {
          out2.set(Number(row.product_id), {
            available: Number(row.available),
            costForUnits: row.cost_for_units === null || row.cost_for_units === void 0 ? null : Number(row.cost_for_units),
            units: Number(row.units),
            bookMin: row.book_min === null || row.book_min === void 0 ? null : Number(row.book_min),
            cheapest4xPrice: row.cheapest_4x_price === null || row.cheapest_4x_price === void 0 ? null : Number(row.cheapest_4x_price),
            listingCount4x: row.listing_count_4x === null || row.listing_count_4x === void 0 ? null : Number(row.listing_count_4x)
          });
        }
      }
      return out2;
    }
    const out = /* @__PURE__ */ new Map();
    for (const id of productIds) {
      const val = this.depthMap.get(id);
      if (val) out.set(id, val);
    }
    return out;
  }
  writeTrend(rows) {
    if (this.db) {
      this.db.exec("DELETE FROM trend");
      const insert = this.db.prepare(
        "INSERT INTO trend (pet_slug, rank, observed_at) VALUES (?, ?, ?)"
      );
      this.db.exec("BEGIN");
      try {
        for (const row of rows) insert.run(row.petSlug, row.rank, row.observedAt);
        this.db.exec("COMMIT");
        return;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    this.trendMap.clear();
    for (const row of rows) {
      this.trendMap.set(row.petSlug, { rank: row.rank, observedAt: row.observedAt });
    }
  }
  trendRanks() {
    if (this.db) {
      const rows = this.db.prepare("SELECT pet_slug, rank, observed_at FROM trend").all();
      const out = /* @__PURE__ */ new Map();
      for (const row of rows) {
        out.set(String(row.pet_slug), { rank: Number(row.rank), observedAt: Number(row.observed_at) });
      }
      return out;
    }
    return new Map(this.trendMap);
  }
  petCount() {
    if (this.db) {
      const row = this.db.prepare("SELECT COUNT(DISTINCT pet_slug) AS n FROM items").get();
      return Number(row.n);
    }
    const slugs = /* @__PURE__ */ new Set();
    for (const item of this.itemsMap.values()) {
      slugs.add(item.realName || item.name);
    }
    return slugs.size;
  }
  itemCount() {
    if (this.db) {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM items").get();
      return Number(row.n);
    }
    return this.itemsMap.size;
  }
  history(productId, sinceTs = 0, limit = 2e3) {
    if (this.db) {
      const rows = this.db.prepare(
        `SELECT ts, price FROM price_history
           WHERE product_id = ? AND ts >= ?
           ORDER BY ts ASC
           LIMIT ?`
      ).all(productId, sinceTs, limit);
      return rows.map((r) => ({ ts: Number(r.ts), price: Number(r.price) }));
    }
    const pts = this.historyMap.get(productId) ?? [];
    return pts.filter((p) => p.ts >= sinceTs).slice(0, limit);
  }
  startSweep(startedAt) {
    if (this.db) {
      const result = this.db.prepare(`INSERT INTO sweeps (started_at, status) VALUES (?, 'running')`).run(startedAt);
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
      status: "running",
      error: null,
      durationMs: null
    });
    return id;
  }
  finishSweep(id, patch) {
    if (this.db) {
      this.db.prepare(
        `UPDATE sweeps
           SET finished_at = ?, requests = ?, items_seen = ?, bands = ?, status = ?, error = ?
           WHERE id = ?`
      ).run(
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
  latestSweep() {
    if (this.db) {
      const row = this.db.prepare("SELECT * FROM sweeps ORDER BY id DESC LIMIT 1").get();
      if (!row) return null;
      const startedAt = Number(row.started_at);
      const finishedAt = row.finished_at === null || row.finished_at === void 0 ? null : Number(row.finished_at);
      return {
        id: Number(row.id),
        startedAt,
        finishedAt,
        requests: Number(row.requests),
        itemsSeen: Number(row.items_seen),
        bands: Number(row.bands),
        status: String(row.status),
        error: row.error === null || row.error === void 0 ? null : String(row.error),
        durationMs: finishedAt === null ? null : finishedAt - startedAt
      };
    }
    return this.sweepsList.length > 0 ? this.sweepsList[this.sweepsList.length - 1] ?? null : null;
  }
  recentSweeps(limit = 20) {
    if (this.db) {
      const rows = this.db.prepare("SELECT * FROM sweeps ORDER BY id DESC LIMIT ?").all(limit);
      return rows.map((row) => {
        const startedAt = Number(row.started_at);
        const finishedAt = row.finished_at === null || row.finished_at === void 0 ? null : Number(row.finished_at);
        return {
          id: Number(row.id),
          startedAt,
          finishedAt,
          requests: Number(row.requests),
          itemsSeen: Number(row.items_seen),
          bands: Number(row.bands),
          status: String(row.status),
          error: row.error === null || row.error === void 0 ? null : String(row.error),
          durationMs: finishedAt === null ? null : finishedAt - startedAt
        };
      });
    }
    return [...this.sweepsList].reverse().slice(0, limit);
  }
  loadSweepState() {
    if (this.db) {
      this.db.prepare("INSERT OR IGNORE INTO sweep_state (id) VALUES (1)").run();
      const row = this.db.prepare("SELECT * FROM sweep_state WHERE id = 1").get();
      return {
        queue: decodeQueue(String(row.queue ?? "[]")),
        tasksDone: Number(row.tasks_done ?? 0),
        cycles: Number(row.cycles ?? 0),
        lastCycleAt: row.last_cycle_at == null ? null : Number(row.last_cycle_at),
        lastFullCycleAt: row.last_full_cycle_at == null ? null : Number(row.last_full_cycle_at),
        truncated: JSON.parse(String(row.truncated ?? "[]"))
      };
    }
    return { ...this.sweepState };
  }
  saveSweepQueue(queue, truncated = []) {
    if (this.db) {
      this.db.prepare(
        `INSERT INTO sweep_state (id, queue, truncated) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET queue = excluded.queue, truncated = excluded.truncated`
      ).run(encodeQueue(queue), JSON.stringify(truncated));
      return;
    }
    this.sweepState.queue = [...queue];
    this.sweepState.truncated = [...truncated];
  }
  finishSweepCycle(at, tasksDone, complete) {
    if (this.db) {
      this.db.prepare(
        `UPDATE sweep_state
           SET cycles = cycles + 1,
               tasks_done = tasks_done + ?,
               last_cycle_at = ?,
               last_full_cycle_at = CASE WHEN ? THEN ? ELSE last_full_cycle_at END
           WHERE id = 1`
      ).run(tasksDone, at, complete ? 1 : 0, at);
      return;
    }
    this.sweepState.cycles++;
    this.sweepState.tasksDone += tasksDone;
    this.sweepState.lastCycleAt = at;
    if (complete) this.sweepState.lastFullCycleAt = at;
  }
  pruneHistory(olderThanTs) {
    if (this.db) {
      const result = this.db.prepare("DELETE FROM price_history WHERE ts < ?").run(olderThanTs);
      return Number(result.changes);
    }
    return 0;
  }
  pruneStaleItems(now, staleAfterMs) {
    if (this.db) {
      const result = this.db.prepare("DELETE FROM items WHERE last_seen < ?").run(now - staleAfterMs);
      return Number(result.changes);
    }
    return 0;
  }
};

// src/core/margin.ts
var FUSION_UNITS = 4;
var DEFAULT_MARGIN_CONFIG = {
  feePct: 0.25,
  minReturnOnCapital: 0.05
};
function breakEvenRatio(feePct) {
  if (!Number.isFinite(feePct) || feePct < 0 || feePct >= 1) {
    throw new RangeError(`feePct must be in [0, 1), got ${feePct}`);
  }
  return FUSION_UNITS / (1 - feePct);
}
function netProceeds(ask, feePct) {
  return ask * (1 - feePct);
}
function evaluateCraft(input, config = DEFAULT_MARGIN_CONFIG) {
  const { normalPrice, neonPrice } = input;
  const flags = [];
  const craftCost = normalPrice * FUSION_UNITS;
  const neonNet = netProceeds(neonPrice, config.feePct);
  const margin = neonNet - craftCost;
  const ratio = normalPrice > 0 ? neonPrice / normalPrice : Number.POSITIVE_INFINITY;
  const be = breakEvenRatio(config.feePct);
  const returnOnCapital = craftCost > 0 ? margin / craftCost : 0;
  const newborn = input.newbornPrice ?? null;
  const fullGrown = input.fullGrownPrice ?? null;
  const tierGap = newborn !== null && fullGrown !== null && newborn > 0 ? fullGrown - newborn : 0;
  const profitable = margin > 0;
  if (!profitable) {
    flags.push("fee_erases_margin");
    if (ratio > 0 && ratio <= be) flags.push("below_break_even_ratio");
  }
  if (tierGap < 0) flags.push("full_grown_cheaper_than_newborn");
  if (newborn !== null && fullGrown !== null && Math.abs(tierGap) < 0.02) {
    flags.push("ageing_unpaid");
  }
  let verdict;
  if (!profitable) {
    verdict = "skip";
  } else if (returnOnCapital < config.minReturnOnCapital) {
    flags.push("thin_depth");
    verdict = "marginal";
  } else {
    verdict = "craft";
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
    verdict
  };
}

// src/config.ts
function num(name, fallback) {
  const raw = process.env[name];
  if (raw === void 0 || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function str(name, fallback) {
  const raw = process.env[name];
  return raw === void 0 || raw === "" ? fallback : raw;
}
function loadConfig() {
  return {
    storeBaseUrl: str("STARPETS_STORE_URL", "https://market.apineural.com"),
    currency: str("STARPETS_CURRENCY", "usd"),
    concurrency: num("STARPETS_CONCURRENCY", 4),
    minIntervalMs: num("STARPETS_MIN_INTERVAL_MS", 250),
    requestBudget: num("STARPETS_REQUEST_BUDGET", 35),
    timeoutMs: num("STARPETS_TIMEOUT_MS", 2e4),
    maxRetries: num("STARPETS_MAX_RETRIES", 4),
    feePct: num("STARPETS_FEE_PCT", DEFAULT_MARGIN_CONFIG.feePct),
    maxNormalPrice: num("STARPETS_MAX_NORMAL_PRICE", 3),
    units: num("STARPETS_UNITS", 4),
    minReturnOnCapital: num("STARPETS_MIN_ROC", DEFAULT_MARGIN_CONFIG.minReturnOnCapital),
    dbPath: str("STARPETS_DB", "./data/starpets.sqlite"),
    host: str("STARPETS_HOST", process.env.HOST || "0.0.0.0"),
    port: num("STARPETS_PORT", num("PORT", 8787)),
    intervalMs: num("STARPETS_INTERVAL_MS", 5 * 6e4),
    historyRetentionMs: num("STARPETS_HISTORY_RETENTION_MS", 14 * 24 * 60 * 6e4)
  };
}

// src/core/api.ts
var MAX_PAGE = 120;
var MAX_AMOUNT = 72;
var MAX_ITEMS_PER_QUERY = MAX_PAGE * MAX_AMOUNT;
var MarketUnavailableError = class extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "MarketUnavailableError";
    this.cause = cause;
  }
};
var MarketApiError = class extends Error {
  status;
  code;
  details;
  constructor(message, status, code, details) {
    super(message);
    this.name = "MarketApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
};
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var Limiter = class {
  active = 0;
  queue = [];
  limit;
  // NOTE: a parameter property (`constructor(private readonly limit: number)`)
  // is unsupported under Node's strip-only TypeScript mode, which is how this
  // project runs without a build step.
  constructor(limit) {
    this.limit = limit;
  }
  async run(fn) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
};
function pruneFilter(filter) {
  const types = filter.types.map((t) => {
    const out2 = { type: t.type };
    for (const key of ["subtypes", "ages", "rarities", "mutations"]) {
      const value = t[key];
      if (Array.isArray(value) && value.length > 0) out2[key] = value;
    }
    if (t.properties && Object.keys(t.properties).length > 0) out2.properties = t.properties;
    return out2;
  });
  const out = { types };
  if (typeof filter.name === "string" && filter.name.length > 0) out.name = filter.name;
  if (filter.price) {
    const price = {};
    if (typeof filter.price.min === "number") price.min = filter.price.min;
    if (typeof filter.price.max === "number" && Number.isFinite(filter.price.max)) {
      price.max = filter.price.max;
    }
    if (Object.keys(price).length > 0) out.price = price;
  }
  return out;
}
var MarketApi = class {
  baseUrl;
  currency;
  metrics = {
    requests: 0,
    retries: 0,
    failures: 0,
    bytes: 0,
    blocked: false
  };
  limiter;
  timeoutMs;
  maxRetries;
  minIntervalMs;
  maxConsecutiveFailures;
  retryOnTimeout;
  onRequest;
  nextSlot = 0;
  consecutiveNetworkFailures = 0;
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? "https://market.apineural.com").replace(/\/+$/, "");
    this.currency = options.currency ?? "usd";
    this.limiter = new Limiter(options.concurrency ?? 4);
    this.timeoutMs = options.timeoutMs ?? 2e4;
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
  async throttle() {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await sleep(wait);
  }
  /** Low-level JSON request with timeout, retry and backoff. */
  async request(method, path, body, signal) {
    const url = `${this.baseUrl}${path}`;
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        this.metrics.retries++;
        const backoff = Math.min(300 * 2 ** (attempt - 1), 4e3);
        await sleep(backoff + Math.random() * 250);
      }
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const started = Date.now();
      await this.throttle();
      try {
        const response = await this.limiter.run(
          () => fetch(url, {
            method,
            headers: body === void 0 ? void 0 : { "Content-Type": "application/json" },
            body: body === void 0 ? void 0 : JSON.stringify(body),
            signal: combined
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
          status: response.status
        });
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
          let parsed = {};
          try {
            parsed = JSON.parse(text);
          } catch {
          }
          const detailMessage = extractDetailMessage(parsed.details);
          throw new MarketApiError(
            detailMessage ?? parsed.statusCode ?? parsed.message ?? `HTTP ${response.status}`,
            response.status,
            parsed.code,
            parsed.details
          );
        }
        return JSON.parse(text);
      } catch (error) {
        if (error instanceof MarketApiError && error.status >= 400 && error.status < 500) {
          this.metrics.failures++;
          throw error;
        }
        if (signal?.aborted) throw error;
        lastError = error;
        this.metrics.failures++;
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
    throw lastError instanceof Error ? lastError : new MarketApiError(`request failed: ${method} ${path}`, 0);
  }
  /**
   * Stop the whole sweep when the host has clearly stopped answering.
   *
   * A connection that times out while the rest of the internet responds is the
   * signature of a rate-limit block, not a transient blip. Continuing to retry
   * only deepens it.
   */
  guardAgainstBlock(method, path, cause) {
    if (this.consecutiveNetworkFailures < this.maxConsecutiveFailures) return;
    this.metrics.blocked = true;
    throw new MarketUnavailableError(
      `${this.consecutiveNetworkFailures} consecutive failures against ${this.baseUrl} (last: ${method} ${path}). Backing off: this looks like a rate-limit block. Raise STARPETS_MIN_INTERVAL_MS and retry later.`,
      cause
    );
  }
  /**
   * Sweep priced items. `amount` is clamped to the server's 72-item cap and
   * `page` to its 120-page cap, because exceeding either is a hard 400.
   */
  async listItems(params) {
    const amount = Math.max(1, Math.min(params.amount ?? MAX_AMOUNT, MAX_AMOUNT));
    const page = Math.max(1, Math.min(params.page ?? 1, MAX_PAGE));
    return this.request(
      "POST",
      "/api/v2/store/items/all",
      {
        page,
        amount,
        currency: params.currency ?? this.currency,
        filter: pruneFilter(params.filter),
        sort: params.sort ?? { price: "asc" }
      },
      params.signal
    );
  }
  /** Just the total count for a filter, without paging. */
  async countItems(filter, signal) {
    const result = await this.listItems({ filter, page: 1, amount: 1, sort: { price: "asc" }, signal });
    return result.count;
  }
  /**
   * Batched order book for many products at once. This is how depth is read:
   * `{id, productId, price}` rows come back sorted ascending, so the cost of
   * the cheapest N units is directly computable.
   */
  async productOffers(products, options = {}) {
    if (products.length === 0) return [];
    const amount = Math.max(1, Math.min(options.amount ?? 50, MAX_AMOUNT));
    const currency = options.currency ?? this.currency;
    const byProduct = /* @__PURE__ */ new Map();
    for (const id of products) {
      byProduct.set(id, { productId: id, offers: [], count: 0, currency });
    }
    const chunkSize = 12;
    for (let i = 0; i < products.length; i += chunkSize) {
      const chunk = products.slice(i, i + chunkSize);
      const response = await this.request(
        "POST",
        "/api/v2/store/items/product",
        {
          currency,
          products: chunk,
          amount
        },
        options.signal
      );
      for (const row of response.items ?? []) {
        const book = byProduct.get(row.productId);
        if (book) book.offers.push(row);
      }
    }
    for (const book of byProduct.values()) {
      book.offers.sort((a, b) => a.price - b.price);
      book.count = Math.max(book.offers.length, 0);
    }
    return [...byProduct.values()];
  }
  /** Prices for store-item ids (the larger id space). */
  async itemPrices(storeItemIds, options = {}) {
    if (storeItemIds.length === 0) return [];
    const response = await this.request(
      "POST",
      "/api/v2/store/items/price",
      { items: storeItemIds, currency: options.currency ?? this.currency },
      options.signal
    );
    return response.items ?? [];
  }
  /** Product detail, including the liquidity we need for ranking. */
  async productInfo(productId, signal) {
    const response = await this.request(
      "GET",
      `/api/v2/products/${productId}/info`,
      void 0,
      signal
    );
    return response.product ?? null;
  }
  /** Variant matrix: `"pumping:flyable:rideable"` -> a product id for that variant. */
  async productProperties(productId, signal) {
    const response = await this.request(
      "GET",
      `/api/products/${productId}/properties`,
      void 0,
      signal
    );
    return response.properties ?? {};
  }
  /** The age ladder for whichever variant `productId` belongs to. */
  async productAges(productId, signal) {
    const response = await this.request(
      "GET",
      `/api/products/${productId}/ages`,
      void 0,
      signal
    );
    return response.ages ?? [];
  }
};
function isTimeoutError(error) {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const cause = error.cause;
  return cause?.code === "UND_ERR_CONNECT_TIMEOUT" || cause?.name === "ConnectTimeoutError" || /timed? ?out/i.test(error.message);
}
function extractDetailMessage(details) {
  if (!details || typeof details !== "object") return void 0;
  const inner = details.details;
  if (!Array.isArray(inner)) return void 0;
  const messages = inner.map((d) => d && typeof d === "object" ? d.message : void 0).filter((m) => typeof m === "string");
  return messages.length > 0 ? messages.join("; ") : void 0;
}

// src/collector/sweep.ts
async function sweepOnce(api, options = {}) {
  const currency = options.currency ?? api.currency;
  const pageSize = Math.min(options.pageSize ?? 72, 72);
  const maxBands = options.maxBands ?? 400;
  const maxFailedBands = options.maxFailedBands ?? 25;
  const log = options.onProgress ?? (() => {
  });
  const startedAt = Date.now();
  const stack = [fullRange(options.minPrice ?? MIN_SWEEP_PRICE)];
  const collected = /* @__PURE__ */ new Map();
  const failedBands = [];
  let bands = 0;
  let aborted = false;
  const baseFilter = (band) => ({
    types: [{ type: "pet" }],
    price: { min: band.min, max: band.max }
  });
  while (stack.length > 0) {
    if (options.signal?.aborted) break;
    if (bands >= maxBands) {
      log(`stopping: reached maxBands (${maxBands})`);
      break;
    }
    const band = stack.pop();
    if (!band) break;
    bands++;
    try {
      const first = await api.listItems({
        filter: baseFilter(band),
        page: 1,
        amount: pageSize,
        currency,
        sort: { price: "asc" },
        signal: options.signal
      });
      for (const item of first.items ?? []) collected.set(item.id, item);
      const decision = planBand(band, first.count ?? 0, MAX_ITEMS_PER_QUERY);
      if (decision.kind === "empty") continue;
      if (decision.kind === "unsplittable") {
        failedBands.push(bandLabel(band));
        log(`WARNING band ${bandLabel(band)} cannot be split (count ${first.count}); paging best-effort`);
        await pageBand(api, band, currency, pageSize, collected, 120, options.signal);
        continue;
      }
      if (decision.kind === "split") {
        stack.push(decision.right, decision.left);
        continue;
      }
      const total = decision.pages;
      log(`band ${bandLabel(band)}: count=${first.count} pages=${total}`);
      for (let page = 2; page <= total; page++) {
        if (options.signal?.aborted) break;
        const result = await api.listItems({
          filter: baseFilter(band),
          page,
          amount: pageSize,
          currency,
          sort: { price: "asc" },
          signal: options.signal
        });
        for (const item of result.items ?? []) collected.set(item.id, item);
      }
    } catch (error) {
      if (error instanceof MarketUnavailableError) {
        log(`ABORT: ${error.message}`);
        aborted = true;
        break;
      }
      failedBands.push(bandLabel(band));
      log(`band ${bandLabel(band)} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (failedBands.length >= maxFailedBands) {
        log(`ABORT: ${failedBands.length} bands failed`);
        aborted = true;
        break;
      }
    }
  }
  const items = [...collected.values()];
  const pets = new Set(items.map((i) => i.realName));
  return {
    items,
    itemCount: items.length,
    petCount: pets.size,
    bands,
    requests: api.metrics.requests,
    durationMs: Date.now() - startedAt,
    failedBands,
    aborted
  };
}
async function pageBand(api, band, currency, pageSize, into, maxPage, signal) {
  for (let page = 2; page <= maxPage; page++) {
    if (signal?.aborted) break;
    const result = await api.listItems({
      filter: { types: [{ type: "pet" }], price: { min: band.min, max: band.max } },
      page,
      amount: pageSize,
      currency,
      sort: { price: "asc" },
      signal
    });
    if ((result.items ?? []).length === 0) break;
    for (const item of result.items) into.set(item.id, item);
  }
}
async function runSweep(api, store, options = {}) {
  const startedAt = Date.now();
  const sweepId = store.startSweep(startedAt);
  try {
    const result = await sweepOnce(api, options);
    const finishedAt = Date.now();
    store.writeItems(result.items, finishedAt);
    store.finishSweep(sweepId, {
      finishedAt,
      requests: result.requests,
      itemsSeen: result.itemCount,
      bands: result.bands,
      status: result.aborted ? "error" : "ok",
      error: result.aborted ? `aborted after ${result.failedBands.length} failed bands` : null
    });
    return result;
  } catch (error) {
    store.finishSweep(sweepId, {
      finishedAt: Date.now(),
      requests: api.metrics.requests,
      itemsSeen: 0,
      bands: 0,
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

// src/core/hygiene.ts
function isUsablePrice(price) {
  return typeof price === "number" && Number.isFinite(price) && price > 0;
}
function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function depthCheck(offers, units = 4) {
  const usable = offers.filter((o) => isUsablePrice(o.price)).map((o) => o.price).sort((a, b) => a - b);
  const available = usable.length;
  const slice = usable.slice(0, units);
  const enough = slice.length >= units;
  const costForUnits = enough ? slice.reduce((sum, p) => sum + p, 0) : null;
  const effectiveUnitCost = costForUnits !== null && units > 0 ? costForUnits / units : null;
  const cheapestListingPrice = usable.length > 0 ? usable[0] ?? null : null;
  const countsByPrice = /* @__PURE__ */ new Map();
  for (const p of usable) {
    countsByPrice.set(p, (countsByPrice.get(p) ?? 0) + 1);
  }
  const priceTiers = [];
  for (const [price, count] of countsByPrice.entries()) {
    priceTiers.push({ price, count });
  }
  priceTiers.sort((a, b) => a.price - b.price);
  let cheapest4xListingPrice = null;
  let listingCountAtCheapest4x = null;
  for (const tier of priceTiers) {
    if (tier.count >= units) {
      cheapest4xListingPrice = tier.price;
      listingCountAtCheapest4x = tier.count;
      break;
    }
  }
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
    priceTiers
  };
}

// src/core/opportunities.ts
var AGE_ALIASES_NEWBORN = ["newborn", "default"];
var AGE_ALIASES_FULL_GROWN = ["full_grown", "fullgrown", "full-grown"];
function buildOpportunities(items, options = {}) {
  const margin = options.margin ?? DEFAULT_MARGIN_CONFIG;
  const units = options.units ?? FUSION_UNITS;
  const maxNormalPrice = options.maxNormalPrice ?? Number.POSITIVE_INFINITY;
  const lowOutlierFactor = options.lowOutlierFactor ?? 12;
  const byPet = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = item.realName || item.name;
    const bucket = byPet.get(key);
    if (bucket) bucket.push(item);
    else byPet.set(key, [item]);
  }
  const out = [];
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
        fullGrownPrice: normal.fullGrownPrice
      },
      margin
    );
    const flags = [...result.flags];
    if (zeroPriceCount > 0) flags.push("no_data_zero_price");
    if (normal.suspiciousLow) flags.push("outlier_ask_rejected");
    if (normal.rejectedHighCount > 0 && !flags.includes("outlier_ask_rejected")) {
      flags.push("outlier_ask_rejected");
    }
    out.push({
      petSlug,
      petName: sample.name,
      rare: sample.rare,
      currency: "usd",
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
      trendRank: null
    });
  }
  return out;
}
function bestImage(items) {
  for (const item of items) {
    const uri = item.imageUri;
    if (uri && /^https?:\/\//i.test(uri)) return uri;
  }
  return null;
}
function cheapestNormalInput(items, lowOutlierFactor = 12) {
  const normals = items.filter((i) => i.pumping === "default" && isUsablePrice(i.price));
  if (normals.length === 0) return null;
  const buckets = /* @__PURE__ */ new Map();
  for (const item of normals) {
    const key = `${item.pumping}:${item.flyable}:${item.rideable}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, byAge: /* @__PURE__ */ new Map() };
      buckets.set(key, bucket);
    }
    const ageKey = item.age ?? "__none__";
    const existing = bucket.byAge.get(ageKey);
    if (!existing || item.price < existing.price) bucket.byAge.set(ageKey, item);
  }
  let best = null;
  for (const bucket of buckets.values()) {
    for (const item of bucket.byAge.values()) {
      if (!best || item.price < best.cheapest.price) best = { bucket, cheapest: item };
    }
  }
  if (!best) return null;
  const rungs = [...best.bucket.byAge.values()].filter((i) => isUsablePrice(i.price));
  const prices = rungs.map((i) => i.price);
  const med = median(prices);
  const suspiciousLow = rungs.length >= 3 && Number.isFinite(med) && med > 0 && best.cheapest.price < med / lowOutlierFactor;
  const findAge = (aliases) => {
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
    zeroPriceCount: 0
  };
}
function buildFlips(items, options = {}) {
  const feePct = options.feePct ?? DEFAULT_MARGIN_CONFIG.feePct;
  const minDiscountPct = options.minDiscountPct ?? 0.15;
  const minMargin = options.minMargin ?? 0.01;
  const maxAsk = options.maxAsk ?? Number.POSITIVE_INFINITY;
  const belowByPet = /* @__PURE__ */ new Map();
  for (const item of items) {
    if (!isUsablePrice(item.price) || !isUsablePrice(item.avgPrice)) continue;
    if (item.price >= item.avgPrice) continue;
    const key = item.realName || item.name;
    belowByPet.set(key, (belowByPet.get(key) ?? 0) + 1);
  }
  const out = [];
  for (const item of items) {
    if (!isUsablePrice(item.price) || !isUsablePrice(item.avgPrice)) continue;
    if (item.price > maxAsk) continue;
    const ask = item.price;
    const marketAvg = item.avgPrice;
    const discountPct = (marketAvg - ask) / marketAvg;
    if (discountPct <= 0) continue;
    const netProceeds2 = marketAvg * (1 - feePct);
    const margin = netProceeds2 - ask;
    const flags = [];
    if (marketAvg === ask) continue;
    const petKey = item.realName || item.name;
    const siblingsBelow = Math.max(0, (belowByPet.get(petKey) ?? 1) - 1);
    const clearsFloor = discountPct >= minDiscountPct && margin >= minMargin;
    if (!clearsFloor) flags.push("below_break_even_ratio");
    out.push({
      petSlug: item.realName || item.name,
      petName: item.name,
      rare: item.rare,
      currency: "usd",
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
      netProceeds: netProceeds2,
      margin,
      discountPct,
      siblingsBelow,
      verdict: clearsFloor ? "watch" : "weak",
      flags,
      salesPerWeek: null
    });
  }
  return out.sort((a, b) => b.discountPct - a.discountPct || b.margin - a.margin);
}
function cheapestNeonAsk(items) {
  let best = null;
  for (const item of items) {
    if (item.pumping !== "neon") continue;
    if (!isUsablePrice(item.price)) continue;
    if (!best || item.price < best.price) best = item;
  }
  return best ? {
    price: best.price,
    productId: best.id,
    age: best.age,
    avgPrice: isUsablePrice(best.avgPrice) ? best.avgPrice : null,
    variant: `${best.pumping}:${best.flyable}:${best.rideable}`
  } : null;
}
function neonLadder(items) {
  return items.filter((i) => i.pumping === "neon" && isUsablePrice(i.price)).sort((a, b) => a.price - b.price).map((i) => ({ age: i.age, price: i.price, productId: i.id }));
}
function variantKeys(items) {
  return [...new Set(items.map((i) => `${i.pumping}:${i.flyable}:${i.rideable}`))].sort();
}

// src/service.ts
var STALE_AFTER_MS = 15 * 6e4;
var OPPORTUNITY_CACHE_MS = 5e3;
var ScannerService = class {
  store;
  api;
  config;
  /** Trend rank per pet slug, from the marketplace's own popularity sort. */
  trendCache = null;
  trendAt = 0;
  /**
   * A second client for user-facing live lookups.
   *
   * The collector's client is built to be patient — several retries with long
   * timeouts — which is right for a background sweep and wrong for a button
   * someone is waiting on. Against a blocked host the patient policy left an
   * interactive depth check hanging for over a minute, so interactive calls
   * get short timeouts and a single retry, and fail fast with a clear message.
   */
  interactiveApi;
  cache = null;
  flipCache = null;
  sweepInFlight = null;
  constructor(store, api, config) {
    this.store = store;
    this.api = api;
    this.config = config;
    this.interactiveApi = new MarketApi({
      baseUrl: api.baseUrl,
      currency: api.currency,
      concurrency: 2,
      minIntervalMs: config.minIntervalMs,
      timeoutMs: 4e3,
      maxRetries: 1,
      // Never wait on a host that has already gone quiet: report and move on.
      retryOnTimeout: false,
      maxConsecutiveFailures: 2
    });
  }
  /** A key that changes whenever the underlying snapshot changes. */
  revision() {
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
  attachLiquidity(opportunities) {
    if (opportunities.length === 0) return;
    const ids = opportunities.map((o) => o.neonProductId);
    const map = this.store.liquidityFor(ids);
    for (const o of opportunities) {
      const hit = map.get(o.neonProductId);
      o.salesPerWeek = hit ? hit.salesPerWeek : null;
      o.demandScore = hit && hit.salesPerWeek > 0 ? o.margin * hit.salesPerWeek : hit ? 0 : null;
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
  async enrichDemand(productIds, budget = 30) {
    const missing = this.store.liquidityMissing(productIds);
    const batch = missing.slice(0, Math.max(0, budget));
    for (const productId of batch) {
      try {
        const info = await this.interactiveApi.productInfo(productId);
        const sales = info?.numberOfSalesPerWeek;
        this.store.writeLiquidity([
          { productId, salesPerWeek: typeof sales === "number" && sales >= 0 ? Math.round(sales) : 0, observedAt: Date.now() }
        ]);
      } catch {
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
  listOpportunities(options = {}) {
    const resolved = this.resolveOptions(options);
    const key = `${this.revision()}:${JSON.stringify(resolved)}`;
    const now = Date.now();
    if (this.cache && this.cache.key === key && now - this.cache.at < OPPORTUNITY_CACHE_MS) {
      return this.cache.value;
    }
    const all = buildOpportunities(this.store.currentItems(), {
      margin: {
        feePct: resolved.feePct,
        minReturnOnCapital: this.config.minReturnOnCapital
      },
      maxNormalPrice: resolved.maxNormalPrice,
      units: resolved.units
    });
    this.attachLiquidity(all);
    this.attachDepth(all);
    this.attachTrend(all);
    const trending = this.trendingSlugs();
    const filtered = all.filter((o) => {
      if (!resolved.includeLosses && o.margin <= 0) return false;
      if (resolved.verdict !== "all" && o.verdict !== resolved.verdict) return false;
      if (resolved.rarities.length > 0 && !resolved.rarities.includes(String(o.rare ?? "").toLowerCase())) {
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
  trendingSlugs() {
    this.loadTrend();
    return new Set(this.trendCache?.keys() ?? []);
  }
  loadTrend() {
    const maxAgeMs = 60 * 60 * 1e3;
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
  attachDepth(opportunities) {
    if (opportunities.length === 0) return;
    const ids = [
      ...new Set(
        opportunities.flatMap((o) => [o.normalProductId, o.neonProductId])
      )
    ];
    const map = this.store.depthFor(ids);
    for (const o of opportunities) {
      const input = map.get(o.normalProductId);
      const neon = map.get(o.neonProductId);
      o.inputAvailable = input ? input.available : null;
      o.inputBuyable = input ? input.available >= (input.units || 4) : null;
      o.inputDepthPrice = input && input.costForUnits !== null && input.units > 0 ? input.costForUnits / input.units : null;
      o.inputDepth4xPrice = input?.cheapest4xPrice ?? null;
      o.inputDepthListingCount = input?.listingCount4x ?? null;
      o.neonAvailable = neon ? neon.available : null;
      o.neonDepthPrice = neon && neon.available > 0 ? neon.bookMin ?? o.neonPrice : null;
      if (o.inputBuyable === false) {
        if (!o.flags.includes("cannot_buy_units")) o.flags.push("cannot_buy_units");
      }
      const buyPrice = o.inputDepth4xPrice ?? o.inputDepthPrice ?? o.normalPrice;
      const sellPrice = o.neonDepthPrice ?? o.neonPrice;
      if (buyPrice !== null && sellPrice !== null) {
        const recheck = evaluateCraft(
          {
            normalPrice: buyPrice,
            neonPrice: sellPrice,
            normalAge: o.normalAge
          },
          { feePct: o.feePct, minReturnOnCapital: this.config.minReturnOnCapital }
        );
        o.normalPrice = buyPrice;
        o.neonPrice = sellPrice;
        o.craftCost = input?.costForUnits ?? buyPrice * 4;
        o.neonNet = recheck.neonNet;
        o.margin = Math.round((o.neonNet - o.craftCost) * 1e3) / 1e3;
        o.ratio = recheck.ratio;
        o.verdict = (o.inputBuyable ?? true) && o.margin > 0 ? recheck.verdict : "skip";
        for (const flag of recheck.flags) {
          if (!o.flags.includes(flag)) o.flags.push(flag);
        }
      }
    }
  }
  /** Attach the marketplace's own rank, for the UI's trend badges. */
  attachTrend(opportunities) {
    this.loadTrend();
    if (!this.trendCache || this.trendCache.size === 0) return;
    for (const o of opportunities) {
      const rank = this.trendCache.get(o.petSlug);
      if (rank !== void 0) o.trendRank = rank;
    }
  }
  /**
   * Refresh the most-traded board from the marketplace's popularity sort.
   */
  async refreshTrending(pages = 2) {
    const seen = /* @__PURE__ */ new Map();
    const observedAt = Date.now();
    for (let page = 1; page <= pages; page++) {
      const result = await this.interactiveApi.listItems({
        filter: { types: [{ type: "pet" }], price: { min: 0.01 } },
        sort: { popularity: "desc" },
        page,
        amount: 72
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
  async verifyDepth(productIds, budget = 40) {
    const units = this.config.units;
    const wanted = [];
    for (const pair of productIds) {
      wanted.push(pair.normalProductId, pair.neonProductId);
    }
    const missing = this.store.depthFor(wanted);
    const toRead = [];
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
          observedAt: Date.now()
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
  async syncPopularPets(options = {}) {
    const pages = options.pages ?? 2;
    const shouldVerify = options.verifyDepth ?? true;
    const now = Date.now();
    const allPopularItems = [];
    for (let page = 1; page <= pages; page++) {
      try {
        const res = await this.interactiveApi.listItems({
          filter: { types: [{ type: "pet" }] },
          sort: { popularity: "desc" },
          page,
          amount: 72
        });
        for (const item of res.items ?? []) {
          if (isUsablePrice(item.price)) {
            allPopularItems.push(item);
          }
        }
      } catch {
        break;
      }
    }
    if (allPopularItems.length === 0) {
      return { petsSynced: 0, itemsStored: 0, topPets: [] };
    }
    this.store.writeItems(allPopularItems, now);
    const uniquePets = /* @__PURE__ */ new Map();
    const trendRows = [];
    const topPets = [];
    for (const item of allPopularItems) {
      const slug = item.realName || item.name;
      if (!uniquePets.has(slug)) {
        uniquePets.set(slug, item);
        const rank = uniquePets.size;
        trendRows.push({ petSlug: slug, rank, observedAt: now });
        topPets.push(item.name);
      }
    }
    this.store.writeTrend(trendRows);
    this.trendCache = new Map(trendRows.map((r) => [r.petSlug, r.rank]));
    this.trendAt = now;
    const itemsToAdd = [];
    const liquidityToWrite = [];
    const candidatePets = [...uniquePets.values()].slice(0, 100);
    const batchSize = 4;
    for (let i = 0; i < candidatePets.length; i += batchSize) {
      const chunk = candidatePets.slice(i, i + batchSize);
      await Promise.all(
        chunk.map(async (pet) => {
          try {
            const props = await this.interactiveApi.productProperties(pet.id);
            const normalBaseId = props["default:false:false"] ?? pet.id;
            const normalAges = await this.interactiveApi.productAges(normalBaseId).catch(() => []);
            const normalPids = normalAges.length > 0 ? normalAges.map((a) => a.id) : [normalBaseId];
            if (!normalPids.includes(normalBaseId)) normalPids.push(normalBaseId);
            const neonBaseKeys = Object.keys(props).filter((k) => k.startsWith("neon:"));
            const neonPids = [];
            for (const nk of neonBaseKeys) {
              const nid = props[nk];
              if (typeof nid === "number") {
                const neonAges = await this.interactiveApi.productAges(nid).catch(() => []);
                if (neonAges.length > 0) {
                  for (const na of neonAges) neonPids.push(na.id);
                } else {
                  neonPids.push(nid);
                }
              }
            }
            const uniqueNeonPids = [...new Set(neonPids)];
            const normalInfo = await this.interactiveApi.productInfo(normalBaseId).catch(() => null);
            if (normalInfo) {
              const sales = normalInfo.numberOfSalesPerWeek;
              if (typeof sales === "number" && sales >= 0) {
                liquidityToWrite.push({ productId: normalBaseId, salesPerWeek: Math.round(sales), observedAt: now });
              }
            }
            const normalBooks = await this.interactiveApi.productOffers(normalPids, { amount: 72 }).catch(() => []);
            const normalOffers = normalBooks.flatMap((b) => b.offers).filter((o) => isUsablePrice(o.price));
            const normalDepth = depthCheck(normalOffers, 4);
            const baseNeonId = props["neon:false:false"];
            let baseNeonPids = [];
            if (typeof baseNeonId === "number") {
              const baseNeonAges = await this.interactiveApi.productAges(baseNeonId).catch(() => []);
              baseNeonPids = baseNeonAges.length > 0 ? baseNeonAges.map((a) => a.id) : [baseNeonId];
              if (!baseNeonPids.includes(baseNeonId)) baseNeonPids.push(baseNeonId);
            }
            const baseNeonBooks = baseNeonPids.length > 0 ? await this.interactiveApi.productOffers(baseNeonPids, { amount: 72 }).catch(() => []) : [];
            const baseNeonOffers = baseNeonBooks.flatMap((b) => b.offers).filter((o) => isUsablePrice(o.price));
            const baseNeonPrices = baseNeonOffers.map((o) => o.price).sort((a, b) => a - b);
            const baseNeonPrice = baseNeonPrices.length > 0 ? baseNeonPrices[0] : null;
            const neonBooks = uniqueNeonPids.length > 0 ? await this.interactiveApi.productOffers(uniqueNeonPids, { amount: 72 }).catch(() => []) : [];
            const neonOffers = neonBooks.flatMap((b) => b.offers).filter((o) => isUsablePrice(o.price));
            const neonPrices = neonOffers.map((o) => o.price).sort((a, b) => a - b);
            const neonPrice = baseNeonPrice ?? (neonPrices.length > 0 ? neonPrices[0] : null);
            const neonProductId = baseNeonId ?? uniqueNeonPids[0];
            const buy4Price = normalDepth.cheapest4xListingPrice ?? normalDepth.cheapestListingPrice;
            const cheapestSingle = normalDepth.cheapestListingPrice;
            const craftCost = normalDepth.costForUnits ?? (buy4Price ? buy4Price * 4 : null);
            if (buy4Price !== null) {
              this.store.writeDepth({
                productId: normalBaseId,
                available: normalDepth.available,
                costForUnits: craftCost,
                units: 4,
                bookMin: cheapestSingle,
                cheapest4xPrice: buy4Price,
                listingCount4x: normalDepth.listingCountAtCheapest4x,
                observedAt: now
              });
              itemsToAdd.push({
                id: normalBaseId,
                goodId: normalInfo?.goodId ?? String(normalBaseId),
                name: normalInfo?.name ?? pet.name,
                type: "pet",
                realName: normalInfo?.realName ?? pet.realName,
                imageId: null,
                imageUri: normalInfo?.imageUri || pet.imageUri,
                subtype: null,
                age: "newborn",
                rare: normalInfo?.rare || pet.rare,
                pumping: "default",
                flyable: false,
                rideable: false,
                price: buy4Price,
                avgPrice: cheapestSingle,
                bonuses: 0,
                source: "observed"
              });
            }
            if (neonProductId && neonPrice !== null) {
              this.store.writeDepth({
                productId: neonProductId,
                available: neonPrices.length,
                costForUnits: neonPrice,
                units: 1,
                bookMin: neonPrice,
                cheapest4xPrice: neonPrice,
                listingCount4x: 1,
                observedAt: now
              });
              itemsToAdd.push({
                id: neonProductId,
                goodId: String(neonProductId),
                name: normalInfo?.name ?? pet.name,
                type: "pet",
                realName: normalInfo?.realName ?? pet.realName,
                imageId: null,
                imageUri: normalInfo?.imageUri || pet.imageUri,
                subtype: null,
                age: "reborn",
                rare: normalInfo?.rare || pet.rare,
                pumping: "neon",
                flyable: false,
                rideable: false,
                price: neonPrice,
                avgPrice: neonPrice,
                bonuses: 0,
                source: "observed"
              });
            }
          } catch {
          }
        })
      );
    }
    if (itemsToAdd.length > 0) {
      this.store.writeItems(itemsToAdd, now);
    }
    if (liquidityToWrite.length > 0) {
      this.store.writeLiquidity(liquidityToWrite);
    }
    this.cache = null;
    return {
      petsSynced: uniquePets.size,
      itemsStored: allPopularItems.length + itemsToAdd.length,
      topPets: topPets.slice(0, 10)
    };
  }
  /**
   * Listings priced below their own 7-day average, ranked by discount.
   *
   * Deliberately a separate list from `listOpportunities`: the craft margin is
   * arithmetic on two asks, this is a bet that a buyer exists at the average.
   * Mixing them into one ranking would launder the weaker signal.
   */
  listFlips(options = {}) {
    const resolved = {
      feePct: options.feePct ?? this.config.feePct,
      minDiscountPct: options.minDiscountPct ?? 0.15,
      minMargin: options.minMargin ?? 0.01,
      maxAsk: options.maxAsk ?? this.config.maxNormalPrice * 4,
      watchOnly: options.watchOnly ?? true,
      limit: options.limit ?? 60
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
      maxAsk: resolved.maxAsk
    });
    const value = (resolved.watchOnly ? all.filter((f) => f.verdict === "watch") : all).slice(
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
  catalog(rarities = ["rare", "ultra_rare", "legendary"]) {
    const byPet = /* @__PURE__ */ new Map();
    for (const item of this.store.currentItems()) {
      const key = item.realName || item.name;
      const bucket = byPet.get(key);
      if (bucket) bucket.push(item);
      else byPet.set(key, [item]);
    }
    const margin = { feePct: this.config.feePct, minReturnOnCapital: this.config.minReturnOnCapital };
    const rows = [];
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
        neonProductId: neon?.productId ?? null
      };
      const overCap = input !== null && input.price > this.config.maxNormalPrice;
      if (!input || !neon || overCap) {
        rows.push({
          ...base,
          craftCost: input ? input.price * 4 : null,
          neonNet: neon ? Math.round(neon.price * (1 - margin.feePct) * 1e3) / 1e3 : null,
          margin: null,
          roiPct: null,
          ratio: null,
          verdict: null,
          status: !input ? "awaiting_price" : overCap ? "over_cap" : "awaiting_neon",
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
          trendRank: null
        });
        continue;
      }
      const result = evaluateCraft(
        {
          normalPrice: input.price,
          neonPrice: neon.price,
          normalAge: input.age,
          newbornPrice: input.newbornPrice,
          fullGrownPrice: input.fullGrownPrice
        },
        margin
      );
      const craftCost = input.price * 4;
      const roiPct = craftCost > 0 ? Math.round(result.margin / craftCost * 1e3) / 10 : null;
      rows.push({
        ...base,
        craftCost,
        neonNet: result.neonNet,
        margin: result.margin,
        roiPct,
        ratio: result.ratio,
        verdict: result.verdict,
        status: "evaluated",
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
        trendRank: null
      });
    }
    const joinIds = [
      ...new Set(
        rows.flatMap((r) => [r.normalProductId, r.neonProductId]).filter((id) => typeof id === "number")
      )
    ];
    const demand = this.store.liquidityFor(joinIds);
    const depth = this.store.depthFor(joinIds);
    this.loadTrend();
    const trend = this.trendCache ?? /* @__PURE__ */ new Map();
    for (const row of rows) {
      const hit = (row.neonProductId !== null ? demand.get(row.neonProductId) : void 0) ?? (row.normalProductId !== null ? demand.get(row.normalProductId) : void 0);
      row.salesPerWeek = hit ? hit.salesPerWeek : null;
      const dIn = row.normalProductId === null ? void 0 : depth.get(row.normalProductId);
      row.inputAvailable = dIn ? dIn.available : null;
      row.inputBuyable = dIn ? dIn.available >= (dIn.units || 4) : null;
      row.inputDepthPrice = dIn && dIn.costForUnits !== null && dIn.units > 0 ? dIn.costForUnits / dIn.units : null;
      row.inputDepth4xPrice = dIn?.cheapest4xPrice ?? null;
      row.inputDepthListingCount = dIn?.listingCount4x ?? null;
      const dNeon = row.neonProductId === null ? void 0 : depth.get(row.neonProductId);
      row.neonAvailable = dNeon ? dNeon.available : null;
      row.neonDepthPrice = dNeon && dNeon.available > 0 ? dNeon.bookMin ?? row.neonPrice : null;
      row.trendRank = trend.get(row.slug) ?? null;
      const effectiveInput = row.inputDepth4xPrice ?? row.inputDepthPrice ?? row.inputPrice;
      const effectiveNeon = row.neonDepthPrice ?? row.neonPrice;
      if (effectiveInput !== null && effectiveNeon !== null) {
        const recheck = evaluateCraft(
          {
            normalPrice: effectiveInput,
            neonPrice: effectiveNeon,
            normalAge: row.inputAge,
            newbornPrice: null,
            fullGrownPrice: null
          },
          margin
        );
        row.inputPrice = effectiveInput;
        row.neonPrice = effectiveNeon;
        row.craftCost = dIn?.costForUnits ?? effectiveInput * 4;
        row.neonNet = recheck.neonNet;
        row.margin = Math.round((row.neonNet - row.craftCost) * 1e3) / 1e3;
        row.roiPct = row.craftCost > 0 ? Math.round(row.margin / row.craftCost * 1e3) / 10 : null;
        row.ratio = recheck.ratio;
        row.verdict = (row.inputBuyable ?? true) && row.margin > 0 ? recheck.verdict : "skip";
        for (const flag of recheck.flags) {
          if (!row.flags.includes(flag)) row.flags.push(flag);
        }
      }
      if (row.inputBuyable === false && !row.flags.includes("cannot_buy_units")) {
        row.flags.push("cannot_buy_units");
      }
      row.demandScore = hit && row.margin !== null && hit.salesPerWeek > 0 ? row.margin * hit.salesPerWeek : hit ? 0 : null;
    }
    const wanted = rarities.map((r) => r.toLowerCase());
    const visible = wanted.length === 0 ? rows : rows.filter((r) => wanted.includes(String(r.rare ?? "").toLowerCase()));
    return visible.sort((a, b) => {
      const rank = (r) => r.status === "evaluated" ? (r.margin ?? 0) > 0 ? 0 : 1 : 2;
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return (b.margin ?? Number.NEGATIVE_INFINITY) - (a.margin ?? Number.NEGATIVE_INFINITY);
    });
  }
  /** Everything the UI needs to state how complete the snapshot is. */
  coverage() {
    return computeCoverage(
      this.store.currentItems(),
      this.store.petCount(),
      this.config.maxNormalPrice,
      this.config.feePct
    );
  }
  resolveOptions(options) {
    return {
      maxNormalPrice: options.maxNormalPrice ?? this.config.maxNormalPrice,
      feePct: options.feePct ?? this.config.feePct,
      units: options.units ?? this.config.units,
      verdict: options.verdict ?? "all",
      limit: options.limit ?? 100,
      sortBy: options.sortBy ?? "margin",
      includeLosses: options.includeLosses ?? false,
      rarities: options.rarities ?? ["rare", "ultra_rare", "legendary"],
      trendingOnly: options.trendingOnly ?? false
    };
  }
  /** One pet, with the evidence behind its verdict. */
  getPet(slug) {
    const items = this.store.itemsForPet(slug);
    if (items.length === 0) return null;
    const summary = this.listOpportunities({ limit: Number.MAX_SAFE_INTEGER, includeLosses: true }).find(
      (o) => o.petSlug === slug
    );
    if (!summary) return null;
    const since = Date.now() - 24 * 60 * 6e4;
    return {
      summary,
      neonLadder: neonLadder(items),
      variants: variantKeys(items),
      history: {
        normal: this.store.history(summary.normalProductId, since),
        neon: this.store.history(summary.neonProductId, since)
      }
    };
  }
  /** Price history for a pet's two sides, for the drift model. */
  history(slug, hours = 24) {
    const items = this.store.itemsForPet(slug);
    if (items.length === 0) return null;
    const summary = this.listOpportunities({ limit: Number.MAX_SAFE_INTEGER, includeLosses: true }).find(
      (o) => o.petSlug === slug
    );
    if (!summary) return null;
    const since = Date.now() - hours * 60 * 6e4;
    return {
      normal: this.store.history(summary.normalProductId, since),
      neon: this.store.history(summary.neonProductId, since)
    };
  }
  /** Live order book for one product: the depth check a min price cannot give. */
  async orderBook(productId, units = 4) {
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
      offers: offers.map((o) => ({ id: o.id, price: o.price }))
    };
  }
  status() {
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
      staleSeconds: latest?.finishedAt == null ? null : Math.round((Date.now() - latest.finishedAt) / 1e3),
      fabricatedItemCount: this.store.countBySource("fabricated"),
      verifiedItemCount: this.store.countBySource("verified"),
      observedItemCount: this.store.countBySource("observed"),
      coverage: this.coverage()
    };
  }
  isStale() {
    const latest = this.store.latestSweep();
    if (!latest?.finishedAt) return true;
    return Date.now() - latest.finishedAt > STALE_AFTER_MS;
  }
  /** Trigger a sweep, coalescing concurrent callers onto one run. */
  async triggerSweep() {
    if (this.sweepInFlight) return this.sweepInFlight;
    this.sweepInFlight = runSweep(this.api, this.store, {
      currency: this.config.currency,
      minPrice: 0.01
    }).finally(() => {
      this.sweepInFlight = null;
      this.cache = null;
    });
    return this.sweepInFlight;
  }
  sweeps(limit = 20) {
    return this.store.recentSweeps(limit);
  }
  /** The marketplace's own most-traded board, for diagnostics and the UI. */
  trendBoard() {
    this.loadTrend();
    return [...(this.trendCache ?? /* @__PURE__ */ new Map()).entries()].map(([slug, rank]) => ({
      slug,
      rank
    }));
  }
  /** The catalog, as identity records. */
  pets() {
    return this.store.petIndex();
  }
  /**
   * Resolve free-form user or model input to a pet slug.
   *
   * Accepts the slug (`dango_penguins`), the display name (`Dango Penguins`),
   * or a distinctive fragment, because a language model will rarely produce the
   * exact slug and an LLM-facing tool that demands one is a bad tool.
   */
  resolvePet(query) {
    const index = this.store.petIndex();
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return null;
    const normalise = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const target = normalise(query);
    const exact = index.find((p) => p.slug === needle || p.name.toLowerCase() === needle);
    if (exact) return { slug: exact.slug, name: exact.name };
    const normalised = index.find((p) => normalise(p.name) === target || normalise(p.slug) === target);
    if (normalised) return { slug: normalised.slug, name: normalised.name };
    const partial = index.filter((p) => normalise(p.name).includes(target));
    if (partial.length === 1) {
      const only = partial[0];
      return { slug: only.slug, name: only.name };
    }
    return null;
  }
  /** Candidate matches for an ambiguous query, so callers can disambiguate. */
  searchPets(query, limit = 10) {
    const normalise = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const target = normalise(query);
    if (target.length === 0) return [];
    return this.store.petIndex().filter((p) => normalise(p.name).includes(target)).slice(0, limit);
  }
  get defaults() {
    return {
      feePct: this.config.feePct,
      maxNormalPrice: this.config.maxNormalPrice,
      units: this.config.units,
      breakEvenRatio: 4 / (1 - this.config.feePct)
    };
  }
};
function computeCoverage(items, petsInCatalog, capitalCap, feePct = DEFAULT_MARGIN_CONFIG.feePct) {
  const byPet = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = item.realName || item.name;
    const bucket = byPet.get(key);
    if (bucket) bucket.push(item);
    else byPet.set(key, [item]);
  }
  let petsEvaluable = 0;
  const inputAsks = [];
  for (const petItems of byPet.values()) {
    const normals = petItems.filter((i) => i.pumping === "default" && isUsablePrice(i.price));
    const hasNeon = petItems.some((i) => i.pumping === "neon" && isUsablePrice(i.price));
    if (normals.length > 0) {
      const cheapest = Math.min(...normals.map((i) => i.price));
      inputAsks.push(cheapest);
    }
    if (normals.length > 0 && hasNeon) petsEvaluable += 1;
  }
  const asks = items.filter((i) => isUsablePrice(i.price)).map((i) => i.price);
  const maxInputAskObserved = inputAsks.length > 0 ? Math.max(...inputAsks) : 0;
  const maxAskObserved = asks.length > 0 ? Math.max(...asks) : 0;
  const minInputAsk = inputAsks.length > 0 ? Math.min(...inputAsks) : 0;
  const profitableBandUnreached = asks.length > 0 && minInputAsk > 0 && maxAskObserved * (1 - feePct) <= FUSION_UNITS * minInputAsk;
  const band = inputAsks.length === 0 ? "none" : `$${Math.min(...inputAsks).toFixed(2)} - $${maxInputAskObserved.toFixed(2)}`;
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
    inputBandReached: band
  };
}
function sortOpportunities(list, sortBy) {
  const copy = [...list];
  switch (sortBy) {
    case "ratio":
      return copy.sort((a, b) => b.ratio / b.breakEvenRatio - a.ratio / a.breakEvenRatio);
    case "discount":
      return copy.sort((a, b) => discount(b) - discount(a));
    case "cheap":
      return copy.sort((a, b) => a.craftCost - b.craftCost);
    case "demand":
      return copy.sort((a, b) => demandKey(b) - demandKey(a));
    case "margin":
    default:
      return copy.sort((a, b) => b.margin - a.margin);
  }
}
function demandKey(o) {
  if (o.demandScore !== null && o.demandScore !== void 0 && o.demandScore > 0) {
    return 2e6 + o.demandScore;
  }
  if (o.margin > 0) {
    return (o.demandScore === null || o.demandScore === void 0 ? 1e6 : 0) + o.margin;
  }
  return -1e6 + o.margin;
}
function discount(opportunity) {
  const avg = opportunity.normalAvgPrice;
  if (avg === null || avg <= 0) return 0;
  return (avg - opportunity.normalPrice) / avg;
}

// src/server/service-singleton.ts
var serviceInstance = null;
var syncInProgress = false;
var lastSync = 0;
var syncStateInstance = {
  lastSyncedAt: Date.now(),
  nextSyncAt: Date.now() + 5 * 6e4,
  isSyncing: false
};
function getService() {
  if (serviceInstance) return serviceInstance;
  let dbPath = ":memory:";
  try {
    const tmpDir = process.env.TMPDIR || process.env.TEMP || "/tmp";
    const tmpDb = join2(tmpDir, "starpets.sqlite");
    if (!existsSync2(tmpDb)) {
      const seedCandidates = [
        join2(process.cwd(), "data", "starpets.sqlite"),
        join2(process.cwd(), "starpets.sqlite")
      ];
      for (const seed of seedCandidates) {
        if (existsSync2(seed)) {
          try {
            copyFileSync(seed, tmpDb);
            break;
          } catch {
          }
        }
      }
    }
    dbPath = existsSync2(tmpDb) ? tmpDb : ":memory:";
  } catch {
    dbPath = ":memory:";
  }
  const config = loadConfig();
  const store = new Store(dbPath);
  const api = new MarketApi({
    baseUrl: config.storeBaseUrl,
    currency: config.currency,
    concurrency: config.concurrency,
    minIntervalMs: config.minIntervalMs,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries
  });
  serviceInstance = new ScannerService(store, api, config);
  return serviceInstance;
}
function triggerBackgroundSyncIfNeeded(service, log = console.log) {
  const now = Date.now();
  if (!syncInProgress && (now - lastSync > 10 * 6e4 || service.isStale())) {
    syncInProgress = true;
    lastSync = now;
    service.syncPopularPets({ pages: 1, verifyDepth: false }).then(() => {
      syncStateInstance.lastSyncedAt = Date.now();
      syncStateInstance.nextSyncAt = Date.now() + 5 * 6e4;
      log("[auto-sync] Completed non-blocking background refresh");
    }).catch((err) => {
      log(`[auto-sync] warning: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      syncInProgress = false;
    });
  }
}

// src/server/http.ts
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";

// src/server/dashboard.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
var cachedLogoDataUri = "";
function getLogoDataUri() {
  if (cachedLogoDataUri) return cachedLogoDataUri;
  const candidates = [
    join3(process.cwd(), "assets", "logo.jpg"),
    join3(process.cwd(), "public", "logo.jpg"),
    join3(process.cwd(), "android", "app", "src", "main", "res", "drawable", "app_logo.png")
  ];
  for (const p of candidates) {
    try {
      if (existsSync3(p)) {
        const mime = p.endsWith(".png") ? "image/png" : "image/jpeg";
        cachedLogoDataUri = `data:${mime};base64,` + readFileSync2(p).toString("base64");
        return cachedLogoDataUri;
      }
    } catch {
    }
  }
  return "/logo.jpg";
}
function dashboardHtml(options = {}) {
  const logoSrc = getLogoDataUri();
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>Pet Pricer \u2014 StarPets Valuation & Craft Arbitrage Scanner</title>
<link rel="icon" href="${logoSrc}" />
<style>
:root {
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  
  /* Light Brown & White Coffee Theme: Latte, Mocha, Cappuccino, Caramel, Cream */
  --bg-gradient: radial-gradient(at 0% 0%, #ecd9c6 0px, transparent 50%),
                 radial-gradient(at 100% 0%, #e2cdb7 0px, transparent 50%),
                 radial-gradient(at 50% 30%, #f7ece1 0px, transparent 60%),
                 radial-gradient(at 100% 100%, #dfc4ab 0px, transparent 50%),
                 radial-gradient(at 0% 100%, #ebd7c3 0px, transparent 50%),
                 #f8f3eb;
                 
  --bg-header: linear-gradient(135deg, #fbf7f2 0%, #efe2d4 50%, #f8eee4 100%);
  --bg-card: linear-gradient(145deg, #fdfaf6 0%, #f4eade 100%);
  --bg-section: linear-gradient(180deg, #fcf9f5 0%, #f2e6d6 100%);
  --bg-form: linear-gradient(135deg, #faf4ec 0%, #eee0cf 100%);
  --bg-table-card: linear-gradient(180deg, #fdfbf8 0%, #f5ece1 100%);
  --bg-table-head: linear-gradient(180deg, #ebdccb 0%, #dfcbba 100%);
  --bg-pie-card: linear-gradient(145deg, #fdf8f3 0%, #f3e5d5 50%, #eae0ce 100%);
  --bg-alert: linear-gradient(135deg, #fdf5ea 0%, #fae5cb 50%, #fbf2e5 100%);
  --bg-drawer: linear-gradient(180deg, #fdf9f4 0%, #f1e4d4 100%);
  
  /* Borders & Shadows */
  --border: #d8c5b2;
  --border-bold: #b89f88;
  --border-subtle: #ebdcd0;
  --shadow-sm: 0 2px 6px rgba(43, 24, 16, 0.05);
  --shadow-md: 0 4px 14px rgba(43, 24, 16, 0.08);
  --shadow-lg: 0 12px 28px -5px rgba(43, 24, 16, 0.14);
  
  /* Text: Dark Roast Espresso, Warm Cocoa, Almond */
  --text: #2b1810;
  --text-muted: #5a3e2b;
  --text-light: #7c6352;
  
  /* Profit, Loss, Status */
  --profit: #047857;
  --profit-bg: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
  --profit-border: #86efac;
  
  --loss: #b91c1c;
  --loss-bg: linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%);
  --loss-border: #fca5a5;
  
  --primary: #7c3aed;
  --primary-bg: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%);
  --primary-border: #c4b5fd;
  
  --warn: #b45309;
  --warn-bg: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
  --warn-border: #fcd34d;
  
  --hot: #c2410c;
  --hot-bg: linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%);
  --hot-border: #fdba74;
}

[data-theme="dark"] {
  --bg-gradient: radial-gradient(at 0% 0%, rgba(94, 60, 36, 0.45) 0px, transparent 50%),
                 radial-gradient(at 100% 0%, rgba(120, 75, 45, 0.4) 0px, transparent 50%),
                 radial-gradient(at 50% 50%, rgba(70, 42, 25, 0.3) 0px, transparent 60%),
                 radial-gradient(at 100% 100%, rgba(90, 55, 33, 0.4) 0px, transparent 50%),
                 #17100b;
                 
  --bg-header: linear-gradient(135deg, #261910 0%, #1e130c 100%);
  --bg-card: linear-gradient(145deg, #271a11 0%, #1c120a 100%);
  --bg-section: linear-gradient(180deg, #241810 0%, #191009 100%);
  --bg-form: linear-gradient(135deg, #261910 0%, #1c120a 100%);
  --bg-table-card: linear-gradient(180deg, #241810 0%, #1a110a 100%);
  --bg-table-head: linear-gradient(180deg, #322116 0%, #251810 100%);
  --bg-pie-card: linear-gradient(145deg, #281b12 0%, #1c120a 100%);
  --bg-alert: linear-gradient(135deg, #2c1d12 0%, #1e130c 100%);
  --bg-drawer: linear-gradient(180deg, #261910 0%, #180f08 100%);
  
  --border: #4d3522;
  --border-bold: #6b4b32;
  --border-subtle: #3a2719;
  
  --text: #f7eee4;
  --text-muted: #d9c4b2;
  --text-light: #ab9582;
  
  --profit: #34d399;
  --profit-bg: linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(16, 185, 129, 0.12) 100%);
  --profit-border: rgba(52, 211, 153, 0.5);
  
  --loss: #f87171;
  --loss-bg: linear-gradient(135deg, rgba(239, 68, 68, 0.25) 0%, rgba(239, 68, 68, 0.12) 100%);
  --loss-border: rgba(248, 113, 113, 0.5);
  
  --primary: #a78bfa;
  --primary-bg: linear-gradient(135deg, rgba(167, 139, 250, 0.25) 0%, rgba(167, 139, 250, 0.12) 100%);
  --primary-border: rgba(167, 139, 250, 0.5);
  
  --warn: #fbbf24;
  --warn-bg: linear-gradient(135deg, rgba(251, 191, 36, 0.25) 0%, rgba(251, 191, 36, 0.12) 100%);
  --warn-border: rgba(251, 191, 36, 0.5);
  
  --hot: #fb923c;
  --hot-bg: linear-gradient(135deg, rgba(251, 146, 60, 0.25) 0%, rgba(251, 146, 60, 0.12) 100%);
  --hot-border: rgba(251, 146, 60, 0.5);
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-family: var(--font) !important;
}

body {
  background: var(--bg-gradient);
  background-attachment: fixed;
  color: var(--text);
  font-size: 14px;
  line-height: 1.45;
  padding-bottom: 90px;
  min-height: 100vh;
  overflow-x: hidden;
}

.container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 16px 20px;
}

/* ---------- Header & Desktop Navbar ---------- */
.header {
  background: var(--bg-header);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 2px solid var(--border);
  padding: 12px 0;
  margin-bottom: 16px;
  position: sticky;
  top: 0;
  z-index: 40;
  box-shadow: var(--shadow-md);
}
.header-wrap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.brand-group {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  user-select: none;
}
.brand-logo-wrap {
  position: relative;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
}
.brand-logo-img {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 2px solid #fbbf24;
  box-shadow: 0 4px 12px rgba(43, 24, 16, 0.25);
  object-fit: cover;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  background: #0d1326;
  display: block;
}
.brand-group:hover .brand-logo-img {
  transform: scale(1.08) rotate(3deg);
}
.brand-badge-dot {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #10b981;
  border: 2px solid #fff;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.8);
}
.brand-title {
  font-size: 19px;
  font-weight: 900;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.brand-tag {
  font-size: 10px;
  font-weight: 800;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--profit-bg);
  color: var(--profit);
  border: 1.5px solid var(--profit-border);
  text-transform: uppercase;
}
.brand-sub {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* ---------- Desktop Navigation Tabs Bar ---------- */
.desktop-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-card);
  padding: 6px 12px;
  border-radius: 10px;
  border: 1.5px solid var(--border);
  box-shadow: var(--shadow-sm);
}
.nav-btn {
  background: none;
  border: none;
  font-size: 13px;
  font-weight: 800;
  padding: 8px 14px;
  border-radius: 8px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.nav-btn:hover {
  background: rgba(66, 38, 23, 0.06);
  color: var(--text);
}
.nav-btn.active {
  background: linear-gradient(135deg, #422617 0%, #2b1810 100%);
  color: #fff;
  box-shadow: 0 3px 8px rgba(43, 24, 16, 0.25);
}
[data-theme="dark"] .nav-btn.active {
  background: linear-gradient(135deg, #8c5328 0%, #633919 100%);
}

/* ---------- Android Mobile Bottom Navigation Bar ---------- */
.mobile-bottom-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 64px;
  background: var(--bg-header);
  border-top: 2px solid var(--border);
  box-shadow: 0 -4px 16px rgba(43, 24, 16, 0.12);
  z-index: 45;
  padding: 0 6px;
  justify-content: space-around;
  align-items: center;
}
.mobile-nav-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 800;
  height: 100%;
  cursor: pointer;
  transition: color 0.15s ease;
  padding: 4px 2px;
}
.mobile-nav-icon {
  font-size: 18px;
  line-height: 1;
}
.mobile-nav-item.active {
  color: #633919;
  font-weight: 900;
}
[data-theme="dark"] .mobile-nav-item.active {
  color: #fb923c;
}
.mobile-nav-item.active .mobile-nav-icon {
  transform: scale(1.15);
  transition: transform 0.15s ease;
}

/* ---------- App Screen Container Views ---------- */
.app-screen {
  display: none;
  animation: fadeIn 0.2s ease;
}
.app-screen.active {
  display: block;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ---------- Live Sync Pill ---------- */
.live-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 20px;
  background: var(--bg-card);
  border: 2px solid var(--border);
  font-size: 12px;
  font-weight: 800;
  box-shadow: var(--shadow-sm);
  color: var(--text);
}
.pulse-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
  70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

/* ---------- Buttons ---------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 800;
  padding: 9px 16px;
  min-height: 44px;
  border-radius: 8px;
  border: 2px solid var(--border-bold);
  background: var(--bg-card);
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.btn:hover {
  filter: brightness(1.05);
  border-color: var(--text);
}
.btn-primary {
  background: linear-gradient(135deg, #633919 0%, #432510 100%);
  color: #fff;
  border-color: #3b1f0c;
  box-shadow: 0 4px 10px rgba(67, 37, 16, 0.25);
}
[data-theme="dark"] .btn-primary {
  background: linear-gradient(135deg, #8c5328 0%, #633919 100%);
  border-color: #8c5328;
}
.btn-success {
  background: linear-gradient(135deg, #059669 0%, #047857 100%);
  color: #fff;
  border-color: #047857;
  box-shadow: 0 4px 10px rgba(4, 120, 87, 0.25);
}
.btn-sm {
  min-height: 36px;
  padding: 6px 12px;
  font-size: 12px;
}

/* ---------- Toast Notification Banner ---------- */
.toast-alert {
  position: fixed;
  bottom: 80px;
  right: 20px;
  z-index: 100;
  max-width: 420px;
  width: calc(100% - 40px);
  background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);
  border: 2px solid #ef4444;
  border-radius: 12px;
  padding: 14px 16px;
  box-shadow: 0 10px 30px rgba(239, 68, 68, 0.28);
  display: flex;
  align-items: flex-start;
  gap: 12px;
  transform: translateY(180%);
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.toast-alert.show {
  transform: translateY(0);
}
.toast-icon { font-size: 24px; line-height: 1; }
.toast-content { flex: 1; }
.toast-title { font-size: 14px; font-weight: 900; color: #991b1b; margin-bottom: 2px; }
.toast-msg { font-size: 12px; font-weight: 700; color: #7f1d1d; margin-bottom: 8px; }
.toast-close { background: none; border: none; font-size: 16px; font-weight: 900; color: #991b1b; cursor: pointer; }

/* ---------- KPI Metrics Cards ---------- */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}
.kpi-card {
  border-radius: 12px;
  padding: 16px 18px;
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kpi-card.profit { background: linear-gradient(135deg, #f2faf5 0%, #dcf1e5 100%); border: 2px solid #9eddb8; }
.kpi-card.demand { background: linear-gradient(135deg, #fdf6ec 0%, #f9e2c6 100%); border: 2px solid #e3be96; }
.kpi-card.breakeven { background: linear-gradient(135deg, #fdf5ef 0%, #f2dcce 100%); border: 2px solid #ddbfa1; }
.kpi-card.sync { background: linear-gradient(135deg, #fbf4eb 0%, #ebd7c2 100%); border: 2px solid #d6be9f; }
[data-theme="dark"] .kpi-card.profit { background: linear-gradient(135deg, rgba(5, 150, 105, 0.25) 0%, rgba(4, 120, 87, 0.15) 100%); border: 2px solid rgba(52, 211, 153, 0.4); }
[data-theme="dark"] .kpi-card.demand { background: linear-gradient(135deg, rgba(217, 119, 6, 0.25) 0%, rgba(180, 83, 9, 0.15) 100%); border: 2px solid rgba(251, 191, 36, 0.4); }
[data-theme="dark"] .kpi-card.breakeven { background: linear-gradient(135deg, rgba(168, 85, 247, 0.25) 0%, rgba(147, 51, 234, 0.15) 100%); border: 2px solid rgba(192, 132, 252, 0.4); }
[data-theme="dark"] .kpi-card.sync { background: linear-gradient(135deg, rgba(99, 102, 241, 0.25) 0%, rgba(79, 70, 229, 0.15) 100%); border: 2px solid rgba(165, 180, 252, 0.4); }
.kpi-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-light); }
.kpi-value { font-size: 24px; font-weight: 900; letter-spacing: -0.02em; color: var(--text); }
.kpi-value.profit { color: var(--profit); }
.kpi-sub { font-size: 12px; font-weight: 700; color: var(--text-muted); }

/* ---------- 3D VISUAL PIE & DONUT CHARTS ---------- */
.pie-section {
  background: var(--bg-pie-card);
  border: 2px solid var(--border-bold);
  border-radius: 14px;
  padding: 20px;
  margin-bottom: 24px;
  box-shadow: var(--shadow-sm);
}
.pie-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1.5px solid var(--border);
}
.pie-title {
  font-size: 16px;
  font-weight: 900;
  display: flex;
  align-items: center;
  gap: 8px;
}
.pie-sub { font-size: 12px; font-weight: 700; color: var(--text-muted); margin-top: 2px; }
.pie-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 20px;
}
.pie-card {
  background: var(--bg-card);
  border: 1.5px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  box-shadow: var(--shadow-sm);
}
.pie-card-title {
  font-size: 13px;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-muted);
  align-self: flex-start;
}

/* ---------- STRAIGHT, HIGH-CONTRAST DONUT & PIE CHARTS ---------- */
.donut-straight-stage {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  padding: 8px 0 16px 0;
}
.donut-straight-scene {
  position: relative;
  width: 240px;
  height: 240px;
  /* Straight upright orientation - clean, circular, and geometric */
  filter: drop-shadow(0 10px 22px rgba(43, 24, 16, 0.16));
}
.donut-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.donut-slice {
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), filter 0.22s ease;
  cursor: pointer;
  transform-origin: 120px 120px;
}
.donut-slice:hover {
  filter: brightness(1.15) drop-shadow(0 4px 12px rgba(43, 24, 16, 0.35));
  transform: scale(1.045);
}
.donut-center-pedestal {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 108px;
  height: 108px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #ffffff 0%, #faf3eb 55%, #ecdccb 100%);
  border: 2.5px solid var(--border-bold);
  box-shadow: 0 8px 22px rgba(67, 37, 16, 0.14), inset 0 2px 4px rgba(255, 255, 255, 0.95), inset 0 -2px 5px rgba(43, 24, 16, 0.08);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  pointer-events: none;
  transition: all 0.25s ease;
}
[data-theme="dark"] .donut-center-pedestal {
  background: radial-gradient(circle at 35% 35%, #3a261a 0%, #291b12 60%, #1c120a 100%);
  border-color: #8c5328;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.5), inset 0 1px 3px rgba(251, 146, 60, 0.3);
}
.pedestal-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  border: 1.5px solid var(--border-bold);
  box-shadow: 0 2px 6px rgba(0,0,0,0.14);
  margin-bottom: 2px;
}
.pedestal-val {
  font-size: 18px;
  font-weight: 900;
  color: var(--text);
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.pedestal-lbl {
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  color: var(--text-muted);
  max-width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Visual Legend with Pet Thumbnails and Relative Share Bars */
.pie-legend {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.legend-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  transition: all 0.15s ease;
}
.legend-item:hover {
  background: rgba(66, 38, 23, 0.08);
  border-color: var(--border-bold);
  transform: translateX(3px);
}
[data-theme="dark"] .legend-item {
  background: rgba(0, 0, 0, 0.25);
}
[data-theme="dark"] .legend-item:hover {
  background: rgba(255, 255, 255, 0.08);
}
.legend-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.legend-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.legend-avatar {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  object-fit: cover;
  background: #ecdccb;
  border: 1px solid var(--border);
}
.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.legend-name { font-weight: 800; color: var(--text); }
.legend-right { font-variant-numeric: tabular-nums; color: var(--text-muted); font-weight: 800; }
.legend-bar-track {
  width: 100%;
  height: 5px;
  background: rgba(43, 24, 16, 0.08);
  border-radius: 3px;
  overflow: hidden;
}
[data-theme="dark"] .legend-bar-track {
  background: rgba(255, 255, 255, 0.1);
}
.legend-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.6s ease;
}

/* ---------- 3D INTRO SPLASH SCREEN OVERLAY ---------- */
.intro-splash-overlay {
  position: fixed;
  inset: 0;
  z-index: 999999;
  background: radial-gradient(circle at 50% 40%, #2b170e 0%, #190e08 60%, #0b0503 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  transition: opacity 0.55s cubic-bezier(0.16, 1, 0.3, 1), transform 0.55s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}
.intro-splash-overlay.hidden {
  opacity: 0;
  transform: scale(1.06);
  pointer-events: none;
}
.intro-backdrop-light {
  position: absolute;
  width: 550px;
  height: 550px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(217, 119, 6, 0.25) 0%, rgba(245, 158, 11, 0.08) 45%, transparent 70%);
  filter: blur(40px);
  animation: pulseBackdropLight 4s ease-in-out infinite alternate;
  pointer-events: none;
}
@keyframes pulseBackdropLight {
  0% { transform: scale(0.85); opacity: 0.7; }
  100% { transform: scale(1.15); opacity: 1; }
}
.intro-3d-stage {
  perspective: 1000px;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 440px;
  width: calc(100% - 40px);
  z-index: 2;
}
.intro-logo-3d-wrapper {
  position: relative;
  width: 140px;
  height: 140px;
  margin-bottom: 22px;
  transform-style: preserve-3d;
}
.intro-logo-3d-card {
  width: 140px;
  height: 140px;
  border-radius: 50%;
  position: relative;
  transform-style: preserve-3d;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.7), 0 0 40px rgba(245, 158, 11, 0.45);
  border: 3.5px solid #fbbf24;
  overflow: hidden;
  /* 3D Turning-Up Entrance Animation */
  animation: logo3DTurnUp 1.6s cubic-bezier(0.16, 1, 0.3, 1) forwards,
             logo3DFloat 3.5s ease-in-out 1.6s infinite alternate;
}
@keyframes logo3DTurnUp {
  0% {
    transform: perspective(900px) rotateX(80deg) rotateY(-40deg) rotateZ(20deg) translateZ(-160px) scale(0.3);
    opacity: 0;
    filter: blur(8px) brightness(2);
  }
  50% {
    transform: perspective(900px) rotateX(-15deg) rotateY(15deg) rotateZ(-5deg) translateZ(40px) scale(1.06);
    opacity: 1;
    filter: blur(0px) brightness(1.3);
  }
  75% {
    transform: perspective(900px) rotateX(6deg) rotateY(-6deg) rotateZ(2deg) translateZ(10px) scale(0.98);
    filter: brightness(1.1);
  }
  100% {
    transform: perspective(900px) rotateX(0deg) rotateY(0deg) rotateZ(0deg) translateZ(0) scale(1);
    opacity: 1;
    filter: brightness(1);
  }
}
@keyframes logo3DFloat {
  0% { transform: translateY(0) rotateX(0deg) rotateY(0deg); }
  100% { transform: translateY(-8px) rotateX(4deg) rotateY(-4deg); }
}
.intro-logo-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.intro-logo-sheen {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, transparent 20%, rgba(255, 255, 255, 0.45) 50%, transparent 80%);
  transform: translateX(-150%) rotate(30deg);
  animation: sheenSweep 2.2s ease-in-out infinite;
  pointer-events: none;
}
@keyframes sheenSweep {
  0%, 20% { transform: translateX(-150%) rotate(30deg); }
  60%, 100% { transform: translateX(250%) rotate(30deg); }
}
.intro-glow-pedestal {
  position: absolute;
  bottom: -20px;
  left: 50%;
  transform: translateX(-50%) rotateX(75deg);
  width: 180px;
  height: 80px;
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(245, 158, 11, 0.65) 0%, rgba(217, 119, 6, 0.25) 50%, transparent 80%);
  filter: blur(10px);
  animation: pulsePedestalRing 2.2s ease-in-out infinite alternate;
  pointer-events: none;
}
@keyframes pulsePedestalRing {
  0% { transform: translateX(-50%) rotateX(75deg) scale(0.85); opacity: 0.6; }
  100% { transform: translateX(-50%) rotateX(75deg) scale(1.15); opacity: 1; }
}
.intro-title {
  font-size: 34px;
  font-weight: 900;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  background: linear-gradient(135deg, #ffffff 0%, #fef3c7 35%, #fbbf24 70%, #d97706 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-bottom: 6px;
  filter: drop-shadow(0 4px 16px rgba(245, 158, 11, 0.4));
}
.intro-subtitle {
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #dfc4ab;
  margin-bottom: 24px;
}
.intro-progress-box {
  width: 100%;
  max-width: 300px;
  margin-bottom: 20px;
}
.intro-progress-bar {
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.14);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.intro-progress-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, #f59e0b 0%, #fbbf24 50%, #34d399 100%);
  border-radius: 3px;
  box-shadow: 0 0 12px rgba(245, 158, 11, 0.7);
  transition: width 0.15s ease-out;
}
.intro-status-text {
  font-size: 11px;
  font-weight: 700;
  color: #b89f88;
  letter-spacing: 0.03em;
}
.intro-enter-btn {
  background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
  color: #fff;
  border: 2px solid #fbbf24;
  border-radius: 30px;
  padding: 10px 24px;
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 0.04em;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(180, 83, 9, 0.4);
  transition: all 0.2s ease;
}
.intro-enter-btn:hover {
  transform: translateY(-2px) scale(1.04);
  box-shadow: 0 12px 26px rgba(180, 83, 9, 0.6);
}

/* ---------- Quick Highlights on Home Screen ---------- */
.home-quick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.quick-card {
  background: var(--bg-card);
  border: 2px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: var(--shadow-sm);
}
.quick-card:hover {
  transform: translateY(-2px);
  border-color: #633919;
  box-shadow: var(--shadow-md);
}

/* ---------- Target Price Alert Window ---------- */
.alert-section {
  background: var(--bg-alert);
  border: 2px solid var(--border-bold);
  border-radius: 14px;
  padding: 20px;
  margin-bottom: 24px;
  box-shadow: var(--shadow-sm);
}
.alert-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1.5px solid var(--border);
}
.alert-title { font-size: 16px; font-weight: 900; display: flex; align-items: center; gap: 8px; }
.alert-form-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.alert-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}
.alert-card {
  background: var(--bg-card);
  border: 1.5px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  box-shadow: var(--shadow-sm);
  transition: all 0.2s ease;
}
.alert-card.triggered {
  background: var(--profit-bg);
  border-color: var(--profit-border);
  box-shadow: 0 4px 14px rgba(4, 120, 87, 0.15);
}
.alert-pet-info { display: flex; align-items: center; gap: 10px; }
.alert-avatar { width: 36px; height: 36px; border-radius: 6px; border: 1px solid var(--border); background: #ecdccb; object-fit: contain; }
.alert-del-btn { background: none; border: none; color: var(--loss); font-size: 16px; cursor: pointer; padding: 4px 8px; font-weight: 900; }

/* ---------- Filters Bar ---------- */
.form-card {
  background: var(--bg-form);
  border: 2px solid var(--border-bold);
  border-radius: 14px;
  padding: 18px 20px;
  margin-bottom: 20px;
  box-shadow: var(--shadow-sm);
}
.form-title { font-size: 14px; font-weight: 900; margin-bottom: 12px; color: var(--text); display: flex; align-items: center; gap: 8px; }
.form-row { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.form-group { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 140px; }
.form-group.grow-2 { flex: 2; min-width: 200px; }
.form-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); }
.form-control {
  font-size: 13px;
  font-weight: 700;
  padding: 10px 14px;
  border-radius: 8px;
  border: 2px solid var(--border);
  background: var(--bg-card);
  color: var(--text);
  outline: none;
  min-height: 44px;
  transition: border-color 0.15s ease;
}
.form-control:focus { border-color: #633919; }
[data-theme="dark"] .form-control:focus { border-color: #a78bfa; }

/* ---------- Badges & Tags ---------- */
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 800;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1.5px solid var(--border);
  background: var(--bg-card);
  color: var(--text);
  white-space: nowrap;
  flex-shrink: 0;
}
.tag-profit { background: var(--profit-bg); border-color: var(--profit-border); color: var(--profit); }
.tag-loss { background: var(--loss-bg); border-color: var(--loss-border); color: var(--loss); }
.tag-hot { background: var(--hot-bg); border-color: var(--hot-border); color: var(--hot); }
.tag-primary { background: var(--primary-bg); border-color: var(--primary-border); color: var(--primary); }
.tag-legendary { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-color: #f59e0b; color: #78350f; font-weight: 900; }
.tag-ultra-rare { background: linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 100%); border-color: #c084fc; color: #581c87; font-weight: 900; }
.tag-rare { background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); border-color: #38bdf8; color: #0369a1; font-weight: 900; }
.tag-uncommon { background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%); border-color: #34d399; color: #065f46; font-weight: 900; }
.tag-common { background: #f1f5f9; border-color: #cbd5e1; color: #475569; font-weight: 900; }

/* ---------- Table View & Clean Bold Pricing ---------- */
.table-card {
  background: var(--bg-table-card);
  border: 2px solid var(--border-bold);
  border-radius: 14px;
  overflow: hidden;
  margin-bottom: 24px;
  box-shadow: var(--shadow-md);
}
.table-responsive {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.table-card table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  min-width: 900px;
}
thead th {
  background: var(--bg-table-head);
  padding: 14px 16px;
  font-size: 12px;
  font-weight: 900;
  text-transform: uppercase;
  color: var(--text);
  border-bottom: 2px solid var(--border-bold);
  letter-spacing: 0.03em;
  white-space: nowrap;
}
tbody tr {
  border-bottom: 1.5px solid var(--border);
  transition: background 0.1s ease;
  cursor: pointer;
}
tbody tr:hover { background: rgba(66, 38, 23, 0.04); }
[data-theme="dark"] tbody tr:hover { background: rgba(255, 255, 255, 0.03); }
tbody td { padding: 14px 16px; vertical-align: middle; }

/* Strict Single-Row Uniformity */
.pet-flex-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  flex-wrap: nowrap;
}
.pet-avatar {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  border: 1.5px solid var(--border);
  background: #ecdccb;
  object-fit: contain;
  flex-shrink: 0;
}
.pet-name-bold {
  font-size: 14px;
  font-weight: 900;
  letter-spacing: -0.01em;
  color: var(--text);
  flex-shrink: 0;
}
.num-cell {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bold-price {
  font-size: 15px;
  font-weight: 900;
  color: var(--text);
}

/* ---------- Cards View ---------- */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.bold-card {
  background: var(--bg-card);
  border: 2px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: all 0.2s ease;
  cursor: pointer;
}
.bold-card:hover {
  border-color: #633919;
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}
.bold-card.profit { border-color: var(--profit-border); }
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.card-math-box {
  background: var(--bg-form);
  border: 1.5px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.math-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.math-row.highlight {
  border-top: 1.5px solid var(--border);
  padding-top: 6px;
  margin-top: 4px;
  font-size: 14px;
  font-weight: 900;
}

/* ---------- Inspection Drawer (Android Optimized Window) ---------- */
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(43, 24, 16, 0.55);
  backdrop-filter: blur(4px);
  z-index: 50;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.drawer-overlay.open { opacity: 1; pointer-events: auto; }
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 540px;
  max-width: 100vw;
  box-sizing: border-box;
  overflow-x: hidden;
  background: var(--bg-drawer);
  border-left: 2px solid var(--border-bold);
  z-index: 51;
  transform: translateX(100%);
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  display: flex;
  flex-direction: column;
  box-shadow: -10px 0 30px rgba(43, 24, 16, 0.25);
}
.drawer.open { transform: translateX(0); }
.drawer-pull-bar { display: none; }
.drawer-header {
  padding: 16px 20px;
  border-bottom: 2px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-header);
}
.drawer-title { font-size: 16px; font-weight: 900; color: var(--text); }
.drawer-body {
  padding: 20px;
  overflow-y: auto;
  overflow-x: hidden;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  box-sizing: border-box;
}
.order-book-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  margin-top: 8px;
}
.order-book-table th {
  background: var(--bg-table-head);
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 900;
  border-bottom: 1.5px solid var(--border);
  text-align: left;
}
.order-book-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.order-book-table tr:last-child td { border-bottom: none; }

/* ---------- Mobile & Android Layout Rules ---------- */
@media (max-width: 768px) {
  body { padding-bottom: 74px; }
  .container { padding: 12px; }
  .desktop-nav { display: none; }
  .mobile-bottom-nav { display: flex; }
  .header-actions .live-pill { display: none; }
  .pie-grid { grid-template-columns: 1fr; }
  .form-row { flex-direction: column; align-items: stretch; }
  .form-group { width: 100%; }
  .alert-form-row { flex-direction: column; align-items: stretch; }
  
  /* Mobile Android Bottom Sheet Modal (No horizontal scroll) */
  .drawer {
    top: auto;
    bottom: 0;
    left: 0;
    right: 0;
    width: 100%;
    max-height: 85vh;
    border-left: none;
    border-top: 3px solid #633919;
    border-radius: 20px 20px 0 0;
    transform: translateY(100%);
  }
  .drawer.open { transform: translateY(0); }
  .drawer-pull-bar {
    display: block;
    width: 48px;
    height: 5px;
    background: var(--border-bold);
    border-radius: 3px;
    margin: 8px auto 4px auto;
  }
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  font-weight: 800;
  color: var(--text-muted);
}
</style>
</head>
<body>

<!-- 3D Intro Splash Animation Screen -->
<div id="introSplash" class="intro-splash-overlay" onclick="dismissSplashIntro()">
  <div class="intro-backdrop-light"></div>
  <div class="intro-3d-stage">
    <div class="intro-logo-3d-wrapper">
      <div class="intro-glow-pedestal"></div>
      <div class="intro-logo-3d-card" id="introLogoCard">
        <img src="${logoSrc}" alt="Pet Pricer" class="intro-logo-img" />
        <div class="intro-logo-sheen"></div>
      </div>
    </div>
    <div class="intro-title">PET PRICER</div>
    <div class="intro-subtitle">Adopt Me &bull; StarPets Real-Time Valuation Engine</div>
    <div class="intro-progress-box">
      <div class="intro-progress-bar">
        <div class="intro-progress-fill" id="introProgressFill"></div>
      </div>
      <div class="intro-status-text" id="introStatusText">Initializing 3D Valuation Engine...</div>
    </div>
    <button type="button" class="intro-enter-btn" id="introEnterBtn" onclick="event.stopPropagation(); dismissSplashIntro()">
      Enter Dashboard \u2197
    </button>
  </div>
</div>
<script>
  window.dismissSplashIntro = function() {
    var s = document.getElementById('introSplash');
    if (s) {
      s.classList.add('hidden');
      setTimeout(function() { s.style.display = 'none'; }, 400);
    }
  };
  setTimeout(window.dismissSplashIntro, 1800);
</script>

<header class="header">
  <div class="container header-wrap">
    <div class="brand-group" onclick="replaySplashIntro()" title="Click to replay Pet Pricer 3D intro">
      <div class="brand-logo-wrap">
        <img class="brand-logo-img" src="${logoSrc}" alt="Pet Pricer Logo" />
        <span class="brand-badge-dot" title="System Connected"></span>
      </div>
      <div>
        <div class="brand-title">
          Pet Pricer
          <span class="brand-tag">StarPets Intelligence</span>
        </div>
        <div class="brand-sub">Adopt Me Real-Time Craft Arbitrage &bull; Buyable Depth &bull; Velocity Intelligence</div>
      </div>
    </div>

    <!-- Desktop Screen Navigation Tabs -->
    <nav class="desktop-nav" id="desktopNav">
      <button class="nav-btn active" data-screen="home" type="button">\u{1F3E0} Home</button>
      <button class="nav-btn" data-screen="demand" type="button">\u{1F525} In-Demand</button>
      <button class="nav-btn" data-screen="profitable" type="button">\u{1F48E} Profitable</button>
      <button class="nav-btn" data-screen="catalog" type="button">\u{1F4CB} Full Market</button>
      <button class="nav-btn" data-screen="alerts" type="button">\u{1F3AF} Alerts</button>
    </nav>

    <div class="header-actions">
      <div class="live-pill">
        <span class="pulse-dot"></span>
        <span>Auto-Sync in <strong id="countdownTimer">04:59</strong></span>
      </div>
      <button class="btn btn-primary" id="syncPopularBtn" type="button">
        \u26A1 Sync Live
      </button>
      <button class="btn" id="themeToggleBtn" type="button">
        \u{1F313} Theme
      </button>
      <a class="btn btn-success" href="/PetPricer.apk" download style="text-decoration:none; display:inline-flex; align-items:center; gap:6px;">
        \u{1F4F2} Download APK
      </a>
    </div>
  </div>
</header>

<main class="container">

  <!-- ================= SCREEN 1: HOME DASHBOARD ================= -->
  <div class="app-screen active" id="screenHome">
    <!-- Executive KPI Cards -->
    <section class="kpi-grid">
      <div class="kpi-card profit" onclick="switchScreen('profitable')">
        <div class="kpi-label">Active Profitable Crafts</div>
        <div class="kpi-value profit" id="kpiProfitableCount">--</div>
        <div class="kpi-sub">Clears 25% StarPets seller fee \u2197</div>
      </div>
      <div class="kpi-card demand" onclick="switchScreen('demand')">
        <div class="kpi-label">#1 In-Demand Hot Pet</div>
        <div class="kpi-value" id="kpiTopDemandName">--</div>
        <div class="kpi-sub" id="kpiTopDemandSub">Verified 4-Stock Depth \u2197</div>
      </div>
      <div class="kpi-card breakeven">
        <div class="kpi-label">Required Break-Even Multiple</div>
        <div class="kpi-value" id="kpiBreakEven">5.33&times;</div>
        <div class="kpi-sub">4 normal inputs / 0.75 net return</div>
      </div>
      <div class="kpi-card sync">
        <div class="kpi-label">Real-Time Refresh Cycle</div>
        <div class="kpi-value" id="kpiSyncStatus">5m Auto</div>
        <div class="kpi-sub">Background Worker Active</div>
      </div>
    </section>

    <!-- Market Demand Volume & Rarity Bar Charts (Pie Charts Removed) -->
    <section class="pie-section">
      <div class="pie-header">
        <div>
          <div class="pie-title">\u{1F4CA} Market Demand Intelligence & Volume Breakdown</div>
          <div class="pie-sub">Weekly trading volume distribution and rarity share across Adopt Me pets on StarPets</div>
        </div>
        <div class="tag tag-hot" id="totalMarketVolumeBadge">Loading Volume...</div>
      </div>
      <div class="pie-grid">
        <!-- Bar Chart Card 1: Top Demanding Pets -->
        <div class="pie-card" style="align-items: stretch;">
          <div class="pie-card-title">\u{1F525} Top Traded Pets (Weekly Volume Share)</div>
          <div class="pie-legend" id="topPetsLegend" style="width: 100%;"></div>
        </div>
        <!-- Bar Chart Card 2: Rarity Demand Distribution -->
        <div class="pie-card" style="align-items: stretch;">
          <div class="pie-card-title">\u2B50 Demand Share by Rarity Tier</div>
          <div class="pie-legend" id="rarityLegend" style="width: 100%;"></div>
        </div>
      </div>
    </section>

    <!-- Quick Navigation Callouts -->
    <div class="home-quick-grid">
      <div class="quick-card" onclick="switchScreen('demand')">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:15px; font-weight:900;">\u{1F525} View Top In-Demand Pets</div>
          <span class="tag tag-hot">High Velocity</span>
        </div>
        <div style="font-size:12px; color:var(--text-muted); font-weight:700;">
          Explore Dragonfruit Fox, Dango Penguins, and all highest-traded Adopt Me pets on StarPets.
        </div>
        <button class="btn btn-sm btn-primary" type="button">Open In-Demand Screen \u2192</button>
      </div>
      <div class="quick-card" onclick="switchScreen('profitable')">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:15px; font-weight:900;">\u{1F48E} View Profitable Crafts</div>
          <span class="tag tag-profit">Positive ROI</span>
        </div>
        <div style="font-size:12px; color:var(--text-muted); font-weight:700;">
          Inspect crafts where Neon sale price after 25% StarPets seller fee exceeds 4x input cost.
        </div>
        <button class="btn btn-sm btn-success" type="button">Open Profitable Screen \u2192</button>
      </div>
    </div>

    <!-- Top Pets Table on Home Screen -->
    <section style="margin-top:24px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <div>
          <h3 style="font-size:18px; font-weight:900;">\u{1F525} Top Trending Pets & Live Craft Margins</h3>
          <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Real-time buy prices, 4-unit craft costs, neon sale values, and profit margins</div>
        </div>
        <button class="btn btn-sm btn-primary" type="button" onclick="switchScreen('catalog')">View All 210+ Pets \u2192</button>
      </div>
      <div id="homePetsContainer"></div>
    </section>
  </div>

  <!-- ================= SCREEN 2: IN-DEMAND PETS ================= -->
  <div class="app-screen" id="screenDemand">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
      <div>
        <h2 style="font-size:18px; font-weight:900;">\u{1F525} High-Demand & Popular Pets</h2>
        <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Pets sorted by weekly sales turnover and popularity rank on StarPets</div>
      </div>
      <div style="display:flex; gap:8px;">
        <select class="form-control" id="viewModeDemand" style="min-height:38px; padding:6px 12px;">
          <option value="table">Table View</option>
          <option value="cards">Cards View</option>
        </select>
      </div>
    </div>
    <div id="demandContentContainer"></div>
  </div>

  <!-- ================= SCREEN 3: PROFITABLE CRAFTS ================= -->
  <div class="app-screen" id="screenProfitable">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
      <div>
        <h2 style="font-size:18px; font-weight:900;">\u{1F48E} Profitable Craft Arbitrage</h2>
        <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Crafts clearing the 25% StarPets fee with verified 4-unit input depth</div>
      </div>
      <div style="display:flex; gap:8px;">
        <select class="form-control" id="viewModeProfitable" style="min-height:38px; padding:6px 12px;">
          <option value="table">Table View</option>
          <option value="cards">Cards View</option>
        </select>
      </div>
    </div>
    <div id="profitableContentContainer"></div>
  </div>

  <!-- ================= SCREEN 4: FULL MARKET CATALOG ================= -->
  <div class="app-screen" id="screenCatalog">
    <!-- Filter & Precision Parameters Bar -->
    <section class="form-card">
      <div class="form-title">\u{1F50D} Market Filter & Search</div>
      <div class="form-row">
        <div class="form-group grow-2">
          <label class="form-label" for="searchInput">Search Pets</label>
          <input class="form-control" type="text" id="searchInput" placeholder="Search pet name (Dragonfruit Fox, Chihuahua...)" />
        </div>
        <div class="form-group">
          <label class="form-label" for="raritySelect">Rarity Filter</label>
          <select class="form-control" id="raritySelect">
            <option value="all">All Rarities</option>
            <option value="legendary">Legendary</option>
            <option value="ultra_rare">Ultra Rare</option>
            <option value="rare">Rare</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="sortBySelect">Sort By</label>
          <select class="form-control" id="sortBySelect">
            <option value="demand">Sales Demand &bull; Turnover</option>
            <option value="margin">Net Profit ($)</option>
            <option value="roi">Return on Capital (ROI %)</option>
            <option value="cheap">Cheapest 4x Input ($)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="viewModeCatalog">View Mode</label>
          <select class="form-control" id="viewModeCatalog">
            <option value="table">Table View</option>
            <option value="cards">Cards View</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="feeInput">StarPets Fee (%)</label>
          <input class="form-control" type="number" id="feeInput" value="25" min="0" max="50" style="max-width: 90px;" />
        </div>
        <div class="form-group">
          <label class="form-label" for="capInput">Max Unit Cap ($)</label>
          <input class="form-control" type="number" id="capInput" value="5.00" step="0.5" style="max-width: 100px;" />
        </div>
      </div>
    </section>
    <div id="catalogContentContainer"></div>
  </div>

  <!-- ================= SCREEN 5: PRICE ALERTS ================= -->
  <div class="app-screen" id="screenAlerts">
    <section class="alert-section">
      <div class="alert-header">
        <div>
          <div class="alert-title">\u{1F3AF} Target Price Alerts & Push Notifications</div>
          <div style="font-size: 12px; font-weight: 700; color: var(--text-muted); margin-top: 2px;">
            Alert triggers whenever 4-buy price drops to or below your target price.
          </div>
        </div>
        <button class="btn btn-sm" id="notifyPermBtn" type="button">\u{1F514} Enable Browser Notifications</button>
      </div>
      <div class="alert-form-row">
        <div class="form-group grow-2">
          <label class="form-label" for="alertPetSelect">Select Pet to Watch</label>
          <select class="form-control" id="alertPetSelect">
            <option value="__all__">\u2B50 ANY PET IN CATALOG (Global Price Drop Alert)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="alertPriceInput">Target Max Price ($)</label>
          <input class="form-control" type="number" id="alertPriceInput" step="0.01" min="0.01" placeholder="e.g. 0.70" />
        </div>
        <button class="btn btn-success" id="addAlertBtn" type="button" style="min-height: 44px;">
          + Set Price Alert (\u2264 Price)
        </button>
      </div>
      <div id="alertsContainer" class="alert-grid">
        <!-- Active alerts render here -->
      </div>
    </section>
  </div>

</main>

<!-- Android Mobile Bottom Navigation Bar -->
<nav class="mobile-bottom-nav">
  <button class="mobile-nav-item active" data-screen="home" type="button">
    <span class="mobile-nav-icon">\u{1F3E0}</span>
    <span>Home</span>
  </button>
  <button class="mobile-nav-item" data-screen="demand" type="button">
    <span class="mobile-nav-icon">\u{1F525}</span>
    <span>In-Demand</span>
  </button>
  <button class="mobile-nav-item" data-screen="profitable" type="button">
    <span class="mobile-nav-icon">\u{1F48E}</span>
    <span>Profitable</span>
  </button>
  <button class="mobile-nav-item" data-screen="catalog" type="button">
    <span class="mobile-nav-icon">\u{1F4CB}</span>
    <span>Market</span>
  </button>
  <button class="mobile-nav-item" data-screen="alerts" type="button">
    <span class="mobile-nav-icon">\u{1F3AF}</span>
    <span>Alerts</span>
  </button>
</nav>

<!-- In-App Notification Toast Banner -->
<div class="toast-alert" id="toastAlert">
  <div class="toast-icon">\u{1F6A8}</div>
  <div class="toast-content">
    <div class="toast-title" id="toastTitle">Target Price Reached!</div>
    <div class="toast-msg" id="toastMsg">Pet is buyable below your target price.</div>
    <a id="toastLink" href="https://starpets.gg/adopt-me/shop" target="_blank" rel="noopener" class="btn btn-sm btn-primary" style="display:inline-block; text-decoration:none;">Open on StarPets \u2197</a>
  </div>
  <button class="toast-close" type="button" id="toastClose">\u2715</button>
</div>

<!-- Inspection Drawer (Android Optimized Bottom Sheet) -->
<div class="drawer-overlay" id="drawerOverlay"></div>
<div class="drawer" id="drawer">
  <div class="drawer-pull-bar"></div>
  <div class="drawer-header">
    <div class="drawer-title" id="drawerTitle">Inspecting Pet</div>
    <button class="btn btn-sm" id="drawerClose" type="button">\u2715 Close</button>
  </div>
  <div class="drawer-body" id="drawerBody"></div>
</div>

<script>
(function() {
  var state = {
    catalog: [],
    theme: localStorage.getItem('theme') || 'light',
    activeScreen: 'home',
    query: '',
    rarity: 'all',
    sort: 'demand',
    viewMode: window.innerWidth <= 768 ? 'cards' : (localStorage.getItem('view_mode') || 'table'),
    feePct: 0.25,
    cap: 5.0,
    secondsRemaining: 300,
    alerts: JSON.parse(localStorage.getItem('starpets_price_alerts') || '[]')
  };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(n) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
  }
  function pad(n, d) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return Number(n).toFixed(d || 2);
  }

  // Proper Rarity Formatting: Legendary, Ultra Rare (no underscores, capital U and R)
  function formatRarity(r) {
    if (!r) return 'Unknown';
    var s = String(r).toLowerCase().replace(/_/g, ' ').trim();
    if (s === 'ultra rare') return 'Ultra Rare';
    if (s === 'legendary') return 'Legendary';
    if (s === 'rare') return 'Rare';
    if (s === 'uncommon') return 'Uncommon';
    if (s === 'common') return 'Common';
    return s.split(' ').map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }

  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }
  applyTheme(state.theme);

  // Screen Switching Architecture
  window.switchScreen = function(screenId) {
    state.activeScreen = screenId;
    document.querySelectorAll('.app-screen').forEach(function(s) { s.classList.remove('active'); });
    var target = el('screen' + screenId.charAt(0).toUpperCase() + screenId.slice(1));
    if (target) target.classList.add('active');

    // Update Desktop Nav
    document.querySelectorAll('.desktop-nav .nav-btn').forEach(function(b) {
      if (b.getAttribute('data-screen') === screenId) b.classList.add('active');
      else b.classList.remove('active');
    });

    // Update Mobile Nav
    document.querySelectorAll('.mobile-bottom-nav .mobile-nav-item').forEach(function(b) {
      if (b.getAttribute('data-screen') === screenId) b.classList.add('active');
      else b.classList.remove('active');
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
    render();
  };

  document.querySelectorAll('[data-screen]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var scr = this.getAttribute('data-screen');
      if (scr) switchScreen(scr);
    });
  });

  // Synthesized Web Audio API Chime for Price Alerts
  function playAlertChime() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc1 = ctx.createOscillator();
      var osc2 = ctx.createOscillator();
      var gain = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.15); // A5
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start(ctx.currentTime);
      osc1.stop(ctx.currentTime + 0.15);
      osc2.start(ctx.currentTime + 0.15);
      osc2.stop(ctx.currentTime + 0.5);
    } catch (e) {}
  }

  function showInAppToast(petName, currentPrice, targetPrice, slug, normalId) {
    var toast = el('toastAlert');
    el('toastTitle').textContent = '\u{1F6A8} Price Alert: ' + petName;
    el('toastMsg').textContent = petName + ' 4-buy price dropped to $' + pad(currentPrice, 2) + ' (<= Target $' + pad(targetPrice, 2) + ')!';
    if (slug && normalId) {
      el('toastLink').href = 'https://starpets.gg/adopt-me/shop/pet/' + encodeURIComponent(slug) + '/' + normalId;
    } else {
      el('toastLink').href = 'https://starpets.gg/adopt-me/shop';
    }
    toast.classList.add('show');
    setTimeout(function() {
      toast.classList.remove('show');
    }, 8000);
  }

  el('toastClose').addEventListener('click', function() {
    el('toastAlert').classList.remove('show');
  });

  function triggerPushNotification(petName, currentPrice, targetPrice, slug, normalId) {
    playAlertChime();
    showInAppToast(petName, currentPrice, targetPrice, slug, normalId);
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('\u{1F6A8} Price Alert: ' + petName, {
        body: petName + ' buyable 4-price is now $' + currentPrice.toFixed(2) + ' (<= Target $' + targetPrice.toFixed(2) + ')! Available on StarPets.',
        icon: 'https://cdn.starpets.gg/favicon.ico'
      });
    }
  }

  // Live 5-Minute Countdown Timer & Server Poller
  function syncWithServerTimer() {
    fetch('/api/sync-status')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (typeof data.secondsRemaining === 'number') {
          state.secondsRemaining = data.secondsRemaining;
        }
      })
      .catch(function() {});
  }

  function startCountdown() {
    setInterval(function() {
      if (state.secondsRemaining > 0) {
        state.secondsRemaining--;
      } else {
        state.secondsRemaining = 300;
        fetchData(true);
        syncWithServerTimer();
      }
      var m = Math.floor(state.secondsRemaining / 60);
      var s = state.secondsRemaining % 60;
      var str = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      el('countdownTimer').textContent = str;
    }, 1000);
  }
  startCountdown();
  syncWithServerTimer();

  function fetchData(silent) {
    var rarities = state.rarity === 'all' ? 'rare,ultra_rare,legendary' : state.rarity;
    var url = '/api/catalog?rarity=' + encodeURIComponent(rarities) + '&fee=' + state.feePct + '&cap=' + state.cap;
    fetch(url)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        state.catalog = data.rows || data.pets || [];
        populateAlertSelect();
        evaluateAlerts();
        render3DCharts();
        render();
      })
      .catch(function(err) {
        if (!silent) {
          console.error('Failed to load market data:', err);
        }
      });
  }

  /* ---------- 3D INTRO SPLASH ANIMATION CONTROLLER ---------- */
  var splashTimer = null;
  window.dismissSplashIntro = function() {
    var splash = el('introSplash');
    if (!splash) return;
    if (splashTimer) clearTimeout(splashTimer);
    splash.classList.add('hidden');
    setTimeout(function() {
      splash.style.display = 'none';
    }, 600);
  };

  window.replaySplashIntro = function() {
    var splash = el('introSplash');
    if (!splash) return;
    splash.style.display = 'flex';
    splash.classList.remove('hidden');
    startSplashAnimation();
  };

  function startSplashAnimation() {
    var fill = el('introProgressFill');
    var status = el('introStatusText');
    var card = el('introLogoCard');
    if (!fill || !status) return;

    fill.style.width = '0%';
    if (card) {
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = 'logo3DTurnUp 1.6s cubic-bezier(0.16, 1, 0.3, 1) forwards, logo3DFloat 3.5s ease-in-out 1.6s infinite alternate';
    }

    var steps = [
      { pct: '30%', text: 'Powering up 3D valuation engine...', delay: 200 },
      { pct: '60%', text: 'Connecting to StarPets live order books...', delay: 700 },
      { pct: '88%', text: 'Calculating 4x craft arbitrage margins...', delay: 1300 },
      { pct: '100%', text: 'Welcome to Pet Pricer!', delay: 1850 },
    ];

    steps.forEach(function(s) {
      setTimeout(function() {
        fill.style.width = s.pct;
        status.textContent = s.text;
      }, s.delay);
    });

    splashTimer = setTimeout(function() {
      window.dismissSplashIntro();
    }, 2400);
  }

  // Auto-launch 3D splash intro on app start
  startSplashAnimation();

  /* ---------- MARKET DEMAND VOLUME & RARITY BAR CHARTS (PIE CHARTS REMOVED) ---------- */
  function render3DCharts() {
    if (!state.catalog || !state.catalog.length) return;

    var slicePalette = [
      { color: '#d97706', brightColor: '#fbbf24', darkColor: '#b45309' }, // Golden Caramel
      { color: '#059669', brightColor: '#34d399', darkColor: '#047857' }, // Mint Emerald
      { color: '#7c3aed', brightColor: '#a78bfa', darkColor: '#5b21b6' }, // Royal Purple
      { color: '#ea580c', brightColor: '#fb923c', darkColor: '#c2410c' }, // Warm Orange
      { color: '#0284c7', brightColor: '#38bdf8', darkColor: '#0369a1' }, // Sky Cyan
      { color: '#9333ea', brightColor: '#c084fc', darkColor: '#7e22ce' }  // Magenta Glow
    ];

    // 1. Top Traded Pets Volume Share
    var validPets = state.catalog.filter(function(p) { return (p.salesPerWeek || 0) > 0; })
      .sort(function(a, b) { return (b.salesPerWeek || 0) - (a.salesPerWeek || 0); });

    var topSlices = [];
    var totalVolume = 0;
    validPets.forEach(function(p) { totalVolume += p.salesPerWeek; });

    var mainTop = validPets.slice(0, 6);
    var mainSum = 0;
    mainTop.forEach(function(p, i) {
      mainSum += p.salesPerWeek;
      var pal = slicePalette[i % slicePalette.length];
      topSlices.push({
        name: p.name,
        slug: p.slug,
        imageUri: p.imageUri,
        rare: p.rare,
        value: p.salesPerWeek,
        color: pal.color,
      });
    });

    if (totalVolume > mainSum) {
      topSlices.push({
        name: 'Other Active Pets',
        slug: '',
        imageUri: null,
        rare: '',
        value: totalVolume - mainSum,
        color: '#78716c',
      });
    }

    var badge = el('totalMarketVolumeBadge');
    if (badge) {
      badge.textContent = '\u{1F525} Total Weekly Trades: ' + totalVolume.toLocaleString() + ' pets/wk';
    }

    // Top Pets Legend Bar Chart with Real Avatars and Share Progress Bars
    var legendEl = el('topPetsLegend');
    if (legendEl) {
      var legendHtml = '';
      topSlices.forEach(function(s) {
        var pct = totalVolume > 0 ? ((s.value / totalVolume) * 100).toFixed(1) : '0';
        var barPct = totalVolume > 0 ? Math.min(100, Math.round((s.value / totalVolume) * 100 * 2.2)) : 0;
        var rareTag = s.rare ? '<span class="tag" style="font-size:9px; padding:1px 5px;">' + esc(formatRarity(s.rare)) + '</span>' : '';
        legendHtml += '<div class="legend-item" style="cursor:pointer;" onclick="filterByPetName(\\'' + esc(s.slug) + '\\')">' +
          '<div class="legend-row-top">' +
            '<div class="legend-left">' +
              (s.imageUri ? '<img class="legend-avatar" src="' + esc(s.imageUri) + '" alt="" />' : '<span class="legend-dot" style="background:' + s.color + '"></span>') +
              '<span class="legend-name">' + esc(s.name) + '</span> ' + rareTag +
            '</div>' +
            '<div class="legend-right"><b>' + s.value.toLocaleString() + '</b> <span style="opacity:0.75;">(' + pct + '%)</span></div>' +
          '</div>' +
          '<div class="legend-bar-track"><div class="legend-bar-fill" style="width:' + barPct + '%; background:' + s.color + ';"></div></div>' +
        '</div>';
      });
      legendEl.innerHTML = legendHtml;
    }

    // 2. Rarity Demand Distribution
    var rarityCounts = { 'Legendary': 0, 'Ultra Rare': 0, 'Rare': 0, 'Uncommon': 0, 'Common': 0 };
    var totalRarityVol = 0;
    state.catalog.forEach(function(p) {
      var r = formatRarity(p.rare);
      var vol = p.salesPerWeek || 1;
      if (rarityCounts[r] !== undefined) rarityCounts[r] += vol;
      else rarityCounts[r] = vol;
      totalRarityVol += vol;
    });

    var rarityPalette = {
      'Legendary': { color: '#d97706' },
      'Ultra Rare': { color: '#7c3aed' },
      'Rare': { color: '#0284c7' },
      'Uncommon': { color: '#059669' },
      'Common': { color: '#64748b' }
    };

    var raritySlices = [];
    Object.keys(rarityCounts).forEach(function(k) {
      if (rarityCounts[k] > 0) {
        var pal = rarityPalette[k] || { color: '#8c5328' };
        raritySlices.push({
          name: k,
          value: rarityCounts[k],
          color: pal.color,
        });
      }
    });
    raritySlices.sort(function(a, b) { return b.value - a.value; });

    var rarityEl = el('rarityLegend');
    if (rarityEl) {
      var rarityLegendHtml = '';
      raritySlices.forEach(function(s) {
        var pct = totalRarityVol > 0 ? ((s.value / totalRarityVol) * 100).toFixed(1) : '0';
        var barPct = totalRarityVol > 0 ? Math.min(100, Math.round((s.value / totalRarityVol) * 100)) : 0;
        rarityLegendHtml += '<div class="legend-item" style="cursor:pointer;" onclick="filterByRarity(\\'' + esc(s.name) + '\\')">' +
          '<div class="legend-row-top">' +
            '<div class="legend-left">' +
              '<span class="legend-dot" style="background:' + s.color + '"></span>' +
              '<span class="legend-name">' + esc(s.name) + '</span>' +
            '</div>' +
            '<div class="legend-right"><b>' + s.value.toLocaleString() + '</b> <span style="opacity:0.75;">(' + pct + '%)</span></div>' +
          '</div>' +
          '<div class="legend-bar-track"><div class="legend-bar-fill" style="width:' + barPct + '%; background:' + s.color + ';"></div></div>' +
        '</div>';
      });
      rarityEl.innerHTML = rarityLegendHtml;
    }
  }

  window.filterByPetName = function(slug) {
    if (!slug) return;
    switchScreen('catalog');
    state.query = slug;
    el('searchInput').value = slug;
    render();
  };

  window.filterByRarity = function(rarity) {
    switchScreen('catalog');
    var mapped = rarity.toLowerCase().replace(/ /g, '_');
    state.rarity = mapped;
    el('raritySelect').value = mapped;
    fetchData(false);
  };

  /* ---------- Target Price Alert System ---------- */
  function populateAlertSelect() {
    var sel = el('alertPetSelect');
    var currentVal = sel.value;
    var uniquePets = [];
    var seen = {};
    state.catalog.forEach(function(p) {
      if (!seen[p.slug]) {
        seen[p.slug] = true;
        uniquePets.push(p);
      }
    });
    uniquePets.sort(function(a, b) { return a.name.localeCompare(b.name); });
    
    var html = '<option value="__all__">\u2B50 ANY PET IN CATALOG (Global Alert: triggers for any pet)</option>';
    uniquePets.forEach(function(p) {
      var price = p.inputDepth4xPrice || p.inputPrice || 0;
      html += '<option value="' + esc(p.slug) + '" data-name="' + esc(p.name) + '" data-price="' + price + '">' +
        esc(p.name) + ' ($' + pad(price, 2) + ')' +
        '</option>';
    });
    sel.innerHTML = html;
    if (currentVal) sel.value = currentVal;
  }

  function renderAlerts() {
    var cont = el('alertsContainer');
    if (!state.alerts.length) {
      cont.innerHTML = '<div style="grid-column: 1/-1; color: var(--text-light); font-size: 13px; font-weight: 700;">No active price alerts set. Select a pet above to watch for price drops!</div>';
      return;
    }
    var html = '';
    state.alerts.forEach(function(a, idx) {
      var isTriggered = a.triggered === true;
      var isGlobal = a.slug === '__all__';
      
      html += '<div class="alert-card ' + (isTriggered ? 'triggered' : '') + '">' +
        '<div class="alert-pet-info">' +
          (isGlobal
            ? '<div style="font-size:24px;width:36px;text-align:center;">\u2B50</div>'
            : (a.imageUri ? '<img class="alert-avatar" src="' + esc(a.imageUri) + '" alt="" />' : '')) +
          '<div>' +
            '<div style="font-weight:900; font-size:14px;">' + (isGlobal ? 'Any Pet in Catalog' : esc(a.name)) + '</div>' +
            '<div style="font-size:12px; font-weight:700; color:var(--text-muted);">' +
              'Target: <strong style="color:var(--text);">&le; $' + pad(a.targetPrice, 2) + '</strong> &bull; ' +
              (isGlobal
                ? (isTriggered ? 'Triggered on: <strong>' + esc(a.triggeredPetName) + ' ($' + pad(a.currentPrice, 2) + ')</strong>' : 'Monitoring all pets')
                : 'Live 4-Buy: <strong>$' + pad(a.currentPrice, 2) + '</strong>') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:8px;">' +
          (isTriggered
            ? '<span class="tag tag-profit" style="animation: pulse 1.5s infinite;">\u{1F6A8} BUY NOW (&le; $' + pad(a.targetPrice, 2) + ')</span>'
            : '<span class="tag tag-primary">Watching (&le; $' + pad(a.targetPrice, 2) + ')</span>') +
          '<button class="alert-del-btn" type="button" onclick="deleteAlert(' + idx + ')" title="Remove alert">\u2715</button>' +
        '</div>' +
      '</div>';
    });
    cont.innerHTML = html;
  }

  window.deleteAlert = function(idx) {
    state.alerts.splice(idx, 1);
    localStorage.setItem('starpets_price_alerts', JSON.stringify(state.alerts));
    renderAlerts();
  };

  function evaluateAlerts() {
    state.alerts.forEach(function(a) {
      if (a.slug === '__all__') {
        var triggeringPet = state.catalog.find(function(p) {
          var price = p.inputDepth4xPrice || p.inputPrice || 0;
          return price > 0 && price <= a.targetPrice;
        });
        if (triggeringPet) {
          var price = triggeringPet.inputDepth4xPrice || triggeringPet.inputPrice || 0;
          a.currentPrice = price;
          a.triggeredPetName = triggeringPet.name;
          if (!a.triggered) {
            a.triggered = true;
            triggerPushNotification(triggeringPet.name, price, a.targetPrice, triggeringPet.slug, triggeringPet.normalProductId);
          }
        } else {
          a.triggered = false;
        }
      } else {
        var match = state.catalog.find(function(p) { return p.slug === a.slug; });
        if (match) {
          var livePrice = match.inputDepth4xPrice || match.inputPrice || 0;
          a.currentPrice = livePrice;
          a.imageUri = match.imageUri || a.imageUri;
          if (livePrice > 0 && livePrice <= a.targetPrice) {
            if (!a.triggered) {
              a.triggered = true;
              triggerPushNotification(a.name, livePrice, a.targetPrice, match.slug, match.normalProductId);
            }
          } else {
            a.triggered = false;
          }
        }
      }
    });
    localStorage.setItem('starpets_price_alerts', JSON.stringify(state.alerts));
    renderAlerts();
  }

  el('addAlertBtn').addEventListener('click', function() {
    var sel = el('alertPetSelect');
    var priceInput = el('alertPriceInput');
    var slug = sel.value;
    var target = parseFloat(priceInput.value);
    if (!slug || isNaN(target) || target <= 0) {
      alert('Please select a pet and enter a valid target price greater than $0.');
      return;
    }

    var isGlobal = slug === '__all__';
    var pet = isGlobal ? null : state.catalog.find(function(p) { return p.slug === slug; });
    var name = isGlobal ? 'Any Pet in Catalog' : (pet ? pet.name : slug);
    var currentPrice = pet ? (pet.inputDepth4xPrice || pet.inputPrice || 0) : 0;
    var isTriggered = false;
    var triggeredPetName = '';
    var normalId = pet ? pet.normalProductId : null;

    if (isGlobal) {
      var triggeringPet = state.catalog.find(function(p) {
        var pPrice = p.inputDepth4xPrice || p.inputPrice || 0;
        return pPrice > 0 && pPrice <= target;
      });
      if (triggeringPet) {
        isTriggered = true;
        currentPrice = triggeringPet.inputDepth4xPrice || triggeringPet.inputPrice || 0;
        triggeredPetName = triggeringPet.name;
        normalId = triggeringPet.normalProductId;
      }
    } else {
      isTriggered = currentPrice > 0 && currentPrice <= target;
    }

    var newAlert = {
      slug: slug,
      name: name,
      imageUri: pet ? pet.imageUri : null,
      targetPrice: target,
      currentPrice: currentPrice,
      triggered: isTriggered,
      triggeredPetName: triggeredPetName
    };

    state.alerts.push(newAlert);
    localStorage.setItem('starpets_price_alerts', JSON.stringify(state.alerts));
    priceInput.value = '';
    renderAlerts();

    if (isTriggered) {
      triggerPushNotification(isGlobal ? triggeredPetName : name, currentPrice, target, slug, normalId);
    }

    if ('Notification' in window && Notification.permission !== 'granted') {
      Notification.requestPermission();
    }
  });

  el('notifyPermBtn').addEventListener('click', function() {
    if ('Notification' in window) {
      Notification.requestPermission().then(function(p) {
        if (p === 'granted') {
          el('notifyPermBtn').textContent = '\u2713 Notifications Enabled';
          el('notifyPermBtn').disabled = true;
        } else {
          alert('Notification permission was ' + p);
        }
      });
    } else {
      alert('Your browser does not support push notifications.');
    }
  });
  if ('Notification' in window && Notification.permission === 'granted') {
    el('notifyPermBtn').textContent = '\u2713 Notifications Enabled';
    el('notifyPermBtn').disabled = true;
  }

  function getFilteredRows(type) {
    return state.catalog.filter(function(r) {
      if (type === 'demand') {
        return r.trendRank !== null || (r.salesPerWeek && r.salesPerWeek > 30);
      }
      if (type === 'profitable') {
        return (r.margin || 0) > 0;
      }
      return true; // catalog
    }).filter(function(r) {
      if (type !== 'catalog' || !state.query) return true;
      var q = state.query.toLowerCase();
      return r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q);
    }).sort(function(a, b) {
      if (type === 'catalog') {
        if (state.sort === 'cheap') return (a.inputPrice || 999) - (b.inputPrice || 999);
        if (state.sort === 'roi') return (b.roiPct || -999) - (a.roiPct || -999);
        if (state.sort === 'margin') return (b.margin || -999) - (a.margin || -999);
      }
      if (type === 'profitable') {
        return (b.margin || 0) - (a.margin || 0);
      }
      // default: demand
      var scoreA = (a.salesPerWeek || 0) + ((a.margin || 0) > 0 ? 10000 : 0);
      var scoreB = (b.salesPerWeek || 0) + ((b.margin || 0) > 0 ? 10000 : 0);
      return scoreB - scoreA;
    });
  }

  function renderKPIs() {
    var profitable = state.catalog.filter(function(r) { return (r.margin || 0) > 0; });
    var hotProfitable = state.catalog.filter(function(r) {
      return (r.trendRank !== null || (r.salesPerWeek && r.salesPerWeek > 50)) && (r.margin || 0) > 0;
    }).sort(function(a, b) { return (b.salesPerWeek || 0) - (a.salesPerWeek || 0); });

    var top = hotProfitable[0] || profitable[0];
    if (top) {
      el('kpiTopDemandName').textContent = top.name;
      el('kpiTopDemandSub').textContent = money(top.margin) + ' profit (' + (top.salesPerWeek ? top.salesPerWeek.toLocaleString() + ' sold/wk' : '#' + top.trendRank + ' traded') + ')';
    } else {
      el('kpiTopDemandName').textContent = 'None';
      el('kpiTopDemandSub').textContent = 'No profitable crafts found';
    }

    el('kpiProfitableCount').textContent = profitable.length + ' Crafts';
    el('kpiBreakEven').textContent = (4 / (1 - state.feePct)).toFixed(2) + '\xD7';
  }

  /* ---------- Table View WITHOUT Redundant Subtitles ---------- */
  function renderTable(rows) {
    if (!rows.length) {
      return '<div class="table-card"><div class="empty-state">No pets found matching current filters.</div></div>';
    }

    var html = '<div class="table-card"><div class="table-responsive"><table><thead><tr>' +
      '<th>Pet Name &amp; Demand</th>' +
      '<th class="num-cell">Buy 4 Normal Price</th>' +
      '<th class="num-cell">Total 4x Cost</th>' +
      '<th class="num-cell">Crafted Base Neon</th>' +
      '<th class="num-cell">Neon Net (-' + (state.feePct * 100).toFixed(0) + '%)</th>' +
      '<th class="num-cell">Net Profit</th>' +
      '<th>4-Stock Depth</th>' +
      '<th style="text-align:center;">Inspect</th>' +
      '</tr></thead><tbody>';

    rows.forEach(function(r) {
      var isProfitable = (r.margin || 0) > 0;
      var buyPrice = r.inputDepth4xPrice || r.inputPrice;
      var craftCost = r.craftCost || (buyPrice ? buyPrice * 4 : null);
      var neonPrice = r.neonDepthPrice || r.neonPrice;
      var neonNet = r.neonNet || (neonPrice ? neonPrice * (1 - state.feePct) : null);
      var roi = r.roiPct !== null ? r.roiPct : (craftCost && r.margin ? ((r.margin / craftCost) * 100).toFixed(1) : null);

      var stockBadge = r.inputBuyable === true
        ? '<span class="tag tag-profit">\u2713 4+ In Stock (' + (r.inputAvailable || 4) + ')</span>'
        : r.inputBuyable === false
          ? '<span class="tag tag-loss">\u26A0\uFE0F Only ' + (r.inputAvailable || 0) + ' Listed</span>'
          : '<span class="tag">Checking...</span>';

      var salesBadge = r.salesPerWeek ? '<span class="tag tag-hot">\u{1F525} ' + r.salesPerWeek.toLocaleString() + ' sold/wk</span>' : '';
      var rankBadge = r.trendRank ? '<span class="tag tag-primary">#' + r.trendRank + ' Traded</span>' : '';

      var formattedRarity = formatRarity(r.rare);
      var rareClass = 'tag';
      var rLower = String(r.rare || '').toLowerCase();
      if (rLower === 'legendary') rareClass = 'tag tag-legendary';
      else if (rLower === 'ultra_rare') rareClass = 'tag tag-ultra-rare';
      else if (rLower === 'rare') rareClass = 'tag tag-rare';
      else if (rLower === 'uncommon') rareClass = 'tag tag-uncommon';
      else if (rLower === 'common') rareClass = 'tag tag-common';

      var neonDisplay = neonPrice !== null
        ? '<div class="bold-price">$' + pad(neonPrice, 2) + '</div>'
        : '<span class="tag tag-loss" title="No player has listed a neon for sale on StarPets">Out of Stock</span>';

      var profitDisplay = isProfitable
        ? '<div class="bold-price" style="color:var(--profit);">' + money(r.margin) + '</div>' + (roi !== null ? '<span class="tag tag-profit" style="margin-top:2px;">+' + roi + '% ROI</span>' : '')
        : r.margin !== null
          ? '<div class="bold-price" style="color:var(--loss);">' + money(r.margin) + '</div>'
          : '<span class="tag tag-warn">Need Neon</span>';

      // Clean bold numbers without redundant subtitles! Entire row is clickable!
      html += '<tr onclick="inspectPet(\\'' + esc(r.slug) + '\\')">' +
        '<td>' +
          '<div class="pet-flex-row">' +
            (r.imageUri ? '<img class="pet-avatar" src="' + esc(r.imageUri) + '" alt="" loading="lazy" />' : '') +
            '<span class="pet-name-bold">' + esc(r.name) + '</span>' +
            (r.rare ? '<span class="' + rareClass + '">' + esc(formattedRarity) + '</span>' : '') +
            rankBadge +
            salesBadge +
          '</div>' +
        '</td>' +
        '<td class="num-cell"><div class="bold-price">$' + pad(buyPrice, 2) + '</div></td>' +
        '<td class="num-cell"><div class="bold-price">$' + pad(craftCost, 2) + '</div></td>' +
        '<td class="num-cell">' + neonDisplay + '</td>' +
        '<td class="num-cell"><div class="bold-price">' + (neonNet !== null ? '$' + pad(neonNet, 2) : '--') + '</div></td>' +
        '<td class="num-cell">' + profitDisplay + '</td>' +
        '<td>' + stockBadge + '</td>' +
        '<td style="text-align:center;">' +
          '<button class="btn btn-sm" type="button" onclick="event.stopPropagation(); inspectPet(\\'' + esc(r.slug) + '\\')">Inspect</button>' +
        '</td>' +
        '</tr>';
    });

    html += '</tbody></table></div></div>';
    return html;
  }

  /* ---------- Cards View with Clickable Surface ---------- */
  function renderCards(rows) {
    if (!rows.length) {
      return '<div class="empty-state">No pets found matching current filters.</div>';
    }

    var html = '<div class="card-grid">';
    rows.forEach(function(r) {
      var isProfitable = (r.margin || 0) > 0;
      var buyPrice = r.inputDepth4xPrice || r.inputPrice;
      var craftCost = r.craftCost || (buyPrice ? buyPrice * 4 : null);
      var neonPrice = r.neonDepthPrice || r.neonPrice;
      var neonNet = r.neonNet || (neonPrice ? neonPrice * (1 - state.feePct) : null);
      var roi = r.roiPct !== null ? r.roiPct : (craftCost && r.margin ? ((r.margin / craftCost) * 100).toFixed(1) : null);

      var formattedRarity = formatRarity(r.rare);
      var rareClass = 'tag';
      var rLower = String(r.rare || '').toLowerCase();
      if (rLower === 'legendary') rareClass = 'tag tag-legendary';
      else if (rLower === 'ultra_rare') rareClass = 'tag tag-ultra-rare';
      else if (rLower === 'rare') rareClass = 'tag tag-rare';

      html += '<div class="bold-card ' + (isProfitable ? 'profit' : '') + '" onclick="inspectPet(\\'' + esc(r.slug) + '\\')">' +
        '<div class="card-head">' +
          '<div style="display:flex; flex-direction:column; gap:8px;">' +
            '<div class="pet-flex-row">' +
              (r.imageUri ? '<img class="pet-avatar" src="' + esc(r.imageUri) + '" alt="" loading="lazy" />' : '') +
              '<span class="pet-name-bold">' + esc(r.name) + '</span>' +
              (r.rare ? '<span class="' + rareClass + '">' + esc(formattedRarity) + '</span>' : '') +
            '</div>' +
            '<div class="pet-flex-row">' +
              (r.salesPerWeek ? '<span class="tag tag-hot">\u{1F525} ' + r.salesPerWeek.toLocaleString() + ' sold/wk</span>' : '') +
              (r.trendRank ? '<span class="tag tag-primary">#' + r.trendRank + ' Traded</span>' : '') +
            '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div class="bold-price" style="color:' + (isProfitable ? 'var(--profit)' : 'var(--loss)') + '">' + (r.margin !== null ? money(r.margin) : '--') + '</div>' +
            (roi !== null ? '<span class="tag ' + (isProfitable ? 'tag-profit' : 'tag-loss') + '">' + (roi >= 0 ? '+' : '') + roi + '% ROI</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="card-math-box">' +
          '<div class="math-row"><span>Buy 4 Normal Price:</span><span style="font-weight:900;">$' + pad(buyPrice, 2) + '</span></div>' +
          '<div class="math-row"><span>Total 4x Craft Cost:</span><span style="font-weight:900;">$' + pad(craftCost, 2) + '</span></div>' +
          '<div class="math-row"><span>Crafted Base Neon:</span><span style="font-weight:900;">' + (neonPrice !== null ? '$' + pad(neonPrice, 2) : '<span class="tag tag-loss">Out of Stock</span>') + '</span></div>' +
          '<div class="math-row"><span>Neon Net (-25% fee):</span><span style="font-weight:900;">' + (neonNet !== null ? '$' + pad(neonNet, 2) : '--') + '</span></div>' +
          '<div class="math-row highlight"><span>Net Profit:</span><span style="color:' + (isProfitable ? 'var(--profit)' : 'var(--loss)') + '">' + (r.margin !== null ? money(r.margin) : '<span class="tag tag-warn">Need Neon</span>') + '</span></div>' +
        '</div>' +
        '<button class="btn btn-sm btn-primary" type="button" onclick="event.stopPropagation(); inspectPet(\\'' + esc(r.slug) + '\\')">Inspect Live Order Book \u2197</button>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  function render() {
    renderKPIs();

    var hCont = el('homePetsContainer');
    if (hCont) {
      var topDemand = getFilteredRows('demand');
      hCont.innerHTML = renderTable(topDemand.slice(0, 20));
    }
    
    if (state.activeScreen === 'demand') {
      var dRows = getFilteredRows('demand');
      var dMode = el('viewModeDemand') ? el('viewModeDemand').value : state.viewMode;
      el('demandContentContainer').innerHTML = dMode === 'table' ? renderTable(dRows) : renderCards(dRows);
    } else if (state.activeScreen === 'profitable') {
      var pRows = getFilteredRows('profitable');
      var pMode = el('viewModeProfitable') ? el('viewModeProfitable').value : state.viewMode;
      el('profitableContentContainer').innerHTML = pMode === 'table' ? renderTable(pRows) : renderCards(pRows);
    } else if (state.activeScreen === 'catalog') {
      var cRows = getFilteredRows('catalog');
      var cMode = el('viewModeCatalog') ? el('viewModeCatalog').value : state.viewMode;
      el('catalogContentContainer').innerHTML = cMode === 'table' ? renderTable(cRows) : renderCards(cRows);
    }
  }

  /* ---------- Pet Detail Inspection Window (Android No Overflow) ---------- */
  window.inspectPet = function(slug) {
    var overlay = el('drawerOverlay');
    var drawer = el('drawer');
    var body = el('drawerBody');
    var title = el('drawerTitle');
    
    overlay.classList.add('open');
    drawer.classList.add('open');
    title.textContent = 'Inspecting Pet';
    body.innerHTML = '<div style="padding:20px;text-align:center;font-weight:800;">Loading live order book offers...</div>';

    fetch('/api/pets/' + encodeURIComponent(slug))
      .then(function(res) { return res.json(); })
      .then(function(detail) {
        var s = detail.summary;
        title.textContent = s.petName + ' \u2014 Live Order Book';

        var ladderHtml = (detail.neonLadder || []).map(function(rung, i) {
          return '<tr>' +
            '<td style="font-weight:800;">' + esc((rung.age || 'reborn').toUpperCase()) + '</td>' +
            '<td class="num-cell" style="font-weight:900;text-align:right;">$' + pad(rung.price, 2) + '</td>' +
            '<td style="text-align:center;">' + (i === 0 ? '<span class="tag tag-profit">Cheapest</span>' : '<span class="tag">Rung ' + (i + 1) + '</span>') + '</td>' +
            '</tr>';
        }).join('');

        var variantBoxHtml = '';
        if (s.neonVariants) {
          variantBoxHtml = '' +
            '<div class="form-title" style="margin-top:10px;">Neon Variant Prices on StarPets</div>' +
            '<div class="card-math-box">' +
              '<div class="math-row"><span>Base Neon (No Potion):</span><span style="font-weight:900; color:var(--profit);">' + (s.neonVariants.noPotion ? '$' + pad(s.neonVariants.noPotion, 2) + ' (Craft Outcome)' : 'Out of Stock') + '</span></div>' +
              '<div class="math-row"><span>Ride Neon Variant:</span><span style="font-weight:900;">' + (s.neonVariants.ride ? '$' + pad(s.neonVariants.ride, 2) : 'Out of Stock') + '</span></div>' +
              '<div class="math-row"><span>Fly-Ride Neon Variant:</span><span style="font-weight:900;">' + (s.neonVariants.flyRide ? '$' + pad(s.neonVariants.flyRide, 2) : 'Out of Stock') + '</span></div>' +
            '</div>';
        }

        body.innerHTML = '' +
          '<div class="pet-flex-row" style="background:var(--bg-form);padding:14px;border-radius:10px;border:1.5px solid var(--border);width:100%;justify-content:space-between;box-sizing:border-box;">' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
              (s.imageUri ? '<img class="pet-avatar" src="' + esc(s.imageUri) + '" alt="" />' : '') +
              '<div>' +
                '<div style="font-size:16px;font-weight:900;">' + esc(s.petName) + '</div>' +
                '<div style="font-size:12px;font-weight:700;color:var(--text-muted);">' +
                  formatRarity(s.rare) + ' &bull; ' + (s.salesPerWeek ? s.salesPerWeek.toLocaleString() + ' sold/wk' : 'Trending') +
                '</div>' +
              '</div>' +
            '</div>' +
            '<a class="btn btn-sm btn-primary" href="https://starpets.gg/adopt-me/shop/pet/' + encodeURIComponent(s.petSlug) + '/' + s.normalProductId + '" target="_blank" rel="noopener" style="text-decoration:none;">StarPets \u2197</a>' +
          '</div>' +

          variantBoxHtml +

          '<div class="form-title" style="margin-top:10px;">Craft Arithmetic Breakdown</div>' +
          '<div class="card-math-box">' +
            '<div class="math-row"><span>Cheapest 4x Buyable Price:</span><span style="font-weight:900;">$' + pad(s.normalPrice, 2) + ' each</span></div>' +
            '<div class="math-row"><span>Total 4-Unit Craft Cost:</span><span style="font-weight:900;">$' + pad(s.craftCost, 2) + '</span></div>' +
            '<div class="math-row"><span>Crafted Base Neon Listing:</span><span style="font-weight:900;">' + (s.neonPrice ? '$' + pad(s.neonPrice, 2) : '<span class="tag tag-loss">Out of Stock on StarPets</span>') + '</span></div>' +
            '<div class="math-row"><span>StarPets 25% Fee:</span><span style="font-weight:900;color:var(--loss);">' + (s.neonPrice ? '-$' + pad(s.neonPrice * 0.25, 2) : '--') + '</span></div>' +
            '<div class="math-row"><span>Net Neon Proceeds:</span><span style="font-weight:900;">' + (s.neonNet ? '$' + pad(s.neonNet, 2) : '--') + '</span></div>' +
            '<div class="math-row highlight"><span>Net Profit Per Craft:</span><span style="color:' + (s.margin > 0 ? 'var(--profit)' : 'var(--loss)') + ';font-size:16px;">' + (s.margin !== null ? money(s.margin) : 'Out of Stock') + '</span></div>' +
            '<div class="math-row"><span>Break-Even Multiple:</span><span>' + (s.ratio ? pad(s.ratio, 2) + '\xD7 (Target: ' + pad(s.breakEvenRatio, 2) + '\xD7)' : '--') + '</span></div>' +
          '</div>' +

          '<div class="form-title" style="margin-top:12px;">Live Neon Listings Across Ages</div>' +
          '<table class="order-book-table">' +
            '<thead><tr><th>Age Rung</th><th class="num-cell" style="text-align:right;">Listing Ask</th><th style="text-align:center;">Status</th></tr></thead>' +
            '<tbody>' + (ladderHtml || '<tr><td colspan="3" style="text-align:center;padding:12px;">No neon listings currently for sale on StarPets</td></tr>') + '</tbody>' +
          '</table>';
      })
      .catch(function(err) {
        body.innerHTML = '<div class="empty-state">Failed to fetch pet details: ' + esc(err.message) + '</div>';
      });
  };

  function closeDrawer() {
    el('drawerOverlay').classList.remove('open');
    el('drawer').classList.remove('open');
  }

  el('drawerOverlay').addEventListener('click', closeDrawer);
  el('drawerClose').addEventListener('click', closeDrawer);

  el('themeToggleBtn').addEventListener('click', function() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  el('syncPopularBtn').addEventListener('click', function() {
    var btn = el('syncPopularBtn');
    btn.disabled = true;
    btn.textContent = '\u23F3 Syncing...';
    fetch('/api/sync-popular', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function() {
        btn.textContent = '\u2713 Synced!';
        state.secondsRemaining = 300;
        setTimeout(function() {
          btn.disabled = false;
          btn.textContent = '\u26A1 Sync Live';
        }, 1500);
        fetchData(false);
      })
      .catch(function() {
        btn.disabled = false;
        btn.textContent = '\u26A1 Sync Live';
      });
  });

  el('searchInput').addEventListener('input', function(e) {
    state.query = e.target.value;
    render();
  });

  el('raritySelect').addEventListener('change', function(e) {
    state.rarity = e.target.value;
    fetchData(false);
  });

  el('sortBySelect').addEventListener('change', function(e) {
    state.sort = e.target.value;
    render();
  });

  ['viewModeDemand', 'viewModeProfitable', 'viewModeCatalog'].forEach(function(selId) {
    var s = el(selId);
    if (s) {
      s.value = state.viewMode;
      s.addEventListener('change', function(e) {
        state.viewMode = e.target.value;
        localStorage.setItem('view_mode', state.viewMode);
        render();
      });
    }
  });

  el('feeInput').addEventListener('change', function(e) {
    state.feePct = Number(e.target.value) / 100;
    fetchData(false);
  });

  el('capInput').addEventListener('change', function(e) {
    state.cap = Number(e.target.value);
    fetchData(false);
  });

  // Initial Load
  fetchData(false);
})();
</script>
</body>
</html>`;
}

// src/server/http.ts
var VERDICTS = ["craft", "marginal", "skip"];
async function handle(service, req, res, options, log, syncState) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const started = Date.now();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  try {
    if (method === "GET" && path === "/") {
      sendHtml(res, 200, dashboardHtml());
      return;
    }
    if (method === "GET" && (path === "/logo.jpg" || path === "/logo.png" || path === "/assets/logo.jpg")) {
      const logoPath = join4(process.cwd(), "assets", "logo.jpg");
      if (existsSync4(logoPath)) {
        const data = readFileSync3(logoPath);
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": data.length,
          "Cache-Control": "public, max-age=86400"
        });
        res.end(data);
        return;
      }
    }
    if (method === "GET" && path === "/health") {
      const status = service.status();
      sendJson(res, 200, { ...status, stale: service.isStale() });
      return;
    }
    if (method === "GET" && path === "/api/status") {
      sendJson(res, 200, { ...service.status(), stale: service.isStale(), defaults: service.defaults });
      return;
    }
    if (method === "GET" && path === "/api/opportunities") {
      const scan = parseScanOptions(url.searchParams);
      const opportunities = service.listOpportunities(scan);
      sendJson(res, 200, {
        count: opportunities.length,
        breakEvenRatio: 4 / (1 - (scan.feePct ?? service.defaults.feePct)),
        opportunities
      });
      return;
    }
    if (method === "GET" && path === "/api/pets") {
      const scan = parseScanOptions(url.searchParams);
      const pets = service.listOpportunities({ ...scan, includeLosses: true }).map((o) => ({
        slug: o.petSlug,
        name: o.petName,
        rare: o.rare,
        imageUri: o.imageUri,
        normalPrice: o.normalPrice,
        neonPrice: o.neonPrice,
        margin: o.margin,
        ratio: o.ratio,
        breakEvenRatio: o.breakEvenRatio,
        verdict: o.verdict
      }));
      sendJson(res, 200, { count: pets.length, pets });
      return;
    }
    if (method === "GET" && path === "/api/flips") {
      const flips = service.listFlips(parseFlipOptions(url.searchParams));
      sendJson(res, 200, {
        count: flips.length,
        feePct: numberParam(url.searchParams, "feePct") ?? service.defaults.feePct,
        flips
      });
      return;
    }
    if (method === "GET" && path === "/api/coverage") {
      sendJson(res, 200, service.coverage());
      return;
    }
    if (method === "GET" && path === "/api/catalog") {
      const rarities = parseRarities(url.searchParams);
      const rows = service.catalog(rarities ?? void 0);
      sendJson(res, 200, { count: rows.length, rows, pets: rows });
      return;
    }
    if (method === "POST" && path === "/api/demand") {
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const body = await readJsonBody(req);
      const ids = Array.isArray(body?.productIds) ? body.productIds.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0) : [];
      if (ids.length === 0) {
        sendJson(res, 400, { error: "invalid_product_ids", hint: 'body must be {"productIds":[...]}' });
        return;
      }
      const budget = typeof body?.budget === "number" && Number.isFinite(body.budget) ? Math.min(Math.max(1, Math.floor(body.budget)), 50) : 30;
      const result = await service.enrichDemand(ids.slice(0, 500), budget);
      sendJson(res, 200, result);
      return;
    }
    if (method === "POST" && path === "/api/trending") {
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const result = await service.refreshTrending(2);
      sendJson(res, 200, result);
      return;
    }
    if (method === "GET" && path === "/api/trending") {
      const rows = [...service.trendBoard()].sort((a, b) => a.rank - b.rank).slice(0, 150);
      sendJson(res, 200, { count: rows.length, pets: rows });
      return;
    }
    if (method === "POST" && path === "/api/verify-depth") {
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const body = await readJsonBody(req);
      const pairs = Array.isArray(body?.pairs) ? body.pairs.filter(
        (p) => p !== null && typeof p === "object" && typeof p.normalProductId === "number" && typeof p.neonProductId === "number"
      ) : [];
      const budget = typeof body?.budget === "number" && Number.isFinite(body.budget) ? Math.min(Math.max(1, Math.floor(body.budget)), 50) : 24;
      const result = await service.verifyDepth(pairs.slice(0, 200), budget);
      sendJson(res, 200, result);
      return;
    }
    if (method === "GET" && path === "/api/sweeps") {
      sendJson(res, 200, { sweeps: service.sweeps(Number(url.searchParams.get("limit") ?? 20)) });
      return;
    }
    const petMatch = /^\/api\/pets\/([^/]+)(\/history)?$/.exec(path);
    if (method === "GET" && petMatch) {
      const slug = decodeURIComponent(petMatch[1]);
      const hours = Number(url.searchParams.get("hours") ?? 24);
      if (petMatch[2]) {
        const history = service.history(slug, Number.isFinite(hours) ? hours : 24);
        if (!history) {
          sendJson(res, 404, { error: "pet_not_found", slug });
          return;
        }
        sendJson(res, 200, { slug, hours, ...history });
        return;
      }
      const detail = service.getPet(slug);
      if (!detail) {
        sendJson(res, 404, { error: "pet_not_found", slug });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }
    if (method === "GET" && path === "/api/order-book") {
      const productId = Number(url.searchParams.get("productId"));
      const units = Number(url.searchParams.get("units") ?? 4);
      if (!Number.isInteger(productId) || productId <= 0) {
        sendJson(res, 400, { error: "invalid_product_id" });
        return;
      }
      sendJson(res, 200, await service.orderBook(productId, Number.isFinite(units) ? units : 4));
      return;
    }
    if (method === "POST" && path === "/api/scan") {
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const result = await service.triggerSweep();
      sendJson(res, 200, {
        itemCount: result.itemCount,
        petCount: result.petCount,
        bands: result.bands,
        requests: result.requests,
        durationMs: result.durationMs,
        aborted: result.aborted,
        failedBands: result.failedBands
      });
      return;
    }
    if (method === "POST" && path === "/api/sync-popular") {
      if (options.adminToken && !authorized(req, options.adminToken)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      syncState.isSyncing = true;
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        const pages = Number(body?.pages ?? 2);
        const resData = await service.syncPopularPets({ pages, verifyDepth: true });
        syncState.lastSyncedAt = Date.now();
        syncState.nextSyncAt = syncState.lastSyncedAt + 5 * 6e4;
        sendJson(res, 200, {
          success: true,
          ...resData,
          lastSyncedAt: syncState.lastSyncedAt,
          nextSyncAt: syncState.nextSyncAt
        });
      } finally {
        syncState.isSyncing = false;
      }
      return;
    }
    if (method === "GET" && path === "/api/sync-status") {
      const now = Date.now();
      const remainingSec = Math.max(0, Math.round((syncState.nextSyncAt - now) / 1e3));
      sendJson(res, 200, {
        lastSyncedAt: syncState.lastSyncedAt,
        nextSyncAt: syncState.nextSyncAt,
        secondsRemaining: remainingSec,
        isSyncing: syncState.isSyncing
      });
      return;
    }
    sendJson(res, 404, { error: "not_found", path });
  } finally {
    log(`${method} ${path} ${Date.now() - started}ms`);
  }
}
function parseRarities(params) {
  const raw = params.get("rarity");
  if (raw === null || raw.trim() === "") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "all" || trimmed === "any") return [];
  const parts = trimmed.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  return parts;
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
function authorized(req, token) {
  const header = req.headers.authorization;
  return typeof header === "string" && header === `Bearer ${token}`;
}
function numberParam(params, name) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function parseFlipOptions(params) {
  const options = {};
  const feePct = numberParam(params, "feePct");
  if (feePct !== null && feePct >= 0) options.feePct = feePct > 1 ? feePct / 100 : feePct;
  const minDiscountPct = numberParam(params, "minDiscountPct");
  if (minDiscountPct !== null && minDiscountPct >= 0) {
    options.minDiscountPct = minDiscountPct > 1 ? minDiscountPct / 100 : minDiscountPct;
  }
  const maxAsk = numberParam(params, "maxAsk");
  if (maxAsk !== null && maxAsk > 0) options.maxAsk = maxAsk;
  const limit = numberParam(params, "limit");
  if (limit !== null && Number.isInteger(limit) && limit > 0) options.limit = Math.min(limit, 5e3);
  if (params.get("watchOnly") === "false") options.watchOnly = false;
  if (params.get("watchOnly") === "true") options.watchOnly = true;
  return options;
}
function parseScanOptions(params) {
  const scan = {};
  const maxNormalPrice = numberParam(params, "maxNormalPrice");
  if (maxNormalPrice !== null && maxNormalPrice > 0) scan.maxNormalPrice = maxNormalPrice;
  const feePct = numberParam(params, "feePct");
  if (feePct !== null && feePct >= 0) scan.feePct = feePct > 1 ? feePct / 100 : feePct;
  const units = numberParam(params, "units");
  if (units !== null && Number.isInteger(units) && units > 1) scan.units = units;
  const verdict = params.get("verdict");
  if (verdict === "all" || verdict && VERDICTS.includes(verdict)) {
    scan.verdict = verdict;
  }
  const limit = numberParam(params, "limit");
  if (limit !== null && Number.isInteger(limit) && limit > 0) scan.limit = Math.min(limit, 5e3);
  const sortBy = params.get("sort");
  if (sortBy === "margin" || sortBy === "ratio" || sortBy === "discount" || sortBy === "cheap" || sortBy === "demand") {
    scan.sortBy = sortBy;
  }
  const rarities = parseRarities(params);
  if (rarities !== null) scan.rarities = rarities;
  if (params.get("includeLosses") === "true") scan.includeLosses = true;
  return scan;
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    // The dashboard is generated fresh each request; never let a proxy pin it.
    "Cache-Control": "no-store"
  });
  res.end(html);
}

// src/server/vercel-entry.ts
async function handler(req, res) {
  const log = (msg) => console.log(`[vercel] ${msg}`);
  try {
    const rawPath = req.headers["x-matched-path"] || req.headers["x-vercel-matched-path"] || req.url || "/";
    let path = rawPath;
    if (path === "/api" || path === "/api/" || path === "/api/index.ts" || path === "/api/index" || path === "/api/index.js") {
      path = "/";
    } else if (path.startsWith("/api?") || path.startsWith("/api/?")) {
      path = "/" + path.substring(path.indexOf("?"));
    }
    req.url = path;
    const service = getService();
    triggerBackgroundSyncIfNeeded(service, log);
    await handle(service, req, res, { port: 8787 }, log, syncStateInstance);
  } catch (err) {
    log(`Fatal handler error: ${err instanceof Error ? err.stack : String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "internal_server_error",
          message: err instanceof Error ? err.message : String(err),
          timestamp: Date.now()
        })
      );
    }
  }
}
export {
  handler as default
};
