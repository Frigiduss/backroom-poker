# Turning on online accounts

Online accounts let a player sign in with an email and password and find their players,
chip bank and stats on any device. They use [Supabase](https://supabase.com) for sign-in
and storage; the free plan is plenty. Until the two values below are filled in, the game
keeps players in the browser only.

1. **Create a project.** Sign up at supabase.com, click **New project**, pick any name,
   set a database password (you won't need it for the game) and a region near you.
2. **Create the players table.** In the project, open **SQL Editor**, click **New query**,
   paste everything from [`setup.sql`](setup.sql), and click **Run**.
3. **Point email links at the game.** Open **Authentication → URL Configuration**. Set
   **Site URL** to `https://frigiduss.github.io/backroom-poker/` and add the same address
   under **Redirect URLs**. Sign-up confirmation and password-reset emails then bring
   people back to the game.
4. **Sign-in rules.** Under **Authentication → Sign In / Providers → Email**, keep **Confirm
   email** on, so nobody can make an account with someone else's address, and set the
   **Minimum password length** to 8 to match the game. (Turning **Confirm email** off makes
   new accounts work straight away, which can help while trying things out, since Supabase's
   built-in email sender only sends a few emails an hour.)
5. **Copy the keys into the game.** Open **Project Settings → API** (or **Data API**) and
   copy the **Project URL** and the **anon public** key (the one labelled public or
   publishable, never the `service_role` secret). Paste them into
   [`src/accounts/config.ts`](../src/accounts/config.ts) and push to `main`; the site
   redeploys on its own.

The anon key is designed to be public. The row security rules in `setup.sql` are what stop
one account from reading or changing another account's players.

## Two-step sign-in

Players can protect their account with an authenticator app (Google Authenticator, Microsoft
Authenticator, 1Password, Authy and so on): **Profile → Account security → Two-step sign-in →
Set up**. After that, signing in asks for the app's 6-digit code as well as the password. The
same panel changes the password and signs the account out on every device.

The code is checked by Supabase, and the database enforces it: `mfa_ok()` and the restrictive
"two-step sign-in finished" policies mean a sign-in that skipped the code can't read or change
that account's rows, use admin powers or collect the daily bonus, and the `poker-table` function
turns it away too. Accounts without an authenticator app work exactly as before. Supabase has
authenticator-app sign-in switched on by default (**Authentication → Multi-Factor**).

**Projects set up before two-step sign-in** run [`security.sql`](security.sql) once in the SQL
Editor. New projects get it from the other files.

**Someone lost their phone?** After checking it's really them, remove their authenticator in the
SQL Editor and they can sign in with just the password again:
`delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'their@email');`

## How it behaves

- Signing in on a device that has local players, into an account with none yet, copies
  those players into the account. The copies on the device stay as they were.
- While signed in, every change saves to the account. If a save fails (no connection),
  the lobby badge says so and the next save tries again with the latest numbers.
- If the account server can't be reached when the game opens, it falls back to the
  players on the device and says so; **Try again** on the profile page reconnects.
- The same player open on two devices at once: the last one to save wins.
- Games against bots run in the browser, so the database can't check each hand. Once
  [`banks.sql`](banks.sql) is run it limits what a save can add instead (see "Chip bank
  limits" below), so editing a saved player can't add more than real winning could.

## The developer console

Admin accounts get a developer console in the game: press the **`** key (top left of the
keyboard), or tap **>_ Console** in the lobby on a phone. It can change your bank and stats,
show every card at the table, fix the next cards dealt, retune or pause the bots, let a bot
play for you, and manage every account's players and the lobby announcement. Type `help`
in it for the full list.

To make your account an admin:

1. Sign up in the game with your email, so the account exists.
2. In Supabase, open **SQL Editor → New query** and paste everything from
   [`admin.sql`](admin.sql).
3. In the last lines, replace `YOUR-EMAIL@example.com` with the email you signed up with,
   then click **Run**.
4. Reload the game. The console button appears in the lobby.

To add another admin later, run just the last statement of `admin.sql` with their email.
To remove one: `delete from public.admins where user_id = (select id from auth.users where email = 'their@email');`

Admin powers are checked by the database (row level security and the `is_admin()`
function), not by the page, so nobody can turn the console's account powers on by editing
the site. Every change made to a player from the console is written to the `admin_log` table.

The console also works at online tables. Open one and the table commands (`state`, `rig`,
`board`, `stack`, `bot`, `pause`, `step`, `level`) go to the table server, or type `tables`
to list every table and `table CODE` to work on one you aren't sitting at. `kick` and
`close` remove a person or end a table. The table server looks the account up in the
`admins` table itself before doing any of it, and every change goes in `admin_log`.

## Playing with friends (online tables)

Signed-in players can make a private table, send its five-letter code (or invite link) to
friends, and play together. Bots take every seat nobody fills, and a bot also plays for
anyone who leaves or lets their 30-second clock run out twice, until they're back.

The table runs on Supabase, not in anyone's browser: an Edge Function called `poker-table`
shuffles, deals, plays the bots and settles every pot, and keeps the deck and everyone's
cards in a table that browsers can't read. Each player only ever receives their own cards
plus what the whole table can see. Each table shuffles with ChaCha20 from a fresh 256-bit key
out of the server's cryptographic random source, so the cards a player has seen give nothing
away about the ones still to come. Online tables use table chips, so banks aren't touched.

To switch it on, do these once:

1. **Create the tables.** In Supabase, open **SQL Editor → New query**, paste everything
   from [`multiplayer.sql`](multiplayer.sql), and click **Run**.
2. **Let GitHub deploy the table server.** In Supabase, click your avatar (top right) →
   **Account preferences → Access Tokens → Generate new token**, name it `github`, and copy
   it. In GitHub, open the repository's **Settings → Secrets and variables → Actions → New
   repository secret**, name it `SUPABASE_ACCESS_TOKEN`, paste the token, and save.
3. **Deploy it.** In GitHub, open **Actions → Deploy table server to Supabase → Run
   workflow**. From then on it redeploys on its own whenever the server code changes.

Rather not use GitHub? In Supabase open **Edge Functions → Deploy a new function → Via
Editor**, name it `poker-table`, run `npm run build` in the repository to
make `supabase/functions/poker-table/index.ts`, replace the sample code with everything in that
file, and click **Deploy**.
Then open the function's **Details** and turn **Verify JWT** off (the function checks each
player's sign-in itself). Repeat the build and paste whenever the server code changes.

Tables nobody has played at for three days are cleared out when someone makes a new one.

## Achievements from online tables

Achievements earned against bots are saved with each player. Achievements earned at online
tables are counted by the `poker-table` function instead, in a table browsers can read but
never write, so nobody can hand themselves one. To switch that on:

1. In Supabase, open **SQL Editor → New query**, paste everything from
   [`achievements.sql`](achievements.sql), and click **Run**.
2. Redeploy the `poker-table` function (merging to `main` does this through the GitHub
   workflow, or run `npm run build` and paste the new `supabase/functions/poker-table/index.ts` into
   the dashboard as before).

Until both are done, online tables play as usual and simply don't count achievements.
Titles shown at online tables are checked by the function too: a title only shows if the
player has earned it.

## Daily bonus and leaderboard

Once a day each player can collect free chips from the lobby: 1,000 on the first day, 500 more
for each day in a row, up to 4,000 from day seven. It comes back 20 hours after a claim, and a
streak holds as long as the next claim is within 48 hours. For online players the database keeps
the claim time, so changing the device clock or editing a saved player can't collect it twice.
Players kept only in a browser use the browser's clock.

The leaderboard ranks online players by chip bank, biggest pot and achievements unlocked. Anyone
can open it, even signed out, and it only shows each player's name, colour, title and score.
Players appear after 10 hands, and anyone can take a player off it from the leaderboard page.

To switch both on, open **SQL Editor → New query**, paste everything from
[`leaderboard.sql`](leaderboard.sql), and click **Run**. Until then the lobby says they aren't
set up yet.

The scores come from each player's saved numbers. With [`banks.sql`](banks.sql) run, the
database limits how fast a bank can grow (below), so the bank and biggest-pot boards can't be
jumped by editing a save. If someone still looks wrong, the developer console can set their
bank and stats back, or turn the leaderboard off for that player with `edit <player> board off`,
which their own setting can't undo.

## Chip bank limits

Run [`banks.sql`](banks.sql) once (after `setup.sql`, `admin.sql` and `leaderboard.sql`). From
then on every save of an online player passes a check in the database:

- Losing chips always saves and earns back the same amount of "win allowance", so ups and
  downs never run into the limit.
- Winning chips spends the allowance. It refills by 2,000 chips a minute up to 500,000, and a
  new account starts with 100,000.
- A win bigger than the allowance saves only what the allowance covers. The game keeps
  sending its own number, so an honest big win (a straight-up hit at a high-limit roulette
  table, say) still lands in full as the allowance refills.
- Topping a bank under 1,000 back up to 10,000 is free once an hour, and a daily bonus adds
  its chips to the allowance.
- The biggest pot can't jump past 50,000 (a full table of 200-big-blind stacks is 36,000).

Admin changes from the console aren't limited. Banks saved before `banks.sql` keep their
numbers; the console can set any that look wrong back. `select * from bank_guard` in the SQL
Editor shows each account's allowance and how many saves were capped (`clamped`).
