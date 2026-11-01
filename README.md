# Back Room Poker: my notes

My browser card room: eight poker games, blackjack, roulette, baccarat, video poker and Lucky Sevens slots,
against bots or with friends online.

- **Live site:** https://frigiduss.github.io/backroom-poker/ (admin dashboard at `/admin/`)
- **Backend:** Supabase project `yqvizfunfdxtlozvtqfs`. Only the public (anon/publishable) key goes in
  the code (`src/accounts/config.ts`). Never commit the `service_role` key.
- **Setup and backend details:** [supabase/README.md](supabase/README.md)

## Commands

```
npm start          # install, build and open the game (same as play.bat / play.command)
npm run dev        # http://localhost:8000, rebuilds on save (restart for CSS changes)
npm run build      # writes dist/ and supabase/functions/poker-table/index.ts
npm test           # rules, online/server tests and bot-vs-bot hands (~3 min)
npm run typecheck
npm run train-bots # retrain the Master bot's net (~30 min on all cores), then test it
```

Build output (`dist/`, the bundled Edge Function, `.neural/`) is gitignored and never committed.
The workflows build everything from source.

## Where things are

```
src/
  engine/      pure game rules, no browser code: cards, hand evaluator, variants, the Hand
               state machine, Table, blackjack, roulette, baccarat, video poker, slots, history,
               share.ts (a hand packed into a #hand= link, checked before it is shown)
  bots/        bot opponents. Bots only see a PlayerView. bot.ts (5 levels x 5 styles),
               neural.ts + neural-weights.ts (Master), persona.ts (24 named bots),
               rivals.ts (grudges), dealers.ts (casino dealers), worker.ts/brain.ts (web worker)
  accounts/    profiles behind AccountStore (local or Supabase), bank rules, stats,
               achievements, bonus, weekly challenges, leaderboard, friends, gifts, avatars,
               crash reports, seasons.ts (seasonal events: dates, free looks, the event achievement)
  online/      table server (server.ts, blackjack.ts, bundled into the Edge Function by
               edge.ts), client.ts, protocol, table chat
  ui/          the poker table and app shell: main.ts (startup + poker table), index.html,
               styles.css, dom.ts, sound.ts, thinker.ts, talk.ts (faces + speech bubbles),
               console.ts, console-blackjack.ts, picker.ts,
               games.ts (lobby games and tabs), crash.ts
    app/       PWA files: icons, manifest, service worker (sw.js)
    casino/    blackjack, roulette, baccarat, video poker, slots, house.ts (their shared frame)
    player/    profile and sign-in, stats, achievements, looks, faces and pictures,
               leaderboard, weekly challenges, friends, hand history (with its Share button and
               shared-hand view), season.ts (lobby event banner)
    online/    online tables, online blackjack, table chat
    guides/    how to play: guide-data.ts (rules + first-hand walkthroughs, no DOM) and the
               guide screen. Keep it in step with the engines; test/guide.test.ts checks it
  admin/       the /admin/ dashboard
scripts/
  build.mjs    the esbuild build (also runs tests and the dev server)
  neural/      self-play, training and the match for the Master bot
supabase/      SQL files to run in the SQL editor, config.toml, and the backend notes
test/          node:test tests; fake-supabase.ts and memory-db.ts fake the backend
```

## Deploys

- **checks.yml**: typecheck, build and tests on every PR. Auto-merge is on for the repo, but no
  branch rule requires `checks` yet.
- **pages.yml**: builds and publishes the site on every push to `main`.
- **supabase-functions.yml**: builds and deploys the `poker-table` Edge Function when engine,
  bots, accounts or online code changes on `main`. Needs the `SUPABASE_ACCESS_TOKEN` secret.
  The Supabase CLI is pinned (2.121.0); bump it by hand.

## SQL files

Run each once in the Supabase SQL editor. Order matters where noted.

| File | Turns on | Run? |
| --- | --- | --- |
| `setup.sql` | accounts and saved players (first) | yes |
| `multiplayer.sql` | online tables | yes |
| `achievements.sql` | achievements from online tables | yes |
| `leaderboard.sql` | daily bonus and leaderboard (re-run after friends/gifts changes) | yes |
| `admin.sql` | admin accounts (put my email in the last lines) | yes |
| `friends.sql` | friends, online status, invites | yes |
| `banks.sql` | limits on how fast a bank can grow | yes |
| `security.sql` | two-step sign-in, for projects made before it | yes |
| `gifts.sql` | chip gifts | yes |
| `avatars.sql` | uploaded pictures | yes |
| `crashes.sql` | crash reports (after `admin.sql`), then type `crashtest` in the console | yes |
| `challenges.sql` | chips for weekly challenges (after `banks.sql`) | not yet |

## Gotchas

- After a deploy the site can look unchanged because the browser cached the old one. A hard
  reload usually fixes it. Clearing site data works too, but it also wipes local (offline) profiles.
- Claude's cloud sessions can't reach supabase.co or github.io, so live checks are done by hand.
- The README is for me. Don't list console commands here (`help` in the console lists them).
