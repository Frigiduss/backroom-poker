# Back Room Poker

A browser poker game against computer opponents.

**Games:** Texas Hold'em (no-limit, pot-limit, fixed-limit), Omaha, Omaha Hi-Lo,
Short Deck, Five Card Draw, Seven Card Stud, Stud Hi-Lo and Razz, plus **Blackjack**
against the dealer (six decks, dealer stands on all 17s, blackjack pays 3 to 2, double,
split and insurance).
**Formats:** cash game (rebuys), Sit & Go tournament (rising blinds), heads-up duel.
**Bots:** Beginner, Easy, Medium, Hard, Expert (or Mixed), each with a play style
(balanced, tight, loose, aggressive, passive).

## Play

**In your browser, nothing to install:** https://frigiduss.github.io/backroom-poker/
(also at https://claude.ai/artifact/YZLtoQAHrSgdDmg59Noiox). Every push to `main` redeploys the
GitHub Pages site.

**From this folder:** double-click `play.bat` (Windows) or `play.command` (Mac/Linux),
or run `npm start`. It installs what it needs the first time, builds the game and opens it
in your browser. Needs [Node.js](https://nodejs.org).

The built game is a single file, `dist/index.html` (made by `npm start` or `npm run build`;
build output isn't kept in git). Copy it anywhere and double-click it to play offline.

Keys: `F` fold, `C` check/call, `R` bet/raise, `Space` next hand. At blackjack: `H` hit,
`S` stand, `D` double, `P` split, `I`/`N` insurance, `Space` deal.

## Players and chip bank

On first visit the game asks who's playing. Each player has a chip bank (10,000 to start)
that carries between games, lifetime stats, and their own lobby choices and table settings.

- **Cash games** take the buy-in (and any rebuys) from the bank; leaving the table puts
  your stack back. Closing the tab mid-game returns your stack as of the last finished hand.
- **Sit & Go and heads-up** cost a 500-chip entry. Every seat pays in, and the pool goes to
  the top finisher (2–3 players), the top two (4–6), or the top three (7+). Leaving early
  forfeits the entry.
- **Blackjack** bets straight from the bank: each wager leaves it when placed and winnings
  land back in it, so bets on an unfinished hand are lost if you leave or close the tab.
- A bank under 1,000 can be refilled to 10,000.
- Several players can share a device; switch from the profile page. Players are stored in
  the browser, so use **Download backup** / **Import a backup** to move one between devices.
- **Online accounts** (optional): sign in with an email and password to keep your players
  on every device. Off until a Supabase project is connected; see
  [supabase/README.md](supabase/README.md) for the five-minute setup.

## Develop

```
npm install
npm run dev        # http://localhost:8000, rebuilds on save (restart to pick up CSS changes)
npm start          # build and open the game in your browser
npm run build      # writes dist/ and supabase/functions/poker-table/index.ts
npm test           # rules tests + thousands of bot-vs-bot hands in every game
npm run typecheck
```

Every pull request runs the **Checks** workflow (`.github/workflows/checks.yml`): type check,
build and the full test suite (about 3 minutes). Build output (`dist/` and
`supabase/functions/poker-table/index.ts`) is not committed, so parallel pull requests don't
conflict over it; the Pages and Supabase deploy workflows build it from source.

### Required checks

To block merging until Checks passes: repo **Settings > Branches > Add branch ruleset** (or
"Add classic branch protection rule") for `main`, turn on **Require status checks to pass**,
and add the `checks` check.

## Layout

- `src/engine/` – pure game logic with no browser code: cards, hand evaluator
  (high, ace-to-five low, Omaha, short deck), variants, a `Hand` state machine
  (blinds, antes, stud bring-in, draws, NL/PL/FL betting, side pots, hi-lo splits)
  and a `Table` (button, blind levels, busts, rebuys, public player stats), plus
  `blackjack.ts` (shoe, dealer, splits, doubles, insurance and basic strategy).
- `src/bots/` – bot opponents. Bots only see a `PlayerView` (what that seat may know).
  Decisions use Monte Carlo equity, pot odds, position, starting-hand charts, and at
  Hard/Expert, opponent ranges from their betting; Expert also adapts to each
  player's observed tendencies.
- `src/accounts/` – player profiles: chip bank rules, stats, backups, and the
  `AccountStore` interface. `LocalAccountStore` keeps profiles in browser storage;
  `OnlineAccountStore` keeps them in Supabase (`online.ts`, configured in `config.ts`).
- `src/ui/` – the browser front end (plain TypeScript + DOM).

The engine and bots have no DOM dependencies, so they can be reused for other
platforms (desktop wrapper, mobile, or a server for multiplayer).
