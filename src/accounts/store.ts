import { Profile, normalizeProfile } from './profile';

/**
 * Where profiles live. The game only talks to this interface, so a server-backed store
 * (sign-in plus a hosted database) can replace the browser one without touching game code.
 * Methods are async for that reason, even though browser storage answers immediately.
 */
export interface AccountStore {
  /** 'local' profiles live in this browser only; 'online' ones follow a signed-in user. */
  readonly kind: 'local' | 'online';
  list(): Promise<Profile[]>;
  get(id: string): Promise<Profile | null>;
  /** Creates or replaces a profile. */
  put(profile: Profile): Promise<void>;
  remove(id: string): Promise<void>;
  /** The profile last played, so the game reopens on it. */
  currentId(): Promise<string | null>;
  setCurrentId(id: string | null): Promise<void>;
}

/** The slice of the Web Storage API the local store needs (localStorage, or a stand-in). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SavedAccounts {
  version: 1;
  current: string | null;
  profiles: Profile[];
}

export const ACCOUNTS_KEY = 'backroom-poker-accounts';

/** Keeps every profile in one key of browser storage. */
export class LocalAccountStore implements AccountStore {
  readonly kind = 'local' as const;
  private data: SavedAccounts;

  constructor(private readonly storage: KeyValueStorage | null, private readonly key = ACCOUNTS_KEY) {
    this.data = this.read();
  }

  private read(): SavedAccounts {
    try {
      const raw = this.storage?.getItem(this.key);
      if (raw) {
        const d = JSON.parse(raw) as Partial<SavedAccounts>;
        const profiles = (Array.isArray(d.profiles) ? d.profiles : []).map(normalizeProfile).filter((p): p is Profile => !!p);
        const current = typeof d.current === 'string' && profiles.some((p) => p.id === d.current) ? d.current : null;
        return { version: 1, current, profiles };
      }
    } catch {
      /* unreadable save: start fresh rather than crash */
    }
    return { version: 1, current: null, profiles: [] };
  }

  private write() {
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.data));
    } catch {
      /* storage full or blocked: profiles last for this visit only */
    }
  }

  async list(): Promise<Profile[]> {
    return this.data.profiles.map(clone);
  }

  async get(id: string): Promise<Profile | null> {
    const p = this.data.profiles.find((x) => x.id === id);
    return p ? clone(p) : null;
  }

  async put(profile: Profile): Promise<void> {
    const copy = clone(profile);
    const i = this.data.profiles.findIndex((x) => x.id === profile.id);
    if (i >= 0) this.data.profiles[i] = copy;
    else this.data.profiles.push(copy);
    this.write();
  }

  async remove(id: string): Promise<void> {
    this.data.profiles = this.data.profiles.filter((x) => x.id !== id);
    if (this.data.current === id) this.data.current = null;
    this.write();
  }

  async currentId(): Promise<string | null> {
    return this.data.current;
  }

  async setCurrentId(id: string | null): Promise<void> {
    this.data.current = id;
    this.write();
  }
}

/** A Map-backed stand-in for localStorage (tests, or browsers with storage blocked). */
export class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
