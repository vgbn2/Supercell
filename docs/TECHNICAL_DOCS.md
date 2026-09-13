# CR Boosting Calculator — Technical Documentation & Specification

> Audience: Developer (vgbn) and future maintainers  
> Last Updated: 2026-09  
> Target Platform: GitHub Pages (`docs/`) + Local Dev Server (`dev.js`) + Cloudflare Worker Proxy (`worker/`)

---

## 1. System Overview

The **CR Boosting Calculator** is a client-facing pricing estimator and account inspection engine for Clash Royale boosting services. Clients enter their player tag, choose their starting and target leagues/packages, and select an urgency deadline. The system fetches official account telemetry, analyzes card level strength, and calculates a dynamic price range in Vietnamese Dong (VND).

### Key Business Goals
1. **Zero-Negotiation Pricing**: Eliminates manual price bargaining by anchoring customer expectations through algorithmic pricing.
2. **Account Truth Enforcement**: Pulls live card levels directly from Supercell API to prevent clients from misreporting underleveled decks.
3. **Automated Risk Refusal**: Rejects accounts with card level deficits $\Delta \ge 5$, protecting boosters from negative drift on ladder stone steps.

---

## 2. Architecture & Technology Stack

```
[Client Browser (GitHub Pages / Localhost)]
      │
      │ 1. GET /player/:tag
      ▼
[Local Dev Server (dev.js) OR Cloudflare Worker] ──(In-Memory/Edge Cache 180s)
      │
      │ 2. Fetch with Bearer Token from Whitelisted IP
      ▼
[Official Supercell Clash Royale API]
(https://api.clashroyale.com/v1)
      │
      ▼
[Payload Sanitizer & Role Classifier] ──(Strips 90% telemetry)──► Returns <3KB JSON
      │
      ▼
[Browser Client-Side Engine]
(Computes VND price, Role-weighted Delta, Pack discount, Urgency surcharge)
```

### Technology Selection Justification
- **Frontend (`docs/index.html`)**: Pure Vanilla HTML5 + ES6+ JavaScript + Modern CSS Custom Properties.
  - Zero build tooling (no Vite, Webpack, or npm dependencies).
  - Micro-footprint (<20 KB total), sub-150ms First Contentful Paint.
  - Deploys instantly to GitHub Pages upon git push to `main`.
- **Local Dev Server (`dev.js`)**: Native Node.js standard library (`node:http`, `node:https`, `node:fs`, `node:path`).
  - Zero npm dependencies.
  - Proxies Supercell API directly from developer's whitelisted machine IP (`113.190.193.13`), avoiding Cloudflare dynamic egress IP 403 blocks during development.
  - Serves `docs/` static files, provides `GET /health` and `GET /player/:tag` with in-memory 180s cache.
- **Edge Backend (`worker/src/index.js`)**: Cloudflare Worker (V8 Isolate).
  - Isolates official Supercell `CR_API_KEY` away from client browser.
  - Fast global edge response (<10ms).
  - Integrated edge caching (`caches.default`) with 180s TTL to prevent Supercell rate limits.
  - Tag sanitization and fallback offline mock mode.
- **Verification Harness (`test/pricing_test.js`)**: Native Node.js `node:assert`. Zero external testing dependencies.

---

## 3. Supercell API Integration & Tag Normalization

### 3.1 Tag Character Set & Auto-Correction
Supercell player tags use a strict Base-14 alphabet:
$$\text{Charset} = \{0, 2, 8, 9, P, Y, L, Q, G, R, J, C, U, V\}$$

Letters `O, I, S, B, Z, D` and digits `1, 5` are excluded from Supercell's encoding to eliminate visual and OCR ambiguity.

#### Auto-Correction Pipeline
Any user input containing `O` is **always digit `0` (zero)**:
```javascript
function normalizePlayerTag(raw) {
  if (!raw || typeof raw !== "string") return null;
  let tag = raw.trim().toUpperCase().replace(/^#/, "");
  tag = tag.replace(/O/g, "0").replace(/B/g, "8");
  if (tag.length < 3 || tag.length > 15) return null;
  for (const ch of tag) {
    if (!VALID_TAG_CHARS.has(ch)) return null;
  }
  return "#" + tag;
}
```

#### Live Verification (`#UGV0UCVQ` vs `#UGVOUCVQ`)
Empirical testing against `https://api.clashroyale.com/v1/players/`:
- Query `%23UGV0UCVQ` (digit `0`): Returns `200 OK` (Player: `deadpool`, King Lvl: 16, 14,000 Trophies).
- Query `%23UGVOUCVQ` (letter `O`): Returns `404 Not Found` (`{"reason":"notFound"}`).
- Auto-normalization ensures `#UGVOUCVQ` $\to$ `#UGV0UCVQ`, resolving smoothly without client error.

### 3.2 Card Level Normalization
The official Supercell API returns raw card levels offset by rarity. The normalized scale runs up to Level 16:
$$\text{displayLevel} = \text{card.displayLevel} \lor (\text{card.level} + (16 - \text{card.maxLevel}))$$

---

## 4. Game Theory & Pricing Economics

### 4.1 Path of Legends Random Walk Model
In Path of Legends stone steps (L7–L9), ladder advancement behaves as a 1D random walk with reflecting lower barrier and absorbing upper threshold:
$$E[T] = \frac{N}{2p - 1}$$
Where:
- $N$: Steps required to reach target league.
- $p$: Booster win rate.
- Drift: $\mu = 2p - 1$.
- Baseline booster parity win rate ($p_0 = 0.85$): $E[T] = \frac{10}{2(0.85) - 1} \approx 14.3\text{ matches}$ (~50 minutes).

### 4.2 Role-Weighted Card Deficit & Effective Win Rate Decay
Stat scaling in Clash Royale adds $+10.25\%$ HP and damage per level gap ($\Delta$). Not all cards are equally sensitive to level deficits: Tower Troops and Win Conditions are far more critical than cycle distraction cards.

#### Card Role Weighting Table:
- **Tower Troops / Defensive Buildings** ($w = 1.6$): Princess Tower, Cannoneer, Dagger Duchess, Tesla, Cannon, Inferno Tower.
- **Win Conditions** ($w = 1.5$): Hog Rider, Goblin Barrel, Golem, Royal Giant, Miner, Lava Hound, Balloon, Graveyard, X-Bow, Mortar, etc.
- **Key Spells** ($w = 1.3$): The Log, Zap, Fireball, Arrows, Poison, Rocket, Snowball, Tornado.
- **Support / Mid-range** ($w = 1.0$): Knight, Musketeer, Valkyrie, Wizard, P.E.K.K.A, Mega Minion.
- **Cycle / Distraction** ($w = 0.7$): Skeletons, Ice Spirit, Electro Spirit, Fire Spirit, Bats, Goblins.

Role-weighted average level:
$$\bar{L}_w = \frac{\sum_{i \in \text{deck}} w_i \cdot L_i}{\sum_{i \in \text{deck}} w_i}$$

Effective level deficit:
$$\Delta = \max\left(0, \text{ceil}(L_{\text{expected}} - \bar{L}_w)\right)$$

Effective win rate:
$$p(\Delta) = \max\left(0.51, 0.85 - 0.068 \cdot \Delta\right)$$

| $\Delta$ | $p(\Delta)$ | Drift $\mu$ | $E[T]$ for 10 steps | Deficit Multiplier |
|---|---|---|---|---|
| **0** | 0.850 | +0.70 | 14.3 matches | **1.0x** |
| **1** | 0.782 | +0.56 | 17.7 matches | **1.3x** |
| **2** | 0.714 | +0.43 | 23.4 matches | **1.7x** |
| **3** | 0.646 | +0.29 | 34.2 matches | **2.2x** |
| **4** | 0.578 | +0.16 | 64.1 matches | **3.0x** |
| **$\ge 5$** | $\le 0.510$ | $\le +0.02$ | $\ge 500$ matches | **REFUSED** (`status: 'REFUSED'`) |

---

## 5. Pricing Formula (VND)

### 5.1 Formula Definition
$$\text{Nominal Price} = \text{roundThousands}\left( \left( \sum_{l \in \text{selected}} \text{BASE} \times \text{LEAGUE\_MULT}[l] \times \text{DELTA\_MULT}[\Delta_l] \right) \times \text{DISCOUNT} \times \text{URGENCY} \right)$$

- $\text{BASE} = 40.000\text{ ₫}$.
- $\text{LEAGUE\_MULT}$:
  - L1 (Challenger I): 1.0x (40.000 ₫)
  - L2 (Challenger II): 1.2x (48.000 ₫)
  - L3 (Challenger III): 1.5x (60.000 ₫)
  - L4 (Master I): 1.8x (72.000 ₫)
  - L5 (Master II): 2.2x (88.000 ₫)
  - L6 (Master III): 2.8x (112.000 ₫)
  - L7 (Grand Champion): 3.5x (140.000 ₫)
  - UC (Ultimate Champion): 4.5x (180.000 ₫)
- **Pack Discounts**: 1 league (0%), 2 leagues (5%), 3–7 leagues (10%), $\ge 8$ leagues (15%).
- **Urgency Multipliers**: Standard $\ge 3$ days (1.0x), Weekend 1 day (2.0x), Weekday rush (4.0x).
- **Price Range Variance**: $[ \text{roundThousands}(\text{Base} \times 0.9), \text{roundThousands}(\text{Base} \times 1.3) ]$.

---

## 6. Supported Packages

1. **Path of Legends (PoL)**: Step-by-step ladder climbs from Unranked (L0) to Ultimate Champion (UC).
2. **Trophy Road**: 50.000 ₫ per 500 trophies gained.

---

## 7. Developer & Deployment Guide

### Local Development
```bash
# Start zero-dependency local Node dev server
node dev.js

# Run standalone unit & formula test suite
node test/pricing_test.js

# Verify worker syntax
node --check worker/src/index.js
```

### Cloudflare Worker Deployment
```bash
cd worker
npm install -g wrangler
wrangler login
wrangler secret put CR_API_KEY
wrangler deploy
```

### GitHub Pages Deployment
1. Push repository to GitHub.
2. In Repository Settings: **Pages $\to$ Build and deployment $\to$ Branch: `main` / Folder: `/docs`**.
3. Live site is accessible at `https://<username>.github.io/<repo>/`.
