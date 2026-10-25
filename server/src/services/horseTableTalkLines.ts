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
  | 'all_in'
  | 'tilt'
  | 'heater';
export type TalkVoice = 'quiet' | 'needler' | 'friendly';

export const TALK_EVENTS: readonly TalkEvent[] = [
  'big_pot_won',
  'showdown_loss',
  'big_hand_shown',
  'arrival',
  'pot_lost',
  'pot_won',
  'all_in',
  'tilt',
  'heater',
];
export const TALK_VOICES: readonly TalkVoice[] = ['quiet', 'needler', 'friendly'];

/** The only placeholders a line may carry. Anything else fails the law test. */
export const TALK_PLACEHOLDERS: readonly string[] = ['potBB', 'street', 'hand', 'seat'];

export interface TalkPool {
  readonly lines: readonly string[];
}

export const LINES: Record<TalkEvent, Record<TalkVoice, TalkPool>> = {
  // Event A: the horse won a pot of 40 big blinds or more.
  //
  // Dan 2026-10-24, on two horses typing "N bb on the river, somebody wanted to
  // see my cards" 23 minutes apart at one table: "HORSES CAN NEVER EVER EVER BE
  // REPEATING THE SAME LINES ... THIS IS SCREAMING I AM A BOT". These four
  // events had ONE line per voice, so every horse of a voice said the same
  // sentence. Each cell is now a deep pool, and HorseTableTalk.chooseLine
  // never picks a phrase the table has heard (PHRASE_TABLE_WINDOW_MS).
  big_pot_won: {
    quiet: {
      lines: [
        'thats a {potBB} bb pot, ill take it',
        'big one, ty',
        'needed that pot',
        'decent pot',
        'ok that helps',
        'nice pot to drag',
        'finally a real pot',
        'that one mattered',
        '{potBB} bb, nice',
        'back in business',
        'good pot for me',
        'stack looks better now',
        'that pot was overdue',
        'big {street}',
        'i was due one of those',
        'ok, back in it',
        'ill stack these quietly',
        'that should hold me for a bit',
        'nobody wanted that one',
        'ill take it down',
        'folded to me, fine',
      ],
    },
    needler: {
      lines: [
        '{potBB} bb on the {street}, somebody wanted to see my cards',
        'thanks for the donation',
        'ty for paying me off',
        'you really wanted to see it huh',
        'expensive {street} for somebody',
        '{potBB} bb, appreciate the gift',
        'that was a lot to pay to look',
        'next time trust the bet',
        'pricey {street} for you',
        'love a big pot',
        'keep sending them my way',
        'my kind of pot',
        'told you i had it',
        'i always have it',
        'pay the man',
        'curiosity is expensive',
        'should have let that one go',
        'thanks, i was getting short',
        'thanks for folding',
        'smart fold',
        'nobody wanted to pay to see it',
        'scared money, thanks',
      ],
    },
    friendly: {
      lines: [
        'nice pot, {potBB} bb, gg',
        'whew, big one',
        'that was a fun hand',
        'big pot, gg all',
        'sorry, cards fell my way',
        'got lucky on that one',
        'what a hand, gg',
        'that was a sweat',
        'good hand all around',
        'cant believe that held',
        'ill take the big ones when they come',
        'nice battle, gg',
        'fun pot, thanks guys',
        'that one felt good',
        'tough spot for you there, gg',
        'heart was pounding on that {street}',
        'well that was exciting',
        'good game, that was a big one',
        'good fold, honestly',
        'glad that got through',
        'phew, nobody called',
      ],
    },
  },
  // Event B: the horse lost at showdown holding two pair or better.
  showdown_loss: {
    quiet: {
      lines: [
        '{hand} no good, fair enough',
        '{hand} wasnt enough',
        'thought {hand} was good',
        'beat again',
        'ok, {hand} loses',
        '{hand}, still second',
        'fair, you had it',
        'second best again',
        'had {hand}, not enough',
        'figured {hand} was good there',
        'cant fold {hand} there',
        'nothing i could do',
        'oh well, {hand}',
        'unlucky spot',
        'bad timing for {hand}',
        'ok, that one stings',
      ],
    },
    needler: {
      lines: [
        '{hand} and still second best, this table is brutal',
        '{hand} loses, sure',
        'of course {hand} isnt good',
        'who beats {hand} on that {street}',
        'cooler, whatever',
        'nice {street} for you',
        'you had to have it',
        'how is {hand} not good',
        '{hand} and i lose, perfect',
        'this table never lets {hand} win',
        'again with the {street}',
        'had {hand} and paid for it',
        'cant win with {hand} here',
        'thats just mean',
        'sick, {hand} no good',
        'brutal {street}, just brutal',
      ],
    },
    friendly: {
      lines: [
        'ran {hand} into a bigger one on the {street}, well played seat {seat}',
        'had {hand}, you got me',
        'nice hand seat {seat}, {hand} wasnt enough',
        'well played, {hand} was no good',
        'thought {hand} was good, nh',
        'gg seat {seat}, you had it',
        'tough cooler, nh',
        '{hand} gets beat, nice hand',
        'you had me the whole way huh',
        'good hand seat {seat}',
        'great {street} for you, gg',
        'cant fold {hand} there, nh',
        'my {hand} was second best, wp',
        'got outdrawn, it happens',
        'that one stings, gg',
        'you earned that one seat {seat}',
      ],
    },
  },
  // Event C: a winner showed a full house or better; the horse did not win.
  big_hand_shown: {
    quiet: {
      lines: [
        '{hand} shown, ok then',
        '{hand}, wow',
        'thats a monster',
        'ok, {hand}',
        'well that explains it',
        'cant beat {hand}',
        'saw that coming',
        '{hand} on the {street}, nice',
        'big hand',
        'yep, {hand}',
        'figured something like that',
        'no arguing with {hand}',
        'nice hand there',
        'glad i was out',
      ],
    },
    needler: {
      lines: [
        '{hand} on this board, of course',
        '{hand}, naturally',
        'where do people find {hand}',
        'sure, {hand} on the {street}',
        'every time, {hand}',
        '{hand} again at this table',
        'nobody ever has the small hand here',
        'of course seat {seat} had {hand}',
        'this deck is wild',
        'how convenient, {hand}',
        '{hand} on the {street}, unreal',
        'pretty sure the deck likes seat {seat}',
        'love seeing {hand} when im out',
        'somebody always has it here',
      ],
    },
    friendly: {
      lines: [
        '{hand}, nice hand seat {seat}',
        'wow, {hand}, gg',
        'huge hand seat {seat}',
        'thats a beauty, {hand}',
        'great hand, nh',
        '{hand} on the {street}, nicely done',
        'congrats on the {hand}',
        'nice one seat {seat}, {hand}',
        'what a hand',
        'good thing i was out of that one',
        'love to see a {hand}',
        'pretty hand, gg',
        'that is a monster, nice',
        'sweet {street} for you seat {seat}',
      ],
    },
  },
  // Event D: a player sat down; the horse has been seated ten hands or more.
  arrival: {
    quiet: {
      lines: [
        'gl',
        'hi',
        'hey',
        'welcome',
        'hello',
        'gl seat {seat}',
        'evening',
        'hey there',
        'yo',
        'welcome in',
        'hi all',
      ],
    },
    needler: {
      lines: [
        'fresh chips at seat {seat}, welcome',
        'another one, welcome',
        'welcome, hope you brought chips',
        'new blood, nice',
        'seat {seat}, you sure about this table',
        'welcome to the shark tank',
        'hope you like action',
        'bout time somebody sat there',
        'welcome, dont take it personal',
        'fresh stack, love it',
        'ah, company',
        'buckle up seat {seat}',
      ],
    },
    friendly: {
      lines: [
        'welcome to the table seat {seat}, good luck',
        'hey welcome',
        'hi seat {seat}, gl',
        'welcome, good table tonight',
        'hello and gl',
        'welcome aboard',
        'glad to have you, gl',
        'hey there, good luck',
        'welcome in seat {seat}',
        'gl and have fun',
        'nice to see a new face, gl',
        'welcome, enjoy',
      ],
    },
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
        'you play like that every hand?',
        'deck must love you',
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
      lines: [
        'ty',
        'thx',
        'gg',
        'finally',
        'nice',
        'about time',
        'ok then',
        'phew',
        'needed it',
        'one',
        'ok good',
        'small one',
        'ill take that',
        'that works',
        'little one, ty',
        'fine by me',
      ],
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
        'fold, good choice',
        'nobody wants to play with me',
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
        'good fold',
      ],
    },
  },
  // Event G: the horse is moving all in. Said as it shoves, and only sometimes.
  all_in: {
    quiet: {
      lines: [
        'gl',
        'here we go',
        'ok lets see',
        'all in',
        'gl both',
        'lets see it',
        'all of it',
        'you or me',
        'ok then',
      ],
    },
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
        'your call',
        'i dare you',
        'show me',
        'time to decide',
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
        'wish me luck',
        'here we go, gl',
        'lets have fun',
        'hope it holds',
      ],
    },
  },
  // Event H: the horse lost again, three showdowns or more in a row at this table.
  tilt: {
    quiet: {
      lines: [
        'again',
        'cant hit anything',
        'card dead for an hour',
        'this is getting old',
        'ok im tilted',
        'not again',
        'brutal',
        'need a break',
        'why me',
        'this is ridiculous',
      ],
    },
    needler: {
      lines: [
        'every hand, every single hand',
        'unreal, again',
        'you guys are on a heater',
        'third time now',
        'cant make this up',
        'ok this is getting silly',
        'rigged deck tonight',
        'somebody stop this',
        'i give up',
        'sure, again',
      ],
    },
    friendly: {
      lines: [
        'rough stretch for me',
        'cant catch a break tonight',
        'one of those nights',
        'deck is cold over here',
        'ill turn it around',
        'gg again, wow',
        'nice hands everyone, ugh',
        'my luck has to change',
        'tough night for me',
        'gg, you guys are good',
      ],
    },
  },
  // Event I: the horse won again, three pots or more in a row at this table.
  heater: {
    quiet: {
      lines: [
        'running good',
        'ill take it again',
        'cards coming',
        'nice run',
        'again',
        'cant complain',
        'rolling now',
        'good stretch',
      ],
    },
    needler: {
      lines: [
        'cant stop wont stop',
        'whos next',
        'on a heater',
        'keep em coming',
        'too hot right now',
        'dont stop now',
        'who wants some',
        'im not leaving',
        'pay up again',
      ],
    },
    friendly: {
      lines: [
        'running lucky tonight',
        'sorry guys, cards are hitting',
        'cant miss right now',
        'thanks again all',
        'ill cool off eventually',
        'sorry, i cant miss',
        'what a run',
        'enjoying this one',
        'thanks for the chips again',
      ],
    },
  },
};

/**
 * Lines that are only true after a showdown (somebody called and saw cards),
 * or only true when everybody folded. A pot can be won either way, so
 * big_pot_won and pot_won carry `showdown` in their facts and
 * HorseTableTalk.chooseLine passes over a line whose need the hand did not
 * meet. Dan 2026-10-24: "somebody wanted to see my cards" typed after a hand
 * nobody called is a line nobody human would type.
 *
 * Keyed by the exact template. theHorseSaysNothingItWasNotTold.law.test.ts
 * holds every key to a line that exists in the pool.
 */
export type LineNeed = 'showdown' | 'no_showdown';

export const LINE_NEEDS: Readonly<Record<string, LineNeed>> = {
  // big_pot_won
  '{potBB} bb on the {street}, somebody wanted to see my cards': 'showdown',
  'ty for paying me off': 'showdown',
  'you really wanted to see it huh': 'showdown',
  'that was a lot to pay to look': 'showdown',
  'next time trust the bet': 'showdown',
  'curiosity is expensive': 'showdown',
  'should have let that one go': 'showdown',
  'told you i had it': 'showdown',
  'i always have it': 'showdown',
  'cant believe that held': 'showdown',
  'that was a sweat': 'showdown',
  'tough spot for you there, gg': 'showdown',
  'heart was pounding on that {street}': 'showdown',
  'nobody wanted that one': 'no_showdown',
  'ill take it down': 'no_showdown',
  'folded to me, fine': 'no_showdown',
  'thanks for folding': 'no_showdown',
  'smart fold': 'no_showdown',
  'nobody wanted to pay to see it': 'no_showdown',
  'scared money, thanks': 'no_showdown',
  'good fold, honestly': 'no_showdown',
  'glad that got through': 'no_showdown',
  'phew, nobody called': 'no_showdown',
  // pot_won
  'keep calling': 'showdown',
  'knew you had nothing': 'showdown',
  'that was close': 'showdown',
  'whew, got there': 'showdown',
  'good hand though': 'showdown',
  'fold, good choice': 'no_showdown',
  'nobody wants to play with me': 'no_showdown',
  'good fold': 'no_showdown',
};
