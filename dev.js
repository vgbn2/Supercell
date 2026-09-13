// dev.js — Zero-dependency local Node server for CR Boosting Calculator
// Serves docs/ static files + proxies Supercell API via developer's whitelisted IP

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 8787;
const DOCS_DIR = path.join(__dirname, "docs");

// 1. Load .env file (simple stdlib parser)
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, "utf8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = val;
  }
  return env;
}

const ENV = { ...loadEnv(), ...process.env };
const API_TOKEN = ENV.API_ROYALE_TOKEN || ENV.CR_API_KEY || "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8"
};

const VALID_TAG_CHARS = new Set("0289CGJLPQRUVY".split(""));

// Card Role Categorization
const ROLE_MAP = {
  // Tower Troops & Defensive Buildings (Weight 1.6x)
  tower: new Set([
    "Tower Princess", "Cannoneer", "Dagger Duchess", "Baby Goblins",
    "Tesla", "Cannon", "Inferno Tower", "Bomb Tower", "Tombstone"
  ]),
  // Win Conditions (Weight 1.5x)
  win_condition: new Set([
    "Hog Rider", "Goblin Barrel", "Golem", "Royal Giant", "Miner",
    "Lava Hound", "Balloon", "Graveyard", "X-Bow", "Mortar",
    "Wall Breakers", "Ram Rider", "Battle Ram", "Royal Hogs",
    "Elixir Golem", "Goblin Giant", "Electro Giant", "Goblin Drill"
  ]),
  // Spells (Weight 1.3x)
  spell: new Set([
    "The Log", "Zap", "Fireball", "Arrows", "Poison", "Rocket",
    "Giant Snowball", "Tornado", "Lightning", "Earthquake", "Void",
    "Freeze", "Barbarian Barrel", "Royal Delivery", "Mirror", "Clone", "Rage"
  ]),
  // Cheap Cycle (Weight 0.7x)
  cycle: new Set([
    "Skeletons", "Ice Spirit", "Electro Spirit", "Fire Spirit",
    "Heal Spirit", "Bats", "Goblins", "Spear Goblins"
  ])
};

function getCardRole(cardName) {
  if (ROLE_MAP.tower.has(cardName)) return "tower";
  if (ROLE_MAP.win_condition.has(cardName)) return "win_condition";
  if (ROLE_MAP.spell.has(cardName)) return "spell";
  if (ROLE_MAP.cycle.has(cardName)) return "cycle";
  return "support"; // Default weight 1.0x
}

const MOCK_PLAYER = {
  tag: "#20U0LQ802Y",
  name: "ProRoyaleKing",
  expLevel: 15,
  trophies: 7850,
  bestTrophies: 8200,
  cards: [
    { name: "Knight", rarity: "common", displayLevel: 15, role: "support", count: 5000 },
    { name: "Archers", rarity: "common", displayLevel: 14, role: "support", count: 2000 },
    { name: "Hog Rider", rarity: "rare", displayLevel: 14, role: "win_condition", count: 800 },
    { name: "Fireball", rarity: "rare", displayLevel: 15, role: "spell", count: 1200 },
    { name: "P.E.K.K.A", rarity: "epic", displayLevel: 14, role: "support", count: 150 },
    { name: "Goblin Barrel", rarity: "epic", displayLevel: 14, role: "win_condition", count: 180 },
    { name: "The Log", rarity: "legendary", displayLevel: 14, role: "spell", count: 20 },
    { name: "Little Prince", rarity: "champion", displayLevel: 13, role: "support", count: 6 },
    { name: "Arrows", rarity: "common", displayLevel: 15, role: "spell", count: 6000 },
    { name: "Tesla", rarity: "common", displayLevel: 14, role: "tower", count: 3000 }
  ],
  _mock: true
};

function normalizePlayerTag(raw) {
  if (!raw || typeof raw !== "string") return null;
  let tag = raw.trim().toUpperCase().replace(/^#/, "");
  tag = tag.replace(/O/g, "0").replace(/B/g, "8");
  if (tag.length < 3 || tag.length > 15) return null;
  for (const ch of tag) {
    if (!VALID_TAG_CHARS.has(ch)) return null;
  }
  return tag;
}

// In-memory cache: tag -> { data, expiresAt } (TTL 180s)
const CACHE = new Map();
const CACHE_TTL_MS = 180 * 1000;

function fetchUpstreamPlayer(tag) {
  return new Promise((resolve, reject) => {
    const encodedTag = "%23" + tag;
    const options = {
      hostname: "api.clashroyale.com",
      port: 443,
      path: `/v1/players/${encodedTag}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        Accept: "application/json",
        "User-Agent": "CR-Boosting-Calculator-Dev/1.0"
      }
    };

    const req = https.request(options, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          reject(new Error("Failed to parse Supercell API response: " + e.message));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("Upstream timeout connecting to api.clashroyale.com"));
    });
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname;

  // 1. Health Route
  if (pathname === "/health" || pathname === "/status") {
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      mode: API_TOKEN ? "live" : "mock",
      tokenConfigured: Boolean(API_TOKEN),
      cachedEntries: CACHE.size,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 2. Player API Routes (/player/:tag, /api/player/:tag, or ?tag=)
  const pathParts = pathname.split("/").filter(Boolean);
  let rawTag = null;

  if (pathParts[0] === "player" && pathParts[1]) {
    rawTag = decodeURIComponent(pathParts[1]);
  } else if (pathParts[0] === "api" && pathParts[1] === "player" && pathParts[2]) {
    rawTag = decodeURIComponent(pathParts[2]);
  } else if (reqUrl.searchParams.get("tag")) {
    rawTag = reqUrl.searchParams.get("tag");
  }

  if (rawTag !== null) {
    const cleanTag = normalizePlayerTag(rawTag);
    if (!cleanTag) {
      res.writeHead(400, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "INVALID_TAG",
        message: "Invalid Clash Royale player tag character set. Use Base-14 characters [0289CGJLPQRUVY]."
      }));
      return;
    }

    // Mock Mode fallback
    if (reqUrl.searchParams.get("mock") === "true" || !API_TOKEN) {
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json", "X-Mode": "Mock" });
      res.end(JSON.stringify({ ...MOCK_PLAYER, tag: "#" + cleanTag }));
      return;
    }

    // Check Cache
    const cached = CACHE.get(cleanTag);
    if (cached && cached.expiresAt > Date.now()) {
      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60, s-maxage=180",
        "X-Cache": "HIT"
      });
      res.end(JSON.stringify(cached.data));
      return;
    }

    try {
      const { status, data } = await fetchUpstreamPlayer(cleanTag);

      if (status !== 200) {
        const errorMap = {
          400: { code: "BAD_TAG", msg: "Invalid tag format reported by Supercell." },
          403: { code: "AUTH_ERROR", msg: "Supercell API key invalid or IP not whitelisted." },
          404: { code: "PLAYER_NOT_FOUND", msg: "Player tag not found in Clash Royale." },
          429: { code: "RATE_LIMITED", msg: "Supercell API rate limit reached. Try again shortly." },
          503: { code: "MAINTENANCE", msg: "Supercell servers currently under maintenance." }
        };
        const err = errorMap[status] || { code: "UPSTREAM_ERROR", msg: "Supercell API error." };
        res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.code, message: err.msg, status }));
        return;
      }

      // Sanitization pipeline
      const sanitized = {
        tag: data.tag || ("#" + cleanTag),
        name: data.name || "Unknown",
        expLevel: data.expLevel || 1,
        trophies: data.trophies || 0,
        bestTrophies: data.bestTrophies || data.trophies || 0,
        cards: (data.cards || []).map(c => ({
          name: c.name,
          rarity: (c.rarity || "common").toLowerCase(),
          displayLevel: c.displayLevel || (c.level + (16 - (c.maxLevel || 14))),
          role: getCardRole(c.name),
          count: c.count || 0
        }))
      };

      // Store in Cache
      CACHE.set(cleanTag, { data: sanitized, expiresAt: Date.now() + CACHE_TTL_MS });

      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60, s-maxage=180",
        "X-Cache": "MISS"
      });
      res.end(JSON.stringify(sanitized));
      return;
    } catch (err) {
      res.writeHead(502, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GATEWAY_ERROR", message: err.message }));
      return;
    }
  }

  // 3. Static File Server for docs/
  let filePath = path.join(DOCS_DIR, pathname === "/" ? "index.html" : pathname);
  const ext = path.extname(filePath).toLowerCase();

  // Prevent directory traversal
  if (!filePath.startsWith(DOCS_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // If extensionless, try .html
      if (!ext && fs.existsSync(filePath + ".html")) {
        filePath += ".html";
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }
    }

    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[CR Boosting Dev Server] Running at http://localhost:${PORT}`);
    console.log(` - Frontend: http://localhost:${PORT}/`);
    console.log(` - Health:   http://localhost:${PORT}/health`);
    console.log(` - Proxy API: http://localhost:${PORT}/player/UGV0UCVQ`);
    console.log(` - Mode:     ${API_TOKEN ? "LIVE (Whitelisted IP Proxy)" : "MOCK (No token configured)"}`);
  });
}

module.exports = { server, normalizePlayerTag, getCardRole, ROLE_MAP };
