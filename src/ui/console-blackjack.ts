// The developer console at a blackjack table, practice or online. The same commands work at
// both: at a practice table they reach into the table in this page, and at an online table
// they go to the table server, which checks the account is an admin before doing anything.
import { Card } from '../engine/cards';
import { Round, RoundData, RoundRig, Shoe, describeTotal, handTotal } from '../engine/blackjack';
import { AdminCommand, AdminTableInfo, BjAdminInfo } from '../online/protocol';
import { esc, fmt } from './dom';
import { Out, UsageError, amount, card, cardsText, need, table } from './console';

/** What the console needs from a practice blackjack table (BlackjackTable.dev provides it). */
export interface DevBlackjack {
  readonly shoe: Shoe;
  readonly round: Round | null;
  readonly spots: { id: string; name: string; isHuman: boolean; stack: number }[];
  nextRig: RoundRig | null;
  paused: boolean;
  setStack(id: string, n: number): void;
  refresh(): void;
  /** Makes the next bot or dealer move now. False on the player's own turn, or with no round in play. */
  step(): boolean;
}

type Remote = (command: AdminCommand, out?: Out) => Promise<AdminTableInfo>;

/** Where blackjack commands go: a practice table in this page, or an online one through the server. */
export type BjTarget = { local: DevBlackjack } | { remote: Remote };

/** The table as one shape, wherever it is. */
type Info = BjAdminInfo & { paused: boolean; /** The viewer's spot id. */ mine: string | null };

function infoOf(t: DevBlackjack): Info {
  const r = t.round;
  const live = !!r && !r.isComplete;
  return {
    phase: live ? 'round' : 'betting',
    roundNumber: r ? 1 : 0,
    spots: t.spots.map((s) => ({ ...s, bet: null, sittingOut: false, away: false })),
    round: r ? r.save() : null,
    inRound: r ? r.seats.map((s) => s.id) : [],
    upcoming: t.shoe.upcoming(16),
    shoeLeft: t.shoe.remaining,
    shoeSize: t.shoe.size,
    nextRig: t.nextRig,
    paused: t.paused,
    mine: t.spots.find((s) => s.isHuman)?.id ?? null,
  };
}

async function inspect(at: BjTarget, me: string | null = null): Promise<Info> {
  if ('local' in at) return infoOf(at.local);
  const info = await at.remote({ do: 'inspect' });
  const mine = info.members.find((m) => m.userId === me)?.seat ?? null;
  return { ...need(info.bj, "That table isn't playing blackjack yet."), paused: info.paused, mine };
}

/** "0", "me", "dealer" or the start of a name. */
function spotOf(info: Info, ref: string | undefined): BjAdminInfo['spots'][number] {
  const r = need(ref, 'Name a spot: its number from state, me, or the start of a name.').toLowerCase();
  if (r === 'me' || r === 'you') return need(info.spots.find((s) => s.id === info.mine), "You don't have a spot at this table.");
  if (/^\d+$/.test(r)) return need(info.spots[Number(r)], `There is no spot ${r}.`);
  const hits = info.spots.filter((s) => s.id === r || s.name.toLowerCase().startsWith(r));
  if (hits.length !== 1) throw new UsageError(hits.length ? `"${ref}" matches ${hits.map((s) => s.name).join(', ')}.` : `No spot called "${ref}".`);
  return hits[0];
}

const playing = (r: RoundData | null): r is RoundData => !!r && r.phase !== 'done';

/** The dealer's draws from these cards if every hand stands now: stands on all 17s. */
function dealerRunout(dealer: Card[], next: Card[]): { draws: Card[]; total: string } {
  const cards = [...dealer];
  const draws: Card[] = [];
  while (handTotal(cards).total < 17 && draws.length < next.length) {
    const c = next[draws.length];
    draws.push(c);
    cards.push(c);
  }
  return { draws, total: describeTotal(cards, false) };
}

/** Who the next round's opening cards go to, with the cards the console fixed. */
function openingDeal(info: BjAdminInfo, everyone: boolean): { who: string; card: Card; fixed: boolean }[] {
  // Bots always play; people only if they have bet (at a practice table, the player always does).
  const seats = info.spots.filter((s) => everyone || !s.isHuman || s.bet !== null);
  const shoe = [...info.upcoming];
  const out: { who: string; card: Card; fixed: boolean }[] = [];
  const draw = (who: string, fixed: Card | undefined) => {
    if (fixed !== undefined) {
      // A fixed card is taken out of the shoe, the topmost copy first.
      const i = shoe.indexOf(fixed);
      if (i >= 0) shoe.splice(i, 1);
      out.push({ who, card: fixed, fixed: true });
    } else if (shoe.length) out.push({ who, card: shoe.shift()!, fixed: false });
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const s of seats) draw(s.name, info.nextRig?.seats?.[s.id]?.[pass]);
    draw(pass ? 'Dealer, face down' : 'Dealer, face up', info.nextRig?.dealer?.[pass]);
  }
  return out;
}

function printState(info: Info, out: Out) {
  const r = info.round;
  const live = playing(r);
  out(`<b>Blackjack</b> · ${live ? `round in play (${r!.phase})` : 'between rounds'} · shoe ${fmt(info.shoeLeft)} of ${fmt(info.shoeSize)} left${info.paused ? ' · <b>paused</b>' : ''}`);
  if (r) out(`Dealer ${cardsText(r.dealer)} · ${describeTotal(r.dealer)}${r.holeShown ? '' : ' <span class="dev-dim">(second card face down)</span>'}`);
  out(table(info.spots.map((s, i) => {
    const si = r ? info.inRound.indexOf(s.id) : -1;
    const seat = r && si >= 0 ? r.seats[si] : null;
    const turn = live && si >= 0 && ((r!.phase === 'play' && r!.seatTurn === si) || (r!.phase === 'insurance' && r!.seats.findIndex((x) => x.insurance === null) === si));
    const hands = seat ? seat.hands.map((h) => `${cardsText(h.cards)} ${describeTotal(h.cards, false)}${h.outcome ? ` <b>${h.outcome}</b>` : ''}`).join('<br>') : '';
    return [`${i}`, `${esc(s.name)}${turn ? ' ◀' : ''}`, s.isHuman ? `person${s.away ? ' (away)' : ''}` : 'bot', s.stack, seat ? seat.hands.reduce((n, h) => n + h.bet, 0) : s.bet ?? 0, hands || (s.sittingOut ? 'sitting out' : '')];
  }), ['#', 'Spot', 'Plays', 'Chips', 'Bet', 'Hands']));
  const rig = info.nextRig;
  if (rig && (rig.dealer?.length || Object.keys(rig.seats ?? {}).length)) {
    const parts = Object.entries(rig.seats ?? {}).map(([id, c]) => `${esc(info.spots.find((s) => s.id === id)?.name ?? id)} ${cardsText(c)}`);
    if (rig.dealer?.length) parts.push(`dealer ${cardsText(rig.dealer)}`);
    out(`Next round is rigged: ${parts.join(' · ')}`, 'dim');
  }
}

function printPeek(info: BjAdminInfo, out: Out, everyone: boolean) {
  const r = info.round;
  const next = info.upcoming;
  if (playing(r)) {
    out(`Dealer's hole card ${cardsText([r.dealer[1]])} · the dealer has <b>${describeTotal(r.dealer)}</b>${r.holeShown ? ' (already face up)' : ''}`);
    if (r.phase === 'dealer') {
      const run = dealerRunout(r.dealer, next);
      out(run.draws.length ? `The dealer draws ${cardsText(run.draws)} and ends on <b>${run.total}</b>` : `The dealer stands on <b>${run.total}</b>`);
    } else {
      const seat = r.phase === 'play' ? r.seats[r.seatTurn] : null;
      if (seat) out(`Next card ${cardsText(next.slice(0, 1))} goes to <b>${esc(seat.name)}</b> on a hit, double or split`);
      const run = dealerRunout(r.dealer, next);
      out(run.draws.length ? `If every hand stood now, the dealer would draw ${cardsText(run.draws)} and end on <b>${run.total}</b>` : `If every hand stood now, the dealer would stand on <b>${run.total}</b>`);
    }
    out(`Next out of the shoe: ${cardsText(next.slice(0, 10))}`);
    return;
  }
  const deal = openingDeal(info, everyone);
  out('Next round deals:');
  out(table(deal.map((d) => [esc(d.who), cardsText([d.card]) + (d.fixed ? ' <span class="dev-dim">rigged</span>' : '')]), ['To', 'Card']));
  if (!everyone && info.spots.some((s) => s.isHuman && s.bet === null && !s.sittingOut)) out('This counts only the people who have bet so far; anyone who bets now shifts the cards.', 'dim');
  const used = deal.filter((d) => !d.fixed).length;
  out(`Then from the shoe: ${cardsText(next.slice(used, used + 8))}`);
}

/** Blackjack's own table commands, by name. */
const COMMANDS: Record<string, { usage: string; help: string; run(at: BjTarget, args: string[], out: Out, me: string | null): Promise<void> }> = {
  state: {
    usage: 'state', help: 'Every card on the table, the dealer\'s face-down one included, with chips and bets.',
    async run(at, _, out) {
      printState(await inspect(at), out);
    },
  },
  peek: {
    usage: 'peek', help: 'The dealer\'s hole card and the cards coming out of the shoe: who gets the next card, what the dealer draws, or how the next round deals.',
    async run(at, _, out) {
      printPeek(await inspect(at), out, 'local' in at);
    },
  },
  deck: {
    usage: 'deck [count]', help: 'The next cards out of the shoe, first one first.',
    async run(at, args, out) {
      const info = await inspect(at);
      const n = Math.max(1, Math.min(16, Number(args[0]) || 12));
      out(`Next ${n}: ${cardsText(info.upcoming.slice(0, n))}`);
    },
  },
  rig: {
    usage: 'rig <spot | dealer> <cards> | rig next <cards> | rig clear',
    help: 'rig me As Kd deals a spot those two cards next round; rig dealer Th 6c sets the dealer\'s upcard and hole card; rig next 5h 9s puts cards on top of the shoe to come out next. Rigged rounds earn no achievements.',
    async run(at, args, out, me) {
      const what = (args[0] ?? '').toLowerCase();
      if (what === 'clear') {
        if ('local' in at) {
          at.local.nextRig = null;
          return out('Next round deals from the shoe.', 'ok');
        }
        return void (await at.remote({ do: 'unrig' }, out));
      }
      const cards = args.slice(1).map(card);
      if (what === 'next') {
        if (!cards.length) throw new UsageError('List the cards, like rig next 5h 9s.');
        if ('local' in at) {
          at.local.shoe.stackTop(cards);
          at.local.refresh();
          return out(`Next out of the shoe: ${cardsText(cards)}`, 'ok');
        }
        return void (await at.remote({ do: 'stackshoe', cards }, out));
      }
      if (!cards.length || cards.length > 2) throw new UsageError('Give one or two cards, like rig me As Kd or rig dealer Th 6c.');
      const dealer = what === 'dealer';
      const info = await inspect(at, me);
      const spot = dealer ? null : spotOf(info, args[0]);
      if ('local' in at) {
        const rig = at.local.nextRig ?? {};
        at.local.nextRig = dealer ? { ...rig, dealer: cards } : { ...rig, seats: { ...rig.seats, [spot!.id]: cards } };
        return out(`${dealer ? 'The dealer' : esc(spot!.name)} gets ${cardsText(cards)} next round.`, 'ok');
      }
      await at.remote({ do: 'rig', seat: dealer ? 'dealer' : spot!.id, cards }, out);
    },
  },
  hole: {
    usage: 'hole <card>', help: 'Swaps the dealer\'s face-down card in the round in play, like hole As. Not once the dealer has checked for blackjack, if it would make one.',
    async run(at, args, out) {
      const c = card(need(args[0], 'Name the card, like hole As.'));
      if ('local' in at) {
        const r = need(at.local.round, 'No round in play.');
        if (r.isComplete) throw new UsageError('No round in play.');
        r.setHole(c);
        at.local.refresh();
        return out(`The dealer's hole card is now ${cardsText([c])}.`, 'ok');
      }
      await at.remote({ do: 'hole', card: c }, out);
    },
  },
  stack: {
    usage: 'stack <spot> <amount | +n | -n>', help: 'Sets a spot\'s chips. At a practice table your chips are your bank.',
    async run(at, args, out, me) {
      const info = await inspect(at, me);
      const spot = spotOf(info, args[0]);
      const n = amount(args[1], spot.stack);
      if ('local' in at) {
        at.local.setStack(spot.id, n);
        return out(`${esc(spot.name)}: ${fmt(spot.stack)} → <b>${fmt(n)}</b>`, 'ok');
      }
      await at.remote({ do: 'stack', seat: spot.id, amount: n }, out);
    },
  },
  pause: {
    usage: 'pause', help: 'Stops the bots, the dealer and the clocks (or carries on if paused). step moves one at a time.',
    async run(at, _, out) {
      if ('local' in at) {
        at.local.paused = !at.local.paused;
        return out(at.local.paused ? 'Paused. step makes one move, pause again to carry on.' : 'Carrying on.', 'ok');
      }
      const info = await inspect(at);
      await at.remote({ do: info.paused ? 'resume' : 'pause' }, out);
    },
  },
  resume: {
    usage: 'resume', help: 'Carries on after pause.',
    async run(at, _, out) {
      if ('local' in at) {
        at.local.paused = false;
        return out('Carrying on.', 'ok');
      }
      await at.remote({ do: 'resume' }, out);
    },
  },
  step: {
    usage: 'step', help: 'Makes the next bot or dealer move now. Online, during betting it deals the round to whoever has bet.',
    async run(at, _, out) {
      if ('local' in at) {
        if (!at.local.step()) throw new UsageError('Nothing to do: it is your move, or no round is in play.');
        return;
      }
      await at.remote({ do: 'step' }, out);
    },
  },
};

const POKER_ONLY = new Set(['reveal', 'board', 'bot', 'ask', 'autopilot', 'speed', 'level', 'deal']);

/**
 * Runs a console command at a blackjack table. False when it isn't a blackjack table
 * command, so the console runs it as usual (help, accounts, tables…).
 */
export async function runBlackjack(name: string, args: string[], out: Out, at: BjTarget, me: string | null): Promise<boolean> {
  const cmd = COMMANDS[name];
  if (cmd) {
    await cmd.run(at, args, out, me);
    return true;
  }
  if (POKER_ONLY.has(name)) throw new UsageError(`${name} is for poker tables. At blackjack, try peek, state, rig, hole or stack.`);
  return false;
}

export function blackjackHelp(out: Out) {
  out('At a blackjack table', 'group');
  out(table(Object.values(COMMANDS).map((c) => [`<b>${esc(c.usage)}</b>`, esc(c.help)]), ['Command', 'What it does']));
}
