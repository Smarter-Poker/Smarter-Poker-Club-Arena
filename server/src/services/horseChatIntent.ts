/**
 * WHAT A PLAYER JUST SAID TO THE TABLE (2026-10-24)
 *
 * Dan, after two horses repeated a line: "HORSES CAN NEVER EVER EVER BE
 * REPEATING THE SAME LINES ... THIS IS SCREAMING I AM A BOT". The other half
 * of that tell is silence: the production chat held "Nice Hand", "Unlucky",
 * "FAT FINGERED THAT SMH", "YOU GUYS PLAY HERE EVERY NIGHT?! LOL" and
 * "Hey Ingrid", and no horse ever answered any of them.
 *
 * classifyChat reads one human line and names what kind of remark it is, or
 * null when it is not something a horse should answer. Pure: no I/O, no
 * randomness, the same text always gives the same answer.
 *
 * WHAT IS NEVER ANSWERED. A line that asks or claims whether anyone is real,
 * a person, a bot, automated or AI, or that accuses the game of being rigged
 * or of cheating, gets no horse reply of any kind. A horse does not claim to
 * be a person and does not argue about the game's integrity. That check runs
 * first and wins over every other intent in the same line.
 *
 * Who the reply comes from is decided by HorseTableTalk.replyToPlayer; this
 * file only reads the words. A horse's name in the line (an address, "Hey
 * Ingrid") is found there too, against the seated horses' usernames.
 */

import type { ReplyEvent } from './horseTableTalkLines.js';

/** Words that end the conversation: no horse answers a line that holds one. */
const NEVER_ANSWER =
  /\b(bots?|robots?|ai|real|human|humans|person|people\s+here|computers?|automated|scripts?|scripted|fake|npcs?|rigged|rig|cheat(s|ing|ers?)?|collud(e|ing)|collusion|scam|scamming)\b/;

/** Chat shorthand, folded so "nh" and "nice hand" read alike. */
const FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnh\b/g, 'nice hand'],
  [/\bwp\b/g, 'well played'],
  [/\bgl\b/g, 'good luck'],
  [/\bty\b/g, 'thank you'],
  [/\bthx\b/g, 'thanks'],
  [/\bu\b/g, 'you'],
  [/\bur\b/g, 'your'],
  [/\bsry\b/g, 'sorry'],
];

/** Lowercase words only, apostrophes dropped, shorthand spelled out. */
export function chatWords(message: string): string {
  let out = message
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, to] of FOLD) out = out.replace(re, to);
  return out;
}

/** In order: the first that matches is the intent. */
const INTENTS: ReadonlyArray<readonly [ReplyEvent, RegExp]> = [
  // "you guys play here every night?"
  [
    'reply_regular',
    /\b(every (night|day)|play here (a lot|often|every)|always (here|on|playing)|you guys play|regulars?|how often (do )?you play)\b/,
  ],
  // "you got lucky", "lucky you": a jab at somebody else, before "got lucky" below
  ['reply_ribbed', /\b(you got lucky|lucky you|so lucky|luckiest)\b/],
  // "unlucky", "bad beat": sympathy, before "sorry" reads as an apology
  ['reply_sympathy', /\b(unlucky|bad beat|tough beat|brutal|ouch|rough one|cooler|tough one)\b/],
  // "got lucky", "my bad", "misclick": the speaker owning it
  [
    'reply_humble',
    /\b(i got lucky|got lucky|my bad|my fault|sorry|misclick(ed)?|mis click|fat finger(ed|s)?|oops|whoops|didnt mean)\b/,
  ],
  [
    'reply_ribbed',
    /\b(lucky|luck ?box|luck ?sack|donk(ey)?|suck ?out|sucked out|runner runner|nice catch|nice river|how (did|do|could) you call|what was that call)\b/,
  ],
  [
    'reply_thanks',
    /\b(nice hand|good hand|well played|nice bet|value bet|balue bet|nice call|good call|nice play|good play|nice one|nice pot|great hand|gg|sick hand|nice read|good read)\b/,
  ],
  [
    'reply_hello',
    /\b(hi|hey|hello|hiya|sup|yo|howdy|evening|good evening|good luck|just got on|just sat( down)?|whats up|wassup|hey all|hi all)\b/,
  ],
];

/**
 * The kind of remark, or null for a line no horse should answer: a question
 * about who is real (see the header), anything the patterns do not recognise,
 * and an empty or overlong line (pasted text is not a remark to the table).
 */
export function classifyChat(message: string): ReplyEvent | null {
  if (typeof message !== 'string') return null;
  const words = chatWords(message);
  if (words.length === 0 || words.length > 200) return null;
  if (NEVER_ANSWER.test(words)) return null;
  for (const [intent, re] of INTENTS) if (re.test(words)) return intent;
  return null;
}

/**
 * The seated horse a line names, if it names exactly one ("Hey Ingrid",
 * "nh trey"). Whole words, case-insensitive; a name shorter than three
 * letters is too likely to be an ordinary word to count as an address.
 */
export function addressedHorse(
  message: string,
  horses: ReadonlyArray<{ userId: string; username: string | null }>
): string | null {
  const words = new Set(
    message
      .toLowerCase()
      .split(/[^a-z0-9_.]+/)
      .map((w) => w.replace(/^[._]+|[._]+$/g, ''))
      .filter(Boolean)
  );
  const named = horses.filter((h) => {
    const name = (h.username ?? '').toLowerCase();
    return name.length >= 3 && words.has(name);
  });
  return named.length === 1 ? named[0].userId : null;
}
