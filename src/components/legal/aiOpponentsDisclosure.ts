/**
 * The AI-opponent disclosure (Dan, 2026-10-25).
 *
 * Horses play under ordinary player names and the table never says which
 * seats they hold (CLAUDE.md 10.5). Players are told once, up front, that AI
 * opponents may be seated: on the sign-up form, in the Terms of Service page
 * and in the acceptance modal every player passes before Club Arena opens.
 *
 * One sentence, one place. tests/ai-opponents-are-disclosed.law.test.tsx
 * fails if any of the three surfaces stops showing it.
 */
export const AI_OPPONENTS_DISCLOSURE =
  'Tables May Include AI Opponents Run By Smarter.Poker. They Play Under Ordinary Player Names, And We Do Not Say Which Seats They Hold.';
