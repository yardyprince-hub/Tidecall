import { describe, expect, it } from "vitest";
import { autoplay, PlaceholderBot } from "../src/engine/bots.js";
import { Season } from "../src/engine/season.js";
import { LIVE_CONFIG, PROTOTYPE_CONFIG } from "../src/engine/types.js";

const names = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

function botSeason(n: number, config = PROTOTYPE_CONFIG, seed = 1) {
  const players = names(n);
  const season = new Season(players, config, seed);
  return autoplay(season, players.map((p, i) => new PlaceholderBot(p.id, seed * 100 + i)));
}

/** Moves a season to its next council with every challenge score left at 0. */
function toCouncil(season: Season) {
  while (season.phase !== "council") season.advance();
}

describe("season shape", () => {
  it("prototype: 8 players, merge at 6, jury of 3, final 3", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const s = botSeason(8, PROTOTYPE_CONFIG, seed);
      expect(s.phase).toBe("complete");
      expect(s.councils).toHaveLength(5);
      expect(s.players.filter((p) => p.status === "out")).toHaveLength(2);
      expect(s.jury()).toHaveLength(3);
      expect(s.active()).toHaveLength(3);
      expect(s.final?.finalists).toContain(s.final?.winner);
    }
  });

  it("live: 12 players with a swap, merge at 8, jury of 5", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const s = botSeason(12, LIVE_CONFIG, seed);
      expect(s.phase).toBe("complete");
      expect(s.councils).toHaveLength(9);
      expect(s.jury()).toHaveLength(5);
      expect(s.log.some((l) => l.text.includes("Crew swap"))).toBe(true);
    }
  });

  it("is replayable from the same seed", () => {
    const a = botSeason(8, PROTOTYPE_CONFIG, 42);
    const b = botSeason(8, PROTOTYPE_CONFIG, 42);
    expect(a.log).toEqual(b.log);
  });

  it("deals two even crews before the merge", () => {
    const s = new Season(names(8), PROTOTYPE_CONFIG, 3);
    const sizes = [...s.crews().values()].map((c) => c.length);
    expect(sizes).toEqual([4, 4]);
  });
});

describe("challenges", () => {
  it("sends the lower-scoring crew to council", () => {
    const s = new Season(names(8), PROTOTYPE_CONFIG, 5);
    s.advance(); // to challenge
    const [crewA, crewB] = [...s.crews().values()];
    crewA!.forEach((p) => s.submitChallengeScore(p.id, 900));
    crewB!.forEach((p) => s.submitChallengeScore(p.id, 100));
    s.advance(); // resolve
    expect(s.councilAttendees().sort()).toEqual(crewB!.map((p) => p.id).sort());
  });

  it("gives the top scorer a Ward after the merge", () => {
    const s = new Season(names(6), PROTOTYPE_CONFIG, 5);
    expect(s.isMerged).toBe(true);
    s.advance();
    s.active().forEach((p, i) => s.submitChallengeScore(p.id, i === 2 ? 999 : 10));
    s.advance();
    expect(s.immunePlayers()).toEqual(["p2"]);
    s.advance(); // to council
    expect(s.voteOptions("p0")).not.toContain("p2");
    expect(() => s.castVote("p0", "p2")).toThrow();
  });
});

describe("council", () => {
  it("eliminates the player with the most votes", () => {
    const s = new Season(names(6), PROTOTYPE_CONFIG, 7);
    toCouncil(s);
    const immune = s.immunePlayers()[0];
    const target = s.councilAttendees().find((id) => id !== immune)!;
    for (const voter of s.eligibleVoters()) {
      const pick = voter === target ? s.voteOptions(voter)[0]! : target;
      s.castVote(voter, pick);
    }
    s.advance();
    expect(s.councils[0]!.eliminated).toBe(target);
    expect(s.player(target).status).toBe("jury");
  });

  it("does not let you vote for yourself", () => {
    const s = new Season(names(6), PROTOTYPE_CONFIG, 7);
    toCouncil(s);
    const voter = s.eligibleVoters()[0]!;
    expect(() => s.castVote(voter, voter)).toThrow();
  });

  it("a Ward relic cancels votes against its holder", () => {
    const s = new Season(names(6), PROTOTYPE_CONFIG, 7);
    toCouncil(s);
    const immune = s.immunePlayers()[0];
    const [holder, other] = s.councilAttendees().filter((id) => id !== immune);
    s.player(holder!).relics = 1;
    for (const voter of s.eligibleVoters()) {
      const pick = voter === holder ? other! : holder!;
      s.castVote(voter, pick);
    }
    s.playRelic(holder!);
    s.advance();
    const council = s.councils[0]!;
    expect(council.eliminated).toBe(other);
    expect(council.relicsPlayed).toEqual([holder]);
    expect(council.votes.filter((v) => v.target === holder).every((v) => v.cancelled)).toBe(true);
  });

  function tiedCouncil() {
    const s = new Season(names(6), PROTOTYPE_CONFIG, 11);
    toCouncil(s);
    const immune = s.immunePlayers()[0]!;
    const [a, b, c, d, e] = s.councilAttendees().filter((id) => id !== immune) as string[];
    s.castVote(a!, b!);
    s.castVote(b!, a!);
    s.castVote(c!, a!);
    s.castVote(d!, b!);
    s.castVote(e!, d!);
    s.castVote(immune, c!);
    s.advance();
    return { s, immune, a: a!, b: b!, c: c!, d: d!, e: e! };
  }

  it("breaks a tie with a revote where the tied players sit out", () => {
    const { s, immune, a, b, c, d, e } = tiedCouncil();
    expect(s.stage).toBe("revote");
    expect(s.eligibleVoters().sort()).toEqual([c, d, e, immune].sort());
    expect(s.voteOptions(c).sort()).toEqual([a, b].sort());
    s.castVote(c, a);
    s.castVote(d, a);
    s.castVote(e, a);
    s.castVote(immune, b);
    s.advance();
    expect(s.councils[0]!.eliminated).toBe(a);
    expect(s.councils[0]!.drewLots).toBe(false);
  });

  it("draws lots between the tied players if the revote ties again", () => {
    const { s, immune, a, b, c, d, e } = tiedCouncil();
    s.castVote(c, a);
    s.castVote(d, a);
    s.castVote(e, b);
    s.castVote(immune, b);
    s.advance();
    expect(s.councils[0]!.drewLots).toBe(true);
    expect([a, b]).toContain(s.councils[0]!.eliminated);
  });

  it("casts missing votes at random so a round never stalls", () => {
    const s = new Season(names(8), PROTOTYPE_CONFIG, 13);
    toCouncil(s);
    s.advance(); // nobody voted
    while (s.phase === "council") s.advance();
    expect(s.councils).toHaveLength(1);
    expect(s.councils[0]!.votes.every((v) => v.auto)).toBe(true);
  });
});

describe("relic search", () => {
  it("allows one search per player per round", () => {
    const s = new Season(names(8), PROTOTYPE_CONFIG, 1);
    s.searchForRelic("p0");
    expect(() => s.searchForRelic("p0")).toThrow();
  });

  it("never hides more relics than the season allows", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = botSeason(8, PROTOTYPE_CONFIG, seed);
      const found = s.players.reduce((n, p) => n + p.relics, 0) + s.councils.reduce((n, c) => n + c.relicsPlayed.length, 0);
      expect(found).toBeLessThanOrEqual(PROTOTYPE_CONFIG.maxRelics);
    }
  });
});

describe("confessionals", () => {
  it("are private to their author while playing, and visible to the jury", () => {
    const s = new Season(names(4), PROTOTYPE_CONFIG, 1);
    s.addConfessional("p0", "I'm coming for p1.");
    expect(s.confessionalsVisibleTo("p1")).toHaveLength(0);
    expect(s.confessionalsVisibleTo("p0")).toHaveLength(1);
    s.player("p1").status = "jury";
    expect(s.confessionalsVisibleTo("p1")).toHaveLength(1);
  });
});

describe("final council", () => {
  function toFinal(seed: number) {
    const s = new Season(names(6), PROTOTYPE_CONFIG, seed);
    while (s.phase !== "final") s.advance();
    return s;
  }

  it("crowns the finalist with the most jury votes", () => {
    const s = toFinal(3);
    const [j1, j2, j3] = s.jury().map((p) => p.id);
    const [f1, f2] = s.finalists();
    s.castJuryVote(j1!, f1!);
    s.castJuryVote(j2!, f1!);
    s.castJuryVote(j3!, f2!);
    s.advance();
    expect(s.phase).toBe("complete");
    expect(s.final?.winner).toBe(f1);
  });

  it("keeps the vote of a juror who leaves early", () => {
    const s = toFinal(4);
    const [j1, j2, j3] = s.jury().map((p) => p.id);
    const [f1, f2] = s.finalists();
    s.jurorLeaves(j1!, f2!);
    s.castJuryVote(j2!, f2!);
    s.castJuryVote(j3!, f1!);
    s.advance();
    expect(s.final?.winner).toBe(f2);
    expect(s.final?.votes.find((v) => v.juror === j1)).toMatchObject({ finalist: f2, auto: false });
  });

  it("casts a random vote for a juror who leaves without choosing", () => {
    const s = toFinal(5);
    const [j1] = s.jury().map((p) => p.id);
    s.jurorLeaves(j1!);
    s.advance();
    if (s.phase === "final") s.advance(); // possible revote
    const vote = s.final?.votes.find((v) => v.juror === j1);
    expect(vote?.auto).toBe(true);
    expect(s.final?.finalists).toContain(vote?.finalist);
    expect(s.final?.votes).toHaveLength(3);
  });

  it("a juror can leave before the final and still has a vote counted", () => {
    const s = new Season(names(6), PROTOTYPE_CONFIG, 9);
    while (s.jury().length === 0) s.advance();
    const early = s.jury()[0]!.id;
    s.jurorLeaves(early);
    while (s.phase !== "complete") s.advance();
    expect(s.final?.votes.some((v) => v.juror === early)).toBe(true);
  });

  it("goes to a jury revote on a tie", () => {
    const s = toFinal(6);
    const [j1, j2, j3] = s.jury().map((p) => p.id);
    const [f1, f2, f3] = s.finalists();
    s.castJuryVote(j1!, f1!);
    s.castJuryVote(j2!, f2!);
    s.castJuryVote(j3!, f3!);
    s.advance();
    expect(s.phase).toBe("final");
    expect(s.finalists().sort()).toEqual([f1, f2, f3].sort());
    s.castJuryVote(j1!, f2!);
    s.castJuryVote(j2!, f2!);
    s.castJuryVote(j3!, f3!);
    s.advance();
    expect(s.final?.winner).toBe(f2);
  });
});
