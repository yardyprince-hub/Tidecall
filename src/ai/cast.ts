import { PlaceholderBot } from "../engine/bots.js";
import { formatFactor, MEALS_PER_DAY, REWARDS, shelterTier, SOURCES } from "../engine/camp.js";
import { MERGED, type Season } from "../engine/season.js";
import type { PlayerId } from "../engine/types.js";
import type { AiClient } from "./client.js";
import type { CastawayView, Line, Persona, TalkKind } from "./protocol.js";

export interface ChatMessage {
  round: number;
  /** "crew", "camp" (merged), or "dm:<id>" for a private chat between the human and that castaway. */
  channel: string;
  from: PlayerId;
  text: string;
}

/** One AI castaway: a persona, a private plan, and a stand-in bot for when the AI can't answer. */
export class AiCastaway {
  plan = "";
  readonly fallback: PlaceholderBot;
  constructor(
    readonly id: PlayerId,
    readonly persona: Persona,
    seed: number,
  ) {
    this.fallback = new PlaceholderBot(id, seed);
  }
}

/**
 * Runs the AI castaways for one season.
 *
 * It decides what each castaway may know (public events, their own camp's group chat,
 * their own private chat with the human, their own votes and plan) and nothing more:
 * no other castaway's relics, searches, whereabouts, or secret votes.
 *
 * When AI is off or a call fails, each castaway falls back to the stand-in bot, so the
 * season always keeps moving.
 */
export class Cast {
  readonly bots: Map<PlayerId, AiCastaway>;
  private pleas = new Map<PlayerId, string>();

  constructor(
    private season: Season,
    private humanId: PlayerId,
    bots: AiCastaway[],
    private chat: () => ChatMessage[],
    private client: AiClient | null,
  ) {
    this.bots = new Map(bots.map((b) => [b.id, b]));
  }

  get aiOn(): boolean {
    return this.client !== null;
  }

  private name(id: PlayerId): string {
    return this.season.player(id).name;
  }

  /** The group chat channel this castaway can hear, if any. */
  private groupChannel(id: PlayerId): string | null {
    const s = this.season;
    if (s.isMerged) return "camp";
    const human = s.player(this.humanId);
    return human.status === "active" && s.player(id).crew === human.crew ? "crew" : null;
  }

  private lines(messages: ChatMessage[]): Line[] {
    return messages.map((m) => ({ from: this.name(m.from), text: m.text }));
  }

  private events(id: PlayerId): string[] {
    const s = this.season;
    const out = s.log.slice(-24).map((l) => `Round ${l.round}: ${l.text}`);
    for (const c of s.councils.slice(-6)) {
      if (!c.attendees.includes(id)) continue; // only people at a council hear its votes read
      const tally = new Map<string, number>();
      for (const v of c.revote ?? c.votes) tally.set(this.name(v.target), (tally.get(this.name(v.target)) ?? 0) + 1);
      const read = [...tally].map(([n, k]) => `${n} ${k}`).join(", ");
      out.push(`Round ${c.round} council votes read: ${read}. ${this.name(c.eliminated)} went home.`);
    }
    return out;
  }

  private myVotes(id: PlayerId): string[] {
    const out: string[] = [];
    for (const c of this.season.councils) {
      const v = (c.revote ?? c.votes).find((x) => x.voter === id);
      if (v) out.push(`round ${c.round}: ${this.name(v.target)}`);
    }
    return out;
  }

  view(id: PlayerId): CastawayView {
    const s = this.season;
    const me = s.player(id);
    const bot = this.bots.get(id);
    const chat = this.chat();
    const group = this.groupChannel(id);
    const campmates = s
      .active()
      .filter((p) => p.id !== id && (s.isMerged || p.crew === me.crew))
      .map((p) => p.name);
    return {
      name: me.name,
      persona: bot?.persona ?? { voice: "", strategy: "", backstory: "" },
      round: s.round,
      merged: s.isMerged,
      camp: me.crew === MERGED ? "the merged camp" : `${me.crew} crew`,
      campmates,
      standings: s.players.map(
        (p) => `${p.name}: ${p.status === "active" ? (p.crew === MERGED ? "in the game" : `${p.crew} crew`) : p.status === "jury" ? "on the jury" : "out"}`,
      ),
      relics: me.relics,
      events: this.events(id),
      myVotes: this.myVotes(id),
      plan: bot?.plan ?? "",
      privateChat: this.lines(chat.filter((m) => m.channel === `dm:${id}`).slice(-16)),
      groupChat: group ? this.lines(chat.filter((m) => m.channel === group && m.round === s.round).slice(-20)) : [],
      ...this.campInfo(id),
      humanName: this.name(this.humanId),
    };
  }

  /** What a castaway can see around their own camp: the shelter, the food, who brought what back. */
  private campInfo(id: PlayerId): Pick<CastawayView, "campLife" | "todaysWork" | "contributions"> {
    const s = this.season;
    const me = s.player(id);
    if (me.status !== "active") return { campLife: [], todaysWork: "", contributions: [] };
    const camp = s.campOf(id);
    const members = s.campMembers(camp.name);
    const tier = shelterTier(camp.materials);
    const c = camp.condition;
    const campLife = [
      `Shelter: ${camp.materials} materials, which makes ${tier.index === 0 ? "no real shelter yet" : `a ${tier.name.toLowerCase()}`}.${tier.next ? ` ${tier.next} materials makes the next stage.` : ""} Wind and rain strip some materials off every night${camp.items.includes("tarp") ? " (the tarp halves that)" : ""}.`,
      `Food store: ${camp.food} meals. Your camp of ${members.length} eats ${members.length * MEALS_PER_DAY} tonight.`,
      `Camp gear: ${camp.items.length ? camp.items.map((i) => REWARDS[i].name.toLowerCase()).join(", ") : "nothing yet (gear is won as a reward at challenges)"}.`,
      s.round === 1 && c.parts.length === 0
        ? "You washed ashore this morning."
        : `Last night: ${c.parts.map((p) => p.label.toLowerCase()).join(", ")}. Overall condition ${formatFactor(c.factor)} at challenges.`,
    ];
    const chore = me.chore;
    const trips = chore ? Math.floor(chore.energy / SOURCES[chore.source].energy) : 0;
    const todaysWork = !chore
      ? "You haven't picked a job today."
      : trips === 0
        ? "You're taking it easy today and barely helping around camp."
        : `Today you ${SOURCES[chore.source].verb} for the camp (${trips} trip${trips === 1 ? "" : "s"}${trips <= 3 ? ", not much" : ""}).`;
    const haul = (h: { wood: number; food: number }) =>
      h.wood || h.food ? [h.wood ? `${h.wood} material${h.wood === 1 ? "" : "s"}` : "", h.food ? `${h.food} food` : ""].filter(Boolean).join(" and ") : "nothing";
    const contributions = members.map(
      (p) =>
        `${p.id === id ? "You" : p.name}: today ${haul(p.gathered)}${s.round > 1 ? `; last round ${haul(p.gatheredLastRound)}` : ""}`,
    );
    return { campLife, todaysWork, contributions };
  }

  /** A line of dialogue, or null if the AI is off or failed (caller uses a canned line). */
  async line(id: PlayerId, kind: TalkKind, replyTo?: ChatMessage): Promise<string | null> {
    if (!this.client) return null;
    const res = await this.client.talk({
      view: this.view(id),
      kind,
      replyTo: replyTo ? { from: this.name(replyTo.from), text: replyTo.text } : undefined,
    });
    return res?.text ?? null;
  }

  /** Records a confessional and updates the castaway's private plan. Returns the confessional, or null. */
  async confess(id: PlayerId): Promise<string | null> {
    if (!this.client) return null;
    const bot = this.bots.get(id);
    const res = await this.client.confess({ view: this.view(id) });
    if (!res || !bot) return null;
    bot.plan = res.plan;
    if (this.season.player(id).status === "active") this.season.addConfessional(id, res.confessional);
    return res.confessional;
  }

  // ---------- decisions the engine needs ----------

  onCamp(): void {
    for (const bot of this.bots.values()) if (this.season.player(bot.id).status === "active") bot.fallback.onCamp(this.season);
  }

  onChallenge(): void {
    for (const bot of this.bots.values()) if (this.season.player(bot.id).status === "active") bot.fallback.onChallenge(this.season);
  }

  /** Every AI castaway at council casts a vote (and maybe plays a relic). */
  async onCouncil(): Promise<void> {
    const s = this.season;
    const voters = [...this.bots.values()].filter((b) => s.eligibleVoters().includes(b.id));
    const immune = s.immunePlayers().map((id) => this.name(id));
    const revote = s.stage === "revote";
    await Promise.all(
      voters.map(async (bot) => {
        const options = s.voteOptions(bot.id);
        if (options.length === 0) return;
        const canPlayRelic = !revote && s.player(bot.id).relics > 0;
        const res = this.client
          ? await this.client.vote({ view: this.view(bot.id), options: options.map((o) => this.name(o)), revote, canPlayRelic, immune })
          : null;
        const target = res && options.find((o) => this.name(o) === res.vote);
        if (!res || !target) return bot.fallback.onCouncil(s);
        s.castVote(bot.id, target);
        if (res.playRelic && canPlayRelic && s.stage === "voting") s.playRelic(bot.id);
      }),
    );
  }

  /** Every AI juror votes for a finalist, after hearing the finalists' speeches. */
  async onFinal(humanPlea: string): Promise<void> {
    const s = this.season;
    const finalists = s.finalists();
    await this.preparePleas();
    if (finalists.includes(this.humanId) && humanPlea.trim()) this.pleas.set(this.humanId, humanPlea.trim());
    const pleas: Line[] = finalists.filter((id) => this.pleas.has(id)).map((id) => ({ from: this.name(id), text: this.pleas.get(id)! }));
    const confessionals: Line[] = s.confessionals.map((c) => ({ from: this.name(c.player), text: c.text }));
    const jurors = [...this.bots.values()].filter((b) => s.jurorsVoting().includes(b.id));
    await Promise.all(
      jurors.map(async (bot) => {
        const res = this.client
          ? await this.client.jury({ view: this.view(bot.id), finalists: finalists.map((f) => this.name(f)), pleas, confessionals })
          : null;
        const pick = res && finalists.find((f) => this.name(f) === res.vote);
        if (!pick) return bot.fallback.onFinal(s);
        s.castJuryVote(bot.id, pick);
      }),
    );
  }

  /** AI finalists write their speech to the jury (once per final). */
  async preparePleas(): Promise<void> {
    const finalists = this.season.finalists();
    if (this.client) {
      await Promise.all(
        finalists
          .filter((id) => id !== this.humanId && !this.pleas.has(id))
          .map(async (id) => {
            const text = await this.line(id, "plea");
            if (text) this.pleas.set(id, text);
          }),
      );
    }
  }

  /** The speeches the finalists gave (for showing on screen). */
  finalPleas(): Line[] {
    return [...this.pleas].map(([id, text]) => ({ from: this.name(id), text }));
  }

  onCouncilRevealed(): void {
    for (const bot of this.bots.values()) bot.fallback.onCouncilRevealed(this.season);
  }

  /** Runs whatever the castaways need to do in the current phase. */
  async act(humanPlea = ""): Promise<void> {
    switch (this.season.phase) {
      case "camp":
        return this.onCamp();
      case "challenge":
        return this.onChallenge();
      case "council":
        return this.onCouncil();
      case "final":
        return this.onFinal(humanPlea);
      default:
        return;
    }
  }
}
