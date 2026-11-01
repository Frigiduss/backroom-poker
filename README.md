# Back Room Poker

Poker, blackjack, roulette, baccarat and video poker in your browser, against computer opponents or with friends online.

**Play now:** https://frigiduss.github.io/backroom-poker/ (nothing to install, no account needed)

## What's in it

- **Eight poker games:** Texas Hold'em (no-limit, pot-limit, fixed-limit), Omaha,
  Omaha Hi-Lo, Short Deck, Five Card Draw, Seven Card Stud, Stud Hi-Lo and Razz. The game
  picker groups them into Hold'em & Omaha, Stud and Draw tabs, each with an example hand.
- **Blackjack** against the dealer: six decks, dealer stands on all 17s, blackjack pays
  3 to 2, with double, split and insurance. Play it solo or at an online table with friends.
- **Roulette** on a European (single zero) or American (double zero) wheel, with every
  standard inside and outside bet, and **baccarat** (punto banco: Player, Banker, Tie and
  pair bets). Both are you against the house, in the Casino tab next to blackjack.
- **Dealers with personality:** the blackjack dealer and the roulette croupier are one of
  eight named characters, each with a face and a way of talking about the big moments
  (a natural, a dealer bust, a straight-up hit, a zero). On a bad run they may, very rarely,
  lean in and whisper you a piece of advice. Turn dealer chat off in the table's Settings.
- **Video poker** machines: Jacks or Better, Bonus Poker and Double Double Bonus, all on
  their full-pay tables. Bet one to five coins of 5 to 500 chips, hold, draw, and a royal
  flush on five coins pays 4,000.
- **Slots:** the Lucky Sevens machine, three reels of suits, chips, crowns and sevens with
  one to five pay lines and coins of 5 to 500 chips. Three sevens on a line pays 500 coins.
- **Three formats:** cash game (with rebuys), Sit & Go tournament (rising blinds) and a
  heads-up duel.
- **Bots that play like people:** five levels (Beginner, Easy, Medium, Hard, Expert, or
  Mixed), plus **Master** in No-Limit Hold'em: Expert's thinking with a trained neural net
  that overrules it when it's sure. Five styles (balanced, tight, loose, aggressive, passive). 24 named bot
  characters have their own faces and table talk; turn the talk off in Settings, or switch
  on Fast bots if you'd rather not wait.
- **Rivals:** the named bots remember how you play against them from one sitting to the
  next. Take a bot's chips or knock them out and they hold a grudge: they greet you with
  it, play back at you harder, and the Expert ones use what they've seen of your habits.
  Win some back off them and they cool down. A bot who keeps beating you gets smug instead.
  Your rivals are listed on the stats page.
- **Practice mode:** a switch on the table setup card adds advice, your equity and pot odds
  on every decision. Practice uses free chips, so it never touches your bank, stats or
  achievements.
- **Chip bank:** 10,000 chips to start, carried between games. A bank under 1,000 can be
  refilled, and a daily bonus grows with your streak.
- **Achievements and titles** to unlock and show off at the table.
- **Stats page:** a chip graph over time plus VPIP and other numbers from your hands.
- **Hand history and replay:** your last 50 poker hands are saved on your device. Open
  History at the table (or from your profile) to step through any of them street by street,
  or press Play to watch it again. You see what you saw at the table: your own cards,
  face-up cards and hands shown at the end.
- **How to play guides:** every game has a short rules page and a step-by-step walk
  through a first hand, with the hand rankings for the poker games. Open it from the
  "How to play" link under the featured game in the lobby, or the Rules button at any table.
- **Looks:** pick a felt and card back for the poker and blackjack tables.
- **Sounds** for cards, chips and wins.

### With an online account (optional)

Sign up with an email and password to keep your chips, stats and achievements on every device.
Signed in, you can also:

- **Play with friends** at a private table: make one, then send its five-letter code or invite
  link. Bots fill the empty seats, and a bot plays for anyone who steps away. The cards are
  shuffled and dealt on the server, so nobody's browser ever sees anyone else's hand.
- **Add friends** with their six-character friend code (or friend link), see who's online,
  and invite them to your table in one tap. Invites pop up on their screen with Join and
  Watch buttons. Only friends who've both said yes see each other's name and online status.
- **Send chips to a friend** from your bank (after 10 hands): up to 10,000 a day, and a friend
  can be sent up to 20,000 a day. Gifts wait in their Friends list until they collect them.
- **Pick a face** for your badge from the game's set, or upload your own picture. It shows at
  online tables, on the leaderboard and in friends lists. (Faces from the set work offline too.)
- **Watch a table** without taking a seat, from its code or watch link.
- **Chat** at the table.
- **Climb the leaderboard** for chip bank, biggest pot and achievements (players appear
  after 10 hands; you can take yourself off it).
- **Lock down your account** with two-step sign-in (a code from an authenticator app),
  change your password, or sign out on every device, from **Profile → Account security**.

Online tables use table chips, so your bank isn't at stake there.

### Keyboard

Poker: `F` fold, `C` check/call, `R` bet/raise, `Space` next hand, `H` hand history.
Hand history: `←`/`→` step, `Space` play/pause, `↑`/`↓` other hands, `Esc` close.
Blackjack: `H` hit, `S` stand, `D` double, `P` split, `I`/`N` insurance, `Space` deal.
Roulette and baccarat: `1`–`3` pick a chip, `U` undo, `C` clear, `R` rebet, `Space` spin or deal.
Video poker: `1`–`5` hold a card, `B` bet one, `X` bet max, `Space` deal or draw.
Slots: `1`–`4` pick a coin, `L` lines, `X` spin max, `Space` spin.

## Install it as an app

Open https://frigiduss.github.io/backroom-poker/, then:

- **iPhone / iPad (Safari):** tap Share, then **Add to Home Screen**.
- **Android (Chrome):** tap the ⋮ menu, then **Install app**.
- **Computer (Chrome or Edge):** click the install icon at the right of the address bar.

The installed app opens full screen and plays against bots offline. It checks for a new
version every time it opens, so updates arrive on their own. Online play still needs a
connection.

## Run it from this folder

Double-click `play.bat` (Windows) or `play.command` (Mac/Linux), or run `npm start`. It
installs what it needs the first time, builds the game and opens it in your browser. Needs
[Node.js](https://nodejs.org).

The built game is a single file, `dist/index.html`. Copy it anywhere and double-click it to
play against bots offline.

---

## For developers

### Commands

```
npm install
npm run dev        # http://localhost:8000, rebuilds on save (restart to pick up CSS changes)
npm start          # install, build and open the game in your browser
npm run build      # writes dist/ and supabase/functions/poker-table/index.ts
npm test           # rules tests, online/server tests and thousands of bot-vs-bot hands (~3 min)
npm run typecheck
npm run train-bots # retrain the Master bot's net (about 30 min on all cores), then test it
```

`npm run build` (`scripts/build.mjs`, esbuild) produces:

- `dist/index.html`: the whole game in one file, with CSS, icons and the bot worker inlined.
- `dist/sw.js`, `dist/manifest.webmanifest`, `dist/icon-*.png`: what makes the site installable.
- `dist/admin.html`: the admin dashboard, published at `/admin/`.
- `supabase/functions/poker-table/index.ts`: the online table server (a Supabase Edge Function).

**Build output is never committed** (it's in `.gitignore`), so parallel pull requests don't
conflict over it. The deploy workflows build everything from source.

### Layout

- `src/engine/`: pure game logic, no browser code. Cards, hand evaluator (high, ace-to-five
  low, Omaha, short deck), variants, a `Hand` state machine (blinds, antes, stud bring-in,
  draws, NL/PL/FL betting, side pots, hi-lo splits), a `Table` (button, blind levels, busts,
  rebuys), `blackjack.ts` (shoe, dealer, splits, doubles, insurance, basic strategy),
  `roulette.ts` (wheels, layout bets, payouts) and `baccarat.ts` (drawing rules, payouts).
- `src/bots/`: bot opponents. Bots only see a `PlayerView` (what that seat may know).
  Decisions use Monte Carlo equity, pot odds, position, starting-hand charts and, at
  Hard/Expert, opponent ranges; Expert also adapts to each player's tendencies. `neural.ts`
  is Master's net (weights in `neural-weights.ts`, made by `scripts/neural/`: self-play where
  every candidate move is played out, a small network trained on the results, and a
  duplicate match against Expert). `persona.ts`
  holds the named characters, `dealers.ts` the blackjack dealers and roulette croupiers, and `worker.ts`/`brain.ts` run bot thinking in a web worker.
- `src/accounts/`: player profiles behind the `AccountStore` interface (`LocalAccountStore`
  in browser storage, `OnlineAccountStore` in Supabase), plus chip bank rules, stats,
  achievements, daily bonus, leaderboard, friends and looks. Supabase URL and public key are in
  `config.ts`.
- `src/online/`: online play. `server.ts` and `blackjack.ts` are the table server (bundled
  into the Edge Function), `client.ts` talks to it, plus the shared protocol and table chat.
- `src/ui/`: the browser front end (plain TypeScript + DOM), the PWA manifest, icons and
  service worker (`sw.js`). `guide.ts` holds the how to play rules and walkthroughs; keep it
  in step with the engines when a rule changes (`test/guide.test.ts` checks the walkthrough
  hands against them).
- `src/admin/`: the admin dashboard page.
- `test/`: Node test runner tests. `fake-supabase.ts` and `memory-db.ts` stand in for the
  real backend.

The engine and bots have no DOM dependencies, so they can be reused on other platforms.

### Deploys and checks (GitHub Actions)

- **Checks** (`.github/workflows/checks.yml`) runs on every pull request: type check, build
  and the full test suite. To block merging until it passes, add a branch ruleset for `main`
  with **Require status checks to pass** and the `checks` check.
- **Pages** (`.github/workflows/pages.yml`) builds and publishes the site to GitHub Pages on
  every push to `main`.
- **Table server** (`.github/workflows/supabase-functions.yml`) builds and deploys the
  `poker-table` Edge Function to Supabase when `main` changes. It needs a
  `SUPABASE_ACCESS_TOKEN` repository secret and skips the deploy (with a notice) without one.

### Supabase backend

Online accounts, tables, achievements, the leaderboard, the daily bonus, friends, chip gifts and pictures run on
[Supabase](https://supabase.com). Without it the game still works fully offline against bots.
Setup is a handful of SQL files run once in the Supabase SQL editor:

| File | Turns on |
| --- | --- |
| `supabase/setup.sql` | Accounts and saved players |
| `supabase/multiplayer.sql` | Online tables (plus deploying the `poker-table` function) |
| `supabase/achievements.sql` | Achievements earned at online tables |
| `supabase/leaderboard.sql` | Daily bonus and leaderboard |
| `supabase/admin.sql` | Admin accounts |
| `supabase/friends.sql` | Friends, who's online, and table invites |
| `supabase/crashes.sql` | Crash reports in the admin dashboard |
| `supabase/banks.sql` | Limits on how fast an online chip bank can grow, so a save can't be edited to cheat |
| `supabase/gifts.sql` | Sending chips to friends, with daily limits |
| `supabase/avatars.sql` | Uploaded profile pictures (storage bucket and its rules) |
| `supabase/security.sql` | Two-step sign-in, for projects set up before it (new projects get it from the files above) |

Step-by-step instructions are in [supabase/README.md](supabase/README.md). Only the public
(anon/publishable) key belongs in the code; the database's row security rules are what keep
accounts apart. Never put the `service_role` key in the repository.

### Admin tools

Admin accounts (made with `supabase/admin.sql`) get a developer console in the game and the
dashboard at `/admin/`, for looking after players, tables, the lobby announcement and the
errors players' games hit (the Crashes tab). Admin
powers are checked by the database and the table server, not the page, and every change is
logged. See [supabase/README.md](supabase/README.md#the-developer-console).
