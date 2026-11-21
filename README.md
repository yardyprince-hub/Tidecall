# Tidecall

An online social strategy game. Shipwrecked castaways play a full season: crews, quick
challenges, private scheming, hidden relics, secret votes at Lantern Council, a merge, and a
jury that crowns the Sole Castaway.

Design doc: https://claude.ai/artifact/7anBYMJCJDiWSPYnQrzp5w

## Status

Building the first prototype: a solo season in the browser, one player against 7 AI castaways.

## Turn on the AI castaways

The other castaways can be played by Claude: each one gets their own personality, talks in
the group chat, answers your private messages, keeps a secret plan, bluffs, votes at Lantern
Council, and votes as a juror. Without a key they are simple stand-in bots instead.

1. In the Tidecall folder, make a copy of `.env.example` and name the copy `.env`.
2. Open `.env` in a text editor and paste your Anthropic API key right after
   `ANTHROPIC_API_KEY=` (no spaces, no quotes). Save it.
3. In a terminal in the Tidecall folder, run `npm install` once, then `npm run dev`.
4. Open http://localhost:5173. The start screen says "AI castaways are on".

Keep the key secret:

- `.env` is ignored by git, so it never gets uploaded to GitHub. Don't rename it or remove it
  from `.gitignore`.
- Only the small server inside `npm run dev` reads the key. The browser never sees it; it asks
  that server for a castaway's line or vote.
- The game only listens on your own computer (localhost). Don't start it with `--host`, or
  other people on your network could play using your key.

Cost: every castaway line, confessional and vote is one request to your Anthropic account.
A full season is roughly 60 to 80 requests. To spend less, set `TIDECALL_MODEL=claude-sonnet-5-5`
or `TIDECALL_MODEL=claude-haiku-5-5` in `.env`. If a request fails, that castaway quietly falls
back to a stand-in line or vote, and the terminal running `npm run dev` says why.

## What's here so far

- `src/engine/season.ts`: the rules of a season (crews, challenges, council votes, relics,
  ties and revotes, swap, merge, jury, final vote, jurors leaving early). No UI, AI or networking.
- `src/engine/bots.ts`: simple placeholder castaways for testing, and `autoplay` to run a season.
- `src/ai/`: the AI castaways. `cast.ts` decides what each castaway is allowed to know (public
  events, their own camp's group chat, their own private chat with you, their own votes and
  plan; never anyone else's relics, searches or whereabouts), `prompts.ts` turns that into a
  prompt, `personas.ts` holds the eight original characters.
- `server/ai.ts`: the local server (a Vite plugin) that holds the API key and calls Claude.
- `src/sim.ts`: plays a whole season with bots and prints it.
- `src/ui/island.ts`: the walkable island drawn on a canvas. Walk with WASD, arrow keys or by
  tapping; walk up to castaways, your camp fire, dig spots, the confession hut or the challenge
  beach and press E.
- `src/ui/`: the browser game. Camp on the island (crew chat, private chats, relic digs, confessionals),
  three challenges (Tide Pools, Signal Fires, Rope Bridge), the scramble, Lantern Council with
  a one-by-one vote reveal, the Jury Lounge, the final council and an end-of-season recap.

```
npm install
npm run dev         # play in the browser at http://localhost:5173
npm test            # rules and AI tests (no key needed)
npm run sim -- 7    # simulate the 8-player prototype season with seed 7
npm run sim -- 7 live   # simulate the 12-player live rules
```
