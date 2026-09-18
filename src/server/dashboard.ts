/**
 * The web client.
 *
 * A luxury coffee-themed, high-contrast, multi-screen dashboard for Adopt Me StarPets
 * craft arbitrage and price intelligence.
 *
 * Design Guarantees:
 *  1. 3D Visual Pie & Donut Charts: True 3D isometric perspective, cylindrical depth extrusion,
 *     specular gradient lighting, interactive 3D hover lift, and visual pet avatars.
 *  2. Android Multi-Screen Architecture: 5 distinct screens (Home Dashboard, In-Demand Pets,
 *     Profitable Crafts, Full Market, Price Alerts) navigated via an Android Bottom Navigation Bar
 *     (and top desktop navbar), eliminating massive 33,000px continuous scrolling.
 *  3. Table Subtitle Cleanup: Removed redundant subtext (each 4x depth, 4 unpotted, etc.)
 *     from table cells for bold, crisp, professional pricing.
 *  4. Clickable Pet Cards & Android-Optimized Detail Window: Tap any pet to inspect; formatted
 *     strictly with zero horizontal overflow on mobile screens.
 *  5. Complete Trending Catalog & Out-of-Stock Transparency: Resolves top 100 pets and clearly
 *     displays 'Out of Stock on StarPets' when no player has listed a neon, rather than mystery dashes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let cachedLogoDataUri = '';
function getLogoDataUri(): string {
  if (cachedLogoDataUri) return cachedLogoDataUri;
  const candidates = [
    join(process.cwd(), 'assets', 'logo.jpg'),
    join(process.cwd(), 'public', 'logo.jpg'),
    join(process.cwd(), 'android', 'app', 'src', 'main', 'res', 'drawable', 'app_logo.png'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const mime = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
        cachedLogoDataUri = `data:${mime};base64,` + readFileSync(p).toString('base64');
        return cachedLogoDataUri;
      }
    } catch {}
  }
  return '/logo.jpg';
}

export interface DashboardOptions {
  demoRowLabel?: string;
}

export function dashboardHtml(options: DashboardOptions = {}): string {
  const logoSrc = getLogoDataUri();
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>Pet Pricer — StarPets Valuation & Craft Arbitrage Scanner</title>
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
      Enter Dashboard ↗
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
      <button class="nav-btn active" data-screen="home" type="button">🏠 Home</button>
      <button class="nav-btn" data-screen="demand" type="button">🔥 In-Demand</button>
      <button class="nav-btn" data-screen="profitable" type="button">💎 Profitable</button>
      <button class="nav-btn" data-screen="catalog" type="button">📋 Full Market</button>
      <button class="nav-btn" data-screen="alerts" type="button">🎯 Alerts</button>
    </nav>

    <div class="header-actions">
      <div class="live-pill">
        <span class="pulse-dot"></span>
        <span>Auto-Sync in <strong id="countdownTimer">04:59</strong></span>
      </div>
      <button class="btn btn-primary" id="syncPopularBtn" type="button">
        ⚡ Sync Live
      </button>
      <button class="btn" id="themeToggleBtn" type="button">
        🌓 Theme
      </button>
      <a class="btn btn-success" href="/PetPricer.apk" download style="text-decoration:none; display:inline-flex; align-items:center; gap:6px;">
        📲 Download APK
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
        <div class="kpi-sub">Clears 25% StarPets seller fee ↗</div>
      </div>
      <div class="kpi-card demand" onclick="switchScreen('demand')">
        <div class="kpi-label">#1 In-Demand Hot Pet</div>
        <div class="kpi-value" id="kpiTopDemandName">--</div>
        <div class="kpi-sub" id="kpiTopDemandSub">Verified 4-Stock Depth ↗</div>
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
          <div class="pie-title">📊 Market Demand Intelligence & Volume Breakdown</div>
          <div class="pie-sub">Weekly trading volume distribution and rarity share across Adopt Me pets on StarPets</div>
        </div>
        <div class="tag tag-hot" id="totalMarketVolumeBadge">Loading Volume...</div>
      </div>
      <div class="pie-grid">
        <!-- Bar Chart Card 1: Top Demanding Pets -->
        <div class="pie-card" style="align-items: stretch;">
          <div class="pie-card-title">🔥 Top Traded Pets (Weekly Volume Share)</div>
          <div class="pie-legend" id="topPetsLegend" style="width: 100%;"></div>
        </div>
        <!-- Bar Chart Card 2: Rarity Demand Distribution -->
        <div class="pie-card" style="align-items: stretch;">
          <div class="pie-card-title">⭐ Demand Share by Rarity Tier</div>
          <div class="pie-legend" id="rarityLegend" style="width: 100%;"></div>
        </div>
      </div>
    </section>

    <!-- Quick Navigation Callouts -->
    <div class="home-quick-grid">
      <div class="quick-card" onclick="switchScreen('demand')">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:15px; font-weight:900;">🔥 View Top In-Demand Pets</div>
          <span class="tag tag-hot">High Velocity</span>
        </div>
        <div style="font-size:12px; color:var(--text-muted); font-weight:700;">
          Explore Dragonfruit Fox, Dango Penguins, and all highest-traded Adopt Me pets on StarPets.
        </div>
        <button class="btn btn-sm btn-primary" type="button">Open In-Demand Screen →</button>
      </div>
      <div class="quick-card" onclick="switchScreen('profitable')">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:15px; font-weight:900;">💎 View Profitable Crafts</div>
          <span class="tag tag-profit">Positive ROI</span>
        </div>
        <div style="font-size:12px; color:var(--text-muted); font-weight:700;">
          Inspect crafts where Neon sale price after 25% StarPets seller fee exceeds 4x input cost.
        </div>
        <button class="btn btn-sm btn-success" type="button">Open Profitable Screen →</button>
      </div>
    </div>

    <!-- Top Pets Table on Home Screen -->
    <section style="margin-top:24px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <div>
          <h3 style="font-size:18px; font-weight:900;">🔥 Top Trending Pets & Live Craft Margins</h3>
          <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Real-time buy prices, 4-unit craft costs, neon sale values, and profit margins</div>
        </div>
        <button class="btn btn-sm btn-primary" type="button" onclick="switchScreen('catalog')">View All 210+ Pets →</button>
      </div>
      <div id="homePetsContainer"></div>
    </section>
  </div>

  <!-- ================= SCREEN 2: IN-DEMAND PETS ================= -->
  <div class="app-screen" id="screenDemand">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
      <div>
        <h2 style="font-size:18px; font-weight:900;">🔥 High-Demand & Popular Pets</h2>
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
        <h2 style="font-size:18px; font-weight:900;">💎 Profitable Craft Arbitrage</h2>
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
      <div class="form-title">🔍 Market Filter & Search</div>
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
          <div class="alert-title">🎯 Target Price Alerts & Push Notifications</div>
          <div style="font-size: 12px; font-weight: 700; color: var(--text-muted); margin-top: 2px;">
            Alert triggers whenever 4-buy price drops to or below your target price.
          </div>
        </div>
        <button class="btn btn-sm" id="notifyPermBtn" type="button">🔔 Enable Browser Notifications</button>
      </div>
      <div class="alert-form-row">
        <div class="form-group grow-2">
          <label class="form-label" for="alertPetSelect">Select Pet to Watch</label>
          <select class="form-control" id="alertPetSelect">
            <option value="__all__">⭐ ANY PET IN CATALOG (Global Price Drop Alert)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="alertPriceInput">Target Max Price ($)</label>
          <input class="form-control" type="number" id="alertPriceInput" step="0.01" min="0.01" placeholder="e.g. 0.70" />
        </div>
        <button class="btn btn-success" id="addAlertBtn" type="button" style="min-height: 44px;">
          + Set Price Alert (≤ Price)
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
    <span class="mobile-nav-icon">🏠</span>
    <span>Home</span>
  </button>
  <button class="mobile-nav-item" data-screen="demand" type="button">
    <span class="mobile-nav-icon">🔥</span>
    <span>In-Demand</span>
  </button>
  <button class="mobile-nav-item" data-screen="profitable" type="button">
    <span class="mobile-nav-icon">💎</span>
    <span>Profitable</span>
  </button>
  <button class="mobile-nav-item" data-screen="catalog" type="button">
    <span class="mobile-nav-icon">📋</span>
    <span>Market</span>
  </button>
  <button class="mobile-nav-item" data-screen="alerts" type="button">
    <span class="mobile-nav-icon">🎯</span>
    <span>Alerts</span>
  </button>
</nav>

<!-- In-App Notification Toast Banner -->
<div class="toast-alert" id="toastAlert">
  <div class="toast-icon">🚨</div>
  <div class="toast-content">
    <div class="toast-title" id="toastTitle">Target Price Reached!</div>
    <div class="toast-msg" id="toastMsg">Pet is buyable below your target price.</div>
    <a id="toastLink" href="https://starpets.gg/adopt-me/shop" target="_blank" rel="noopener" class="btn btn-sm btn-primary" style="display:inline-block; text-decoration:none;">Open on StarPets ↗</a>
  </div>
  <button class="toast-close" type="button" id="toastClose">✕</button>
</div>

<!-- Inspection Drawer (Android Optimized Bottom Sheet) -->
<div class="drawer-overlay" id="drawerOverlay"></div>
<div class="drawer" id="drawer">
  <div class="drawer-pull-bar"></div>
  <div class="drawer-header">
    <div class="drawer-title" id="drawerTitle">Inspecting Pet</div>
    <button class="btn btn-sm" id="drawerClose" type="button">✕ Close</button>
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
    el('toastTitle').textContent = '🚨 Price Alert: ' + petName;
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
      new Notification('🚨 Price Alert: ' + petName, {
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
      badge.textContent = '🔥 Total Weekly Trades: ' + totalVolume.toLocaleString() + ' pets/wk';
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
    
    var html = '<option value="__all__">⭐ ANY PET IN CATALOG (Global Alert: triggers for any pet)</option>';
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
            ? '<div style="font-size:24px;width:36px;text-align:center;">⭐</div>'
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
            ? '<span class="tag tag-profit" style="animation: pulse 1.5s infinite;">🚨 BUY NOW (&le; $' + pad(a.targetPrice, 2) + ')</span>'
            : '<span class="tag tag-primary">Watching (&le; $' + pad(a.targetPrice, 2) + ')</span>') +
          '<button class="alert-del-btn" type="button" onclick="deleteAlert(' + idx + ')" title="Remove alert">✕</button>' +
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
          el('notifyPermBtn').textContent = '✓ Notifications Enabled';
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
    el('notifyPermBtn').textContent = '✓ Notifications Enabled';
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
    el('kpiBreakEven').textContent = (4 / (1 - state.feePct)).toFixed(2) + '\u00d7';
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
        ? '<span class="tag tag-profit">✓ 4+ In Stock (' + (r.inputAvailable || 4) + ')</span>'
        : r.inputBuyable === false
          ? '<span class="tag tag-loss">⚠️ Only ' + (r.inputAvailable || 0) + ' Listed</span>'
          : '<span class="tag">Checking...</span>';

      var salesBadge = r.salesPerWeek ? '<span class="tag tag-hot">🔥 ' + r.salesPerWeek.toLocaleString() + ' sold/wk</span>' : '';
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
              (r.salesPerWeek ? '<span class="tag tag-hot">🔥 ' + r.salesPerWeek.toLocaleString() + ' sold/wk</span>' : '') +
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
        '<button class="btn btn-sm btn-primary" type="button" onclick="event.stopPropagation(); inspectPet(\\'' + esc(r.slug) + '\\')">Inspect Live Order Book ↗</button>' +
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
        title.textContent = s.petName + ' — Live Order Book';

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
            '<a class="btn btn-sm btn-primary" href="https://starpets.gg/adopt-me/shop/pet/' + encodeURIComponent(s.petSlug) + '/' + s.normalProductId + '" target="_blank" rel="noopener" style="text-decoration:none;">StarPets ↗</a>' +
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
            '<div class="math-row"><span>Break-Even Multiple:</span><span>' + (s.ratio ? pad(s.ratio, 2) + '\u00d7 (Target: ' + pad(s.breakEvenRatio, 2) + '\u00d7)' : '--') + '</span></div>' +
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
    btn.textContent = '⏳ Syncing...';
    fetch('/api/sync-popular', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function() {
        btn.textContent = '✓ Synced!';
        state.secondsRemaining = 300;
        setTimeout(function() {
          btn.disabled = false;
          btn.textContent = '⚡ Sync Live';
        }, 1500);
        fetchData(false);
      })
      .catch(function() {
        btn.disabled = false;
        btn.textContent = '⚡ Sync Live';
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
