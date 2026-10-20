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
