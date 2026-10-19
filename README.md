# Back Room Poker

A browser poker game against computer opponents.

**Games:** Texas Hold'em (no-limit, pot-limit, fixed-limit), Omaha, Omaha Hi-Lo,
Short Deck, Five Card Draw, Seven Card Stud, Stud Hi-Lo and Razz.
**Formats:** cash game (rebuys), Sit & Go tournament (rising blinds), heads-up duel.
**Bots:** Beginner, Easy, Medium, Hard, Expert (or Mixed), each with a play style
(balanced, tight, loose, aggressive, passive).

## Play

Open `dist/index.html` in any browser. It is a single self-contained file, no server needed.

Keys: `F` fold, `C` check/call, `R` bet/raise, `Space` next hand.

## Develop

```
npm install
npm run dev        # http://localhost:8000, rebuilds on save (restart to pick up CSS changes)
npm run build      # writes dist/index.html
npm test           # rules tests + thousands of bot-vs-bot hands in every game
npm run typecheck
```

## Layout

- `src/engine/` – pure game logic with no browser code: cards, hand evaluator
  (high, ace-to-five low, Omaha, short deck), variants, a `Hand` state machine
  (blinds, antes, stud bring-in, draws, NL/PL/FL betting, side pots, hi-lo splits)
  and a `Table` (button, blind levels, busts, rebuys, public player stats).
- `src/bots/` – bot opponents. Bots only see a `PlayerView` (what that seat may know).
  Decisions use Monte Carlo equity, pot odds, position, starting-hand charts, and at
  Hard/Expert, opponent ranges from their betting; Expert also adapts to each
  player's observed tendencies.
- `src/ui/` – the browser front end (plain TypeScript + DOM).

The engine and bots have no DOM dependencies, so they can be reused for other
platforms (desktop wrapper, mobile, or a server for multiplayer).
