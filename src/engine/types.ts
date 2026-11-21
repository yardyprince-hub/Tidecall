export type PlayerId = string;

export type Phase =
  | "camp" // chat, private messages, one relic search each
  | "challenge" // everyone submits a score
  | "scramble" // lobbying before council (no engine input needed)
  | "council" // secret vote, then relic window, then reveal
  | "final" // jury votes for a finalist
  | "complete";

export type PlayerStatus = "active" | "jury" | "out";

export interface Player {
  id: PlayerId;
  name: string;
  isHuman: boolean;
  /** Crew name, or "merged" after the merge. */
  crew: string;
  status: PlayerStatus;
  /** Ward relics held (each cancels all votes against the holder at one council). */
  relics: number;
  /** Has this player already searched for a relic this round? */
  searchedThisRound: boolean;
  /** Round in which the player was voted out, if any. */
  outInRound?: number;
}

export interface SeasonConfig {
  /** Crew names; players are dealt evenly into them. */
  crews: string[];
  /** Reshuffle crews when this many players remain. null = no swap. */
  swapAt: number | null;
  /** Merge into one camp when this many players remain. */
  mergeAt: number;
  /** Number of finalists at final council. */
  finalists: number;
  /** Chance a relic search succeeds. */
  relicFindChance: number;
  /** Maximum relics hidden in the whole season. */
  maxRelics: number;
}

export const PROTOTYPE_CONFIG: SeasonConfig = {
  crews: ["Coral", "Driftwood"],
  swapAt: null,
  mergeAt: 6,
  finalists: 3,
  relicFindChance: 1 / 3,
  maxRelics: 2,
};

export const LIVE_CONFIG: SeasonConfig = {
  crews: ["Coral", "Driftwood"],
  swapAt: 10,
  mergeAt: 8,
  finalists: 3,
  relicFindChance: 1 / 3,
  maxRelics: 3,
};

export interface CouncilResult {
  round: number;
  attendees: PlayerId[];
  immune: PlayerId[];
  /** voter -> target, in reveal order. */
  votes: { voter: PlayerId; target: PlayerId; cancelled: boolean; auto: boolean }[];
  relicsPlayed: PlayerId[];
  revote?: { voter: PlayerId; target: PlayerId; auto: boolean }[];
  drewLots: boolean;
  eliminated: PlayerId;
}

export interface FinalResult {
  finalists: PlayerId[];
  votes: { juror: PlayerId; finalist: PlayerId; auto: boolean }[];
  revote?: { juror: PlayerId; finalist: PlayerId; auto: boolean }[];
  drewLots: boolean;
  winner: PlayerId;
}

export interface Confessional {
  round: number;
  player: PlayerId;
  text: string;
}

export type LogEntry = { round: number; phase: Phase; text: string };
