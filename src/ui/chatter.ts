import type { Rng } from "../engine/rng.js";

/**
 * Canned lines for the placeholder castaways. The language-model castaways replace
 * this file; until then it keeps camp from feeling empty.
 */
const CAMP = [
  "Anyone else hear the drums last night?",
  "I'm keeping my head down and working on the shelter.",
  "We need to win the next challenge, full stop.",
  "{name}, can we talk later? Just us.",
  "I trust this crew. Mostly.",
  "Somebody's been out by the reef a lot. Just saying.",
  "If we lose, I think we keep it simple.",
  "{name} pulled their weight today, credit where it's due.",
];

const SCRAMBLE = [
  "I'm voting {name}. Nothing personal.",
  "Don't split the vote, that's how we get blindsided.",
  "{name} is playing everyone. Think about it.",
  "I'm open to anything right now.",
  "Whatever happens tonight, I'm not going home without a fight.",
];

const DM_REPLIES = [
  "I hear you. Let's keep this between us.",
  "Maybe. Who else is with us?",
  "I'm not sure I believe that, but okay.",
  "Deal. If you're good, I'm good.",
  "Funny, {name} said the same thing about you.",
  "I'll think about it before council.",
];

const CONFESSIONALS = [
  "Everyone thinks I'm harmless. Good.",
  "{name} is the biggest threat out here and nobody sees it.",
  "I made a promise today I might not keep.",
  "Honestly, I'm just trying to survive the next vote.",
  "If I get to the end, this jury will respect how I played.",
];

const recent: string[] = [];

/** Pick a line that hasn't been used in the last few picks, so castaways don't echo each other. */
function fresh(rng: Rng, lines: string[]): string {
  const options = lines.filter((l) => !recent.includes(l));
  const line = rng.pick(options.length ? options : lines);
  recent.push(line);
  if (recent.length > 5) recent.shift();
  return line;
}

function fill(line: string, rng: Rng, names: string[]): string {
  return line.replace("{name}", names.length ? rng.pick(names) : "someone");
}

export const chatter = {
  camp: (rng: Rng, names: string[]) => fill(fresh(rng, CAMP), rng, names),
  scramble: (rng: Rng, names: string[]) => fill(fresh(rng, SCRAMBLE), rng, names),
  dmReply: (rng: Rng, names: string[]) => fill(fresh(rng, DM_REPLIES), rng, names),
  confessional: (rng: Rng, names: string[]) => fill(fresh(rng, CONFESSIONALS), rng, names),
};
