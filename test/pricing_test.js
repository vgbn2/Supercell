const assert = require("node:assert");

// ==========================================
// 1. SYSTEM SPECIFICATIONS & CONSTANTS
// ==========================================
const BASE_LEAGUE_PRICE = 40_000;
const VALID_TAG_CHARS = new Set("0289CGJLPQRUVY".split(""));

const LEAGUE_CONFIG = {
  L1: { name: "Challenger I", mult: 1.0, expLevel: 13 },
  L2: { name: "Challenger II", mult: 1.2, expLevel: 14 },
  L3: { name: "Challenger III", mult: 1.5, expLevel: 14 },
  L4: { name: "Master I", mult: 1.8, expLevel: 15 },
  L5: { name: "Master II", mult: 2.2, expLevel: 15 },
  L6: { name: "Master III", mult: 2.8, expLevel: 15 },
  L7: { name: "Grand Champion", mult: 3.5, expLevel: 16 },
  UC: { name: "Ultimate Champion", mult: 4.5, expLevel: 16 }
};

const LEAGUE_KEYS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "UC"];

const DELTA_TIERS = [
  { max: 0, mult: 1.0 },
  { max: 1, mult: 1.3 },
  { max: 2, mult: 1.7 },
  { max: 3, mult: 2.2 },
  { max: 4, mult: 3.0 },
  { max: Infinity, mult: null } // Refused when delta >= 5
];

const DEADLINE_MULT = {
  default: 1.0,
  weekend: 2.0,
  weekday: 4.0
};

const PACK_DISCOUNT = {
  1: 1.00,
  2: 0.95,
  3: 0.90,
  full: 0.85
};

const VARIANCE = { floor: 0.9, ceil: 1.3 };

// Strategic Role Weights
const ROLE_WEIGHTS = {
  tower: 1.6,
  win_condition: 1.5,
  spell: 1.3,
  support: 1.0,
  cycle: 0.7
};

const ROLE_MAP = {
  tower: new Set(["Tower Princess", "Cannoneer", "Dagger Duchess", "Baby Goblins", "Tesla", "Cannon", "Inferno Tower", "Bomb Tower", "Tombstone"]),
  win_condition: new Set(["Hog Rider", "Goblin Barrel", "Golem", "Royal Giant", "Miner", "Lava Hound", "Balloon", "Graveyard", "X-Bow", "Mortar", "Wall Breakers", "Ram Rider", "Battle Ram", "Royal Hogs", "Elixir Golem", "Goblin Giant", "Electro Giant", "Goblin Drill"]),
  spell: new Set(["The Log", "Zap", "Fireball", "Arrows", "Poison", "Rocket", "Giant Snowball", "Tornado", "Lightning", "Earthquake", "Void", "Freeze", "Barbarian Barrel", "Royal Delivery", "Mirror", "Clone", "Rage"]),
  cycle: new Set(["Skeletons", "Ice Spirit", "Electro Spirit", "Fire Spirit", "Heal Spirit", "Bats", "Goblins", "Spear Goblins"])
};

// ==========================================
// 2. FORMULA ENGINE IMPLEMENTATION
// ==========================================
function normalizeTag(raw) {
  if (!raw || typeof raw !== "string") return null;
  let tag = raw.trim().toUpperCase().replace(/^#/, "");
  tag = tag.replace(/O/g, "0").replace(/B/g, "8");
  if (tag.length < 3 || tag.length > 15) return null;
  for (const ch of tag) {
    if (!VALID_TAG_CHARS.has(ch)) return null;
  }
  return "#" + tag;
}

function getCardRole(cardName) {
  if (ROLE_MAP.tower.has(cardName)) return "tower";
  if (ROLE_MAP.win_condition.has(cardName)) return "win_condition";
  if (ROLE_MAP.spell.has(cardName)) return "spell";
  if (ROLE_MAP.cycle.has(cardName)) return "cycle";
  return "support";
}

function calculateRoleWeightedLevel(cards) {
  if (!cards || !cards.length) return 14.0;
  let totalWeight = 0;
  let weightedLevelSum = 0;

  for (const c of cards) {
    const role = c.role || getCardRole(c.name);
    const w = ROLE_WEIGHTS[role] || 1.0;
    totalWeight += w;
    weightedLevelSum += (c.displayLevel || 14) * w;
  }

  return totalWeight > 0 ? (weightedLevelSum / totalWeight) : 14.0;
}

function getDeltaMult(delta) {
  for (const tier of DELTA_TIERS) {
    if (delta <= tier.max) return tier.mult;
  }
  return null;
}

function roundThousands(val) {
  return Math.round(val / 1000) * 1000;
}

function calculatePoLBoost({ startLeague = "L0", targetLeague = "UC", avgCardLevel = 14.0, deadline = "default" }) {
  const startIdx = startLeague === "L0" ? 0 : LEAGUE_KEYS.indexOf(startLeague) + 1;
  const targetIdx = LEAGUE_KEYS.indexOf(targetLeague) + 1;

  if (targetIdx <= startIdx || targetIdx <= 0) {
    return { status: "INVALID_SELECTION", message: "Target league must be higher than starting league." };
  }

  const selectedLeagues = LEAGUE_KEYS.slice(startIdx, targetIdx);
  let rawTotal = 0;
  const stepBreakdown = [];

  for (const lKey of selectedLeagues) {
    const config = LEAGUE_CONFIG[lKey];
    const delta = Math.max(0, Math.ceil(config.expLevel - avgCardLevel));
    const deltaMult = getDeltaMult(delta);

    if (deltaMult === null) {
      return {
        status: "REFUSED",
        reason: `Account underleveled for ${config.name} (Δ=${delta} >= 5). Requires card upgrades.`,
        delta,
        league: config.name
      };
    }

    const stepPrice = BASE_LEAGUE_PRICE * config.mult * deltaMult;
    rawTotal += stepPrice;
    stepBreakdown.push({
      leagueKey: lKey,
      leagueName: config.name,
      expLevel: config.expLevel,
      delta,
      deltaMult,
      stepPrice: roundThousands(stepPrice)
    });
  }

  const count = selectedLeagues.length;
  const discountRate = count >= 8 ? PACK_DISCOUNT.full : (PACK_DISCOUNT[count] || PACK_DISCOUNT[3] || 1.0);
  const urgencyRate = DEADLINE_MULT[deadline] || 1.0;

  const basePrice = rawTotal * discountRate * urgencyRate;
  const nominal = roundThousands(basePrice);
  const floor = roundThousands(basePrice * VARIANCE.floor);
  const ceil = roundThousands(basePrice * VARIANCE.ceil);

  return {
    status: "OK",
    rawTotal,
    basePrice,
    nominal,
    floor,
    ceil,
    discountRate,
    urgencyRate,
    stepCount: count,
    stepBreakdown
  };
}

function calculateTrophyRoad({ currentCups = 5000, targetCups = 7500, deadline = "default" }) {
  if (targetCups <= currentCups) {
    return { status: "INVALID_SELECTION", message: "Target trophies must be higher than current." };
  }
  const diff = targetCups - currentCups;
  const base = Math.ceil(diff / 500) * 50_000;
  const urgencyRate = DEADLINE_MULT[deadline] || 1.0;
  const basePrice = base * urgencyRate;
  return {
    status: "OK",
    basePrice,
    nominal: roundThousands(basePrice),
    floor: roundThousands(basePrice * VARIANCE.floor),
    ceil: roundThousands(basePrice * VARIANCE.ceil),
    cupsToGain: diff
  };
}

// ==========================================
// TEST SUITE: DYNAMIC FORMULA VERIFICATION
// ==========================================
console.log("Running CR Boosting Calculator Test Suite (Dynamic First-Principles Mode)...\n");

// Test 1: Tag Normalization & OCR Auto-Correction
console.log("1. Testing Tag Normalization & Character Mapping...");
{
  const testCases = [
    { input: "UGV0UCVQ", expected: "#UGV0UCVQ" },
    { input: "#UGVOUCVQ", expected: "#UGV0UCVQ" }, // 'O' -> '0'
    { input: "2B00LQ802Y", expected: "#2800LQ802Y" }, // 'B' -> '8'
    { input: "  #20u0lq802y  ", expected: "#20U0LQ802Y" }, // trim + upper
    { input: "2OUOLQ8O2Y", expected: "#20U0LQ802Y" }, // multiple 'O' -> '0'
    { input: "#123XYZ", expected: null }, // invalid chars
    { input: "#UGV5UCVQ", expected: null }, // '5' is not in Base-14
    { input: "#20U0LQ8S2Y", expected: null }, // 'S' is rejected
    { input: "", expected: null },
    { input: 12345, expected: null }, // non-string rejected
    { input: null, expected: null },
    { input: undefined, expected: null }
  ];

  for (const { input, expected } of testCases) {
    const result = normalizeTag(input);
    assert.strictEqual(result, expected, `Normalization mismatch for input: "${input}"`);
  }
  console.log("   ✓ Tag normalization verified dynamically against Base-14 character set.");
}

// Test 2: Role-Weighted Level Calculus
console.log("2. Testing Strategic Role-Weighting Calculus...");
{
  const sampleDeck = [
    { name: "Tesla", displayLevel: 14 }, // tower (1.6)
    { name: "Hog Rider", displayLevel: 14 }, // win_condition (1.5)
    { name: "Fireball", displayLevel: 15 }, // spell (1.3)
    { name: "The Log", displayLevel: 14 }, // spell (1.3)
    { name: "Knight", displayLevel: 15 }, // support (1.0)
    { name: "Archers", displayLevel: 14 }, // support (1.0)
    { name: "Skeletons", displayLevel: 13 }, // cycle (0.7)
    { name: "Ice Spirit", displayLevel: 13 } // cycle (0.7)
  ];

  // Derive expected role-weighted level manually from first principles
  let totalW = 0;
  let totalWeightedLvl = 0;
  for (const c of sampleDeck) {
    const role = getCardRole(c.name);
    const w = ROLE_WEIGHTS[role];
    totalW += w;
    totalWeightedLvl += c.displayLevel * w;
  }
  const theoreticalWeightedAvg = totalWeightedLvl / totalW;
  const computed = calculateRoleWeightedLevel(sampleDeck);

  assert.strictEqual(Math.abs(computed - theoreticalWeightedAvg) < 1e-9, true, "Weighted average must equal theoretical sum");
  console.log("   ✓ Role-weighted calculus verified against tactical card weights (Tower 1.6x, WinCon 1.5x, Spell 1.3x).");
}

// Test 3: Single-Step PoL Calculations derived from Constants
console.log("3. Testing Single-Step PoL Calculations derived from Base Constants...");
{
  const testSteps = [
    { start: "L0", target: "L1", avgCard: 14.0 },
    { start: "L6", target: "L7", avgCard: 15.0 },
    { start: "L7", target: "UC", avgCard: 14.0 }
  ];

  for (const { start, target, avgCard } of testSteps) {
    const res = calculatePoLBoost({ startLeague: start, targetLeague: target, avgCardLevel: avgCard, deadline: "default" });
    assert.strictEqual(res.status, "OK");

    const cfg = LEAGUE_CONFIG[target];
    const expectedDelta = Math.max(0, Math.ceil(cfg.expLevel - avgCard));
    const expectedDeltaMult = getDeltaMult(expectedDelta);
    const expectedRaw = BASE_LEAGUE_PRICE * cfg.mult * expectedDeltaMult;
    const expectedNominal = roundThousands(expectedRaw * PACK_DISCOUNT[1] * DEADLINE_MULT.default);
    const expectedFloor = roundThousands(expectedRaw * PACK_DISCOUNT[1] * DEADLINE_MULT.default * VARIANCE.floor);
    const expectedCeil = roundThousands(expectedRaw * PACK_DISCOUNT[1] * DEADLINE_MULT.default * VARIANCE.ceil);

    assert.strictEqual(res.nominal, expectedNominal, `Nominal mismatch for step ${start} -> ${target}`);
    assert.strictEqual(res.floor, expectedFloor, `Floor mismatch for step ${start} -> ${target}`);
    assert.strictEqual(res.ceil, expectedCeil, `Ceil mismatch for step ${start} -> ${target}`);
  }
  console.log("   ✓ Single-step prices verified against exact theoretical models.");
}

// Test 4: Multi-League Pack Climbs & Discount Thresholds
console.log("4. Testing Multi-League Pack Discount Thresholds...");
{
  const packs = [
    { start: "L0", target: "L2", count: 2, expectedRate: PACK_DISCOUNT[2] },
    { start: "L3", target: "L6", count: 3, expectedRate: PACK_DISCOUNT[3] },
    { start: "L1", target: "L7", count: 6, expectedRate: PACK_DISCOUNT[3] },
    { start: "L0", target: "UC", count: 8, expectedRate: PACK_DISCOUNT.full }
  ];

  for (const { start, target, count, expectedRate } of packs) {
    const res = calculatePoLBoost({ startLeague: start, targetLeague: target, avgCardLevel: 14.5, deadline: "default" });
    assert.strictEqual(res.status, "OK");
    assert.strictEqual(res.stepCount, count, `Step count mismatch for ${start} -> ${target}`);
    assert.strictEqual(res.discountRate, expectedRate, `Discount rate mismatch for ${count}-step pack`);

    // Verify raw total equals sum of individual steps
    const computedRaw = res.stepBreakdown.reduce((sum, s) => {
      const cfg = LEAGUE_CONFIG[s.leagueKey];
      return sum + BASE_LEAGUE_PRICE * cfg.mult * s.deltaMult;
    }, 0);
    assert.strictEqual(res.rawTotal, computedRaw, "Raw total must match sum of step prices");
  }
  console.log("   ✓ Pack discounts and step breakdowns verified dynamically.");
}

// Test 5: Urgency Multipliers (Computed from Raw Base Price)
console.log("5. Testing Urgency Multipliers (Standard vs Weekend vs Weekday)...");
{
  const avgLevel = 14.8;
  const standard = calculatePoLBoost({ startLeague: "L3", targetLeague: "L6", avgCardLevel: avgLevel, deadline: "default" });
  const weekend = calculatePoLBoost({ startLeague: "L3", targetLeague: "L6", avgCardLevel: avgLevel, deadline: "weekend" });
  const weekday = calculatePoLBoost({ startLeague: "L3", targetLeague: "L6", avgCardLevel: avgLevel, deadline: "weekday" });

  // Verify baseline prices before rounding scale exactly by multiplier ratio
  const rawBaseDiscounted = standard.rawTotal * standard.discountRate;

  assert.strictEqual(standard.basePrice, rawBaseDiscounted * DEADLINE_MULT.default);
  assert.strictEqual(weekend.basePrice, rawBaseDiscounted * DEADLINE_MULT.weekend);
  assert.strictEqual(weekday.basePrice, rawBaseDiscounted * DEADLINE_MULT.weekday);

  // Verify rounded outputs match theoretical formula: roundThousands(basePrice)
  assert.strictEqual(standard.nominal, roundThousands(rawBaseDiscounted * DEADLINE_MULT.default));
  assert.strictEqual(weekend.nominal, roundThousands(rawBaseDiscounted * DEADLINE_MULT.weekend));
  assert.strictEqual(weekday.nominal, roundThousands(rawBaseDiscounted * DEADLINE_MULT.weekday));

  // Verify variance bounds scale proportionally
  assert.strictEqual(weekend.floor, roundThousands(weekend.basePrice * VARIANCE.floor));
  assert.strictEqual(weekend.ceil, roundThousands(weekend.basePrice * VARIANCE.ceil));
  assert.strictEqual(weekday.floor, roundThousands(weekday.basePrice * VARIANCE.floor));
  assert.strictEqual(weekday.ceil, roundThousands(weekday.basePrice * VARIANCE.ceil));

  console.log("   ✓ Urgency scaling verified dynamically from base price without magic numbers.");
}

// Test 6: Hard Refusal Boundary (Delta >= 5 vs Delta = 4)
console.log("6. Testing Hard Refusal Threshold (Δ >= 5)...");
{
  const targetLeague = "UC";
  const expLevel = LEAGUE_CONFIG[targetLeague].expLevel;

  // Boundary Case A: Delta = 5.0 (Should be REFUSED)
  const delta5Avg = expLevel - 5.0;
  const refused5 = calculatePoLBoost({ startLeague: "L0", targetLeague, avgCardLevel: delta5Avg });
  assert.strictEqual(refused5.status, "REFUSED", "Delta = 5 must be refused");
  assert(refused5.delta >= 5, "Reported delta must be >= 5");

  // Boundary Case B: Delta = 5.5 (Should be REFUSED)
  const delta6Avg = expLevel - 5.5;
  const refused6 = calculatePoLBoost({ startLeague: "L0", targetLeague, avgCardLevel: delta6Avg });
  assert.strictEqual(refused6.status, "REFUSED", "Delta > 5 must be refused");

  // Boundary Case C: Delta = 4.0 (Must be ACCEPTED at maximum penalty tier)
  const delta4Avg = expLevel - 4.0;
  const accepted4 = calculatePoLBoost({ startLeague: "L0", targetLeague, avgCardLevel: delta4Avg });
  assert.strictEqual(accepted4.status, "OK", "Delta = 4 must be accepted");
  const stepUC = accepted4.stepBreakdown.find(s => s.leagueKey === "UC");
  assert.strictEqual(stepUC.deltaMult, 3.0, "Delta = 4 must map to 3.0x multiplier");

  console.log("   ✓ Hard refusal boundaries tested dynamically across Δ=4.0, Δ=5.0, Δ=5.5.");
}

// Test 7: Trophy Road Engine
console.log("7. Testing Trophy Road Pack Engine...");
{
  const cur = 5200;
  const tgt = 6800;
  const tr = calculateTrophyRoad({ currentCups: cur, targetCups: tgt, deadline: "weekend" });
  assert.strictEqual(tr.status, "OK");
  const expectedDiff = tgt - cur;
  const expectedBase = Math.ceil(expectedDiff / 500) * 50_000 * DEADLINE_MULT.weekend;
  assert.strictEqual(tr.nominal, roundThousands(expectedBase));
  assert.strictEqual(tr.floor, roundThousands(expectedBase * VARIANCE.floor));
  assert.strictEqual(tr.ceil, roundThousands(expectedBase * VARIANCE.ceil));

  console.log("   ✓ Trophy Road formula verified dynamically against 500-cup step rates.");
}

// Test 8: Level 16 Card Normalization Formula (All Rarities)
console.log("8. Testing Level 16 Card Normalization Scale...");
{
  const calcDisplayLevel = c => c.displayLevel || (c.level + (16 - (c.maxLevel || 14)));

  // Commons: maxLevel = 16 (offset 0)
  assert.strictEqual(calcDisplayLevel({ level: 16, maxLevel: 16 }), 16, "Max Common must be L16");
  assert.strictEqual(calcDisplayLevel({ level: 15, maxLevel: 16 }), 15, "L15 Common must be L15");
  assert.strictEqual(calcDisplayLevel({ level: 1, maxLevel: 16 }), 1, "L1 Common must be L1");

  // Rares: maxLevel = 14 (offset +2)
  assert.strictEqual(calcDisplayLevel({ level: 14, maxLevel: 14 }), 16, "Max Rare must be L16");
  assert.strictEqual(calcDisplayLevel({ level: 13, maxLevel: 14 }), 15, "L13 Rare must be L15");
  assert.strictEqual(calcDisplayLevel({ level: 1, maxLevel: 14 }), 3, "L1 Rare base level must be L3");

  // Epics: maxLevel = 11 (offset +5)
  assert.strictEqual(calcDisplayLevel({ level: 11, maxLevel: 11 }), 16, "Max Epic must be L16");
  assert.strictEqual(calcDisplayLevel({ level: 10, maxLevel: 11 }), 15, "L10 Epic must be L15");
  assert.strictEqual(calcDisplayLevel({ level: 1, maxLevel: 11 }), 6, "L1 Epic base level must be L6");

  // Legendaries: maxLevel = 8 (offset +8)
  assert.strictEqual(calcDisplayLevel({ level: 8, maxLevel: 8 }), 16, "Max Legendary must be L16");
  assert.strictEqual(calcDisplayLevel({ level: 7, maxLevel: 8 }), 15, "L7 Legendary must be L15");
  assert.strictEqual(calcDisplayLevel({ level: 1, maxLevel: 8 }), 9, "L1 Legendary base level must be L9");

  // Champions: maxLevel = 6 (offset +10)
  assert.strictEqual(calcDisplayLevel({ level: 6, maxLevel: 6 }), 16, "Max Champion must be L16");
  assert.strictEqual(calcDisplayLevel({ level: 4, maxLevel: 6 }), 14, "L4 Champion must be L14");
  assert.strictEqual(calcDisplayLevel({ level: 1, maxLevel: 6 }), 11, "L1 Champion base level must be L11");

  console.log("   ✓ Level 16 normalization formula verified across all 5 rarity scales.");
}

// Test 9: Fractional Deficit Refusal Hard Boundary & Unrounded Precision
console.log("9. Testing Fractional Deficit Boundary (CORE-001 Verification)...");
{
  const targetLeague = "UC"; // expLevel = 16

  // Case A: Raw weighted level = 11.989 -> Deficit = ceil(16 - 11.989) = ceil(4.011) = 5 -> REFUSED
  const rawFractional = 11.989;
  const resRefused = calculatePoLBoost({ startLeague: "L0", targetLeague, avgCardLevel: rawFractional });
  assert.strictEqual(resRefused.status, "REFUSED", "Raw weighted level 11.989 must produce Delta=5 and REFUSED status");
  assert.strictEqual(resRefused.delta, 5, "Deficit for 11.989 must be exactly 5");

  // Case B: If prematurely rounded to 1 decimal (12.0) -> Deficit = ceil(16 - 12.0) = 4 -> ACCEPTED (defect behavior)
  const roundedDefectValue = Math.round(rawFractional * 10) / 10; // 12.0
  const resBugged = calculatePoLBoost({ startLeague: "L0", targetLeague, avgCardLevel: roundedDefectValue });
  assert.strictEqual(resBugged.status, "OK", "Prematurely rounded 12.0 would bypass refusal gate (demonstrating why unrounded float is critical)");

  // Case C: Legitimate boundary at 12.000 -> Deficit = 4 -> ACCEPTED
  const resAccepted = calculatePoLBoost({ startLeague: "L0", targetLeague, avgCardLevel: 12.0 });
  assert.strictEqual(resAccepted.status, "OK", "Legitimate exact level 12.0 must be accepted");
  const stepUC = resAccepted.stepBreakdown.find(s => s.leagueKey === "UC");
  assert.strictEqual(stepUC.deltaMult, 3.0, "Delta=4 must map to 3.0x multiplier");

  console.log("   ✓ Fractional deficit boundary and unrounded state precision strictly verified.");
}

console.log("\n============================================================");
console.log("ALL 9 TEST SUITES VERIFIED DYNAMICALLY FROM FIRST PRINCIPLES");
console.log("============================================================");
