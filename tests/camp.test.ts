import { describe, expect, it } from "vitest";
import { autoplay, PlaceholderBot } from "../src/engine/bots.js";
import { FOOD_CRATE, MEALS_PER_DAY, NIGHTLY_WEAR, REWARDS, newCamp, nightlyWear, settleNight, shelterTier, type RewardItem } from "../src/engine/camp.js";
import { MERGED, Season } from "../src/engine/season.js";
import { PROTOTYPE_CONFIG } from "../src/engine/types.js";

const NAMES = ["You", "Ana", "Bo", "Cyra", "Dez", "Emre", "Fen", "Gil"];

function newSeason(seed = 3) {
  return new Season(
    NAMES.map((n, i) => ({ id: i === 0 ? "you" : n.toLowerCase(), name: n, isHuman: i === 0 })),
    PROTOTYPE_CONFIG,
    seed,
  );
}

describe("gathering", () => {
  it("costs energy and fills the camp's shelter and food store", () => {
    const s = newSeason();
    const camp = s.campOf("you");
    const food = camp.food;
    expect(s.gather("you", "palm")).toBe(1);
    expect(s.gather("you", "fruit")).toBe(1);
    expect(s.gather("you", "fish")).toBe(1);
    expect(camp.materials).toBe(1);
    expect(camp.food).toBe(food + 2);
    expect(s.player("you").energy).toBe(s.player("you").maxEnergy - 4);
    expect(s.player("you").gathered).toEqual({ wood: 1, food: 2 });
  });

  it("stops when the castaway runs out of energy", () => {
    const s = newSeason();
    let trips = 0;
    while (s.gather("you", "palm") !== null) trips++;
    expect(trips).toBe(s.player("you").maxEnergy);
    expect(s.campOf("you").materials).toBe(trips);
  });

  it("gear makes each trip bring back more", () => {
    const s = newSeason();
    s.campOf("you").items.push("machete", "fishingRod", "flint");
    expect(s.gather("you", "palm")).toBe(2);
    expect(s.gather("you", "fish")).toBe(4);
  });

  it("only one camp's store fills", () => {
    const s = newSeason();
    const rival = s.active().find((p) => p.crew !== s.player("you").crew)!;
    s.gather("you", "palm");
    expect(s.campOf(rival.id).materials).toBe(0);
  });

  it("a computer castaway finishes its chore when camp ends", () => {
    const s = newSeason();
    const mate = s.active().find((p) => p.id !== "you" && p.crew === s.player("you").crew)!;
    s.setChore(mate.id, "palm", 7);
    s.gather(mate.id, "palm"); // one trip done "on screen"
    s.advance(); // camp -> challenge
    expect(s.player(mate.id).gathered.wood).toBe(7);
  });
});

describe("the night at camp", () => {
  it("needs a lot of materials before there is a real shelter", () => {
    expect(shelterTier(0).name).toBe("No shelter");
    expect(shelterTier(10).name).toBe("No shelter");
    expect(shelterTier(25).name).toBe("Lean-to");
    expect(shelterTier(60).name).toBe("Shelter");
    expect(shelterTier(100).name).toBe("Sturdy shelter");
  });

  it("no shelter and no food makes castaways weaker; a good camp makes them stronger", () => {
    const rough = newCamp("Coral", 0);
    expect(settleNight(rough, 4).factor).toBeLessThan(0.8);
    const good = newCamp("Coral", 4 * MEALS_PER_DAY);
    good.materials = 100;
    good.items.push("blankets");
    expect(settleNight(good, 4).factor).toBeGreaterThan(1.1);
  });

  it("hunger gets worse night after night", () => {
    const camp = newCamp("Coral", 0);
    const first = settleNight(camp, 4).factor;
    const second = settleNight(camp, 4).factor;
    expect(second).toBeLessThan(first);
    expect(camp.hungryNights).toBe(2);
  });

  it("everyone eats from the store, and the weather wears the shelter (less with a tarp)", () => {
    const camp = newCamp("Coral", 20);
    camp.materials = 30;
    settleNight(camp, 4);
    expect(camp.food).toBe(20 - 4 * MEALS_PER_DAY);
    expect(camp.materials).toBe(30 - NIGHTLY_WEAR);
    expect(nightlyWear(100, [])).toBe(12);
    expect(nightlyWear(100, ["tarp"])).toBe(6);
    expect(nightlyWear(2, [])).toBe(2);
  });

  it("a rough night means less energy the next day", () => {
    const s = newSeason();
    // Nobody gathers anything: no shelter, and the rice runs out the first night.
    s.advance(); // night 1
    expect(s.campOf("you").condition.factor).toBeLessThan(1);
    // Play to the next camp.
    while (s.phase !== "camp" || s.round === 1) {
      if (s.phase === "challenge") for (const p of s.active()) s.submitChallengeScore(p.id, 500);
      s.advance();
    }
    expect(s.player("you").maxEnergy).toBeLessThan(12);
    expect(s.player("you").gathered).toEqual({ wood: 0, food: 0 });
  });
});

describe("rewards", () => {
  it("the winning crew earns a piece of gear for its camp", () => {
    const s = newSeason();
    s.advance();
    const mine = s.player("you").crew;
    for (const p of s.active()) s.submitChallengeScore(p.id, p.crew === mine ? 900 : 100);
    s.advance();
    expect(s.lastRewards).toHaveLength(1);
    expect(s.lastRewards[0]!.camp).toBe(mine);
    expect(s.campOf("you").items).toContain(s.lastRewards[0]!.item);
  });

  it("a camp with every item wins food instead", () => {
    const s = newSeason();
    s.advance();
    const mine = s.player("you").crew;
    s.campOf("you").items.push(...(Object.keys(REWARDS) as RewardItem[]));
    const food = s.campOf("you").food;
    for (const p of s.active()) s.submitChallengeScore(p.id, p.crew === mine ? 900 : 100);
    s.advance();
    expect(s.lastRewards[0]!.item).toBeNull();
    expect(s.campOf("you").food).toBe(food + FOOD_CRATE);
  });

  it("the merged camp keeps the best shelter and pools food and gear", () => {
    const s = newSeason(11);
    s.camp("Coral").materials = 40;
    s.camp("Coral").items.push("tarp");
    s.camp("Driftwood").items.push("flint");
    autoplay(s, NAMES.map((n, i) => new PlaceholderBot(i === 0 ? "you" : n.toLowerCase(), i + 1)));
    const merged = s.camp(MERGED);
    expect(merged.items).toEqual(expect.arrayContaining(["tarp", "flint"]));
  });
});

describe("computer castaways at camp", () => {
  it("plan real work, and whole seasons still finish", () => {
    const s = newSeason(5);
    const bots = NAMES.map((n, i) => new PlaceholderBot(i === 0 ? "you" : n.toLowerCase(), i + 9));
    autoplay(s, bots);
    expect(s.final?.winner).toBeTruthy();
    expect(s.camp(MERGED).materials).toBeGreaterThan(0);
  });
});
