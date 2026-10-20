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
4. **Optional: skip the confirmation email.** Under **Authentication → Sign In / Providers →
   Email**, turn off **Confirm email** if you'd rather new accounts work straight away.
   Supabase's built-in email sender only sends a few emails an hour, so this helps while
   you're trying things out.
5. **Copy the keys into the game.** Open **Project Settings → API** (or **Data API**) and
   copy the **Project URL** and the **anon public** key (the one labelled public or
   publishable, never the `service_role` secret). Paste them into
   [`src/accounts/config.ts`](../src/accounts/config.ts) and push to `main`; the site
   redeploys on its own.

The anon key is designed to be public. The row security rules in `setup.sql` are what stop
one account from reading or changing another account's players.

## How it behaves

- Signing in on a device that has local players, into an account with none yet, copies
  those players into the account. The copies on the device stay as they were.
- While signed in, every change saves to the account. If a save fails (no connection),
  the lobby badge says so and the next save tries again with the latest numbers.
- If the account server can't be reached when the game opens, it falls back to the
  players on the device and says so; **Try again** on the profile page reconnects.
- The same player open on two devices at once: the last one to save wins.
- The chip bank is kept by the browser, so a determined player could edit their own
  numbers. That only matters if bank sizes are ever compared between people, for
  example a leaderboard, which would need the bank rules to run on the server.

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
plus what the whole table can see. Online tables use table chips, so banks aren't touched.

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
Editor**, name it `poker-table`, replace the sample code with everything in
[`functions/poker-table/index.ts`](functions/poker-table/index.ts), and click **Deploy**.
Then open the function's **Details** and turn **Verify JWT** off (the function checks each
player's sign-in itself). Repeat the paste whenever that file changes.

Tables nobody has played at for three days are cleared out when someone makes a new one.
