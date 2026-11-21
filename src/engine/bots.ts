import { Rng } from "./rng.js";
import type { Season } from "./season.js";
import type { PlayerId } from "./types.js";

/**
 * Placeholder castaways: simple rule-based players used to test the rules.
 * They only use information a real player could see. The language-model castaways
 * replace these later, behind the same `Castaway` interface.
 */
export interface Castaway {
  readonly id: PlayerId;
  onCamp(season: Season): void;
  onChallenge(season: Season): void;
  onCouncil(season: Season): void;
  onFinal(season: Season): void;
  /** Called after each council so the castaway can react to how others voted. */
  onCouncilRevealed(season: Season): void;
}

export class PlaceholderBot implements Castaway {
  readonly id: PlayerId;
  private rng: Rng;
  private skill: number;
  /** How much this bot likes each other castaway, roughly -1..1. */
  private affinity = new Map<PlayerId, number>();

  constructor(id: PlayerId, seed: number) {
    this.id = id;
    this.rng = new Rng(seed);
    this.skill = 0.3 + this.rng.next() * 0.7;
  }

  private like(id: PlayerId): number {
    if (!this.affinity.has(id)) this.affinity.set(id, this.rng.next() * 2 - 1);
    return this.affinity.get(id) as number;
  }

  onCamp(season: Season): void {
    if (!season.player(this.id).searchedThisRound) season.searchForRelic(this.id);
  }

  onChallenge(season: Season): void {
    const score = Math.round(1000 * Math.max(0, this.skill + (this.rng.next() - 0.5) * 0.6));
    season.submitChallengeScore(this.id, score);
  }

  onCouncil(season: Season): void {
    if (!season.eligibleVoters().includes(this.id)) return;
    const me = season.player(this.id);
    if (season.stage === "voting" && me.relics > 0) {
      const fewLeft = season.active().length <= 5;
      if (fewLeft || this.rng.chance(0.35)) season.playRelic(this.id);
    }
    const options = season.voteOptions(this.id);
    if (options.length === 0) return;
    const target = [...options].sort((a, b) => this.like(a) - this.like(b))[0] as PlayerId;
    season.castVote(this.id, target);
  }

  onFinal(season: Season): void {
    if (!season.jurorsVoting().includes(this.id)) return;
    const finalists = season.finalists();
    const choice = [...finalists].sort((a, b) => this.like(b) - this.like(a))[0] as PlayerId;
    season.castJuryVote(this.id, choice);
  }

  onCouncilRevealed(season: Season): void {
    const last = season.councils[season.councils.length - 1];
    if (!last) return;
    for (const v of [...last.votes, ...(last.revote ?? [])]) {
      if (v.target === this.id) this.affinity.set(v.voter, this.like(v.voter) - 0.4);
      else if (v.voter !== this.id && v.target !== this.id) this.affinity.set(v.voter, this.like(v.voter) + 0.05);
    }
  }
}

/** Runs a season to the end with every seat played by a castaway. Returns the season. */
export function autoplay(season: Season, castaways: Castaway[], maxSteps = 1000): Season {
  const byId = new Map(castaways.map((c) => [c.id, c]));
  const each = (fn: (c: Castaway) => void) => {
    for (const p of season.players) {
      const c = byId.get(p.id);
      if (c) fn(c);
    }
  };
  let steps = 0;
  while (season.phase !== "complete") {
    if (++steps > maxSteps) throw new Error("Season did not finish");
    const councilsBefore = season.councils.length;
    switch (season.phase) {
      case "camp":
        each((c) => season.player(c.id).status === "active" && c.onCamp(season));
        break;
      case "challenge":
        each((c) => season.player(c.id).status === "active" && c.onChallenge(season));
        break;
      case "council":
        each((c) => c.onCouncil(season));
        break;
      case "final":
        each((c) => c.onFinal(season));
        break;
      default:
        break;
    }
    season.advance();
    if (season.councils.length > councilsBefore) each((c) => c.onCouncilRevealed(season));
  }
  return season;
}
