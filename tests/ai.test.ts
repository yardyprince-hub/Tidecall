import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { aiHandler, AiBrain, type MessagesClient } from "../server/ai.js";
import { AiCastaway, Cast, type ChatMessage } from "../src/ai/cast.js";
import type { AiClient } from "../src/ai/client.js";
import { PERSONAS } from "../src/ai/personas.js";
import type { CastawayView } from "../src/ai/protocol.js";
import { briefing, cleanLine, matchOption, votePrompt } from "../src/ai/prompts.js";
import { Rng } from "../src/engine/rng.js";
import { Season } from "../src/engine/season.js";
import { PROTOTYPE_CONFIG } from "../src/engine/types.js";

const NAMES = ["You", "Ana", "Bo", "Cyra", "Dez", "Emre", "Fen", "Gil"];

function newSeason(seed = 3) {
  const players = NAMES.map((n, i) => ({ id: i === 0 ? "you" : n.toLowerCase(), name: n, isHuman: i === 0 }));
  const season = new Season(players, PROTOTYPE_CONFIG, seed);
  const bots = NAMES.slice(1).map((n, i) => new AiCastaway(n.toLowerCase(), PERSONAS[i]!, seed + i));
  return { season, bots };
}

/** A pretend AI that answers instantly: talks, and votes for the first allowed name. */
function fakeClient(log: string[] = []): AiClient {
  return {
    status: async () => ({ enabled: true, model: "fake" }),
    talk: async (r) => (log.push(`talk:${r.view.name}:${r.kind}`), { text: `${r.view.name} says hi` }),
    confess: async (r) => (log.push(`confess:${r.view.name}`), { confessional: "I'm fine.", plan: `${r.view.name}'s plan` }),
    vote: async (r) => (log.push(`vote:${r.view.name}`), { vote: r.options[0]!, playRelic: r.canPlayRelic, reason: "" }),
    jury: async (r) => (log.push(`jury:${r.view.name}`), { vote: r.finalists[0]!, reason: "" }),
  };
}

/** Plays a whole season with the human acting like a bot (random votes), driving the Cast. */
async function playSeason(cast: Cast, season: Season) {
  const rng = new Rng(9);
  let steps = 0;
  while (season.phase !== "complete") {
    if (++steps > 500) throw new Error("stuck");
    const before = season.councils.length;
    if (season.phase === "challenge" && season.player("you").status === "active") season.submitChallengeScore("you", 500);
    if (season.phase === "council" && season.eligibleVoters().includes("you")) season.castVote("you", rng.pick(season.voteOptions("you")));
    if (season.phase === "final" && season.jurorsVoting().includes("you")) season.castJuryVote("you", rng.pick(season.finalists()));
    await cast.act("Vote for me.");
    season.advance();
    if (season.councils.length > before) cast.onCouncilRevealed();
  }
}

describe("AI castaways in a season", () => {
  it("finishes a season with AI decisions", async () => {
    const { season, bots } = newSeason();
    const log: string[] = [];
    const cast = new Cast(season, "you", bots, () => [], fakeClient(log));
    await playSeason(cast, season);
    expect(season.final?.winner).toBeTruthy();
    expect(log.some((l) => l.startsWith("vote:"))).toBe(true);
    expect(log.some((l) => l.startsWith("jury:"))).toBe(true);
    expect(log.some((l) => l.endsWith(":plea"))).toBe(true);
  });

  it("finishes a season with AI off (stand-in bots)", async () => {
    const { season, bots } = newSeason(5);
    const cast = new Cast(season, "you", bots, () => [], null);
    await playSeason(cast, season);
    expect(season.final?.winner).toBeTruthy();
  });

  it("falls back to the stand-in bot when the AI fails", async () => {
    const { season, bots } = newSeason(7);
    const broken: AiClient = { ...fakeClient(), vote: async () => null, jury: async () => null, talk: async () => null };
    const cast = new Cast(season, "you", bots, () => [], broken);
    await playSeason(cast, season);
    expect(season.final?.winner).toBeTruthy();
    expect(season.councils.every((c) => c.votes.every((v) => !v.auto || v.voter === "you"))).toBe(true);
  });

  it("only tells a castaway what they could know", () => {
    const { season, bots } = newSeason();
    const chat: ChatMessage[] = [
      { round: 1, channel: "dm:ana", from: "you", text: "secret for Ana" },
      { round: 1, channel: "dm:bo", from: "you", text: "secret for Bo" },
      { round: 1, channel: "crew", from: "you", text: "hi crew" },
    ];
    const cast = new Cast(season, "you", bots, () => chat, fakeClient());
    season.player("bo").relics = 1;
    const me = season.player("you");
    const mate = season.active().find((p) => p.id !== "you" && p.crew === me.crew)!;
    const rival = season.active().find((p) => p.crew !== me.crew)!;

    const mateView = cast.view(mate.id);
    expect(mateView.groupChat.map((l) => l.text)).toEqual(["hi crew"]);
    const rivalView = cast.view(rival.id);
    expect(rivalView.groupChat).toEqual([]);

    const ana = cast.view("ana");
    expect(ana.privateChat.map((l) => l.text)).toEqual(["secret for Ana"]);
    const text = briefing(ana);
    expect(text).not.toContain("secret for Bo");
    expect(text).toContain("Your secret Ward relics: 0");
  });

  it("tells a castaway about their camp and their real chore for the day", () => {
    const { season, bots } = newSeason();
    const cast = new Cast(season, "you", bots, () => [], fakeClient());
    const mate = season.active().find((p) => p.id !== "you" && p.crew === season.player("you").crew)!;
    season.setChore(mate.id, "palm", 8);
    season.gather("you", "fruit");
    const text = briefing(cast.view(mate.id));
    expect(text).toContain("Today you cut palm fronds and branches for the camp (8 trips)");
    expect(text).toContain("Shelter: 0 materials");
    expect(text).toContain("You: today nothing");
    expect(text).toContain(`${season.player("you").name}: today 1 food`);
  });

  it("an AI confessional updates the castaway's private plan", async () => {
    const { season, bots } = newSeason();
    const cast = new Cast(season, "you", bots, () => [], fakeClient());
    await cast.confess("ana");
    expect(cast.view("ana").plan).toBe("Ana's plan");
    expect(season.confessionals.at(-1)?.text).toBe("I'm fine.");
  });
});

describe("prompt helpers", () => {
  it("cleans model chat lines", () => {
    expect(cleanLine('Ana: "We stick together."', "Ana")).toBe("We stick together.");
    expect(cleanLine("x".repeat(300), "Ana").length).toBeLessThanOrEqual(240);
  });

  it("matches vote answers to allowed names", () => {
    expect(matchOption(" bo ", ["Ana", "Bo"])).toBe("Bo");
    expect(matchOption("I vote Ana.", ["Ana", "Bo"])).toBe("Ana");
    expect(matchOption("Zed", ["Ana", "Bo"])).toBeNull();
  });

  it("lists the allowed names in the vote prompt", () => {
    const view = { name: "Ana", persona: PERSONAS[0]!, events: [], myVotes: [], standings: [], campmates: [], privateChat: [], groupChat: [] } as unknown as CastawayView;
    const p = votePrompt({ op: "vote", view, options: ["Bo", "Cyra"], revote: false, canPlayRelic: false, immune: ["Dez"] });
    expect(p).toContain("Bo, Cyra");
    expect(p).toContain("Dez won the Ward");
  });
});

/** Fake SDK: returns whatever parsed output the test sets. */
function fakeMessages(out: unknown, stop = "end_turn"): MessagesClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    parse: (async (params: unknown) => {
      calls.push(params);
      return { stop_reason: stop, parsed_output: out, content: [] };
    }) as unknown as MessagesClient["parse"],
  };
}

describe("AI server", () => {
  const { season, bots } = newSeason();
  const cast = new Cast(season, "you", bots, () => [], null);
  const anaView = cast.view("ana");

  it("sends the cached rules, low effort, and a structured format", async () => {
    const messages = fakeMessages({ text: "Hey all." });
    const brain = new AiBrain(messages, "claude-opus-5-5");
    expect(await brain.handle({ op: "talk", view: anaView, kind: "camp" })).toEqual({ text: "Hey all." });
    const params = messages.calls[0] as { model: string; system: { cache_control: unknown }[]; output_config: { effort: string; format: unknown } };
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format).toBeTruthy();
  });

  it("rejects a vote for someone who isn't an option", async () => {
    const brain = new AiBrain(fakeMessages({ vote: "Zed", playRelic: false, reason: "" }));
    expect(await brain.handle({ op: "vote", view: anaView, options: ["Bo"], revote: false, canPlayRelic: false, immune: [] })).toBeNull();
  });

  it("never plays a relic the castaway can't play", async () => {
    const brain = new AiBrain(fakeMessages({ vote: "bo", playRelic: true, reason: "" }));
    expect(await brain.handle({ op: "vote", view: anaView, options: ["Bo"], revote: false, canPlayRelic: false, immune: [] })).toEqual({
      vote: "Bo",
      playRelic: false,
      reason: "",
    });
  });

  it("returns nothing on a refusal", async () => {
    const brain = new AiBrain(fakeMessages(null, "refusal"));
    expect(await brain.handle({ op: "talk", view: anaView, kind: "camp" })).toBeNull();
  });

  it("reports AI off and refuses calls when there's no key", async () => {
    const handler = aiHandler(null);
    const call = (method: string, url: string) =>
      new Promise<{ status: number; body: unknown }>((resolve) => {
        const res = { statusCode: 0, setHeader() {}, end: (text: string) => resolve({ status: res.statusCode, body: JSON.parse(text) }) };
        void handler({ method, url, on() {} } as unknown as IncomingMessage, res as unknown as ServerResponse);
      });
    expect(await call("GET", "/status")).toEqual({ status: 200, body: { enabled: false } });
    expect((await call("POST", "/")).status).toBe(503);
  });
});
