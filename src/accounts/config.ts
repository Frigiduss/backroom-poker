import { OnlineConfig } from './online';

/**
 * Online accounts. Leave these empty and the game keeps players in the browser only.
 * Fill them in from Supabase (Project Settings → API) to turn on sign-in; see
 * supabase/README.md. The anon key is meant to be public: row security in
 * supabase/setup.sql is what keeps each account's players private.
 */
export const ONLINE: OnlineConfig = {
  url: 'https://yqvizfunfdxtlozvtqfs.supabase.co',
  anonKey: 'sb_publishable_LTshLjzpLxeYiRB9Zkz8aA_24T7b0Bm',
};
