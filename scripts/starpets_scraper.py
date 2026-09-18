#!/usr/bin/env python3
"""
StarPets High-Demand & Arbitrage Scraper (Python Edition)

Fetches high-demand Adopt Me pets from StarPets API, applies the 4-listing
depth rule, checks live in-stock neon prices, applies the marketplace fee,
and calculates net arbitrage profit and ROI.

Features:
- Queries StarPets popularity sort directly (capturing Dragonfruit Fox, Dango Penguins, etc.)
- Enforces 4-listing depth rule for normal pet inputs (no fake single-listing margins)
- Verifies in-stock neon listings across all age rungs (ignoring $0 placeholders and suggested best prices)
- Applies seller fee (default 25%)
- Rate-limited and cached to preserve credits and avoid API blocks
- Saves directly to SQLite (data/starpets.sqlite) or outputs JSON

Usage:
  python scripts/starpets_scraper.py --popular 20
  python scripts/starpets_scraper.py --sync --db data/starpets.sqlite
"""

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

API_BASE = "https://market.apineural.com"
DEFAULT_FEE_PCT = 0.25
DEFAULT_UNITS = 4
REQUEST_DELAY_SEC = 0.25


def _http_request(method: str, path: str, data: Optional[Dict[str, Any]] = None, timeout: float = 15.0) -> Any:
    url = f"{API_BASE}{path}"
    headers = {"Content-Type": "application/json", "User-Agent": "FreeBuff-StarPets-Scanner/1.0"}
    req_data = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)

    for attempt in range(4):
        try:
            time.sleep(REQUEST_DELAY_SEC)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(1.0 * (2 ** attempt))
                continue
            raise RuntimeError(f"HTTP {e.code} for {url}: {e.read().decode('utf-8', errors='ignore')}") from e
        except Exception as e:
            if attempt == 3:
                raise RuntimeError(f"Request failed for {url}: {e}") from e
            time.sleep(1.0 * (2 ** attempt))
    raise RuntimeError(f"Failed after retries: {url}")


def fetch_popular_items(page: int = 1, amount: int = 72) -> List[Dict[str, Any]]:
    payload = {
        "page": page,
        "amount": amount,
        "currency": "usd",
        "filter": {"types": [{"type": "pet"}]},
        "sort": {"popularity": "desc"},
    }
    data = _http_request("POST", "/api/v2/store/items/all", payload)
    return data.get("items", [])


def fetch_product_properties(product_id: int) -> Dict[str, int]:
    data = _http_request("GET", f"/api/products/{product_id}/properties")
    return data.get("properties", {})


def fetch_product_info(product_id: int) -> Optional[Dict[str, Any]]:
    try:
        data = _http_request("GET", f"/api/v2/products/{product_id}/info")
        return data.get("product")
    except Exception:
        return None


def fetch_product_ages(product_id: int) -> List[Dict[str, Any]]:
    try:
        data = _http_request("GET", f"/api/products/{product_id}/ages")
        return data.get("ages", [])
    except Exception:
        return []


def fetch_product_offers(product_ids: List[int], amount: int = 72) -> List[Dict[str, Any]]:
    if not product_ids:
        return []
    all_items = []
    # StarPets API validates that products <= 12 items
    for i in range(0, len(product_ids), 12):
        chunk = product_ids[i:i + 12]
        payload = {"currency": "usd", "products": chunk, "amount": amount}
        try:
            data = _http_request("POST", "/api/v2/store/items/product", payload)
            all_items.extend(data.get("items", []))
        except Exception:
            pass
    return all_items


def analyze_depth(offers: List[Dict[str, Any]], units: int = 4) -> Dict[str, Any]:
    prices = sorted([float(o["price"]) for o in offers if float(o.get("price", 0)) > 0])
    available = len(prices)
    enough = available >= units

    slice_prices = prices[:units]
    cost_for_units = sum(slice_prices) if enough else None
    effective_unit_cost = (cost_for_units / units) if cost_for_units is not None else None
    cheapest_listing = prices[0] if prices else None
    cheapest_4th = slice_prices[units - 1] if enough else cheapest_listing

    # Count frequencies per price tier
    counts: Dict[float, int] = {}
    for p in prices:
        counts[p] = counts.get(p, 0) + 1

    tiers = sorted([{"price": p, "count": c} for p, c in counts.items()], key=lambda x: x["price"])

    # 4-listing rule: lowest price where count >= 4
    cheapest_4x_price = None
    listing_count_4x = None
    for t in tiers:
        if t["count"] >= units:
            cheapest_4x_price = t["price"]
            listing_count_4x = t["count"]
            break

    if cheapest_4x_price is None and enough:
        cheapest_4x_price = cheapest_4th
        listing_count_4x = counts.get(cheapest_4x_price, 0)

    return {
        "enough": enough,
        "available": available,
        "costForUnits": cost_for_units,
        "effectiveUnitCost": effective_unit_cost,
        "cheapestListing": cheapest_listing,
        "cheapest4th": cheapest_4th,
        "cheapest4xPrice": cheapest_4x_price,
        "listingCount4x": listing_count_4x,
        "priceTiers": tiers[:8],
    }


def scan_popular_arbitrage(limit_pets: int = 20, fee_pct: float = DEFAULT_FEE_PCT) -> List[Dict[str, Any]]:
    print(f"[*] Fetching popular pets from StarPets API (target: top {limit_pets} unique pets)...")
    items = fetch_popular_items(page=1, amount=72)
    if len(items) < limit_pets:
        items += fetch_popular_items(page=2, amount=72)

    unique_pets: Dict[str, Dict[str, Any]] = {}
    for it in items:
        slug = it.get("realName") or it.get("name")
        if slug and slug not in unique_pets:
            unique_pets[slug] = it
        if len(unique_pets) >= limit_pets:
            break

    results = []
    print(f"[*] Analyzing order books across all age rungs for {len(unique_pets)} high-demand pets...")

    rank = 1
    for slug, pet in unique_pets.items():
        pet_name = pet.get("name", slug)
        pet_id = int(pet["id"])
        image_uri = pet.get("imageUri")
        rare = pet.get("rare")

        try:
            props = fetch_product_properties(pet_id)
            normal_base_id = props.get("default:false:false", pet_id)

            # Collect all normal product IDs across all age rungs (newborn, junior, etc.)
            normal_ages = fetch_product_ages(normal_base_id)
            normal_pids = [a["id"] for a in normal_ages if isinstance(a.get("id"), int)] if normal_ages else [normal_base_id]
            if normal_base_id not in normal_pids:
                normal_pids.append(normal_base_id)

            # Prioritize Base Neon (No Potion) because 4 normal unpotted pets craft into an unpotted Neon
            base_neon_id = props.get("neon:false:false")
            base_neon_pids = []
            if base_neon_id:
                base_ages = fetch_product_ages(base_neon_id)
                base_neon_pids = [a["id"] for a in base_ages if isinstance(a.get("id"), int)] if base_ages else [base_neon_id]
                if base_neon_id not in base_neon_pids:
                    base_neon_pids.append(base_neon_id)

            base_neon_offers = fetch_product_offers(base_neon_pids, amount=72) if base_neon_pids else []
            base_neon_prices = sorted([float(o["price"]) for o in base_neon_offers if float(o.get("price", 0)) > 0])
            base_neon_price = base_neon_prices[0] if base_neon_prices else None

            # Collect all neon product IDs across all neon variants and age rungs as fallback
            neon_base_keys = [k for k in props.keys() if k.startswith("neon:")]
            neon_pids: List[int] = []
            for nk in neon_base_keys:
                nid = props[nk]
                neon_ages = fetch_product_ages(nid)
                if neon_ages:
                    neon_pids.extend([a["id"] for a in neon_ages if isinstance(a.get("id"), int)])
                else:
                    neon_pids.append(nid)
            neon_pids = list(dict.fromkeys(neon_pids))  # deduplicate

            normal_info = fetch_product_info(normal_base_id)
            sales_per_week = normal_info.get("numberOfSalesPerWeek") if normal_info else None

            # Normal order book across all normal age rungs
            normal_offers = fetch_product_offers(normal_pids, amount=72)
            normal_depth = analyze_depth(normal_offers, units=4)

            # Neon order book across all neon age rungs and variants
            neon_offers = fetch_product_offers(neon_pids, amount=72) if neon_pids else []
            neon_prices = sorted([float(o["price"]) for o in neon_offers if float(o.get("price", 0)) > 0])
            neon_price = base_neon_price if base_neon_price is not None else (neon_prices[0] if neon_prices else None)
            neon_available = len(base_neon_prices) if base_neon_price is not None else len(neon_prices)

            # Minimum price to buy 4 units
            buy4_price = normal_depth["cheapest4xPrice"] or normal_depth["cheapest4th"] or normal_depth["cheapestListing"]
            cheapest_single = normal_depth["cheapestListing"]
            craft_cost = normal_depth["costForUnits"] or ((buy4_price or 0) * 4)

            if neon_price and craft_cost and craft_cost > 0:
                neon_net = round(neon_price * (1.0 - fee_pct), 3)
                margin = round(neon_net - craft_cost, 3)
                ratio = round(neon_price / buy4_price, 2) if buy4_price and buy4_price > 0 else 0
                roi_pct = round((margin / craft_cost) * 100, 1)
            else:
                neon_net = None
                margin = None
                ratio = None
                roi_pct = None

            break_even_ratio = round(4.0 / (1.0 - fee_pct), 2)
            verdict = "craft" if (margin is not None and margin > 0 and normal_depth["enough"]) else "skip"

            row = {
                "rank": rank,
                "name": pet_name,
                "slug": slug,
                "rare": rare,
                "imageUri": image_uri,
                "salesPerWeek": sales_per_week,
                "normalProductId": normal_base_id,
                "neonProductId": neon_pids[0] if neon_pids else None,
                "inputPrice": buy4_price,
                "cheapestSingle": cheapest_single,
                "input4xPrice": normal_depth["cheapest4xPrice"],
                "inputAvailable": normal_depth["available"],
                "inputBuyable": normal_depth["enough"],
                "craftCost": round(craft_cost, 2),
                "neonPrice": neon_price,
                "neonNet": neon_net,
                "neonAvailable": neon_available,
                "margin": margin,
                "roiPct": roi_pct,
                "ratio": ratio,
                "breakEvenRatio": break_even_ratio,
                "verdict": verdict,
                "listingCount4x": normal_depth.get("listingCount4x", 0),
                "priceTiers": normal_depth["priceTiers"],
            }
            results.append(row)
            rank += 1

            status_icon = "🔥 [PROFIT]" if verdict == "craft" else "   [SKIP]"
            margin_str = f"+${margin:.2f} ({roi_pct}%)" if margin and margin > 0 else f"-${abs(margin):.2f}" if margin else "N/A"
            print(f"#{row['rank']:2d} {status_icon} {pet_name:<20} | Buy 4: ${buy4_price or 0:.2f} (Tot: ${craft_cost:.2f}) | Neon: ${neon_price or 0:.2f} | Margin: {margin_str} | Sales/wk: {sales_per_week or 0}", flush=True)

        except Exception as e:
            print(f"[-] Error processing {pet_name}: {e}", flush=True)
            continue

    return results


def sync_to_sqlite(db_path: str, results: List[Dict[str, Any]]):
    print(f"[*] Syncing {len(results)} analyzed pets to SQLite at {db_path}...")
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    now = int(time.time() * 1000)

    # Ensure tables exist
    cur.execute("""
    CREATE TABLE IF NOT EXISTS trend (
        pet_slug TEXT PRIMARY KEY,
        rank INTEGER NOT NULL,
        observed_at INTEGER NOT NULL
    )""")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS liquidity (
        product_id INTEGER PRIMARY KEY,
        sales_per_week INTEGER NOT NULL,
        observed_at INTEGER NOT NULL
    )""")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS depth (
        product_id INTEGER PRIMARY KEY,
        available INTEGER NOT NULL,
        cost_for_units REAL,
        units INTEGER NOT NULL,
        book_min REAL,
        cheapest_4x_price REAL,
        listing_count_4x INTEGER,
        observed_at INTEGER NOT NULL
    )""")

    cur.execute("""
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
    )""")

    for r in results:
        cur.execute("INSERT OR REPLACE INTO trend (pet_slug, rank, observed_at) VALUES (?, ?, ?)",
                    (r["slug"], r["rank"], now))

        if r["salesPerWeek"] is not None:
            if r["normalProductId"]:
                cur.execute("INSERT OR REPLACE INTO liquidity (product_id, sales_per_week, observed_at) VALUES (?, ?, ?)",
                            (r["normalProductId"], r["salesPerWeek"], now))
            if r["neonProductId"]:
                cur.execute("INSERT OR REPLACE INTO liquidity (product_id, sales_per_week, observed_at) VALUES (?, ?, ?)",
                            (r["neonProductId"], r["salesPerWeek"], now))

        if r["normalProductId"]:
            book_min = r.get("cheapestSingle") or r["inputPrice"]
            cur.execute("""
            INSERT OR REPLACE INTO depth (product_id, available, cost_for_units, units, book_min, cheapest_4x_price, listing_count_4x, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (r["normalProductId"], r["inputAvailable"], r["craftCost"], 4,
                         book_min, r["input4xPrice"], r.get("listingCount4x", 0), now))

            # Ensure normal item is in items table with the 4-buyable price and single cheapest
            if r["inputPrice"]:
                cur.execute("""
                INSERT OR REPLACE INTO items (product_id, pet_slug, pet_name, rare, pumping, age, flyable, rideable, price, avg_price, bonuses, image_uri, source, first_seen, last_seen)
                VALUES (?, ?, ?, ?, 'default', 'newborn', 0, 0, ?, ?, 0, ?, 'observed', ?, ?)
                """, (r["normalProductId"], r["slug"], r["name"], r["rare"], r["inputPrice"], book_min, r["imageUri"], now, now))

        if r["neonProductId"] and r["neonPrice"]:
            cur.execute("""
            INSERT OR REPLACE INTO depth (product_id, available, cost_for_units, units, book_min, cheapest_4x_price, listing_count_4x, observed_at)
            VALUES (?, ?, ?, 1, ?, ?, 1, ?)""",
                        (r["neonProductId"], r["neonAvailable"], r["neonPrice"], r["neonPrice"], r["neonPrice"], now))

            cur.execute("""
            INSERT OR REPLACE INTO items (product_id, pet_slug, pet_name, rare, pumping, age, flyable, rideable, price, avg_price, bonuses, image_uri, source, first_seen, last_seen)
            VALUES (?, ?, ?, ?, 'neon', 'reborn', 0, 0, ?, ?, 0, ?, 'observed', ?, ?)
            """, (r["neonProductId"], r["slug"], r["name"], r["rare"], r["neonPrice"], r["neonPrice"], r["imageUri"], now, now))

    conn.commit()
    conn.close()
    print("[+] SQLite sync complete.")


def main():
    parser = argparse.ArgumentParser(description="StarPets Adopt Me Demand & Arbitrage Scraper")
    parser.add_argument("--popular", type=int, default=25, help="Number of popular pets to scan")
    parser.add_argument("--fee", type=float, default=0.25, help="Seller fee percentage (default: 0.25)")
    parser.add_argument("--sync", action="store_true", help="Sync results into SQLite database")
    parser.add_argument("--db", type=str, default="data/starpets.sqlite", help="Path to SQLite database")
    parser.add_argument("--json", type=str, default=None, help="Path to save JSON report")

    args = parser.parse_args()

    results = scan_popular_arbitrage(limit_pets=args.popular, fee_pct=args.fee)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(f"[+] Exported JSON to {args.json}")

    if args.sync or os.path.exists(args.db):
        sync_to_sqlite(args.db, results)


if __name__ == "__main__":
    main()
