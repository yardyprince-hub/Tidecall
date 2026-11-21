# Tidecall

An online social strategy game. Shipwrecked castaways play a full season: crews, quick
challenges, private scheming, hidden relics, secret votes at Lantern Council, a merge, and a
jury that crowns the Sole Castaway.

Design doc: https://claude.ai/artifact/7anBYMJCJDiWSPYnQrzp5w

## Status

Building the first prototype: a solo season in the browser, one player against 7 AI castaways.

## What's here so far

- `src/engine/season.ts`: the rules of a season (crews, challenges, council votes, relics,
  ties and revotes, swap, merge, jury, final vote, jurors leaving early). No UI, AI or networking.
- `src/engine/bots.ts`: simple placeholder castaways for testing, and `autoplay` to run a season.
- `src/sim.ts`: plays a whole season with bots and prints it.
- `src/ui/`: the browser game. Camp (crew chat, private chats, relic search, confessionals),
  three challenges (Tide Pools, Signal Fires, Rope Bridge), the scramble, Lantern Council with
  a one-by-one vote reveal, the Jury Lounge, the final council and an end-of-season recap.

```
npm install
npm run dev         # play in the browser at http://localhost:5173
npm test            # rules tests
npm run sim -- 7    # simulate the 8-player prototype season with seed 7
npm run sim -- 7 live   # simulate the 12-player live rules
```
