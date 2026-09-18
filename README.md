---
title: Pet Pricer
emoji: 🐾
colorFrom: blue
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# Pet Pricer — StarPets Intelligence

Finds pets where **buying four normal pets and fusing them into one neon** is
actually profitable, across the whole Adopt Me catalog, and exposes the result
to an Android app and to an assistant over MCP.

It reports two independent signals and never conflates them:

1. **Craft margin** — arithmetic on two asks, fee included. `craft` means the
   spread clears your fee at the observed prices. It does not mean a buyer
   exists at the neon price.
2. **Underpriced listings** — items trading below their own 7-day average. This
   one *does* assume a buyer at the average, which the snapshot cannot prove, so
   it is presented as a watchlist with that caveat attached rather than as
   realised profit.

It is **read-only**. It observes public prices and reports arithmetic. It has no
login, no purchase path, no listing path and no trade path, and it never drives
a browser or the Roblox client.

**Nothing in it is invented.** Every price, name and image traces to a row the
collector observed, or to one of four hand-verified reference pets. Where data is
missing the UI says which data is missing and why, because an empty screen is
honest and a confident fake profit is not.

---

## The one rule that does the work

Everything reduces to a single inequality:

```
margin = neon_ask × (1 − fee) − 4 × normal_ask  >  0

        ⇒   neon_ask / normal_ask  >  4 / (1 − fee)
```

At a 25% sell-side fee that ratio is **5.333x**. The break-even is a *ratio*, so
it is independent of the pet and of absolute price — which is what makes
scanning hundreds of pets tractable. The engine screens on the ratio first; only
survivors need order-book depth analysis.

Applied to the four pets whose prices were verified directly against the
market's own structured data, the fee **flips three of four from profitable to
loss-making**:

| Pet | cheapest normal | cheapest neon | gross | after 25% fee | ratio | verdict |
|---|---|---|---|---|---|---|
| Dragonfruit Fox | $0.83 | $4.78 | +$1.46 | **+$0.265** | 5.76x | craft |
| Sushi Penguin | $0.47 | $2.21 | +$0.33 | **−$0.223** | 4.70x | skip |
| Dango Penguins | $0.72 | $3.07 | +$0.19 | **−$0.578** | 4.26x | skip |
| Three Blind Mice | $0.08 | $0.22 | −$0.10 | **−$0.155** | 2.75x | skip |

Those four rows are the acceptance test in `test/unit/margin.test.ts` and the
`craft / skip / skip / skip` verdict set is asserted end-to-end, including over
MCP.

---

## Architecture

```
                    market API (public, unauthenticated)
                              │
                    ┌─────────▼─────────┐
                    │     collector     │  banded sweep, budgeted + resumable
                    └─────────┬─────────┘
                              │ SQLite snapshot + price history
                    ┌─────────▼─────────┐
                    │      service      │  margin engine, ranking, cache
                    └────┬─────────┬────┘
                         │         │
              ┌──────────▼──┐   ┌──▼──────────┐
              │  HTTP API   │   │ MCP server  │
              └──────┬──────┘   └──────┬──────┘
                     │                 │
              Android app        assistant tools
```

MCP is a **layer, not a data source**: it is a thin projection of the same
`ScannerService` the HTTP API uses, so the assistant and the phone can never
disagree about a number. Both read the local snapshot, not the market — your
phone is never the thing that gets the host to rate-limit you.

---

## The market API, as discovered

The read path is a public JSON API — **no auth, CORS-open**. Endpoints were
recovered from the site's own JS bundle and then confirmed against live
responses; the service validates requests with Joi and echoes the exact missing
field, so the schema was *asked for* rather than guessed.

Host for Adopt Me: `https://market.apineural.com`.

| Endpoint | Purpose | Limits |
|---|---|---|
| `POST /api/v2/store/items/all` | sweep priced items | `page ≤ 120`, `amount ≤ 72` |
| `POST /api/v2/store/items/product` | batched **order book** (depth) | ids are *product* ids |
| `POST /api/v2/store/items/price` | prices for *store-item* ids | different id space |
| `GET /api/v2/products/{id}/info` | detail + `numberOfSalesPerWeek` | liquidity for free |
| `GET /api/products/{id}/properties` | `pumping:flyable:rideable → productId` | the variant matrix |
| `GET /api/products/{id}/ages` | the age ladder for one variant | |
| `POST {manualMode}/api/goods/list` | catalog search, `game: 0` = ADOPT | `X-Version: 2` |

Filter schema on `items/all`:

```jsonc
{
  "page": 1, "amount": 72, "currency": "usd",
  "filter": {
    "types": [{ "type": "pet",
                "subtypes": [], "ages": [], "rarities": [],
                "mutations": [], "properties": {} }],
    "name": "Dango Penguins",        // fuzzy, case-insensitive
    "price": { "min": 3.0, "max": 3.2 }
  },
  "sort": { "price": "asc" }        // or { "popularity": "desc" }
}
```

`page ≤ 120` × `amount ≤ 72` means **any single query caps at 8,640 items**, while
the priced pet universe is far larger. `filter.price` is therefore the partition
key — see `src/core/bands.ts`.

Six fields were verified on the Dango Penguins neon (`id 1681844`), which is
what the whole design rests on:

```jsonc
GET /api/v2/products/1681844/info
{ "product": {
    "pumping": "neon", "flyable": false, "rideable": false, "age": "reborn",
    "currentMinPrice":   { "usd": 3.07 },
    "numberOfSalesPerWeek": 120,
    "avgPriceForWeek":   { "usd": 3.97 },
    "currentStoreItemId":{ "usd": "124253012" }   // the product → store-item hop
} }
```

---

## Data-hygiene rules (each one earned)

These are not defensive style. Every rule below came from a concrete error made
while working this out by hand, and each is covered by a test.

1. **`price === 0` means "no data", never "$0.00".** Roughly half the catalog
   reports it. Minimising over it reports a free pet on the normal side
   (infinite margin) and a catastrophic fake loss on the neon side. The sweep
   floor starts at `$0.01` for the same reason.
2. **The neon is `pumping=neon`, not an age.** There are two independent axes;
   reading the literal string "neon" out of `age` produced three wrong neon
   prices in a row, two of which looked profitable.
3. **The neon ladder is not ordered.** Observed on one pet: reborn $0.22,
   twinkle *no data*, sparkle $1.41, flare $1.20, sunshine $0.63, luminous
   $0.34. "Cheapest neon regardless of age" requires walking **every** rung.
4. **Attribute-match the input side.** A cheaper Full-Grown is usually not an
   inversion at all — it is a *different product* (non-flyable, non-rideable,
   different pumping). Age tiers are only compared inside one
   `pumping:flyable:rideable` combination.
5. **Reject absurd asks, not wide spreads.** A MAD-based rule wrongly rejected a
   perfectly ordinary $2.60 ask next to the genuine $416 outlier, because a
   densely-packed cheap book has a tiny median deviation. Rejection now needs
   *both* a large multiple of the median *and* a large absolute amount.
6. **Depth, not just price.** A craft consumes four units, so a single cheap
   listing is not an opportunity.
7. **A flat ladder means unpaid ageing.** Newborn→full-grown moved the price by
   3¢ on one pet and 0¢ on another, so on cheap pets the entire margin is the
   4→1 fusion edge and ageing is effectively unpaid labour.
8. **`mega_neon` has no age ladder** (`age: null`), so the rung walk is
   conditional on pumping type.
9. **`avgPrice` is sometimes a copy of the current ask.** On 52% of the live
   catalog the two were identical, so an "average" that equals the ask carries
   no signal at all. Rows where they match are dropped from the discount view
   rather than scored as a 0% discount.
10. **An empty result is not a verdict until coverage is known.** A run that
    collected 2,664 rows whose inputs topped out at $0.83 and whose neons topped
    out at $0.11 had observed nothing that *could* have been profitable. The
    report says so numerically instead of letting a thin list read as a thin
    market. See `CoverageReport` and `test/unit/coverage.test.ts`.

---

## Quick start

Requires Node 22.5+ (uses the built-in `node:sqlite`; no native build step).

```bash
npm install
npm run typecheck
npm test                 # 97 unit + integration tests, no network
npm run sweep            # one budgeted, resumable cycle
npm run watch            # budgeted cycles on the configured cadence
npm run serve            # HTTP API on :8787
npm run mcp              # MCP server on stdio
```

`sweep` is **budgeted and resumable**. Each run spends a small request budget,
checkpoints its position in the database, and the next run continues where it
stopped — so running `npm run sweep` a few times, or leaving `npm run watch`
running, walks the whole catalog without ever tripping the host's limit. Watch
the queue drain with `npm run sweep -- --budget=35` then `node src/collector/cli.ts stats`.

`npm run sweep -- --full` forces a single unbounded pass. It exists for a
staging host without the live rate limit; against the real host it will get you
blocked (see below).

No network? Seed a known-good fixture and everything still works:

```bash
node scripts/seed-fixture.ts --db ./data/fixture.sqlite
STARPETS_DB=./data/fixture.sqlite npm run serve
```

### Serving it on your network (so a phone can reach it)

The API binds loopback by default. To expose it to your LAN — which is what the
Android app needs — bind all interfaces:

```bash
STARPETS_HOST=0.0.0.0 STARPETS_PORT=8787 STARPETS_DB=./data/demo.sqlite npm run serve
```

It prints the LAN URL to use in the app:

```
[server] listening on http://0.0.0.0:8787
[server]   dashboard  http://127.0.0.1:8787/
[server]   on your LAN  http://192.168.18.3:8787/  (use this in the Android app)
[server] snapshot: 2697 items / 387 pets
```

Binding `0.0.0.0` exposes the API to everything on the network, and the
manifest enables cleartext HTTP so the app can talk to it. There is no
authentication on reads — put it on a trusted network, or front it with
something that authenticates before shipping it anywhere real.

### The browser dashboard

`GET /` serves a self-contained dashboard: no build step, no CDN, no bundler.
It renders exactly what the API returns and computes nothing itself, so all
arithmetic stays on the server and it can never disagree with the Android client
or the MCP tools.

Four views sit behind one toolbar:

- **Opportunities** — pets whose margin clears the fee, ranked by **profit ×
  demand** by default (see below).
- **Underpriced** — listings below their own 7-day average, ranked by discount.
  This is deliberately a *different* claim from the craft margin and is labelled
  as an assumption: it needs a buyer at the average, which the snapshot cannot
  prove. The cheapest ask sitting below the average is itself evidence that
  sellers are competing downward.
- **Full market** — every pet with a computable margin, including the losers,
  because a scanner that only lists winners is a liability.
- **Whole catalog** — every pet in the snapshot with its status, including the
  ones we cannot price yet, so a short profitable list cannot read as an empty
  market.

**Rarity filter.** The default view is rare, ultra-rare and legendary only —
the tiers people actually pay for. Common and uncommon pets dominate the catalog
by count, not by profit. `rarity=all` restores the full set; the filter applies
to opportunities, the catalog and the table.

**Demand ranking.** Margin alone points at pets that never sell. The market
exposes weekly sales per product, so the scanner collects it as its own budgeted
job (`POST /api/demand`, one request per pet — the same rate-limit rules apply)
and ranks by `margin × salesPerWeek`: expected weekly profit, not per-craft
profit. A $0.65 margin selling 14×/week beats a $1.10 margin selling once.
Missing readings are treated as *unknown*, never as zero — a pet nobody has
measured ranks below measured winners but above pets measured to have no
demand, because "nobody has looked" is weaker evidence than "no sales".

Spotlight card, KPI row, real pet thumbnails from the market CDN (with a monogram
fallback for missing or unreachable art), break-even meters, per-pet detail
drawer with the full neon ladder, drift sparkline and a live depth button, plus a
prominent banner for any collection gap. Filters: search, sort, verdict, capital
cap, fee. Refreshes every 60 seconds.

The layout is phone-first: the tab strip scrolls inside itself and the wide table
scrolls inside its own container, so the page itself never scrolls sideways.

### Provenance, and a database you can trust

Every row records `source`: `observed` (swept from the market), `verified` (the
four hand-checked reference pets, transcribed from confirmed prices) or
`fabricated`. Nothing writes `fabricated` any more — the generators that used to
produce invented pets were deleted, because they shipped: the dashboard served
5,493 fabricated rows ranked above the real ones, and a confident fake profit is
worse than an empty screen.

Provenance is recorded, not inferred. It used to be guessed from a reserved id
range, which misfired the moment the hand-verified rows landed in that same
range — labelling real, confirmed prices as "must not be traded on".

`GET /api/status` reports the counts, and the dashboard refuses to pass
generated rows off as real.

To merge the verification fixture into a real snapshot:

```bash
cp ./data/live.sqlite ./data/market.sqlite
node scripts/seed-fixture.ts --db ./data/market.sqlite
```

Live checks against the real API are opt-in, because they are what can get you
rate-limited:

```bash
npm run test:live
```

---

## HTTP API

| Route | Purpose |
|---|---|
| `GET /` | browser dashboard (see below) |
| `GET /health`, `GET /api/status` | snapshot size, age, fee, break-even, staleness |
| `GET /api/opportunities` | ranked candidates; `maxNormalPrice`, `feePct`, `verdict`, `sort` (`demand` default option), `rarity`, `limit`, `includeLosses` |
| `GET /api/catalog` | the whole market incl. pets with no verdict yet, with a status per row |
| `GET /api/flips` | listings below their own 7-day average; `minDiscountPct`, `maxAsk`, `watchOnly` |
| `POST /api/demand` | enrich weekly-sales data, budgeted; body `{"productIds":[...],"budget":30}` |
| `GET /api/coverage` | how much of the price range this snapshot actually explains |
| `GET /api/pets` | catalog: identity + prices |
| `GET /api/pets/{slug}` | full breakdown: ladder, variants, history |
| `GET /api/pets/{slug}/history?hours=` | price drift |
| `GET /api/order-book?productId=&units=` | live 4-unit depth |
| `POST /api/scan` | trigger a sweep (bearer-protected if `STARPETS_ADMIN_TOKEN` is set) |
| `GET /api/sweeps` | recent sweep history |

`feePct` accepts either `0.25` or `25`. Omitting it uses the configured default —
note that an omitted parameter must stay *absent*, since `Number(null) === 0`
would otherwise silently mean a 0% fee and report three loss-making pets as
profitable. That regression is pinned by `test/unit/server-params.test.ts`.

---

## MCP tools

| Tool | Purpose |
|---|---|
| `market_status` | snapshot health, age, fee, break-even |
| `scan_opportunities` | ranked candidates, filtered and sorted |
| `get_pet` | one pet's full breakdown and the evidence behind its verdict |
| `get_order_book` | live 4-unit depth (the only tool that calls the market) |
| `price_history` | observed drift, for reasoning about the ageing window |
| `find_pet` | catalog search |

Paste into an MCP client config:

```json
{
  "mcpServers": {
    "starpets-margin": {
      "command": "node",
      "args": ["/absolute/path/to/src/mcp/cli.ts"],
      "env": { "STARPETS_DB": "/absolute/path/to/data/starpets.sqlite" }
    }
  }
}
```

---

## Android app

`android/` is a Kotlin + Compose client: filter chips, ranked list, per-pet
breakdown with the full neon ladder and flags, live depth lookup, and settings
for the backend URL, fee and capital cap. It polls every **4 minutes** and
persists its settings.

Build it in Android Studio, or:

```bash
cd android && ./gradlew assembleDebug
```

The default backend URL is `http://10.0.2.2:8787`, which is how the emulator
reaches a server on the host machine. It uses `HttpURLConnection` and Android's
built-in `org.json`, so there is no serialization library to keep in step; swap
in Retrofit or Ktor behind `ScannerApi` if you prefer.

> **Not verified here:** this environment has no JDK or Android SDK, so the app
> compiles only in Android Studio. Everything outside `android/` is typechecked
> and tested. Toolchain versions live in `android/gradle/libs.versions.toml`.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `STARPETS_STORE_URL` | `https://market.apineural.com` | store host for Adopt Me |
| `STARPETS_CURRENCY` | `usd` | |
| `STARPETS_FEE_PCT` | `0.25` | **your** sell-side fee; sets the break-even ratio |
| `STARPETS_MAX_NORMAL_PRICE` | `3` | capital cap on the input side |
| `STARPETS_UNITS` | `4` | units per craft |
| `STARPETS_MIN_ROC` | `0.05` | return on capital below which a craft is "marginal" |
| `STARPETS_CONCURRENCY` | `4` | in-flight request ceiling |
| `STARPETS_MIN_INTERVAL_MS` | `250` | minimum gap between request starts |
| `STARPETS_REQUEST_BUDGET` | `35` | requests per sweep cycle (see the rate-limit note) |
| `STARPETS_INTERVAL_MS` | `300000` | poll cadence |
| `STARPETS_DB` | `./data/starpets.sqlite` | |
| `STARPETS_HOST` | `127.0.0.1` | set `0.0.0.0` to reach it from a phone |
| `STARPETS_PORT` | `8787` | |
| `STARPETS_ADMIN_TOKEN` | unset | if set, required on `POST /api/scan` |

---

## Operational notes and honest limits

**There is a hard floor on "real time": about 240 seconds.** The market serves
its data from a 4-minute CDN cache, so polling faster returns identical bytes.
The default cadence is 5 minutes.

**Rate limiting is not theoretical — it happened, twice, and it is measured.**

The host is blocked by IP after roughly **50 requests in a window**: every
subsequent connection times out while the rest of the internet stays reachable.
It has a recovery time of at least 10 minutes.

Critically, the ceiling is on **volume, not rate**. The first attempt tripped it
at ~52 requests while issuing roughly 6/second; the second attempt tripped it at
the same ~52 requests while pacing at only **0.45 requests/second**. Slowing down
does not buy you more requests. This is what makes a single-pass full sweep
impossible and why the collector is built around a resumable budget:

- each cycle spends `STARPETS_REQUEST_BUDGET` requests (default 35) and then
  stops *on purpose*, storing its queue in the `sweep_state` table;
- the next cycle resumes exactly where it left off;
- the queue is consumed **breadth-first: every frontier probe before any page
  fill**, so a handful of requests buys a picture of the whole price range
  instead of drilling one corner of it;
- and within a tier, ordering is unchanged, so cheap bands still refresh most
  often;
- the queue is checkpointed after **every** request, and the in-flight task is
  left in the queue until it succeeds — so a block or a hard kill costs at most
  one idempotent page fetch;
- a circuit breaker aborts a cycle after 8 consecutive connection failures
  rather than deepening the block, and the watcher backs off exponentially to
  30 minutes.

**The ordering fix is the most consequential change in this repo, so it is worth
being precise about it.** The queue used to be consumed depth-first: the children
of the band just probed were placed ahead of every waiting sibling, so a cycle
refined `$0.01-$0.04` to exhaustion — page fills included — before asking what a
$20 pet costs. A real run spent its entire budget down there and concluded
"nothing is profitable", having observed a maximum ask of **$0.11**. The cheap end
is not the interesting end: a craft needs an input under the cap *and* a neon
above 5x it, so a $2 pet and a $20 neon matter at least as much.

Measured on a synthetic log-spread catalog, breadth-first sampling reaches:

| Requests | Max price sampled (breadth-first) | (old, depth-first) |
|---|---|---|
| 4 | $0.07 | ~$0.10 |
| 8 | $0.18 | ~$0.10 |
| 12 | $0.42 | ~$0.10 |
| 16 | $1.03 | ~$0.10 |
| 20 | $2.49 | ~$0.10 |

At the default budget of 35, the first cycle now samples past $3. The regression
is pinned by `test/integration/budgeted-sweep.test.ts`.

The client also enforces a minimum gap between request starts
(`STARPETS_MIN_INTERVAL_MS`) in addition to a concurrency limit. That is good
citizenship, not a fix for the ceiling.

**A complete catalog pass is ~300–600 requests**, therefore several hours of
budgeted cycles. Partitioning is required (the 120-page cap), and both the band
recursion's completeness and the resume-after-block behaviour are proven against
fakes that enforce the same ceiling:
`test/integration/budgeted-sweep.test.ts` drives 4,000 items through a host that
blocks at 6 requests, and asserts the catalog is fully covered across many
interrupted cycles, with nothing lost when the process restarts mid-sweep.

**Surviving margins are cents.** At a $3 cap you are risking ~$12 of capital to
make ~$0.27, and the neon price can move during the hours-to-days it takes to
age four pets. That is why every poll is stored: `price_history` is the drift
model, and `avgPrice` gives a free "is this ask below its own average" signal.

**Ranking by margin alone is not enough.** `opportunityScore` multiplies margin
by turnover, and `/api/v2/products/{id}/info` exposes
`numberOfSalesPerWeek` for exactly this. Per-pet liquidity enrichment is wired
up on demand (`get_pet` in MCP, the depth endpoint over HTTP) but is *not* run
for all pets on every sweep, because that would add hundreds of requests to each
cycle. Treat the current ranking as margin-first.

**Verdicts are arithmetic, not advice.** `craft` means the spread clears your
fee *at the observed asks*. It does not mean a buyer exists at the neon price,
that supply is bot-free, or that you will not be outbid.

**A short list is usually a coverage problem, not a market verdict.** Before
concluding that nothing is profitable, check `GET /api/coverage`. If
`profitableBandUnreached` is true, then no arrangement of the data on hand could
have shown a profit at any ratio, and the answer is "collect more", not "don't
trade". This is the single most common way to be misled by this tool.

### Terms of service

This is a real-money marketplace for Roblox items, and reselling them is against
Roblox's terms. The market's `robots.txt` permits product and category pages, but
**`robots.txt` is not terms of service** — read their actual terms before
polling commercially. Cheap supply in this economy is frequently botted or
compromised, and enforcement means revocation with no recourse. The fee model
ships as configuration because the real numbers vary by tier and currency; the
default 25% is the value on the account this was built for, not a verified fact
about the platform.

---

## Layout

```
src/
  core/
    types.ts          domain model (pumping ≠ age)
    api.ts            market client: throttle, retry, circuit breaker
    bands.ts          price-band partition (the 120-page workaround)
    hygiene.ts        zero-price / outlier / depth rules
    margin.ts         break-even ratio, verdicts, scoring
    opportunities.ts  swept items → evaluated crafts, and below-average listings
  collector/
    store.ts          node:sqlite snapshot, history, resumable queue state
    sweep.ts          banded sweep, budgeted cycles, watch loop, block backoff
    cli.ts
  server/             HTTP API
  mcp/                MCP tools
  service.ts          shared layer under both (incl. CoverageReport)
  server/dashboard.ts self-contained browser client
test/
  unit/               margin, hygiene, bands, opportunities, flips, coverage,
                      params, queue
  integration/        MCP over stdio, budgeted sweep, API resilience
  integration/        MCP over stdio; sweeps that resume across a block
  live/               opt-in acceptance against the real API
android/              Kotlin + Compose client
scripts/seed-fixture.ts
```
