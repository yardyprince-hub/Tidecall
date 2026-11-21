import "./style.css";
import { PlaceholderBot } from "../engine/bots.js";
import { Rng } from "../engine/rng.js";
import { MERGED, Season } from "../engine/season.js";
import { PROTOTYPE_CONFIG, type PlayerId } from "../engine/types.js";
import { CHALLENGES, runChallenge, type ChallengeKind } from "./challenges.js";
import { chatter } from "./chatter.js";

const YOU = "you";
const CASTAWAY_NAMES = ["Ana", "Bo", "Cyra", "Dez", "Emre", "Fen", "Gil", "Hana", "Isa", "Jory", "Kai", "Lu"];

interface ChatMessage {
  round: number;
  /** "crew", "camp" (merged), or "dm:<id>" for a private chat with that castaway. */
  channel: string;
  from: PlayerId;
  text: string;
}

interface Game {
  season: Season;
  bots: Map<PlayerId, PlaceholderBot>;
  rng: Rng;
  chat: ChatMessage[];
  channel: string;
  lastChallenge: ChallengeKind | null;
  finalStatement: string;
}

const app = document.getElementById("app") as HTMLElement;
let game: Game | null = null;

// ---------- helpers ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const name = (id: PlayerId) => (game ? game.season.player(id).name : id);
const me = () => game!.season.player(YOU);

function botsAct(): void {
  const { season, bots } = game!;
  for (const bot of bots.values()) {
    const p = season.player(bot.id);
    switch (season.phase) {
      case "camp":
        if (p.status === "active") bot.onCamp(season);
        break;
      case "challenge":
        if (p.status === "active") bot.onChallenge(season);
        break;
      case "council":
        bot.onCouncil(season);
        break;
      case "final":
        bot.onFinal(season);
        break;
      default:
        break;
    }
  }
}

function afterCouncilRevealed(): void {
  const { season, bots } = game!;
  for (const bot of bots.values()) bot.onCouncilRevealed(season);
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

function say(channel: string, from: PlayerId, text: string): void {
  game!.chat.push({ round: game!.season.round, channel, from, text });
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

function page(main: string): void {
  app.innerHTML = `<div class="layout">${game ? sidebar() : ""}<main class="panel">${main}</main></div>`;
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
      <button class="primary" type="submit">Wash ashore</button>
    </form>
    <p class="note">Prototype: the other castaways are simple stand-in bots. Smarter AI castaways come next.</p>`);
  on(
    "#start",
    (e) => {
      e.preventDefault();
      const input = (e.target as HTMLFormElement).elements.namedItem("name") as HTMLInputElement;
      startSeason(input.value.trim() || "Castaway");
    },
    "submit",
  );
}

function startSeason(playerName: string): void {
  const seed = Math.floor(Math.random() * 1e9);
  const rng = new Rng(seed);
  const others = rng.shuffle(CASTAWAY_NAMES).slice(0, 7);
  const players = [{ id: YOU, name: playerName, isHuman: true }, ...others.map((n) => ({ id: n.toLowerCase(), name: n }))];
  const season = new Season(players, PROTOTYPE_CONFIG, seed);
  const bots = new Map(others.map((n, i) => [n.toLowerCase(), new PlaceholderBot(n.toLowerCase(), seed + i + 1)]));
  game = { season, bots, rng, chat: [], channel: "crew", lastChallenge: null, finalStatement: "" };
  enterCamp();
}

// ---------- camp ----------

function enterCamp(): void {
  const { season, rng } = game!;
  if (me().status !== "active") return renderSpectator();
  botsAct();
  const mates = campmates();
  const names = mates.map(name);
  for (const id of rng.shuffle(mates).slice(0, 3)) say(campChannel(), id, chatter.camp(rng, [...names, me().name]));
  for (const id of mates) if (rng.chance(0.5)) season.addConfessional(id, chatter.confessional(rng, names));
  game!.channel = campChannel();
  renderCamp();
}

function chatPanel(phaseLabel: string): string {
  const { season, chat, channel } = game!;
  const mates = campmates();
  const tabs = [campChannel(), ...mates.map((id) => `dm:${id}`)];
  const label = (c: string) => (c.startsWith("dm:") ? name(c.slice(3)) : c === "crew" ? `${me().crew} crew` : "Whole camp");
  const msgs = chat.filter((m) => m.channel === channel && m.round === season.round);
  return `
    <div class="chat">
      <div class="tabs">${tabs
        .map((c) => `<button class="tab ${c === channel ? "on" : ""}" data-ch="${c}">${esc(label(c))}</button>`)
        .join("")}</div>
      <div class="messages">${
        msgs.length
          ? msgs.map((m) => `<p><b>${esc(name(m.from))}:</b> ${esc(m.text)}</p>`).join("")
          : `<p class="note">${channel.startsWith("dm:") ? "A private chat. Nobody else can read it." : `Nothing said yet ${phaseLabel}.`}</p>`
      }</div>
      <form id="say" class="row"><input name="text" maxlength="200" placeholder="Say something..." autocomplete="off" /><button>Send</button></form>
    </div>`;
}

function wireChat(rerender: () => void, lines: (rng: Rng, names: string[]) => string): void {
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
      say(channel, YOU, text);
      const others = campmates().map(name);
      if (channel.startsWith("dm:")) {
        say(channel, channel.slice(3), chatter.dmReply(rng, others));
      } else if (rng.chance(0.7)) {
        say(channel, rng.pick(campmates()), lines(rng, [...others, me().name]));
      }
      rerender();
      (app.querySelector("#say input") as HTMLInputElement | null)?.focus();
    },
    "submit",
  );
}

function renderCamp(): void {
  const s = game!.season;
  const searched = me().searchedThisRound;
  page(`
    <h1>Camp</h1>
    <p class="lead">${s.isMerged ? "One camp now. Every castaway for themselves." : `You're on the ${esc(me().crew)} crew.`} Talk, scheme, and search for relics before the challenge.</p>
    ${chatPanel("at camp")}
    <div class="cards">
      <section class="card">
        <h3>Search for relics</h3>
        <p>One search per round. A Ward relic cancels every vote against you at one council.</p>
        <button id="search" ${searched ? "disabled" : ""}>${searched ? "Searched this round" : "Search the shoreline"}</button>
        <p id="search-result" class="note"></p>
      </section>
      <section class="card">
        <h3>Confessional</h3>
        <p>Talk to the camera. Nobody still playing will see this. The jury will.</p>
        <form id="conf" class="stack"><textarea name="text" rows="2" maxlength="500"></textarea><button>Record</button></form>
      </section>
    </div>
    <button id="go" class="primary">Head to the challenge</button>`);
  wireChat(renderCamp, chatter.camp);
  on("#search", () => {
    const found = s.searchForRelic(YOU);
    renderCamp();
    const out = app.querySelector("#search-result");
    if (out) out.textContent = found ? "You found a Ward relic! Keep it secret." : "Nothing but driftwood.";
  });
  on(
    "#conf",
    (e) => {
      e.preventDefault();
      const t = (e.target as HTMLFormElement).elements.namedItem("text") as HTMLTextAreaElement;
      s.addConfessional(YOU, t.value);
      t.value = "";
      t.placeholder = "Recorded.";
    },
    "submit",
  );
  on("#go", () => {
    s.advance();
    renderChallengeIntro();
  });
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
  page(`
    <h1>Challenge: ${c.title}</h1>
    <p class="lead">${c.howTo}</p>
    <p>${stakes}</p>
    <div id="arena" class="arena"><button id="begin" class="primary">Begin</button></div>`);
  on("#begin", async () => {
    const arena = app.querySelector("#arena") as HTMLElement;
    const score = await runChallenge(kind, arena, rng);
    season.submitChallengeScore(YOU, score);
    botsAct();
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
  page(`
    <h1>${headline}</h1>
    <p class="lead">Your score: ${score} / 1000.</p>
    <button id="go" class="primary">${atCouncil ? "Talk before council" : "Watch the other crew's council"}</button>`);
  on("#go", () => (atCouncil ? enterScramble() : runCouncilWithoutYou()));
}

// ---------- scramble and council ----------

function enterScramble(): void {
  const { rng } = game!;
  const mates = campmates().filter((id) => game!.season.councilAttendees().includes(id));
  const names = mates.map(name);
  for (const id of rng.shuffle(mates).slice(0, 3)) say(campChannel(), id, chatter.scramble(rng, [...names, me().name]));
  game!.channel = campChannel();
  renderScramble();
}

function renderScramble(): void {
  page(`
    <h1>The scramble</h1>
    <p class="lead">Council is close. Make your deals now.</p>
    ${chatPanel("before council")}
    <button id="go" class="primary">Go to Lantern Council</button>`);
  wireChat(renderScramble, chatter.scramble);
  on("#go", () => {
    game!.season.advance();
    botsAct();
    renderVote();
  });
}

function renderVote(): void {
  const s = game!.season;
  if (!s.eligibleVoters().includes(YOU)) return finishCouncil();
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
      finishCouncil();
    },
    "submit",
  );
}

/** Resolve the council (and any revote), then show the reveal. */
function finishCouncil(): void {
  const s = game!.season;
  const before = s.councils.length;
  s.advance();
  if (s.councils.length === before) {
    // Revote stage.
    botsAct();
    return renderVote();
  }
  afterCouncilRevealed();
  void renderReveal();
}

function runCouncilWithoutYou(): void {
  const s = game!.season;
  const before = s.councils.length;
  s.advance(); // scramble -> council
  while (s.councils.length === before) {
    botsAct();
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
  on("#go", nextAfterCouncil);
}

function nextAfterCouncil(): void {
  const s = game!.season;
  if (s.phase === "final") return renderFinal();
  if (me().status !== "active") return renderSpectator();
  enterCamp();
}

// ---------- after you're voted out ----------

function renderSpectator(): void {
  const s = game!.season;
  if (s.phase === "final") return renderFinal();
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
  on("#watch", () => {
    // Bots play a whole round; we show its council.
    while (s.phase !== "council" && s.phase !== "final") {
      botsAct();
      s.advance();
    }
    if (s.phase === "final") return renderFinal();
    runCouncilFromCouncilPhase();
  });
  on("#skip", () => {
    while (s.phase !== "complete") {
      const before = s.councils.length;
      botsAct();
      s.advance();
      if (s.councils.length > before) afterCouncilRevealed();
    }
    renderEnd();
  });
  on("#leave", renderLeave);
}

function runCouncilFromCouncilPhase(): void {
  const s = game!.season;
  const before = s.councils.length;
  while (s.councils.length === before) {
    botsAct();
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
    b.addEventListener("click", () => leaveAndFinish(b.dataset.id)),
  );
  on("#random", () => leaveAndFinish(undefined));
  on("#stay", () => (finalNow ? renderFinal() : renderSpectator()));
}

function leaveAndFinish(finalist: string | undefined): void {
  const s = game!.season;
  s.jurorLeaves(YOU, finalist);
  while (s.phase !== "complete") {
    const before = s.councils.length;
    botsAct();
    s.advance();
    if (s.councils.length > before) afterCouncilRevealed();
  }
  renderEnd();
}

// ---------- final council ----------

function renderFinal(): void {
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
        botsAct();
        s.advance();
        if (s.phase === "final") return renderFinal();
        renderEnd();
      },
      "submit",
    );
    return;
  }

  if (youVote) {
    page(`
      <h1>Final Lantern Council${revote ? ": jury revote" : ""}</h1>
      <p class="lead">You're on the jury. Who deserves to be the Sole Castaway?</p>
      <div class="options">${finalists
        .map((id) => `<button class="jury-vote primary" data-id="${id}">${esc(name(id))}</button>`)
        .join("")}</div>
      <button id="leave">Leave the game</button>`);
    app.querySelectorAll<HTMLButtonElement>(".jury-vote").forEach((b) =>
      b.addEventListener("click", () => {
        s.castJuryVote(YOU, b.dataset.id as string);
        botsAct();
        s.advance();
        if (s.phase === "final") return renderFinal();
        renderEnd();
      }),
    );
    on("#leave", renderLeave);
    return;
  }

  // Not a finalist and not voting (out before the merge, or left): just resolve it.
  while (s.phase === "final") {
    botsAct();
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
    <section class="card"><h3>Season recap: every confessional</h3>${
      s.confessionals.length
        ? s.confessionals.map((c) => `<p><b>${esc(name(c.player))}</b> (round ${c.round}): ${esc(c.text)}</p>`).join("")
        : `<p class="note">Nobody spoke to the camera this season.</p>`
    }</section>
    <button id="again" class="primary">Play another season</button>`);
  on("#again", renderStart);
}

renderStart();
