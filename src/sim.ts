/**
 * Plays a whole season with placeholder bots and prints what happened.
 * Usage: npm run sim -- [seed] [live]
 */
import { autoplay, PlaceholderBot } from "./engine/bots.js";
import { Season } from "./engine/season.js";
import { LIVE_CONFIG, PROTOTYPE_CONFIG } from "./engine/types.js";

const NAMES = ["Ana", "Bo", "Cyra", "Dez", "Emre", "Fen", "Gil", "Hana", "Isa", "Jory", "Kai", "Lu"];

const seed = Number(process.argv[2] ?? Date.now() % 100000);
const live = process.argv[3] === "live";
const config = live ? LIVE_CONFIG : PROTOTYPE_CONFIG;
const count = live ? 12 : 8;

const players = NAMES.slice(0, count).map((name) => ({ id: name.toLowerCase(), name }));
const season = new Season(players, config, seed);
autoplay(
  season,
  players.map((p, i) => new PlaceholderBot(p.id, seed * 31 + i)),
);

console.log(`Tidecall season (seed ${seed}, ${live ? "live" : "prototype"} rules)\n`);
let lastRound = 0;
for (const entry of season.log) {
  if (entry.round !== lastRound) {
    console.log(`\n-- Round ${entry.round} --`);
    lastRound = entry.round;
  }
  console.log(`  ${entry.text}`);
}
for (const c of season.councils) {
  const tally = c.votes
    .map((v) => `${season.player(v.voter).name}->${season.player(v.target).name}${v.cancelled ? " (cancelled)" : ""}`)
    .join(", ");
  console.log(`\nCouncil ${c.round}: ${tally}${c.revote ? " | revote" : ""} => ${season.player(c.eliminated).name} out`);
}
if (season.final) {
  const tally = season.final.votes.map((v) => `${season.player(v.juror).name}->${season.player(v.finalist).name}`);
  console.log(`\nJury votes: ${tally.join(", ")}`);
  console.log(`Winner: ${season.player(season.final.winner).name}`);
}
