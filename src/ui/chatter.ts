import type { Rng } from "../engine/rng.js";

/**
 * Canned lines for the placeholder castaways. The language-model castaways replace
 * this file; until then it keeps camp from feeling empty.
 */
const CAMP = [
  "Anyone else hear the drums last night?",
  "We need to win the next challenge, full stop.",
  "{name}, can we talk later? Just us.",
  "I trust this crew. Mostly.",
  "Somebody's been out by the reef a lot. Just saying.",
  "If we lose, I think we keep it simple.",
  "{name} pulled their weight today, credit where it's due.",
];

/** Camp lines that match what the castaway is actually doing today. */
const CHORES: Record<string, string[]> = {
  palm: [
    "Heading up to the palms. That shelter isn't going to build itself.",
    "I'll cut fronds for the roof. Somebody grab the big branches?",
    "Another night on the sand and I'm done. I'm on shelter duty.",
  ],
  fruit: [
    "I'm going to pick fruit before we all start fighting over the rice.",
    "Found a fruit tree up the hill yesterday. I'll bring back what I can.",
  ],
  fish: [
    "I'm going down to the rocks to fish. Wish me luck.",
    "Fish for dinner if the tide's on our side. I'm on it.",
  ],
  rest: [
    "I'm saving my energy for the challenge, honestly.",
    "Somebody has to keep the fire company.",
  ],
};

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
  chore: (rng: Rng, chore: string) => fresh(rng, CHORES[chore] ?? CHORES.rest!),
  camp: (rng: Rng, names: string[]) => fill(fresh(rng, CAMP), rng, names),
  scramble: (rng: Rng, names: string[]) => fill(fresh(rng, SCRAMBLE), rng, names),
  dmReply: (rng: Rng, names: string[]) => fill(fresh(rng, DM_REPLIES), rng, names),
  confessional: (rng: Rng, names: string[]) => fill(fresh(rng, CONFESSIONALS), rng, names),
};
