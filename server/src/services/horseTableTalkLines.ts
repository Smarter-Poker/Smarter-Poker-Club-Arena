/**
 * HORSE TABLE TALK LINES (Phase 10, "Table talk at the felt", 2026-10-06)
 *
 * The pool a seated horse draws one chat line from, seven events by three
 * voices. Dan approved and ordered table talk on 2026-10-21: "they need to
 * sometimes say things like nice hand or you got lucky, or other simple random
 * phrases inside the chat after a hand is over". The mode row
 * `horse_post_modes.mode = 'table_talk'` is switched on by
 * 20261022050713_horse_table_talk_and_gestures_on, and three events were added the
 * same day so a horse talks after ordinary hands, not only after 40 big blind
 * pots: pot_lost (any showdown it lost), pot_won (any pot it won) and all_in
 * (a good luck line as it moves in, never every time).
 *
 * Dan 2026-10-22: "100+ different short phrases ... every horse should be
 * different and say different things, in different styles". The pool holds
 * well over 100 distinct lines; each horse uses only its own share of it and
 * types it in its own style (case, punctuation, shorthand, emoji), all in
 * horseVoiceStyle.ts. Lines here stay plain and emoji free.
 *
 * The register is deliberately lowercase chat: a typed line at a poker table,
 * not UI copy. The Title Case gate inspects labels, titles and descriptions,
 * and this file carries none of those keys on purpose: every cell is keyed
 * `lines`.
 *
 * A line may carry only facts the engine holds at that moment, through four
 * placeholders and no others:
 *
 *   {potBB}   the pot in big blinds, rounded
 *   {street}  preflop, flop, turn or river (the street the hand ended on)
 *   {hand}    the hand name the engine SHOWED (the horse's own unmucked hand,
 *             or the winner's shown hand), lowercased
 *   {seat}    a seat number the engine holds, never a username
 *
 * No username ever reaches a line: the sanitizer in HorseTableTalk.ts refuses
 * any token that equals a seated player's username, and
 * theHorseSaysNothingItWasNotTold.law.test.ts reads every line here through
 * the same sanitizer, the client's profanity list and the placeholder rule.
 * Plain hyphens only, no emoji, no at sign, at most 120 characters.
 *
 * Pure data. No imports, no randomness: the choice is a hash of
 * (horse, hand number, event) in HorseTableTalk.chooseLine.
 */

export type TalkEvent =
  | 'big_pot_won'
  | 'showdown_loss'
  | 'big_hand_shown'
  | 'arrival'
  | 'pot_lost'
  | 'pot_won'
  | 'all_in';
export type TalkVoice = 'quiet' | 'needler' | 'friendly';

export const TALK_EVENTS: readonly TalkEvent[] = [
  'big_pot_won',
  'showdown_loss',
  'big_hand_shown',
  'arrival',
  'pot_lost',
  'pot_won',
  'all_in',
];
export const TALK_VOICES: readonly TalkVoice[] = ['quiet', 'needler', 'friendly'];

/** The only placeholders a line may carry. Anything else fails the law test. */
export const TALK_PLACEHOLDERS: readonly string[] = ['potBB', 'street', 'hand', 'seat'];

export interface TalkPool {
  readonly lines: readonly string[];
}

export const LINES: Record<TalkEvent, Record<TalkVoice, TalkPool>> = {
  // Event A: the horse won a pot of 40 big blinds or more.
  big_pot_won: {
    quiet: { lines: ['thats a {potBB} bb pot, ill take it'] },
    needler: { lines: ['{potBB} bb on the {street}, somebody wanted to see my cards'] },
    friendly: { lines: ['nice pot, {potBB} bb, gg'] },
  },
  // Event B: the horse lost at showdown holding two pair or better.
  showdown_loss: {
    quiet: { lines: ['{hand} no good, fair enough'] },
    needler: { lines: ['{hand} and still second best, this table is brutal'] },
    friendly: { lines: ['ran {hand} into a bigger one on the {street}, well played seat {seat}'] },
  },
  // Event C: a winner showed a full house or better; the horse did not win.
  big_hand_shown: {
    quiet: { lines: ['{hand} shown, ok then'] },
    needler: { lines: ['{hand} on this board, of course'] },
    friendly: { lines: ['{hand}, nice hand seat {seat}'] },
  },
  // Event D: a player sat down; the horse has been seated ten hands or more.
  arrival: {
    quiet: { lines: ['gl'] },
    needler: { lines: ['fresh chips at seat {seat}, welcome'] },
    friendly: { lines: ['welcome to the table seat {seat}, good luck'] },
  },
  // Event E: the horse lost a pot at showdown, any hand.
  pot_lost: {
    quiet: {
      lines: [
        'nh',
        'nice hand',
        'ugh',
        'ok',
        'wow',
        'fair',
        'sigh',
        'cant win one',
        'gg',
        'card dead all night',
        'figures',
        'yep',
        'oh well',
        'next',
        'thought i had it',
        'knew it',
        'that hurts',
        'not my night',
        'rough',
        'unlucky',
      ],
    },
    needler: {
      lines: [
        'you got lucky',
        'lucky',
        'lucky {street}',
        'of course',
        'every single time',
        'how',
        'really?',
        'you called with that?',
        'sure, why not',
        'unreal',
        'hit your card huh',
        'gotta be kidding',
        'gift from the poker gods',
        'nice catch',
        'wow you really called',
        'runner runner, classic',
        'that was a reach',
        'enjoy it while it lasts',
        'ok i see how it is',
        'rigged lol',
        'you play like that every hand?',
        'the deck loves you',
        'bold call',
        'cant believe that got there',
      ],
    },
    friendly: {
      lines: [
        'nice hand',
        'Nice hand',
        'nh',
        'well played',
        'wp',
        'gg',
        'good hand',
        'nice one seat {seat}',
        'got me there',
        'too good',
        'well played sir',
        'nh, you had me',
        'good call',
        'you earned that one',
        'great read',
        'nicely done',
        'had it all the way huh',
        'gg, my bad',
        'good stuff',
        'respect',
        'you got me',
        'cant be mad at that',
      ],
    },
  },
  // Event F: the horse won a pot, any size.
  pot_won: {
    quiet: {
      lines: ['ty', 'thx', 'gg', 'finally', 'nice', 'about time', 'ok then', 'phew', 'needed it', 'one'],
    },
    needler: {
      lines: [
        'ty for the chips',
        'thanks',
        'ship it',
        'needed that',
        'thank you very much',
        'lol',
        'too easy',
        'appreciate it',
        'keep calling',
        'knew you had nothing',
        'come again',
        'tip your dealer',
        'stack those for me',
        'read you like a book',
        'love when that happens',
      ],
    },
    friendly: {
      lines: [
        'ty',
        'gg',
        'thanks all',
        'phew',
        'finally a hand',
        'gg wp',
        'that was close',
        'lucky me',
        'sorry about that',
        'ty ty',
        'whew, got there',
        'needed that one bad',
        'ill take it',
        'good hand though',
      ],
    },
  },
  // Event G: the horse is moving all in. Said as it shoves, and only sometimes.
  all_in: {
    quiet: { lines: ['gl', 'good luck', 'here we go', 'ok lets see', 'all in', 'gl both'] },
    needler: {
      lines: [
        'lets go',
        'one time',
        'lets dance',
        'you sure?',
        'run it',
        'call it',
        'prove it',
        'your move',
        'dont be scared',
        'lets gamble',
      ],
    },
    friendly: {
      lines: [
        'good luck',
        'gl',
        'gl gl',
        'good luck to you',
        'may the best hand win',
        'here goes nothing',
        'pray for me',
        'gl sir',
        'fingers crossed',
        'no regrets',
      ],
    },
  },
};
