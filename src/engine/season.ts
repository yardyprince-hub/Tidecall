import { Rng } from "./rng.js";
import type {
  Confessional,
  CouncilResult,
  FinalResult,
  LogEntry,
  Phase,
  Player,
  PlayerId,
  SeasonConfig,
} from "./types.js";

export const MERGED = "merged";

export interface NewPlayer {
  id: PlayerId;
  name: string;
  isHuman?: boolean;
}

type CouncilStage = "voting" | "revote";

/**
 * The rules of one Tidecall season, with no networking, timers or AI in it.
 *
 * Callers move the season along with `advance()`. Between advances they feed in player
 * input (relic searches, challenge scores, votes). Any input a player fails to give
 * before `advance()` is filled in by the rules: a missing challenge score counts as 0,
 * and a missing vote is cast at random, so a round never stalls.
 */
export class Season {
  readonly config: SeasonConfig;
  readonly players: Player[];
  readonly log: LogEntry[] = [];
  readonly councils: CouncilResult[] = [];
  readonly confessionals: Confessional[] = [];
  final: FinalResult | null = null;

  private rng: Rng;
  private _phase: Phase = "camp";
  private _round = 1;
  private merged = false;
  private relicsFound = 0;

  private challengeScores = new Map<PlayerId, number>();
  private immune = new Set<PlayerId>();
  private attendees: PlayerId[] = [];
  private councilStage: CouncilStage = "voting";
  private votes = new Map<PlayerId, PlayerId>();
  private relicPlays = new Set<PlayerId>();
  private revoteCandidates: PlayerId[] = [];
  private firstVotes: CouncilResult["votes"] = [];

  private finalStage: "voting" | "revote" = "voting";
  private juryVotes = new Map<PlayerId, PlayerId>();
  /** Jurors who left early: their chosen finalist, or null for "cast at random". */
  private departedJurors = new Map<PlayerId, PlayerId | null>();
  private finalCandidates: PlayerId[] = [];
  private firstJuryVotes: FinalResult["votes"] = [];

  constructor(players: NewPlayer[], config: SeasonConfig, seed: number) {
    if (players.length < config.finalists + 1) {
      throw new Error(`Need at least ${config.finalists + 1} players`);
    }
    if (new Set(players.map((p) => p.id)).size !== players.length) {
      throw new Error("Player ids must be unique");
    }
    this.config = config;
    this.rng = new Rng(seed);
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      isHuman: p.isHuman ?? false,
      crew: "",
      status: "active",
      relics: 0,
      searchedThisRound: false,
    }));
    if (this.players.length <= config.mergeAt) {
      this.merge();
    } else {
      this.dealCrews();
    }
    this.note(`${this.players.length} castaways wash ashore.`);
  }

  // ---------- read-only views ----------

  get phase(): Phase {
    return this._phase;
  }

  get round(): number {
    return this._round;
  }

  get isMerged(): boolean {
    return this.merged;
  }

  get stage(): CouncilStage {
    return this.councilStage;
  }

  player(id: PlayerId): Player {
    const p = this.players.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown player ${id}`);
    return p;
  }

  active(): Player[] {
    return this.players.filter((p) => p.status === "active");
  }

  jury(): Player[] {
    return this.players.filter((p) => p.status === "jury");
  }

  crews(): Map<string, Player[]> {
    const out = new Map<string, Player[]>();
    for (const p of this.active()) {
      const list = out.get(p.crew) ?? [];
      list.push(p);
      out.set(p.crew, list);
    }
    return out;
  }

  /** Players at the current council (empty outside council). */
  councilAttendees(): PlayerId[] {
    return [...this.attendees];
  }

  immunePlayers(): PlayerId[] {
    return [...this.immune];
  }

  /** Who may cast a vote right now at council. */
  eligibleVoters(): PlayerId[] {
    if (this._phase !== "council") return [];
    if (this.councilStage === "revote") {
      return this.attendees.filter((id) => !this.revoteCandidates.includes(id));
    }
    return [...this.attendees];
  }

  /** Who `voter` may vote for right now. */
  voteOptions(voter: PlayerId): PlayerId[] {
    if (this._phase !== "council") return [];
    const pool = this.councilStage === "revote" ? this.revoteCandidates : this.attendees;
    return pool.filter((id) => id !== voter && !this.immune.has(id));
  }

  /** Finalists the jury chooses between right now. */
  finalists(): PlayerId[] {
    if (this._phase !== "final") return [];
    return this.finalStage === "revote" ? [...this.finalCandidates] : this.active().map((p) => p.id);
  }

  /** Jurors who still need to vote in the current final stage. */
  jurorsVoting(): PlayerId[] {
    if (this._phase !== "final") return [];
    return this.jury()
      .map((p) => p.id)
      .filter((id) => !this.departedJurors.has(id));
  }

  // ---------- player input ----------

  /** One relic search per player per round, during camp. Returns true if a relic was found. */
  searchForRelic(id: PlayerId): boolean {
    this.require("camp");
    const p = this.requireActive(id);
    if (p.searchedThisRound) throw new Error(`${p.name} already searched this round`);
    p.searchedThisRound = true;
    if (this.relicsFound >= this.config.maxRelics) return false;
    if (!this.rng.chance(this.config.relicFindChance)) return false;
    p.relics += 1;
    this.relicsFound += 1;
    return true;
  }

  /** A private note "to the camera". The jury and the end-of-season recap can read these. */
  addConfessional(id: PlayerId, text: string): void {
    this.requireActive(id);
    const trimmed = text.trim();
    if (!trimmed) return;
    this.confessionals.push({ round: this._round, player: id, text: trimmed.slice(0, 1000) });
  }

  /** Confessionals a given viewer may read. Jurors see them all; players still in the game see only their own. */
  confessionalsVisibleTo(viewer: PlayerId): Confessional[] {
    const v = this.player(viewer);
    if (v.status === "active") return this.confessionals.filter((c) => c.player === viewer);
    return [...this.confessionals];
  }

  submitChallengeScore(id: PlayerId, score: number): void {
    this.require("challenge");
    this.requireActive(id);
    if (!Number.isFinite(score) || score < 0) throw new Error("Score must be a non-negative number");
    this.challengeScores.set(id, score);
  }

  castVote(voter: PlayerId, target: PlayerId): void {
    this.require("council");
    if (!this.eligibleVoters().includes(voter)) throw new Error(`${voter} cannot vote now`);
    if (!this.voteOptions(voter).includes(target)) throw new Error(`${voter} cannot vote for ${target}`);
    this.votes.set(voter, target);
  }

  /** Play a Ward relic at council: every vote against the holder is cancelled. */
  playRelic(id: PlayerId): void {
    this.require("council");
    if (this.councilStage !== "voting") throw new Error("Relics can only be played before the first reveal");
    if (!this.attendees.includes(id)) throw new Error(`${id} is not at council`);
    const p = this.player(id);
    if (p.relics < 1) throw new Error(`${p.name} has no relic`);
    if (this.relicPlays.has(id)) return;
    p.relics -= 1;
    this.relicPlays.add(id);
  }

  castJuryVote(juror: PlayerId, finalist: PlayerId): void {
    this.require("final");
    if (!this.jurorsVoting().includes(juror)) throw new Error(`${juror} cannot vote now`);
    if (!this.finalists().includes(finalist)) throw new Error(`${finalist} is not a finalist`);
    this.juryVotes.set(juror, finalist);
  }

  /**
   * A juror leaves the game before the final vote. They must lock in a vote; if they
   * leave without one (or before finalists are known), the game casts it for a random
   * finalist so no jury vote is lost.
   */
  jurorLeaves(juror: PlayerId, finalist?: PlayerId): void {
    const p = this.player(juror);
    if (p.status !== "jury") throw new Error(`${p.name} is not on the jury`);
    if (finalist !== undefined) {
      this.require("final");
      if (!this.finalists().includes(finalist)) throw new Error(`${finalist} is not a finalist`);
    }
    this.departedJurors.set(juror, finalist ?? null);
    this.juryVotes.delete(juror);
  }

  // ---------- moving the season along ----------

  advance(): void {
    switch (this._phase) {
      case "camp":
        this._phase = "challenge";
        this.challengeScores.clear();
        break;
      case "challenge":
        this.resolveChallenge();
        this._phase = "scramble";
        break;
      case "scramble":
        this._phase = "council";
        this.councilStage = "voting";
        this.votes.clear();
        this.relicPlays.clear();
        break;
      case "council":
        this.resolveCouncilStep();
        break;
      case "final":
        this.resolveFinalStep();
        break;
      case "complete":
        throw new Error("The season is over");
    }
  }

  // ---------- rules ----------

  private resolveChallenge(): void {
    this.immune.clear();
    const scoreOf = (id: PlayerId) => this.challengeScores.get(id) ?? 0;

    if (this.merged) {
      const players = this.active();
      const best = Math.max(...players.map((p) => scoreOf(p.id)));
      const top = players.filter((p) => scoreOf(p.id) === best);
      const winner = this.rng.pick(top);
      this.immune.add(winner.id);
      this.attendees = players.map((p) => p.id);
      this.note(`${winner.name} wins the challenge and earns a Ward.`);
      return;
    }

    const crews = this.crews();
    const topN = Math.min(...[...crews.values()].map((c) => c.length));
    const crewScore = (members: Player[]) => {
      const scores = members.map((m) => scoreOf(m.id)).sort((a, b) => b - a).slice(0, topN);
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    };
    const scored = [...crews.entries()].map(([name, members]) => ({ name, members, score: crewScore(members) }));
    const worst = Math.min(...scored.map((s) => s.score));
    const loser = this.rng.pick(scored.filter((s) => s.score === worst));
    this.attendees = loser.members.map((m) => m.id);
    this.note(`${loser.name} crew loses the challenge and heads to Lantern Council.`);
  }

  private resolveCouncilStep(): void {
    if (this.councilStage === "voting") {
      // Fill in any missing votes at random so the round never stalls.
      const votes: CouncilResult["votes"] = [];
      for (const voter of this.eligibleVoters()) {
        let target = this.votes.get(voter);
        let auto = false;
        if (!target) {
          const options = this.voteOptions(voter);
          if (options.length === 0) continue;
          target = this.rng.pick(options);
          auto = true;
        }
        votes.push({ voter, target, cancelled: this.relicPlays.has(target), auto });
      }
      this.firstVotes = this.rng.shuffle(votes); // reveal order
      for (const id of this.relicPlays) this.note(`${this.player(id).name} plays a Ward relic.`);

      const counted = votes.filter((v) => !v.cancelled).map((v) => v.target);
      if (counted.length === 0) {
        const pool = this.attendees.filter((id) => !this.immune.has(id) && !this.relicPlays.has(id));
        this.eliminate(this.rng.pick(pool.length ? pool : this.attendees), true);
        return;
      }
      const leaders = topOf(counted);
      if (leaders.length === 1) {
        this.eliminate(leaders[0] as PlayerId, false);
        return;
      }
      // Tie: tied players do not vote; everyone else revotes between them.
      this.revoteCandidates = leaders;
      this.councilStage = "revote";
      this.votes.clear();
      this.note(`Tie between ${this.listNames(leaders)}. Revote.`);
      if (this.eligibleVoters().length === 0) this.resolveCouncilStep();
      return;
    }

    // Revote stage.
    const revote: NonNullable<CouncilResult["revote"]> = [];
    for (const voter of this.eligibleVoters()) {
      let target = this.votes.get(voter);
      let auto = false;
      if (!target) {
        const options = this.voteOptions(voter);
        if (options.length === 0) continue;
        target = this.rng.pick(options);
        auto = true;
      }
      revote.push({ voter, target, auto });
    }
    const leaders = revote.length ? topOf(revote.map((v) => v.target)) : this.revoteCandidates;
    if (leaders.length === 1) {
      this.eliminate(leaders[0] as PlayerId, false, revote);
    } else {
      this.note("Still tied. The castaways draw lots.");
      this.eliminate(this.rng.pick(leaders), true, revote);
    }
  }

  private eliminate(id: PlayerId, drewLots: boolean, revote?: CouncilResult["revote"]): void {
    const p = this.player(id);
    p.status = this.merged ? "jury" : "out";
    p.outInRound = this._round;
    this.councils.push({
      round: this._round,
      attendees: [...this.attendees],
      immune: [...this.immune],
      votes: this.firstVotes,
      relicsPlayed: [...this.relicPlays],
      revote,
      drewLots,
      eliminated: id,
    });
    this.note(`${p.name}'s lantern goes dark.${p.status === "jury" ? " They join the jury." : ""}`);

    this.attendees = [];
    this.immune.clear();
    this.revoteCandidates = [];
    this.councilStage = "voting";
    this.firstVotes = [];

    const remaining = this.active().length;
    if (remaining <= this.config.finalists) {
      this._phase = "final";
      this.finalStage = "voting";
      this.juryVotes.clear();
      this.note(`Final council: ${this.active().map((x) => x.name).join(", ")} face the jury.`);
      return;
    }
    if (!this.merged && remaining <= this.config.mergeAt) {
      this.merge();
    } else if (!this.merged && this.config.swapAt !== null && remaining === this.config.swapAt) {
      this.dealCrews();
      this.note("Crew swap! The crews are reshuffled.");
    } else if (!this.merged && [...this.crews().values()].some((c) => c.length < 2)) {
      this.dealCrews();
      this.note("A crew is too small to hold council. The crews are reshuffled.");
    }
    this._round += 1;
    this._phase = "camp";
    for (const x of this.players) x.searchedThisRound = false;
  }

  private resolveFinalStep(): void {
    const candidates = this.finalists();
    const votes: FinalResult["votes"] = [];
    for (const juror of this.jury().map((p) => p.id)) {
      if (this.departedJurors.has(juror)) {
        const locked = this.departedJurors.get(juror) ?? null;
        if (locked && candidates.includes(locked)) {
          votes.push({ juror, finalist: locked, auto: false });
        } else {
          votes.push({ juror, finalist: this.rng.pick(candidates), auto: true });
        }
        continue;
      }
      const choice = this.juryVotes.get(juror);
      if (choice && candidates.includes(choice)) votes.push({ juror, finalist: choice, auto: false });
      else votes.push({ juror, finalist: this.rng.pick(candidates), auto: true });
    }

    if (this.finalStage === "voting") {
      this.firstJuryVotes = this.rng.shuffle(votes);
      const leaders = votes.length ? topOf(votes.map((v) => v.finalist)) : candidates;
      if (leaders.length === 1) {
        this.crown(leaders[0] as PlayerId, false);
        return;
      }
      this.finalStage = "revote";
      this.finalCandidates = leaders;
      this.juryVotes.clear();
      // A departed juror's locked vote may be for someone no longer in the revote; it is re-rolled.
      this.note(`The jury is tied between ${this.listNames(leaders)}. The jury revotes.`);
      return;
    }

    const leaders = votes.length ? topOf(votes.map((v) => v.finalist)) : candidates;
    if (leaders.length === 1) this.crown(leaders[0] as PlayerId, false, votes);
    else this.crown(this.rng.pick(leaders), true, votes);
  }

  private crown(id: PlayerId, drewLots: boolean, revote?: FinalResult["revote"]): void {
    this.final = {
      finalists: this.active().map((p) => p.id),
      votes: this.firstJuryVotes,
      revote,
      drewLots,
      winner: id,
    };
    this._phase = "complete";
    this.note(`${this.player(id).name} is crowned the Sole Castaway!`);
  }

  private dealCrews(): void {
    const shuffled = this.rng.shuffle(this.active());
    shuffled.forEach((p, i) => {
      p.crew = this.config.crews[i % this.config.crews.length] as string;
    });
  }

  private merge(): void {
    this.merged = true;
    for (const p of this.active()) p.crew = MERGED;
    this.note("The crews merge into one camp. From now on it's every castaway for themselves.");
  }

  private require(phase: Phase): void {
    if (this._phase !== phase) throw new Error(`Not allowed during ${this._phase} (needs ${phase})`);
  }

  private requireActive(id: PlayerId): Player {
    const p = this.player(id);
    if (p.status !== "active") throw new Error(`${p.name} is no longer in the game`);
    return p;
  }

  private listNames(ids: PlayerId[]): string {
    const names = ids.map((id) => this.player(id).name);
    return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  private note(text: string): void {
    this.log.push({ round: this._round, phase: this._phase, text });
  }
}

/** The ids with the most occurrences (several if tied). */
function topOf(ids: PlayerId[]): PlayerId[] {
  const counts = new Map<PlayerId, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const max = Math.max(...counts.values());
  return [...counts.entries()].filter(([, n]) => n === max).map(([id]) => id);
}
