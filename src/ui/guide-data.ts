// The how to play text: rules and a first-hand walkthrough for every game in the lobby.
// The rules come from the engines (src/engine), so keep the two in step when a rule changes;
// test/guide.test.ts checks the walkthrough hands against them. No DOM here.
import { Card, makeCard } from '../engine/cards';
import type { Sym } from '../engine/slots';
import type { GameId } from './games';

// Suits: 0 clubs, 1 diamonds, 2 hearts, 3 spades. Ranks 2..14 (ace high).
const c = (rank: number, suit: number): Card => makeCard(rank, suit);
export const C = 0, D = 1, H = 2, S = 3;
export const A = 14, K = 13, Q = 12, J = 11, T = 10;

/** A row of cards in a step: whose they are, and which ones to mark. */
export interface Row {
  label: string;
  cards: (Card | null)[];
  /** Cards to light up: held, kept, or the ones that make the hand. */
  mark?: number[];
}

export interface Step {
  title: string;
  /** What happens and what to do. Bold with <b>; the text is ours, not the player's. */
  text: string;
  rows?: Row[];
  /** Roulette: bets on the layout (spot, chips) or the winning pocket, instead of cards. */
  bets?: [string, number][];
  pocket?: number;
  /** Slots: the window of symbols, top row first, and which rows (by line index into it) paid. */
  reels?: Sym[][];
  paid?: number[];
}

/** Which hand ranking chart the rules show. */
export type Ranking = 'high' | 'short' | 'low' | 'hilo' | 'videopoker';

export interface Guide {
  goal: string;
  rules: string[];
  ranking?: Ranking;
  steps: Step[];
}

const BETTING = 'On your turn you can <b>fold</b> (give up the hand), <b>check</b> (pass when nobody has bet), <b>call</b> (match the bet) or <b>bet</b> and <b>raise</b>. No-Limit lets you bet every chip you have, Pot-Limit caps a bet at the size of the pot, and Fixed-Limit uses set bet sizes that double on the later rounds.';
const BOARD_STREETS = 'Three shared cards come face up (the <b>flop</b>), then one more (the <b>turn</b>) and a last one (the <b>river</b>), with a round of betting after each.';
const BLINDS = 'The two players left of the dealer button post the <b>small</b> and <b>big blind</b> before any cards come, so every pot starts with something in it. The button moves one seat left each hand.';
const STUD_DEAL = 'Everyone puts in an <b>ante</b>. You get two cards face down and one face up, then three more face up and a last one face down, with a round of betting after each new card.';
const STUD_LIMIT = 'Stud here is Fixed-Limit: bets are one small bet on the first two rounds and one big bet (twice as much) after that.';

const GUIDES: Record<GameId, Guide> = {
  holdem: {
    goal: 'Make the best five-card hand from your two hole cards and the five shared cards on the board, or bet so that everyone else folds.',
    rules: [
      BLINDS,
      'Everyone gets two cards face down. Only you can see yours. The first round of betting starts with the player left of the big blind.',
      BOARD_STREETS,
      BETTING,
      'If two or more players are left after the river, hands are shown. The best five cards from any mix of your two and the board\'s five win. Equal hands split the pot.',
    ],
    ranking: 'high',
    steps: [
      { title: 'The blinds go in', text: 'You are on the <b>button</b> this hand, so you act last on every round after the first. The two players to your left post the blinds.' },
      { title: 'Your hole cards', text: 'Ace-jack of hearts is a strong start. Two players fold and one calls the big blind. Raise to take control of the pot: tap <b>Raise to</b> or press <b>R</b>.', rows: [{ label: 'You', cards: [c(A, H), c(J, H)] }] },
      { title: 'The flop', text: 'You have <b>top pair</b>, jacks, with the best kicker (your ace). Your opponent checks to you. Bet about half the pot so worse jacks and sevens pay you.', rows: [{ label: 'You', cards: [c(A, H), c(J, H)], mark: [1] }, { label: 'Board', cards: [c(J, C), c(7, D), c(2, S)], mark: [0] }] },
      { title: 'The turn', text: 'The nine changes little. They check again and you bet again. They call, so they likely hold a pair too.', rows: [{ label: 'You', cards: [c(A, H), c(J, H)], mark: [1] }, { label: 'Board', cards: [c(J, C), c(7, D), c(2, S), c(9, H)], mark: [0] }] },
      { title: 'The river', text: 'A three is a blank. A small bet can still get paid by a weaker jack. If you think only better hands would call, check instead.', rows: [{ label: 'You', cards: [c(A, H), c(J, H)], mark: [1] }, { label: 'Board', cards: [c(J, C), c(7, D), c(2, S), c(9, H), c(3, C)], mark: [0] }] },
      { title: 'Showdown', text: 'They show jack-ten. You both have a pair of jacks, so the next best card decides it: your <b>ace kicker</b> beats their ten and the pot is yours.', rows: [{ label: 'You', cards: [c(A, H), c(J, H)], mark: [0, 1] }, { label: 'Them', cards: [c(J, D), c(T, D)], mark: [0] }, { label: 'Board', cards: [c(J, C), c(7, D), c(2, S), c(9, H), c(3, C)], mark: [0] }] },
    ],
  },
  shortdeck: {
    goal: 'Hold\'em with a 36-card deck. Make the best five-card hand from your two hole cards and the board, but with the ranks changed to match the smaller deck.',
    rules: [
      'Every 2, 3, 4 and 5 is taken out, so the deck runs from six to ace. Hands come in stronger than in full-deck Hold\'em.',
      '<b>A flush beats a full house</b> and <b>three of a kind beats a straight</b>, because with fewer cards those hands are harder to make.',
      'The ace still plays low in one straight: A-6-7-8-9.',
      BLINDS + ' The flop, turn and river come as in Hold\'em.',
      'Short Deck here is No-Limit: you can bet all your chips at any time.',
    ],
    ranking: 'short',
    steps: [
      { title: 'A smaller deck', text: 'There are only 36 cards and nine of each suit. Pairs and draws are worth more than you are used to, so expect more action.' },
      { title: 'Your hole cards', text: 'Queen-jack of hearts. You call the big blind and one player raises. Suited cards like these play well here, so you call.', rows: [{ label: 'You', cards: [c(Q, H), c(J, H)] }] },
      { title: 'The flop', text: 'Two hearts on board give you a <b>flush draw</b>. With nine hearts in the deck and four in sight, five are left for you. The raiser bets and you call.', rows: [{ label: 'You', cards: [c(Q, H), c(J, H)], mark: [0, 1] }, { label: 'Board', cards: [c(T, H), c(7, H), c(7, C)], mark: [0, 1] }] },
      { title: 'The turn', text: 'The ace of hearts makes your <b>flush</b>. They bet big and you raise. They go all in, and you call.', rows: [{ label: 'You', cards: [c(Q, H), c(J, H)], mark: [0, 1] }, { label: 'Board', cards: [c(T, H), c(7, H), c(7, C), c(A, H)], mark: [0, 1, 3] }] },
      { title: 'Showdown', text: 'They show a pair of tens for a <b>full house</b>, tens full of sevens. That wins in normal Hold\'em, but in Short Deck <b>your flush beats it</b>.', rows: [{ label: 'You', cards: [c(Q, H), c(J, H)], mark: [0, 1] }, { label: 'Them', cards: [c(T, S), c(T, C)], mark: [0, 1] }, { label: 'Board', cards: [c(T, H), c(7, H), c(7, C), c(A, H), c(8, D)] }] },
    ],
  },
  omaha: {
    goal: 'Make the best five-card hand using <b>exactly two</b> of your four hole cards and <b>exactly three</b> from the board.',
    rules: [
      BLINDS,
      'Everyone gets four cards face down. The flop, turn and river then come as in Hold\'em, with a round of betting after each.',
      'At showdown you must use two of your cards and three of the board\'s. Four hearts on the board and one heart in your hand is <b>not</b> a flush.',
      'Omaha is played Pot-Limit by default: the most you can bet is the size of the pot. No-Limit and Fixed-Limit are in the table options.',
      'With four cards each, big hands are common. A hand that would be strong in Hold\'em, like one pair, rarely wins here.',
    ],
    ranking: 'high',
    steps: [
      { title: 'Your hole cards', text: 'Two aces with a king and queen is a premium start: pairs, high straights and a heart draw all at once. Raise with <b>Raise to</b>, and one player calls.', rows: [{ label: 'You', cards: [c(A, H), c(A, C), c(K, H), c(Q, C)] }] },
      { title: 'The flop', text: 'Your ace and queen with the king, jack and ten on the board make a <b>straight</b>, ace high. That uses exactly two of yours and three of the board. Bet the pot.', rows: [{ label: 'You', cards: [c(A, H), c(A, C), c(K, H), c(Q, C)], mark: [0, 3] }, { label: 'Board', cards: [c(K, D), c(T, S), c(J, H)], mark: [0, 1, 2] }] },
      { title: 'Watch the board', text: 'The four of clubs is safe: the board has no pair, so nobody has a full house, and no three cards of one suit, so no flush. Bet again.', rows: [{ label: 'You', cards: [c(A, H), c(A, C), c(K, H), c(Q, C)], mark: [0, 3] }, { label: 'Board', cards: [c(K, D), c(T, S), c(J, H), c(4, C)], mark: [0, 1, 2] }] },
      { title: 'Showdown', text: 'They show two kings for <b>three kings</b>. Your straight beats it. Had the river paired the board, their three kings could have become a full house.', rows: [{ label: 'You', cards: [c(A, H), c(A, C), c(K, H), c(Q, C)], mark: [0, 3] }, { label: 'Them', cards: [c(K, S), c(K, C), c(7, S), c(3, H)], mark: [0, 1] }, { label: 'Board', cards: [c(K, D), c(T, S), c(J, H), c(4, C), c(2, D)], mark: [0, 1, 2] }] },
    ],
  },
  omaha8: {
    goal: 'Omaha where the pot is split in two: half to the best high hand and half to the best <b>low</b> hand, if anyone has one.',
    rules: [
      'The deal and betting are the same as Omaha: four hole cards, a flop, turn and river. You use exactly two of your cards and three of the board for each half.',
      'A low hand is five different ranks, all <b>eight or lower</b>. Aces count low, and straights and flushes do not spoil a low. The best low is A-2-3-4-5.',
      'You can use different cards for your high and your low. Winning both halves is called a <b>scoop</b>.',
      'If nobody can make a low, the best high hand wins the whole pot.',
      'Omaha Hi-Lo is played Pot-Limit by default, with Fixed-Limit in the table options.',
    ],
    ranking: 'hilo',
    steps: [
      { title: 'Your hole cards', text: 'Ace-two is the best start for low, and the pair of kings gives you a shot at high too. Hands that can go both ways are what you want. Raise.', rows: [{ label: 'You', cards: [c(A, D), c(2, C), c(K, S), c(K, H)] }] },
      { title: 'The flop', text: 'Two low cards came. You have <b>three kings</b> for high and need one more low card that is not an ace, two, three or four to make a low. Bet.', rows: [{ label: 'You', cards: [c(A, D), c(2, C), c(K, S), c(K, H)], mark: [2, 3] }, { label: 'Board', cards: [c(3, C), c(4, D), c(K, D)], mark: [2] }] },
      { title: 'The river', text: 'The five gives you A-2-3-4-5, the <b>best possible low</b>. The same cards are also a five-high straight, which beats your three kings for high.', rows: [{ label: 'You', cards: [c(A, D), c(2, C), c(K, S), c(K, H)], mark: [0, 1] }, { label: 'Board', cards: [c(3, C), c(4, D), c(K, D), c(9, S), c(5, H)], mark: [0, 1, 4] }] },
      { title: 'Showdown', text: 'They show six-seven for a <b>seven-high straight</b>, which beats yours for high. Their low, 7-6-5-4-3, is worse than yours. They take the high half and you take the low half.', rows: [{ label: 'You', cards: [c(A, D), c(2, C), c(K, S), c(K, H)], mark: [0, 1] }, { label: 'Them', cards: [c(6, C), c(7, C), c(8, S), c(Q, H)], mark: [0, 1] }, { label: 'Board', cards: [c(3, C), c(4, D), c(K, D), c(9, S), c(5, H)], mark: [0, 1, 4] }] },
    ],
  },
  draw5: {
    goal: 'Make the best five-card hand. Nothing is shared: you get five private cards and one chance to swap some of them.',
    rules: [
      BLINDS,
      'Everyone gets five cards face down, then there is a round of betting.',
      'In the <b>draw</b>, each player throws away any number of cards, from none to all five, and gets new ones. Keeping all five is called <b>standing pat</b>.',
      'A second round of betting follows, then the best hand wins at showdown.',
      BETTING,
      'Five Card Draw is played Fixed-Limit by default, with Pot-Limit and No-Limit in the table options.',
    ],
    ranking: 'high',
    steps: [
      { title: 'Your five cards', text: 'A <b>pair of kings</b> is a good hand before the draw. One player bets and you raise.', rows: [{ label: 'You', cards: [c(K, S), c(K, D), c(7, C), c(4, H), c(2, S)], mark: [0, 1] }] },
      { title: 'The draw', text: 'Keep the kings and throw the rest away: tap the seven, four and two, then <b>Discard 3 and draw</b>. Your opponent draws one card, which often means two pair or a straight or flush draw.', rows: [{ label: 'You', cards: [c(K, S), c(K, D), null, null, null], mark: [0, 1] }] },
      { title: 'After the draw', text: 'You catch a pair of eights for <b>two pair</b>, kings and eights. They check and you bet.', rows: [{ label: 'You', cards: [c(K, S), c(K, D), c(8, H), c(8, C), c(3, D)], mark: [0, 1, 2, 3] }] },
      { title: 'Showdown', text: 'They call and show queens and fives. Two pair against two pair is decided by the top pair, so your <b>kings up</b> win.', rows: [{ label: 'You', cards: [c(K, S), c(K, D), c(8, H), c(8, C), c(3, D)], mark: [0, 1, 2, 3] }, { label: 'Them', cards: [c(Q, H), c(Q, C), c(5, S), c(5, D), c(J, C)], mark: [0, 1, 2, 3] }] },
    ],
  },
  stud7: {
    goal: 'Make the best five-card hand from seven cards of your own, four of them face up where everyone can see. There are no shared cards and no blinds.',
    rules: [
      STUD_DEAL,
      'On the first round, the player with the <b>lowest up card</b> must open with a small forced bet called the <b>bring-in</b>. Anyone after can call it or <b>complete</b> it to a full bet.',
      'From the second round on, the player whose up cards make the best hand acts first.',
      STUD_LIMIT,
      'At showdown, everyone left makes their best five cards out of seven.',
    ],
    ranking: 'high',
    steps: [
      { title: 'Antes and third street', text: 'You have a pair of queens with one of them hidden. The lowest up card at the table, a three, posts the bring-in. You <b>complete</b> to a full bet.', rows: [{ label: 'Down', cards: [c(Q, H), c(8, C)], mark: [0] }, { label: 'Up', cards: [c(Q, S)], mark: [0] }] },
      { title: 'Fourth street', text: 'An eight up gives you <b>two pair</b>, queens and eights, and the other players can only see a queen and an eight. Bet.', rows: [{ label: 'Down', cards: [c(Q, H), c(8, C)], mark: [0, 1] }, { label: 'Up', cards: [c(Q, S), c(8, D)], mark: [0, 1] }] },
      { title: 'Fifth and sixth street', text: 'A five and a three do not help. Watch the other players\' up cards: if the last queens and eights are showing elsewhere, your hand cannot improve. Here they are not, so keep betting.', rows: [{ label: 'Down', cards: [c(Q, H), c(8, C)], mark: [0, 1] }, { label: 'Up', cards: [c(Q, S), c(8, D), c(5, H), c(3, C)], mark: [0, 1] }] },
      { title: 'Seventh street', text: 'Your last card comes face down: the queen of diamonds, for a <b>full house</b>, queens full of eights. Nobody else knows it.', rows: [{ label: 'Down', cards: [c(Q, H), c(8, C), c(Q, D)], mark: [0, 1, 2] }, { label: 'Up', cards: [c(Q, S), c(8, D), c(5, H), c(3, C)], mark: [0, 1] }] },
      { title: 'Showdown', text: 'Your opponent shows a straight, nine high. A full house beats a straight, and the pot is yours.', rows: [{ label: 'You', cards: [c(Q, H), c(8, C), c(Q, S), c(8, D), c(5, H), c(3, C), c(Q, D)], mark: [0, 1, 2, 3, 6] }] },
    ],
  },
  stud8: {
    goal: 'Seven Card Stud where the pot is split: half to the best high hand and half to the best low hand of five cards eight or lower.',
    rules: [
      STUD_DEAL,
      'The lowest up card posts the bring-in on the first round. After that, the best-looking high hand acts first.',
      'A low is five different ranks, all <b>eight or lower</b>, with aces low. Straights and flushes do not spoil a low, so A-2-3-4-5 is the best low and also a straight.',
      'You choose any five of your seven for high and any five for low. Winning both halves is a <b>scoop</b>. If nobody has a low, the high hand wins it all.',
      STUD_LIMIT,
    ],
    ranking: 'hilo',
    steps: [
      { title: 'Third street', text: 'Three low cards, ace among them, is a great start. A two showing elsewhere posts the bring-in, and you complete.', rows: [{ label: 'Down', cards: [c(A, C), c(3, D)], mark: [0, 1] }, { label: 'Up', cards: [c(5, S)], mark: [0] }] },
      { title: 'Fourth and fifth street', text: 'A six and a four give you a <b>low already made</b>: 6-5-4-3-A. You also have four cards to a straight. Keep betting.', rows: [{ label: 'Down', cards: [c(A, C), c(3, D)], mark: [0, 1] }, { label: 'Up', cards: [c(5, S), c(6, H), c(4, C)], mark: [0, 1, 2] }] },
      { title: 'Sixth street', text: 'A king does nothing for you, but a made low with a straight draw is worth calling to the end.', rows: [{ label: 'Down', cards: [c(A, C), c(3, D)], mark: [0, 1] }, { label: 'Up', cards: [c(5, S), c(6, H), c(4, C), c(K, S)], mark: [0, 1, 2] }] },
      { title: 'Seventh street and showdown', text: 'The two of diamonds is perfect. For high you have a <b>six-high straight</b>, 2-3-4-5-6. For low you have <b>A-2-3-4-5</b>, the best there is. Your opponent shows two pair, so you scoop the whole pot.', rows: [{ label: 'You', cards: [c(A, C), c(3, D), c(5, S), c(6, H), c(4, C), c(K, S), c(2, D)], mark: [0, 1, 2, 3, 4, 6] }] },
    ],
  },
  razz: {
    goal: 'Seven Card Stud for the <b>lowest</b> hand. The best five of your seven cards win when they are the lowest at the table.',
    rules: [
      STUD_DEAL,
      'Aces are always low, and <b>straights and flushes do not count</b>. Pairs hurt you. The best hand is A-2-3-4-5, and a hand is compared by its highest card first.',
      'On the first round, the <b>highest up card</b> brings in. After that, the lowest-looking hand acts first.',
      STUD_LIMIT,
      'There is no eight-or-better rule: some low hand always wins.',
    ],
    ranking: 'low',
    steps: [
      { title: 'Third street', text: 'Ace, two and four is a strong razz start. A king showing elsewhere has to bring in, and you complete.', rows: [{ label: 'Down', cards: [c(A, H), c(2, S)], mark: [0, 1] }, { label: 'Up', cards: [c(4, C)], mark: [0] }] },
      { title: 'Fourth street', text: 'A king is a bad card in razz. Your up cards show 4-K, so a player showing two low cards will act first and likely bet. You still have three good low cards, so call.', rows: [{ label: 'Down', cards: [c(A, H), c(2, S)], mark: [0, 1] }, { label: 'Up', cards: [c(4, C), c(K, D)], mark: [0] }] },
      { title: 'Fifth and sixth street', text: 'A five and a three make <b>A-2-3-4-5</b> with one card still to come. Nobody can beat it, so bet and raise.', rows: [{ label: 'Down', cards: [c(A, H), c(2, S)], mark: [0, 1] }, { label: 'Up', cards: [c(4, C), c(K, D), c(5, H), c(3, D)], mark: [0, 2, 3] }] },
      { title: 'Showdown', text: 'Your last card does not matter. Your best five are a perfect low, and the king and jack are left out. The pot is yours.', rows: [{ label: 'You', cards: [c(A, H), c(2, S), c(4, C), c(K, D), c(5, H), c(3, D), c(J, C)], mark: [0, 1, 2, 4, 5] }] },
    ],
  },
  blackjack: {
    goal: 'Beat the dealer by getting closer to 21 than they do without going over.',
    rules: [
      'Number cards count their value, jacks, queens and kings count 10, and an ace counts 1 or 11, whichever helps. A hand with an ace counted as 11 is <b>soft</b>.',
      'Place a bet and press <b>Deal</b>. You get two cards face up. The dealer gets one up and one face down, and checks for blackjack under an ace or a ten.',
      'On your turn: <b>Hit</b> for another card, <b>Stand</b> to stop, <b>Double</b> to double your bet and take exactly one more card, or <b>Split</b> a pair into two hands with a bet on each. You can split up to four hands; split aces get one card each.',
      'Go over 21 and you <b>bust</b> and lose straight away. When everyone is done, the dealer draws until 17 or more and <b>stands on all 17s</b>.',
      'A win pays 1 to 1, a <b>blackjack</b> (an ace and a ten-card as your first two) pays 3 to 2, and a tie gets your bet back. When the dealer shows an ace you are offered <b>insurance</b>, which pays 2 to 1 but is a losing bet in the long run.',
      'The shoe has six decks and is reshuffled when the cut card comes out.',
    ],
    steps: [
      { title: 'Place your bet', text: 'Pick a chip to set your bet, use ×2 or Max to change it, then press <b>Deal</b> or Space.' },
      { title: 'Your cards', text: 'You have 16 and the dealer shows a ten. Sixteen is the hardest total in the game, but against a ten the dealer is likely to finish on 20, so the book play is to <b>Hit</b> (H).', rows: [{ label: 'Dealer', cards: [c(T, D), null] }, { label: 'You · 16', cards: [c(T, S), c(6, H)] }] },
      { title: 'Hit', text: 'A four gives you 20. Now <b>Stand</b> (S): one more card would almost surely bust you.', rows: [{ label: 'Dealer', cards: [c(T, D), null] }, { label: 'You · 20', cards: [c(T, S), c(6, H), c(4, C)], mark: [2] }] },
      { title: 'The dealer plays', text: 'The dealer turns over a seven for 17 and must stand. Your 20 wins, paid 1 to 1.', rows: [{ label: 'Dealer · 17', cards: [c(T, D), c(7, C)] }, { label: 'You · 20', cards: [c(T, S), c(6, H), c(4, C)], mark: [0, 1, 2] }] },
      { title: 'Next hand: double down', text: 'Eleven against a six is the best time to <b>Double</b> (D). Your bet doubles and you get one card, here a nine for 20. The dealer is more likely to bust with a six showing.', rows: [{ label: 'Dealer', cards: [c(6, S), null] }, { label: 'You · 20', cards: [c(6, D), c(5, C), c(9, H)], mark: [2] }] },
    ],
  },
  roulette: {
    goal: 'Guess where the ball will land. Put chips on single numbers or groups of numbers, spin, and the house pays every bet that covers the winning pocket.',
    rules: [
      'The <b>European</b> wheel has 37 pockets: 1 to 36 and a single zero. The <b>American</b> wheel adds a double zero for 38. Payouts are the same on both, so the double zero only adds house edge (2.7% against 5.3%).',
      'Pick a chip from the rack and tap the layout to place it. You can stack chips, undo, clear or double your bets before the spin.',
      'Inside bets: a <b>single number</b> pays 35 to 1, a <b>split</b> (two numbers) 17 to 1, a <b>street</b> (three) 11 to 1, a <b>corner</b> (four) 8 to 1 and a <b>line</b> (six) 5 to 1.',
      'Outside bets: a <b>dozen</b> or <b>column</b> pays 2 to 1. <b>Red</b> or <b>black</b>, <b>odd</b> or <b>even</b>, and <b>1-18</b> or <b>19-36</b> pay 1 to 1. Zero is none of these, so these bets lose when the ball lands on zero.',
      'The table limits set the smallest chip on one spot and the most you can have riding on one spin.',
    ],
    steps: [
      { title: 'Choose a chip', text: 'Tap a chip in the rack, or press a number key, to choose what each tap on the layout puts down.' },
      { title: 'Place your bets', text: 'Put 10 on <b>red</b>, 5 straight up on <b>17</b>, and 10 on the <b>second dozen</b> (13 to 24). That is 25 riding on the spin.', bets: [['17', 5], ['Red', 10], ['13 to 24', 10]] },
      { title: 'Spin', text: 'Press <b>Spin</b> or Space. Once the ball is rolling, the bets are locked.' },
      { title: 'The result', text: 'The ball lands on <b>17 black</b>. Your 5 on 17 pays 35 to 1, so 175, and the dozen pays 20. Red loses its 10. You are up 185 for the spin.', pocket: 17 },
      { title: 'Rebet', text: 'Press <b>Rebet</b> (R) to put the same bets down again, or clear the layout and start fresh.' },
    ],
  },
  baccarat: {
    goal: 'Bet on which hand, Player or Banker, will finish closest to nine. The cards play themselves: your only decision is the bet.',
    rules: [
      'Bet on <b>Player</b>, <b>Banker</b> or a <b>Tie</b>, and if you like on a <b>pair</b> in either hand. Then press <b>Deal</b>.',
      'Aces count 1, two to nine count their value, and tens and face cards count 0. Only the last digit of a total counts, so 7 and 8 make 5.',
      'Each hand gets two cards. A total of 8 or 9 is a <b>natural</b> and nobody draws. Otherwise Player draws a third card on 0 to 5 and stands on 6 or 7, and Banker draws by a fixed table that looks at its own total and the Player\'s third card.',
      'Player pays 1 to 1. Banker pays 1 to 1 less a <b>5% commission</b>, because Banker wins slightly more often. A Tie pays 8 to 1, and Player and Banker bets come back on a tie. Each pair bet pays 11 to 1.',
      'The shoe has eight decks.',
    ],
    steps: [
      { title: 'Place a bet', text: 'Pick a chip and tap <b>Banker</b> to bet 100 on it. Banker is the best bet on the table, even after the commission.' },
      { title: 'The deal', text: 'Player has a king and a three, which counts as <b>3</b>. Banker has a six and a queen, so <b>6</b>. Neither is a natural.', rows: [{ label: 'Player · 3', cards: [c(K, C), c(3, D)] }, { label: 'Banker · 6', cards: [c(6, S), c(Q, H)] }] },
      { title: 'Third cards', text: 'Player has 3, so Player draws: a two, for <b>5</b>. Banker on 6 only draws when Player\'s third card is a six or seven, so Banker stands.', rows: [{ label: 'Player · 5', cards: [c(K, C), c(3, D), c(2, H)], mark: [2] }, { label: 'Banker · 6', cards: [c(6, S), c(Q, H)] }] },
      { title: 'The result', text: 'Banker\'s 6 beats Player\'s 5. Your 100 on Banker wins 95 after the 5% commission. Press <b>Rebet</b> to bet the same again.', rows: [{ label: 'Player · 5', cards: [c(K, C), c(3, D), c(2, H)] }, { label: 'Banker · 6', cards: [c(6, S), c(Q, H)], mark: [0, 1] }] },
    ],
  },
  videopoker: {
    goal: 'Make the best poker hand you can from five cards and one draw. The machine pays by its pay table, and there is no one else to beat.',
    rules: [
      'Choose a coin size from the rack, then <b>Bet one</b> to add a coin or <b>Bet max</b> for five. Press <b>Deal</b> for five cards.',
      'Tap the cards you want to <b>hold</b>. Press <b>Draw</b> and the others are replaced from the same deck. Your final hand is paid from the pay table.',
      'On Jacks or Better, the smallest win is a <b>pair of jacks or better</b>. Lower pairs pay nothing.',
      'Every line pays per coin, but a <b>royal flush</b> jumps from 250 to 800 a coin on the fifth coin. That is why five coins is always the right bet.',
      'Three machines: <b>Jacks or Better</b> (9/6), <b>Bonus Poker</b>, which pays extra for four aces and four 2s, 3s or 4s, and <b>Double Double Bonus</b>, with bigger four-of-a-kind pays and even more with the right kicker, but two pair pays only 1.',
    ],
    ranking: 'videopoker',
    steps: [
      { title: 'Bet max', text: 'Pick a coin size and press <b>Bet max</b> (X), then <b>Deal</b> (Space). Five coins is the only way to get the full royal flush prize.' },
      { title: 'The deal', text: 'Three jacks. <b>Hold</b> them by tapping each one, and leave the four and nine to be replaced.', rows: [{ label: 'Dealt', cards: [c(J, H), c(J, S), c(4, C), c(J, D), c(9, H)], mark: [0, 1, 3] }] },
      { title: 'The draw', text: 'Press <b>Draw</b>. A seven and a two come. <b>Three of a kind</b> pays 3 a coin, so 15 coins on five. A matching card or a pair would have paid more.', rows: [{ label: 'Final', cards: [c(J, H), c(J, S), c(7, S), c(J, D), c(2, D)], mark: [0, 1, 3] }] },
      { title: 'What to hold', text: 'A simple order on Jacks or Better: keep a full house or better. Four cards to a royal come next, even ahead of a made flush or straight. Then three of a kind, a straight or flush, two pair, a high pair, four to a flush and a low pair. With nothing at all, keep your jacks, queens, kings and aces.' },
    ],
  },
  slots: {
    goal: 'Line up matching symbols along the pay lines you bought. Every spin is chance, so the only choices are your coin size and how many lines to play.',
    rules: [
      'Pick a <b>coin</b> size and how many <b>lines</b> to play, from one to five. Each line costs one coin, so five lines of 5 chips is 25 a spin.',
      'The lines are bought in order: the <b>middle row</b> first, then the top row, the bottom row, and the two <b>diagonals</b>.',
      'Press <b>Spin</b> (Space) to play, or <b>Spin max</b> (X) to buy all five lines. <b>Lines</b> (L) changes how many you play.',
      'Symbols pay <b>left to right</b> along a line you bought, in coins for each coin on that line: three sevens 500, three crowns 60, three chips 30, three spades 18, three hearts 15, three diamonds 12 and three clubs 8.',
      'Smaller wins: <b>any three black suits</b> or <b>any three red suits</b> pay 3, <b>any two chips</b> on a line pay 3, and chips on the first reel pay 1.',
      'The machine pays back about 95% of what goes in over a long run, so expect to lose a little over time.',
    ],
    steps: [
      { title: 'Choose your bet', text: 'Pick a coin of 5 chips from the rack. Press <b>Spin max</b> to play all five lines, which costs 25.' },
      { title: 'The spin', text: 'The reels stop one at a time. The middle row is <b>heart, diamond, heart</b>, any three red suits, for 3 coins. The top row is <b>spade, club, spade</b>, any three black suits, for 3 more.', reels: [['spade', 'club', 'spade'], ['heart', 'diamond', 'heart'], ['club', 'seven', 'crown']], paid: [0, 1] },
      { title: 'Your pay', text: 'Six coins of 5 is 30 back on a 25 spin. The bottom row and the two diagonals paid nothing, and the seven in the middle of the bottom row would need two more beside it.', reels: [['spade', 'club', 'spade'], ['heart', 'diamond', 'heart'], ['club', 'seven', 'crown']], paid: [0, 1] },
      { title: 'Keep going, or stop', text: 'Spin again with Space. Each spin is independent of the last, so a machine is never "due". Set a budget and leave when it is gone.' },
    ],
  },};

/** Every game has a guide; the tests check this along with the walkthrough cards. */
export const GUIDE_GAMES = Object.keys(GUIDES) as GameId[];
export const guideFor = (id: GameId): Guide => GUIDES[id];
