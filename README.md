# Clash Royale Boosting Price Calculator & Account Engine

Client-facing pricing calculator and account inspection engine for Clash Royale boosting services. Built with pure Vanilla JS and deployed on GitHub Pages, backed by a local/edge proxy architecture.

---

## Features

- **Automated Account Inspection**: Fetches King Tower level, card levels, trophies, and max card counts directly from the official Clash Royale API.
- **Tag Auto-Correction & Normalization**: Strips `#`, whitespace, and auto-corrects character collisions (e.g. letter `O` $\to$ digit `0`, `B` $\to$ `8`) according to Supercell's Base-14 character set `[0289CGJLPQRUVY]`.
- **Role-Weighted Game-Theory Engine**: Weights card level deficits by tactical archetype (Tower Troops 1.6x, Win Conditions 1.5x, Key Spells 1.3x, Support 1.0x, Cycle 0.7x) rather than naive flat averages.
- **Fair VND Pricing**: Price ranges in Vietnamese Dong (VND) based on 1D random walk Markov ladder drift, level deficits ($\Delta$), multi-league pack discounts, and urgency surcharges.
- **Hard Refusal Safeguard**: Automatically rejects underleveled accounts ($\Delta \ge 5$) where booster effective win rate drops below 50% on stone steps.
- **Supported Packages**:
  - **Path of Legends (PoL)**: League 1 (Challenger I) to League 8 (Ultimate Champion).
  - **Trophy Road**: Scaled per 500 cups gained.
- **One-Click Order Export**: Generates pre-formatted quote summaries with direct deep-links to Zalo and one-click clipboard copying.
- **Zero-Dependency Architecture (Ponytail Full)**:
  - Frontend: Pure HTML5, CSS Custom Properties, ES6+ JS in `docs/index.html`.
  - Local Dev Server: `dev.js` uses native Node.js stdlib (`node:http`, `node:https`, `node:fs`, `node:path`).
  - Edge Proxy: Cloudflare Worker in `worker/src/index.js` with 180s edge caching.

---

## Directory Structure

```
.
├── dev.js                  # Zero-dependency local Node server (serves docs/ + live Supercell proxy + health)
├── docs/
│   ├── index.html          # Static SPA frontend (GitHub Pages deployment)
│   └── TECHNICAL_DOCS.md   # Comprehensive technical manual & game theory specs
├── worker/
│   ├── src/
│   │   └── index.js        # Cloudflare Worker API proxy & caching engine
│   └── wrangler.toml       # Cloudflare Wrangler config
├── test/
│   └── pricing_test.js     # Native Node.js assert test suite
├── .env                    # Local environment variables (API_ROYALE_TOKEN)
└── README.md               # Quickstart and overview
```

---

## Quickstart & Local Verification

### 1. Run Pricing Engine Tests
Run the standalone Node.js test suite to verify formulas, role-weighting, tag normalization, and refusal boundaries from first principles:
```bash
node test/pricing_test.js
```

### 2. Run Local Development Server
Start the zero-dependency local Node server on port 8787:
```bash
node dev.js
```

This starts:
- Frontend: `http://localhost:8787/` (with live auto-detection and health status pill)
- Health Check: `http://localhost:8787/health`
- Live Supercell Proxy: `http://localhost:8787/player/UGV0UCVQ` (queries official API using token in `.env`)

### 3. Verify Worker Syntax
```bash
node --check worker/src/index.js
```

---

## Supercell API & IP Whitelisting Notes

Official Supercell Developer Portal keys contain HMAC-SHA512 (`HS512`) signed IP CIDR whitelists (`limits[].cidrs`). Requests from non-whitelisted IPs return `403 Forbidden` (`{"reason":"accessDenied"}`).
- **Local Dev**: Running `node dev.js` proxies requests directly from your whitelisted machine IP (`113.190.193.13`).
- **Production Edge**: Deploy `worker/src/index.js` to Cloudflare Workers with `CR_API_KEY` or `API_ROYALE_TOKEN` configured.

---

## Deployment

### 1. Cloudflare Worker Proxy
```bash
cd worker
npm install -g wrangler
wrangler login

# Store your Supercell API key as a secure secret
wrangler secret put CR_API_KEY

# Deploy to Cloudflare edge
wrangler deploy
```

### 2. GitHub Pages Frontend
1. Commit and push the repository to GitHub:
   ```bash
   git add .
   git commit -m "CR Boosting Calculator"
   git push origin main
   ```
2. In GitHub Repository Settings:
   - Go to **Settings $\to$ Pages**.
   - Under **Build and deployment**, set **Source** to `Deploy from a branch`.
   - Select Branch `main` and Folder `/docs`.
   - Click **Save**.

The frontend will be live at `https://<username>.github.io/<repo-name>/`.

---

## License

Private repository for personal and authorized boosting service use.  
All Clash Royale assets and trademarks belong to Supercell Oy.
