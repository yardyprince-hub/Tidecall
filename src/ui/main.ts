import "./style.css";
import { AiCastaway, Cast, type ChatMessage } from "../ai/cast.js";
import { httpAiClient } from "../ai/client.js";
import { dealPersonas } from "../ai/personas.js";
import type { AiStatus } from "../ai/protocol.js";
import { formatFactor, MEALS_PER_DAY, REWARDS, shelterTier, SOURCES, type RewardItem } from "../engine/camp.js";
import { Rng } from "../engine/rng.js";
import { MERGED, Season } from "../engine/season.js";
import { PROTOTYPE_CONFIG, type PlayerId } from "../engine/types.js";
import { CHALLENGES, runChallenge, type ChallengeKind } from "./challenges.js";
import { chatter } from "./chatter.js";
import { describeItem, Island, type Interaction } from "./island.js";

const YOU = "you";
/** How long camp lasts before the challenge starts on its own. The start screen offers these. */
const CAMP_TIME_CHOICES = [60, 120, 180];
const DEFAULT_CAMP_SECONDS = 60;
const CASTAWAY_NAMES = ["Ana", "Bo", "Cyra", "Dez", "Emre", "Fen", "Gil", "Hana", "Isa", "Jory", "Kai", "Lu"];

interface Game {
  season: Season;
  cast: Cast;
  rng: Rng;
  /** The season's seed: keeps the island's trees in the same places all season. */
  seed: number;
  chat: ChatMessage[];
  channel: string;
  lastChallenge: ChallengeKind | null;
  finalStatement: string;
  /** Seconds of camp time before each challenge starts on its own. */
  campSeconds: number;
}

const app = document.getElementById("app") as HTMLElement;
let game: Game | null = null;
let island: Island | null = null;
/** The camp countdown, if one is running. */
let campClock: ReturnType<typeof setInterval> | null = null;
let ai: AiStatus = { enabled: false };
/** Who is "typing" right now, shown under the chat. */
const typing = new Set<PlayerId>();

// ---------- helpers ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const name = (id: PlayerId) => (game ? game.season.player(id).name : id);
const me = () => game!.season.player(YOU);

/** Let the castaways do whatever the current phase needs. Votes may take a few seconds with AI on. */
async function botsAct(): Promise<void> {
  await game!.cast.act(game!.finalStatement);
}

function afterCouncilRevealed(): void {
  game!.cast.onCouncilRevealed();
}

/** A holding screen while the castaways think. */
function busy(text: string): void {
  page(`<h1 class="busy">${esc(text)}</h1><p class="note">${ai.enabled ? "The castaways are thinking it over." : ""}</p>`);
}

/** Bots in the player's camp (crew-mates before the merge, everyone after). */
function campmates(): PlayerId[] {
  const s = game!.season;
  const mine = me().crew;
  return s.active().filter((p) => p.id !== YOU && p.crew === mine).map((p) => p.id);
}

function campChannel(): string {
  return game!.season.isMerged ? "camp" : "crew";
}

function say(channel: string, from: PlayerId, text: string): ChatMessage {
  const msg = { round: game!.season.round, channel, from, text };
  game!.chat.push(msg);
  // Private chats stay private: only group talk shows as a speech bubble on the island.
  if (from !== YOU && !channel.startsWith("dm:")) island?.say(from, text);
  refreshMessages();
  return msg;
}

/** Ask a castaway for a line (AI if on, canned otherwise) and say it, showing "typing" meanwhile. */
async function speak(
  id: PlayerId,
  channel: string,
  kind: "camp" | "scramble" | "reply" | "dm",
  canned: () => string,
  replyTo?: ChatMessage,
): Promise<void> {
  const g = game!;
  const round = g.season.round;
  typing.add(id);
  refreshMessages();
  const text = (await g.cast.line(id, kind, replyTo)) ?? canned();
  typing.delete(id);
  // Drop the line if the game moved on while it was being written.
  if (game !== g || g.season.round !== round || g.season.player(id).status !== "active") return refreshMessages();
  say(channel, id, text);
}

/** Names a castaway might mention: everyone they live with except themselves. */
function namesFor(id: PlayerId): string[] {
  return [...campmates().map(name), me().name].filter((n) => n !== name(id));
}

// ---------- layout ----------

function sidebar(): string {
  const s = game!.season;
  const groups = new Map<string, string[]>();
  for (const p of s.players) {
    const key = p.status === "active" ? (p.crew === MERGED ? "Merged camp" : `${p.crew} crew`) : p.status === "jury" ? "Jury" : "Out";
    const tag = p.id === YOU ? " (you)" : "";
    const list = groups.get(key) ?? [];
    list.push(`<li class="${p.status}">${esc(p.name)}${tag}</li>`);
    groups.set(key, list);
  }
  const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b));
  return `
    <aside class="sidebar">
      <h2>Round ${s.round}</h2>
      ${order.map((k) => `<h3>${k}</h3><ul>${groups.get(k)!.join("")}</ul>`).join("")}
      <p class="relics">Your relics: ${me().relics}</p>
      <details><summary>Season log</summary><ol class="log">${s.log
        .slice(-14)
        .map((l) => `<li>${esc(l.text)}</li>`)
        .join("")}</ol></details>
    </aside>`;
}

function rank(group: string): number {
  if (group === "Jury") return 2;
  if (group === "Out") return 3;
  return 1;
}

function stopCampClock(): void {
  if (campClock) clearInterval(campClock);
  campClock = null;
}

/**
 * Draw a screen. With `side`, the screen is a fixed full-window game view: the roster on the left,
 * the main view in the middle and `side` (the chat) on the right, so nothing needs page scrolling.
 */
function page(main: string, side?: string): void {
  stopCampClock();
  island?.destroy();
  island = null;
  app.innerHTML = side
    ? `<div class="layout fit">${game ? sidebar() : ""}<main class="panel">${main}</main><aside class="chat-col">${side}</aside></div>`
    : `<div class="layout">${game ? sidebar() : ""}<main class="panel">${main}</main></div>`;
}

function on(selector: string, handler: (e: Event) => void, event = "click"): void {
  app.querySelector(selector)?.addEventListener(event, handler);
}

// ---------- start ----------

function renderStart(): void {
  game = null;
  page(`
    <h1>Tidecall</h1>
    <p class="lead">Your ship went down. Seven strangers washed up with you. Only one leaves as the Sole Castaway, and the people you vote out decide who.</p>
    <form id="start" class="stack">
      <label>Your name <input name="name" maxlength="16" required value="Castaway" /></label>
      <label>Camp time before each challenge
        <select name="camp">${CAMP_TIME_CHOICES.map(
          (sec) => `<option value="${sec}" ${sec === DEFAULT_CAMP_SECONDS ? "selected" : ""}>${sec / 60} minute${sec === 60 ? "" : "s"}</option>`,
        ).join("")}</select>
      </label>
      <button class="primary" type="submit">Wash ashore</button>
    </form>
    <p class="note" id="ai-note">Checking for AI castaways...</p>`);
  const ready = httpAiClient.status().then((status) => {
    ai = status;
    const note = app.querySelector("#ai-note");
    if (note)
      note.textContent = status.enabled
        ? "AI castaways are on: they talk, scheme, and bluff. Each message uses your Anthropic account."
        : "AI castaways are off (no API key found), so the others are simple stand-in bots. The README explains how to turn them on.";
  });
  on(
    "#start",
    async (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const input = form.elements.namedItem("name") as HTMLInputElement;
      const camp = Number((form.elements.namedItem("camp") as HTMLSelectElement).value) || DEFAULT_CAMP_SECONDS;
      await ready;
      startSeason(input.value.trim() || "Castaway", camp);
    },
    "submit",
  );
}

function startSeason(playerName: string, campSeconds = DEFAULT_CAMP_SECONDS): void {
  const seed = Math.floor(Math.random() * 1e9);
  const rng = new Rng(seed);
  const others = rng.shuffle(CASTAWAY_NAMES).slice(0, 7);
  const players = [{ id: YOU, name: playerName, isHuman: true }, ...others.map((n) => ({ id: n.toLowerCase(), name: n }))];
  const season = new Season(players, PROTOTYPE_CONFIG, seed);
  const personas = dealPersonas(rng, others.length);
  const castaways = others.map((n, i) => new AiCastaway(n.toLowerCase(), personas[i]!, seed + i + 1));
  const chat: ChatMessage[] = [];
  const cast = new Cast(season, YOU, castaways, () => chat, ai.enabled ? httpAiClient : null);
  game = { season, cast, rng, seed, chat, channel: "crew", lastChallenge: null, finalStatement: "", campSeconds };
  void enterCamp();
}

// ---------- camp ----------

async function enterCamp(): Promise<void> {
  const g = game!;
  const { season, rng } = g;
  if (me().status !== "active") return renderSpectator();
  await botsAct();
  g.channel = campChannel();
  renderCamp();
  const mates = campmates();
  const channel = campChannel();
  const round = season.round;
  // Camp talk, one after another so they can react to each other.
  for (const id of rng.shuffle(mates).slice(0, 3)) {
    if (game !== g || season.round !== round || season.phase !== "camp") return;
    const chore = season.player(id).chore;
    const canned = () =>
      rng.chance(0.5) ? chatter.chore(rng, chore && chore.energy >= 3 ? chore.source : "rest") : chatter.camp(rng, namesFor(id));
    await speak(id, channel, "camp", canned);
  }
  // Private confessionals, then each castaway's plan updates.
  if (game !== g || season.round !== round) return;
  await Promise.all(
    mates
      .filter(() => rng.chance(0.5))
      .map(async (id) => {
        if ((await g.cast.confess(id)) === null && season.player(id).status === "active") {
          season.addConfessional(id, chatter.confessional(rng, mates.map(name)));
        }
      }),
  );
}

function chatPanel(phaseLabel: string): string {
  const { season, chat, channel } = game!;
  const mates = campmates();
  const tabs = [campChannel(), ...mates.map((id) => `dm:${id}`)];
  const label = (c: string) => (c.startsWith("dm:") ? name(c.slice(3)) : c === "crew" ? `${me().crew} crew` : "Whole camp");
  return `
    <div class="chat" data-empty="${esc(phaseLabel)}">
      <div class="tabs">${tabs
        .map((c) => `<button class="tab ${c === channel ? "on" : ""}" data-ch="${c}">${esc(label(c))}</button>`)
        .join("")}</div>
      <div class="messages">${messagesHtml(phaseLabel)}</div>
      <form id="say" class="row"><input name="text" maxlength="200" placeholder="Message... (Esc to walk)" autocomplete="off" /><button>Send</button></form>
    </div>`;
}

function messagesHtml(phaseLabel: string): string {
  const { season, chat, channel } = game!;
  const msgs = chat.filter((m) => m.channel === channel && m.round === season.round);
  const who = [...typing].filter((id) => (channel.startsWith("dm:") ? channel === `dm:${id}` : campmates().includes(id)));
  const typingLine = who.length ? `<p class="typing">${who.map((id) => esc(name(id))).join(" and ")} ${who.length > 1 ? "are" : "is"} typing...</p>` : "";
  const body = msgs.length
    ? msgs.map((m) => `<p><b>${esc(name(m.from))}:</b> ${esc(m.text)}</p>`).join("")
    : typingLine
      ? ""
      : `<p class="note">${channel.startsWith("dm:") ? "A private chat. Nobody else can read it." : `Nothing said yet ${phaseLabel}.`}</p>`;
  return body + typingLine;
}

/** Update just the message list (keeps whatever the player is typing). */
function refreshMessages(): void {
  const box = app.querySelector<HTMLElement>(".chat .messages");
  const panel = app.querySelector<HTMLElement>(".chat");
  if (!box || !panel || !game) return;
  box.innerHTML = messagesHtml(panel.dataset.empty ?? "");
  box.scrollTop = box.scrollHeight;
}

function wireChat(rerender: () => void, lines: (rng: Rng, names: string[]) => string, kind: "camp" | "scramble"): void {
  const box = app.querySelector<HTMLElement>(".chat .messages");
  if (box) box.scrollTop = box.scrollHeight;
  // Esc leaves the chat box so WASD walks again.
  app.querySelector<HTMLInputElement>("#say input")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") (e.target as HTMLInputElement).blur();
  });
  app.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      game!.channel = b.dataset.ch as string;
      rerender();
    }),
  );
  on(
    "#say",
    (e) => {
      e.preventDefault();
      const input = (e.target as HTMLFormElement).elements.namedItem("text") as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;
      const { rng, channel } = game!;
      input.value = "";
      const msg = say(channel, YOU, text);
      if (channel.startsWith("dm:")) {
        const who = channel.slice(3);
        void speak(who, channel, "dm", () => chatter.dmReply(rng, namesFor(who)), msg);
      } else {
        // Whoever was named answers; otherwise someone usually chimes in.
        const mates = campmates();
        const named = mates.filter((id) => text.toLowerCase().includes(name(id).toLowerCase()));
        const responders = named.length ? named.slice(0, 2) : rng.chance(0.75) && mates.length ? [rng.pick(mates)] : [];
        void (async () => {
          for (const who of responders) await speak(who, channel, game!.cast.aiOn ? "reply" : kind, () => lines(rng, namesFor(who)), msg);
        })();
      }
      input.focus();
    },
    "submit",
  );
}

function renderCamp(): void {
  const s = game!.season;
  page(
    `
    <header class="camp-head">
      <div>
        <h1>Camp</h1>
        <p class="note">${s.isMerged ? "One camp now. Every castaway for themselves." : `You're on the ${esc(me().crew)} crew.`} Walk with WASD, arrows or a tap. Press E to talk, gather or dig (X marks on the beach); hold E to keep gathering.</p>
      </div>
      <button id="go" class="primary">Head to the challenge early</button>
    </header>
    <div class="island-wrap">
      <canvas id="island" aria-label="The island. Use WASD or arrow keys to walk, E to interact."></canvas>
      <div id="camp-clock" class="camp-clock" role="timer" aria-live="off"></div>
      <p id="rumor" class="rumor" aria-live="polite"></p>
      <button id="act" class="act">Interact</button>
    </div>
    <div id="camp-status" class="camp-status"></div>`,
    `<div id="conf-slot"></div><div id="chat-slot"></div>`,
  );
  const canvas = app.querySelector("#island") as HTMLCanvasElement;
  island = new Island(canvas, {
    castaways: s.active().map((p) => ({
      id: p.id,
      name: p.name,
      crew: p.crew,
      isYou: p.id === YOU,
      job: p.chore ? { source: p.chore.source, trips: Math.floor((p.chore.energy - p.chore.spent) / SOURCES[p.chore.source].energy) } : null,
    })),
    merged: s.isMerged,
    yourCrew: me().crew,
    worldSeed: game!.seed,
    seed: s.round * 7919 + s.players.length,
    onInteract: handleIslandInteraction,
    onGather: (id, source) => {
      if (s.phase !== "camp" || s.player(id).status !== "active") return null;
      const got = s.gather(id, source);
      refreshCampStatus();
      return got;
    },
    camp: (crew) => s.camp(crew),
    dayProgress: () => 1 - me().energy / Math.max(1, me().maxEnergy),
    onRumor: (text) => {
      const el = app.querySelector("#rumor");
      if (el) el.textContent = text;
    },
  });
  // Replay this round's camp chatter as speech bubbles.
  const lines = game!.chat.filter((m) => m.round === s.round && m.channel === campChannel() && m.from !== YOU);
  lines.forEach((m, i) => setTimeout(() => island?.say(m.from, m.text), 600 + i * 1800));
  renderChatSlot();
  refreshCampStatus();
  startCampClock();
  on("#act", () => island?.interact());
  on("#go", goToChallenge);
}

/** The camp panel under the island: shelter, food, your energy, gear, last night, who's pitching in. */
function refreshCampStatus(): void {
  const el = app.querySelector("#camp-status");
  if (!el || !game) return;
  const s = game.season;
  const you = me();
  const camp = s.campOf(YOU);
  const members = s.campMembers(camp.name);
  const tier = shelterTier(camp.materials);
  const need = members.length * MEALS_PER_DAY;
  const pct = (n: number, d: number) => `${Math.max(0, Math.min(100, (n / Math.max(1, d)) * 100))}%`;
  const c = camp.condition;
  const haul = (h: { wood: number; food: number }) =>
    h.wood || h.food ? [h.wood ? `${h.wood} material${h.wood === 1 ? "" : "s"}` : "", h.food ? `${h.food} food` : ""].filter(Boolean).join(", ") : "nothing yet";
  const items = (Object.keys(REWARDS) as RewardItem[]).map(
    (i) => `<span class="gear ${camp.items.includes(i) ? "have" : ""}" title="${esc(describeItem(i))}">${esc(REWARDS[i].name)}</span>`,
  );
  el.innerHTML = `
    <div class="stats">
    <div class="stat">
      <span class="stat-name">Shelter</span>
      <span class="bar wood"><i style="width:${pct(camp.materials, tier.next ?? camp.materials)}"></i></span>
      <span>${esc(tier.name)} · ${camp.materials}${tier.next ? ` / ${tier.next} for the next stage` : " materials"}</span>
    </div>
    <div class="stat">
      <span class="stat-name">Food</span>
      <span class="bar food ${camp.food < need ? "short" : ""}"><i style="width:${pct(camp.food, need)}"></i></span>
      <span>${camp.food} meals · your camp eats ${need} tonight</span>
    </div>
    <div class="stat">
      <span class="stat-name">Your energy</span>
      <span class="bar energy"><i style="width:${pct(you.energy, you.maxEnergy)}"></i></span>
      <span>${you.energy} / ${you.maxEnergy} · palm or fruit 1, fishing 2</span>
    </div>
    </div>
    <div class="gear-row"><span class="stat-name">Camp gear</span> ${items.join("")}</div>
    <p class="note">${
      s.round === 1 && c.parts.length === 0
        ? "Night falls after the challenge. With no shelter and no food, everyone will be weaker at the next challenge."
        : `Last night: ${esc(c.parts.map((p) => `${p.label} (${formatFactor(1 + p.delta)})`).join(", "))}. Challenge condition ${formatFactor(c.factor)}.`
    }</p>
    <p class="note">Pitching in today: ${members.map((p) => `${esc(p.id === YOU ? "You" : p.name)} ${haul(p.gathered)}`).join(" · ")}</p>`;
}

function renderChatSlot(): void {
  const slot = app.querySelector("#chat-slot");
  if (!slot) return;
  slot.innerHTML = chatPanel("at camp");
  wireChat(renderChatSlot, chatter.camp, "camp");
}

/** Camp lasts a set time; when the clock runs out, the challenge starts whether you're ready or not. */
function startCampClock(): void {
  stopCampClock();
  const g = game!;
  const round = g.season.round;
  const deadline = performance.now() + g.campSeconds * 1000;
  let warned = false;
  const tick = () => {
    const el = app.querySelector<HTMLElement>("#camp-clock");
    if (game !== g || g.season.round !== round || g.season.phase !== "camp" || !el) return stopCampClock();
    const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    el.textContent = `Challenge in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    el.classList.toggle("urgent", left <= 10);
    if (left <= 10 && !warned) {
      warned = true;
      island?.showToast("The challenge drums are sounding. 10 seconds!", 3000);
    }
    if (left === 0) {
      stopCampClock();
      goToChallenge();
    }
  };
  tick();
  campClock = setInterval(tick, 250);
}

function goToChallenge(): void {
  if (game!.season.phase !== "camp") return;
  game!.season.advance();
  renderChallengeIntro();
}

function handleIslandInteraction(what: Interaction): void {
  const s = game!.season;
  switch (what.kind) {
    case "castaway": {
      if (!campmates().includes(what.id)) {
        island?.showToast(`${name(what.id)} is on the other crew. Save it for the merge.`);
        return;
      }
      game!.channel = `dm:${what.id}`;
      renderChatSlot();
      island?.showToast(`Private chat with ${name(what.id)}`);
      (app.querySelector("#say input") as HTMLInputElement | null)?.focus();
      return;
    }
    case "bonfire":
      game!.channel = campChannel();
      renderChatSlot();
      island?.showToast(s.isMerged ? "Talking to the whole camp" : "Talking to your crew");
      (app.querySelector("#say input") as HTMLInputElement | null)?.focus();
      return;
    case "dig": {
      if (me().searchedThisRound) {
        island?.showToast("You've already dug this round.");
        return;
      }
      const found = s.searchForRelic(YOU);
      island?.showToast(found ? "You found a Ward relic! Keep it secret." : "Nothing but driftwood.", 3500);
      const relics = app.querySelector(".relics");
      if (relics) relics.textContent = `Your relics: ${me().relics}`;
      return;
    }
    case "hut": {
      const slot = app.querySelector("#conf-slot");
      if (!slot) return;
      slot.innerHTML = `
        <section class="card">
          <h3>Confession hut</h3>
          <p>Talk to the camera. Nobody still playing will see this. The jury will.</p>
          <form id="conf" class="stack"><textarea name="text" rows="2" maxlength="500"></textarea><div class="row"><button class="primary">Record</button><button type="button" id="conf-cancel">Cancel</button></div></form>
        </section>`;
      slot.querySelector("#conf-cancel")?.addEventListener("click", () => (slot.innerHTML = ""));
      const form = slot.querySelector("#conf") as HTMLFormElement;
      (form.elements.namedItem("text") as HTMLTextAreaElement).focus();
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const t = form.elements.namedItem("text") as HTMLTextAreaElement;
        s.addConfessional(YOU, t.value);
        slot.innerHTML = "";
        island?.showToast("Confessional recorded.");
      });
      return;
    }
    case "arena":
      goToChallenge();
      return;
  }
}

// ---------- challenge ----------

function renderChallengeIntro(): void {
  const { rng, season } = game!;
  const kinds = (Object.keys(CHALLENGES) as ChallengeKind[]).filter((k) => k !== game!.lastChallenge);
  const kind = rng.pick(kinds);
  game!.lastChallenge = kind;
  const c = CHALLENGES[kind];
  const stakes = season.isMerged
    ? "Win and you earn the Ward: nobody can vote for you tonight."
    : "Crew scores are averaged. The losing crew goes to Lantern Council.";
  const yours = season.campOf(YOU).condition;
  const ease = yours.factor;
  const feel =
    ease >= 1.05
      ? "You're rested and fed, so this one is a little easier for you."
      : ease <= 0.95
        ? "You're tired and hungry, so this one is harder for you."
        : "You're holding up okay.";
  const others = [...season.crews().keys()]
    .filter((crew) => crew !== me().crew)
    .map((crew) => {
      const f = season.camp(crew).condition.factor;
      return `${esc(crew)} crew looks ${f >= 1.05 ? "well rested" : f <= 0.9 ? "worn out and hungry" : "tired"}.`;
    });
  page(`
    <h1>Challenge: ${c.title}</h1>
    <p class="lead">${c.howTo}</p>
    <p>${stakes}</p>
    <p class="condition ${ease >= 1 ? "good" : "bad"}">Condition ${formatFactor(ease)}: ${esc(yours.shelter.toLowerCase())}, ${esc(yours.meals.toLowerCase())}. ${feel} ${others.join(" ")}</p>
    <div id="arena" class="arena"><button id="begin" class="primary">Begin</button></div>`);
  on("#begin", async () => {
    const arena = app.querySelector("#arena") as HTMLElement;
    const score = await runChallenge(kind, arena, rng, ease);
    season.submitChallengeScore(YOU, score);
    await botsAct();
    season.advance();
    renderChallengeResult(score);
  });
}

function renderChallengeResult(score: number): void {
  const s = game!.season;
  const atCouncil = s.councilAttendees().includes(YOU);
  const immune = s.immunePlayers()[0];
  const headline = s.isMerged
    ? immune === YOU
      ? "You won the Ward! Nobody can vote for you tonight."
      : `${esc(name(immune!))} wins the Ward.`
    : atCouncil
      ? "Your crew lost. You're going to Lantern Council."
      : "Your crew won. You're safe tonight.";
  const rewards = s.lastRewards.map((r) => {
    const ours = r.camp === me().crew;
    const who = r.camp === MERGED ? "The camp" : ours ? "Your crew" : `${esc(r.camp)} crew`;
    if (!r.item) return `<p class="reward">${who} wins a crate of food for camp.</p>`;
    return `<p class="reward ${ours ? "ours" : ""}">${who} wins a reward: <b>${esc(REWARDS[r.item].name)}</b>. ${esc(REWARDS[r.item].effect)}</p>`;
  });
  page(`
    <h1>${headline}</h1>
    <p class="lead">Your score: ${score} / 1000.</p>
    ${rewards.join("")}
    <button id="go" class="primary">${atCouncil ? "Talk before council" : "Watch the other crew's council"}</button>`);
  on("#go", () => (atCouncil ? enterScramble() : void runCouncilWithoutYou()));
}

// ---------- scramble and council ----------

function enterScramble(): void {
  const { rng } = game!;
  const g = game!;
  const mates = campmates().filter((id) => g.season.councilAttendees().includes(id));
  g.channel = campChannel();
  renderScramble();
  const channel = campChannel();
  void (async () => {
    for (const id of rng.shuffle(mates).slice(0, 3)) {
      if (game !== g || g.season.phase !== "scramble") return;
      await speak(id, channel, "scramble", () => chatter.scramble(rng, namesFor(id)));
    }
  })();
}

function renderScramble(): void {
  page(`
    <h1>The scramble</h1>
    <p class="lead">Council is close. Make your deals now.</p>
    ${chatPanel("before council")}
    <button id="go" class="primary">Go to Lantern Council</button>`);
  wireChat(renderScramble, chatter.scramble, "scramble");
  on("#go", async () => {
    game!.season.advance();
    busy("The castaways write down their votes...");
    await botsAct();
    renderVote();
  });
}

function renderVote(): void {
  const s = game!.season;
  if (!s.eligibleVoters().includes(YOU)) return void finishCouncil();
  const options = s.voteOptions(YOU);
  const revote = s.stage === "revote";
  const canRelic = !revote && me().relics > 0;
  page(`
    <h1>Lantern Council${revote ? ": revote" : ""}</h1>
    <p class="lead">${revote ? "It's a tie. The tied castaways can't vote. Choose between them." : "Write down a name. Your vote is secret until it's read."}</p>
    <form id="vote" class="stack">
      <div class="options">${options
        .map((id, i) => `<label class="option"><input type="radio" name="target" value="${id}" ${i === 0 ? "checked" : ""}/> ${esc(name(id))}</label>`)
        .join("")}</div>
      ${canRelic ? `<label class="relic-play"><input type="checkbox" name="relic" /> Play my Ward relic (cancels every vote against me tonight)</label>` : ""}
      <button class="primary">Cast vote</button>
    </form>`);
  on(
    "#vote",
    (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const target = (form.elements.namedItem("target") as RadioNodeList).value;
      const relic = form.elements.namedItem("relic") as HTMLInputElement | null;
      s.castVote(YOU, target);
      if (relic?.checked) s.playRelic(YOU);
      void finishCouncil();
    },
    "submit",
  );
}

/** Resolve the council (and any revote), then show the reveal. */
async function finishCouncil(): Promise<void> {
  const s = game!.season;
  const before = s.councils.length;
  s.advance();
  if (s.councils.length === before) {
    // Revote stage.
    busy("A tie! The castaways revote...");
    await botsAct();
    return renderVote();
  }
  afterCouncilRevealed();
  void renderReveal();
}

async function runCouncilWithoutYou(): Promise<void> {
  const s = game!.season;
  const before = s.councils.length;
  s.advance(); // scramble -> council
  busy("The other crew heads to Lantern Council...");
  while (s.councils.length === before) {
    await botsAct();
    s.advance();
  }
  afterCouncilRevealed();
  void renderReveal();
}

async function renderReveal(): Promise<void> {
  const s = game!.season;
  const c = s.councils[s.councils.length - 1]!;
  page(`
    <h1>Lantern Council, round ${c.round}</h1>
    <p class="lead">${c.relicsPlayed.length ? `${c.relicsPlayed.map((id) => esc(name(id))).join(" and ")} played a Ward relic!` : "The votes are read one at a time."}</p>
    <ol id="reveal" class="reveal"></ol>
    <div id="after"></div>`);
  const list = app.querySelector("#reveal") as HTMLElement;
  const show = async (target: PlayerId, note = "") => {
    await wait(650);
    const li = document.createElement("li");
    li.innerHTML = `${esc(name(target))}${note}`;
    list.append(li);
  };
  for (const v of c.votes) await show(v.target, v.cancelled ? ' <span class="note">(cancelled by relic)</span>' : "");
  if (c.revote) {
    await wait(500);
    list.insertAdjacentHTML("beforeend", `<li class="divider">Tie. Revote:</li>`);
    for (const v of c.revote) await show(v.target);
  }
  if (c.drewLots) list.insertAdjacentHTML("beforeend", `<li class="divider">Still tied. Lots are drawn.</li>`);
  await wait(800);
  const out = s.player(c.eliminated);
  const after = app.querySelector("#after") as HTMLElement;
  after.innerHTML = `
    <h2 class="dark">${out.id === YOU ? "Your" : `${esc(out.name)}'s`} lantern goes dark.</h2>
    ${out.status === "jury" ? `<p>${out.id === YOU ? "You join" : "They join"} the jury.</p>` : ""}
    <button id="go" class="primary">Continue</button>`;
  on("#go", () => void nextAfterCouncil());
}

async function nextAfterCouncil(): Promise<void> {
  const s = game!.season;
  if (s.phase === "final") return renderFinal();
  if (me().status !== "active") return renderSpectator();
  await enterCamp();
}

// ---------- after you're voted out ----------

function renderSpectator(): void {
  const s = game!.season;
  if (s.phase === "final") return void renderFinal();
  if (s.phase === "complete") return renderEnd();
  const juror = me().status === "jury";
  const confs = juror ? s.confessionalsVisibleTo(YOU) : [];
  page(`
    <h1>${juror ? "The Jury Lounge" : "Your season is over"}</h1>
    <p class="lead">${
      juror
        ? "You'll help choose the winner. You can watch everything and read every confessional, but you can't talk to anyone still playing."
        : "You were voted out before the merge, so you're not on the jury. You can watch the rest of the season."
    }</p>
    ${
      juror
        ? `<section class="card"><h3>Confessionals</h3>${
            confs.length
              ? confs
                  .slice(-12)
                  .reverse()
                  .map((c) => `<p><b>${esc(name(c.player))}</b> (round ${c.round}): ${esc(c.text)}</p>`)
                  .join("")
              : `<p class="note">None yet.</p>`
          }</section>`
        : ""
    }
    <div class="row">
      <button id="watch" class="primary">Watch the next round</button>
      ${juror ? `<button id="leave">Leave the game</button>` : `<button id="skip">Skip to the end</button>`}
    </div>`);
  on("#watch", async () => {
    // The castaways play a whole round; we show its council.
    busy("A new day on the island...");
    await campConfessionals();
    while (s.phase !== "council" && s.phase !== "final") {
      await botsAct();
      s.advance();
    }
    if (s.phase === "final") return renderFinal();
    await runCouncilFromCouncilPhase();
  });
  on("#skip", async () => {
    busy("Playing out the rest of the season...");
    await playToEnd();
    renderEnd();
  });
  on("#leave", renderLeave);
}

/** While you watch from the jury, a couple of castaways still talk to the camera. */
async function campConfessionals(): Promise<void> {
  const { season, cast, rng } = game!;
  if (!cast.aiOn || season.phase !== "camp") return;
  const speakers = rng.shuffle(season.active().map((p) => p.id)).slice(0, 2);
  await Promise.all(speakers.map((id) => cast.confess(id)));
}

async function playToEnd(): Promise<void> {
  const s = game!.season;
  while (s.phase !== "complete") {
    const before = s.councils.length;
    await botsAct();
    s.advance();
    if (s.councils.length > before) afterCouncilRevealed();
  }
}

async function runCouncilFromCouncilPhase(): Promise<void> {
  const s = game!.season;
  const before = s.councils.length;
  busy("Lantern Council...");
  while (s.councils.length === before) {
    await botsAct();
    s.advance();
  }
  afterCouncilRevealed();
  void renderReveal();
}

function renderLeave(): void {
  const s = game!.season;
  const finalNow = s.phase === "final";
  page(`
    <h1>Leave the game?</h1>
    <p class="lead">Your jury vote still counts. ${
      finalNow ? "Choose a finalist now, or leave it to chance." : "The finalists aren't known yet, so the game will cast your vote for a random finalist."
    }</p>
    ${
      finalNow
        ? `<div class="options">${s
            .finalists()
            .map((id) => `<button class="leave-vote" data-id="${id}">Vote ${esc(name(id))} and leave</button>`)
            .join("")}</div>`
        : ""
    }
    <div class="row"><button id="random">Leave, vote at random</button><button id="stay" class="primary">Stay</button></div>`);
  app.querySelectorAll<HTMLButtonElement>(".leave-vote").forEach((b) =>
    b.addEventListener("click", () => void leaveAndFinish(b.dataset.id)),
  );
  on("#random", () => void leaveAndFinish(undefined));
  on("#stay", () => (finalNow ? renderFinal() : renderSpectator()));
}

async function leaveAndFinish(finalist: string | undefined): Promise<void> {
  game!.season.jurorLeaves(YOU, finalist);
  busy("Playing out the rest of the season...");
  await playToEnd();
  renderEnd();
}

// ---------- final council ----------

function pleasHtml(includeYours = false): string {
  const pleas = game!.cast.finalPleas().filter((p) => includeYours || p.from !== me().name);
  return pleas.length
    ? `<section class="card"><h3>The finalists' speeches</h3>${pleas.map((p) => `<p><b>${esc(p.from)}:</b> ${esc(p.text)}</p>`).join("")}</section>`
    : "";
}

/** Jury votes are in: resolve, then show a revote or the result. */
async function resolveFinal(): Promise<void> {
  const s = game!.season;
  busy("The jury's votes are read...");
  await botsAct();
  s.advance();
  if (s.phase === "final") return renderFinal();
  renderEnd();
}

async function renderFinal(): Promise<void> {
  const s = game!.season;
  const finalists = s.finalists();
  const youFinalist = finalists.includes(YOU);
  const youVote = s.jurorsVoting().includes(YOU);
  const revote = s.log[s.log.length - 1]?.text.includes("revotes") ?? false;

  if (youFinalist) {
    page(`
      <h1>Final Lantern Council${revote ? ": jury revote" : ""}</h1>
      <p class="lead">You made it to the end with ${finalists
        .filter((id) => id !== YOU)
        .map((id) => esc(name(id)))
        .join(" and ")}. Make your case to the jury: ${s
        .jury()
        .map((p) => esc(p.name))
        .join(", ")}.</p>
      <form id="plea" class="stack">
        <textarea name="text" rows="4" maxlength="800" placeholder="Why should the jury crown you?">${esc(game!.finalStatement)}</textarea>
        <button class="primary">Face the jury</button>
      </form>`);
    on(
      "#plea",
      (e) => {
        e.preventDefault();
        game!.finalStatement = ((e.target as HTMLFormElement).elements.namedItem("text") as HTMLTextAreaElement).value;
        void resolveFinal();
      },
      "submit",
    );
    return;
  }

  if (youVote) {
    busy("The finalists make their case...");
    await game!.cast.preparePleas();
    page(`
      <h1>Final Lantern Council${revote ? ": jury revote" : ""}</h1>
      <p class="lead">You're on the jury. Who deserves to be the Sole Castaway?</p>
      ${pleasHtml()}
      <div class="options">${finalists
        .map((id) => `<button class="jury-vote primary" data-id="${id}">${esc(name(id))}</button>`)
        .join("")}</div>
      <button id="leave">Leave the game</button>`);
    app.querySelectorAll<HTMLButtonElement>(".jury-vote").forEach((b) =>
      b.addEventListener("click", () => {
        s.castJuryVote(YOU, b.dataset.id as string);
        void resolveFinal();
      }),
    );
    on("#leave", renderLeave);
    return;
  }

  // Not a finalist and not voting (out before the merge, or left): just resolve it.
  busy("The jury decides...");
  while (s.phase === "final") {
    await botsAct();
    s.advance();
  }
  renderEnd();
}

// ---------- end ----------

function renderEnd(): void {
  const s = game!.season;
  const f = s.final!;
  const won = f.winner === YOU;
  const voteList = (votes: { juror: PlayerId; finalist: PlayerId; auto: boolean }[]) =>
    votes
      .map((v) => `<li>${esc(name(v.juror))} voted ${esc(name(v.finalist))}${v.auto ? ' <span class="note">(cast automatically)</span>' : ""}</li>`)
      .join("");
  page(`
    <h1>${won ? "You are the Sole Castaway!" : `${esc(name(f.winner))} is the Sole Castaway.`}</h1>
    <h3>Jury votes</h3>
    <ol class="reveal">${voteList(f.votes)}</ol>
    ${f.revote ? `<h3>Jury revote</h3><ol class="reveal">${voteList(f.revote)}</ol>` : ""}
    ${f.drewLots ? `<p>The jury stayed tied, so lots were drawn.</p>` : ""}
    ${pleasHtml(true)}
    <section class="card"><h3>Season recap: every confessional</h3>${
      s.confessionals.length
        ? s.confessionals.map((c) => `<p><b>${esc(name(c.player))}</b> (round ${c.round}): ${esc(c.text)}</p>`).join("")
        : `<p class="note">Nobody spoke to the camera this season.</p>`
    }</section>
    <button id="again" class="primary">Play another season</button>`);
  on("#again", renderStart);
}

// In development only: lets a test script peek at the season.
if (import.meta.env.DEV) (window as unknown as { tidecall: () => Game | null }).tidecall = () => game;

renderStart();
