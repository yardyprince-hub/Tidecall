/**
 * What the browser sends to the local AI server, and what comes back.
 *
 * The browser decides what each AI castaway is allowed to know (see context.ts) and
 * sends only that. The server turns it into a prompt, calls Claude with the API key it
 * holds, and returns a short answer. The key never reaches the browser.
 */

export interface Persona {
  /** How they talk. */
  voice: string;
  /** How they like to play. */
  strategy: string;
  /** Something about who they were before the wreck, to give them texture. */
  backstory: string;
}

export interface Line {
  from: string;
  text: string;
}

/** Everything one castaway knows right now, written from their point of view. */
export interface CastawayView {
  name: string;
  persona: Persona;
  round: number;
  merged: boolean;
  /** "Coral crew", "Driftwood crew", or "the merged camp". */
  camp: string;
  /** Names of the people they live with right now (not including themselves). */
  campmates: string[];
  /** Everyone still in the game, with their crew, plus who is on the jury and who is out. */
  standings: string[];
  /** Ward relics they secretly hold. */
  relics: number;
  /** Public things that have happened: challenge results, who went home, tallies. */
  events: string[];
  /** Their own votes so far, so they remember what they did. */
  myVotes: string[];
  /** Their private plan from their last confessional. */
  plan: string;
  /** Recent private chat between them and the human player (the only DMs that exist). */
  privateChat: Line[];
  /** What was said today in the group chat they can hear. */
  groupChat: Line[];
  /** The human player's name, so prompts can refer to them. */
  humanName: string;
}

export type TalkKind = "camp" | "scramble" | "reply" | "dm" | "plea";

export interface TalkRequest {
  op: "talk";
  view: CastawayView;
  kind: TalkKind;
  /** For "reply" and "dm": the message they are answering. */
  replyTo?: Line;
}
export interface TalkResponse {
  text: string;
}

export interface ConfessRequest {
  op: "confess";
  view: CastawayView;
}
export interface ConfessResponse {
  confessional: string;
  plan: string;
}

export interface VoteRequest {
  op: "vote";
  view: CastawayView;
  options: string[];
  revote: boolean;
  canPlayRelic: boolean;
  /** Who is safe tonight (won the Ward), if anyone. */
  immune: string[];
}
export interface VoteResponse {
  vote: string;
  playRelic: boolean;
  reason: string;
}

export interface JuryRequest {
  op: "jury";
  view: CastawayView;
  finalists: string[];
  pleas: Line[];
  /** Jurors can read every confessional. */
  confessionals: Line[];
}
export interface JuryResponse {
  vote: string;
  reason: string;
}

export type AiRequest = TalkRequest | ConfessRequest | VoteRequest | JuryRequest;

export interface AiStatus {
  enabled: boolean;
  model?: string;
}
