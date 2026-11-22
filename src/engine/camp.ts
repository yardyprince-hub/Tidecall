/**
 * Camp life: gathering shelter materials and food, the night at camp, and the reward
 * gear a crew can win. No UI here; the Season calls these and keeps the state.
 *
 * The idea: every castaway has a day's worth of energy. Spending it at the palms builds
 * the shelter; spending it on fruit or fishing fills the food store. Overnight the camp
 * eats and sleeps, and how well they rested and ate sets their condition, which makes the
 * next challenge easier or harder and sets how much energy they have tomorrow.
 */

/** Where a castaway can gather. */
export type GatherSource = "palm" | "fruit" | "fish";
export type Supply = "wood" | "food";

export type RewardItem = "tarp" | "blankets" | "flint" | "fishingRod" | "machete" | "pot";

export const REWARDS: Record<RewardItem, { name: string; effect: string }> = {
  tarp: { name: "Tarp", effect: "Keeps the rain out: the shelter washes away half as fast, and everyone sleeps better." },
  blankets: { name: "Blankets", effect: "Warm nights. Everyone sleeps better." },
  flint: { name: "Flint", effect: "A fire that lasts all night, and every catch of fish cooks into an extra meal." },
  fishingRod: { name: "Fishing rod", effect: "Every fishing trip brings back two more fish." },
  machete: { name: "Machete", effect: "Every trip to the palms brings back double the materials." },
  pot: { name: "Cooking pot", effect: "Boiled water and hot meals keep everyone healthier." },
};

/** When every item is already at camp, the reward is a crate of food instead. */
export const FOOD_CRATE = 10;

export const SOURCES: Record<GatherSource, { supply: Supply; energy: number; verb: string }> = {
  palm: { supply: "wood", energy: 1, verb: "cut palm fronds and branches" },
  fruit: { supply: "food", energy: 1, verb: "picked fruit" },
  fish: { supply: "food", energy: 2, verb: "went fishing" },
};

/** Shelter stages by how many materials have gone into it. */
export const SHELTER_TIERS = [
  { min: 0, name: "No shelter", rest: -0.15 },
  { min: 25, name: "Lean-to", rest: -0.05 },
  { min: 60, name: "Shelter", rest: 0.05 },
  { min: 100, name: "Sturdy shelter", rest: 0.1 },
] as const;

/** Materials the wind and rain strip from the shelter each night: at least this many... */
export const NIGHTLY_WEAR = 4;
/** ...or this share of a big shelter, so even a sturdy one needs upkeep. A tarp halves it. */
export const WEAR_SHARE = 0.12;

export function nightlyWear(materials: number, items: readonly RewardItem[]): number {
  const wear = Math.min(materials, Math.max(NIGHTLY_WEAR, Math.ceil(materials * WEAR_SHARE)));
  return items.includes("tarp") ? Math.floor(wear / 2) : wear;
}
/** A full day's energy for a well-rested, well-fed castaway. */
export const BASE_ENERGY = 12;
/** Meals each castaway eats a day. */
export const MEALS_PER_DAY = 2;
/** Food each crew starts with: a sack of rice from the wreck, one day's meals. */
export const STARTING_FOOD = 8;
/** The merge feast, added to the merged camp's food store. */
export const MERGE_FEAST = 12;

export interface ConditionPart {
  label: string;
  delta: number;
}

export interface Condition {
  /** Multiplier on challenge performance, 0.6 to 1.3. */
  factor: number;
  shelter: string;
  /** "Everyone ate", "Half rations", "Nobody ate"... */
  meals: string;
  parts: ConditionPart[];
}

export interface CampState {
  /** Crew name, or "merged". */
  name: string;
  /** Materials built into the shelter so far. */
  materials: number;
  /** Meals in the food store. */
  food: number;
  items: RewardItem[];
  /** Nights in a row the camp went hungry. */
  hungryNights: number;
  /** How the camp came through its last night (round 1 starts neutral). */
  condition: Condition;
}

export const FRESH_CONDITION: Condition = {
  factor: 1,
  shelter: "No shelter yet",
  meals: "Just washed ashore",
  parts: [],
};

export function newCamp(name: string, food = STARTING_FOOD): CampState {
  return { name, materials: 0, food, items: [], hungryNights: 0, condition: FRESH_CONDITION };
}

export function shelterTier(materials: number): { index: number; name: string; rest: number; next: number | null } {
  let index = 0;
  SHELTER_TIERS.forEach((t, i) => {
    if (materials >= t.min) index = i;
  });
  const tier = SHELTER_TIERS[index]!;
  const next = SHELTER_TIERS[index + 1]?.min ?? null;
  return { index, name: tier.name, rest: tier.rest, next };
}

/** How much one trip to a source brings back, given the camp's gear. */
export function gatherYield(source: GatherSource, items: readonly RewardItem[]): number {
  switch (source) {
    case "palm":
      return items.includes("machete") ? 2 : 1;
    case "fruit":
      return 1;
    case "fish":
      return 1 + (items.includes("fishingRod") ? 2 : 0) + (items.includes("flint") ? 1 : 0);
  }
}

/** Energy for the day, from how the camp came through the night. */
export function energyFor(condition: Condition): number {
  return Math.round(BASE_ENERGY * Math.min(1.2, Math.max(0.75, condition.factor)));
}

/**
 * The night at camp: everyone eats from the store, sleeps in whatever shelter there is,
 * and the weather wears the shelter down. Changes the camp in place and returns its new condition.
 */
export function settleNight(camp: CampState, members: number): Condition {
  const parts: ConditionPart[] = [];
  const tier = shelterTier(camp.materials);
  parts.push({ label: tier.index === 0 ? "Slept on the sand" : `Slept in the ${tier.name.toLowerCase()}`, delta: tier.rest });
  if (camp.items.includes("tarp")) parts.push({ label: "Tarp kept the rain off", delta: 0.03 });
  if (camp.items.includes("blankets")) parts.push({ label: "Blankets", delta: 0.04 });
  if (camp.items.includes("flint")) parts.push({ label: "Fire all night", delta: 0.03 });
  if (camp.items.includes("pot")) parts.push({ label: "Boiled water", delta: 0.03 });

  const needed = members * MEALS_PER_DAY;
  const eaten = Math.min(camp.food, needed);
  camp.food -= eaten;
  const fed = needed === 0 ? 1 : eaten / needed;
  let meals: string;
  if (fed >= 1) {
    meals = "Everyone ate";
    camp.hungryNights = 0;
    parts.push({ label: "Full bellies", delta: 0.05 });
  } else if (fed >= 0.5) {
    meals = "Half rations";
    camp.hungryNights = 0;
    parts.push({ label: "Half rations", delta: -0.04 });
  } else {
    meals = eaten === 0 ? "Nobody ate" : "Barely any food";
    camp.hungryNights += 1;
    parts.push({ label: meals, delta: -0.12 });
    if (camp.hungryNights > 1) {
      parts.push({ label: `Hungry ${camp.hungryNights} nights running`, delta: -Math.min(0.12, 0.04 * (camp.hungryNights - 1)) });
    }
  }

  camp.materials -= nightlyWear(camp.materials, camp.items);

  const total = parts.reduce((sum, p) => sum + p.delta, 0);
  const factor = Math.round(Math.min(1.3, Math.max(0.6, 1 + total)) * 100) / 100;
  camp.condition = { factor, shelter: tier.name, meals, parts };
  return camp.condition;
}

/** "+8%" / "-12%" for a condition factor. */
export function formatFactor(factor: number): string {
  const pct = Math.round((factor - 1) * 100);
  return pct === 0 ? "±0%" : pct > 0 ? `+${pct}%` : `${pct}%`;
}
