// Cloudflare Worker Proxy for Clash Royale API
// ponytail: native fetch + edge cache, zero external dependencies

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const VALID_TAG_CHARS = new Set("0289CGJLPQRUVY".split(""));

// Card Role Categorization
const ROLE_MAP = {
  tower: new Set([
    "Tower Princess", "Cannoneer", "Dagger Duchess", "Baby Goblins",
    "Tesla", "Cannon", "Inferno Tower", "Bomb Tower", "Tombstone"
  ]),
  win_condition: new Set([
    "Hog Rider", "Goblin Barrel", "Golem", "Royal Giant", "Miner",
    "Lava Hound", "Balloon", "Graveyard", "X-Bow", "Mortar",
    "Wall Breakers", "Ram Rider", "Battle Ram", "Royal Hogs",
    "Elixir Golem", "Goblin Giant", "Electro Giant", "Goblin Drill"
  ]),
  spell: new Set([
    "The Log", "Zap", "Fireball", "Arrows", "Poison", "Rocket",
    "Giant Snowball", "Tornado", "Lightning", "Earthquake", "Void",
    "Freeze", "Barbarian Barrel", "Royal Delivery", "Mirror", "Clone", "Rage"
  ]),
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
  return "support";
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

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), {
        status: 405,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const token = env.CR_API_KEY || env.API_ROYALE_TOKEN;

    // Health / Status check
    if (pathParts[0] === "health" || pathParts[0] === "status") {
      return new Response(JSON.stringify({
        status: "ok",
        mode: token ? "live" : "mock",
        tokenConfigured: Boolean(token),
        env: "production",
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    // Support both /player/:tag and /api/player/:tag or ?tag=...
    let rawTag = "";
    if (pathParts[0] === "player" && pathParts[1]) {
      rawTag = decodeURIComponent(pathParts[1]);
    } else if (pathParts[0] === "api" && pathParts[1] === "player" && pathParts[2]) {
      rawTag = decodeURIComponent(pathParts[2]);
    } else if (url.searchParams.get("tag")) {
      rawTag = url.searchParams.get("tag");
    } else {
      return new Response(JSON.stringify({
        error: "INVALID_ROUTE",
        message: "Endpoint: GET /player/:tag or GET /health"
      }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const cleanTag = normalizePlayerTag(rawTag);
    if (!cleanTag) {
      return new Response(JSON.stringify({
        error: "INVALID_TAG",
        message: "Invalid Clash Royale player tag character set. Use Base-14 characters [0289CGJLPQRUVY]."
      }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    // Mock Mode fallback
    if (url.searchParams.get("mock") === "true" || !token) {
      return new Response(JSON.stringify({
        ...MOCK_PLAYER,
        tag: "#" + cleanTag
      }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Mode": "Mock" }
      });
    }

    // Edge Cache Lookup (180s TTL)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) return cachedResponse;

    // Upstream Fetch
    const upstreamUrl = `https://api.clashroyale.com/v1/players/%23${cleanTag}`;

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json"
        },
        cf: { cacheTtl: 180, cacheEverything: true },
        signal: AbortSignal.timeout(8000)
      });

      if (!upstreamRes.ok) {
        const errorMap = {
          400: { code: "BAD_TAG", msg: "Invalid tag format reported by Supercell." },
          403: { code: "AUTH_ERROR", msg: "Supercell API key invalid or IP not whitelisted." },
          404: { code: "PLAYER_NOT_FOUND", msg: "Player tag not found in Clash Royale." },
          429: { code: "RATE_LIMITED", msg: "Supercell API rate limit reached. Try again shortly." },
          503: { code: "MAINTENANCE", msg: "Supercell servers currently under maintenance." }
        };
        const err = errorMap[upstreamRes.status] || { code: "UPSTREAM_ERROR", msg: "Failed to fetch from Supercell API." };
        return new Response(JSON.stringify({ error: err.code, message: err.msg, status: upstreamRes.status }), {
          status: upstreamRes.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }

      const player = await upstreamRes.json();

      // Sanitization pipeline
      const sanitized = {
        tag: player.tag || ("#" + cleanTag),
        name: player.name || "Unknown",
        expLevel: player.expLevel || 1,
        trophies: player.trophies || 0,
        bestTrophies: player.bestTrophies || player.trophies || 0,
        cards: (player.cards || []).map(c => ({
          name: c.name,
          rarity: (c.rarity || "common").toLowerCase(),
          displayLevel: c.displayLevel || (c.level + (16 - (c.maxLevel || 14))),
          role: getCardRole(c.name),
          count: c.count || 0
        }))
      };

      const response = new Response(JSON.stringify(sanitized), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60, s-maxage=180, stale-while-revalidate=60"
        }
      });

      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;
    } catch (err) {
      return new Response(JSON.stringify({ error: "GATEWAY_ERROR", message: err.message }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }
  }
};
