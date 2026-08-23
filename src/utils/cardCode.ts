/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD CODE — one canonical short form, from every shape the store holds
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23, with a screenshot of the Hand Detail panel: the flop, turn
 * and river all read `UNDEFINE` in red beside a diamond.
 *
 * `UNDEFINE` is the literal JavaScript string "undefined" with its last
 * character sliced off for the rank, and the "d" it sliced read as diamonds.
 * The adapter did:
 *
 *     const cardStr = (c: { rank: string; suit: string }) =>
 *       `${c.rank}${(c.suit || '').charAt(0).toLowerCase()}`;
 *
 * ...over `community_cards`, which is not an array of objects. Production
 * stores it as an array of STRINGS, and not short ones:
 *
 *     ["Jdiamonds", "6diamonds", "4clubs", "Ahearts", "3spades"]
 *
 * So `c.rank` was undefined on every card of every hand. Worse, the obvious
 * one-line "fix" — treat it as a string and take the last character — is also
 * wrong: `"Jdiamonds".slice(-1)` is "s", which renders the jack of diamonds as
 * a spade. A hand history that shows the wrong suit is worse than one that
 * shows nothing, because nothing looks broken.
 *
 * Meanwhile the SAME hand's `hole_cards` column really is objects, with the
 * full suit word: `{ rank: 'A', suit: 'spades' }`. Two shapes, one renderer.
 *
 * This is the single place that knows about all of them. Everything returns
 * the canonical short code the table already uses everywhere else — rank plus
 * one lowercase suit letter, e.g. `Jd`, `Th`, `4c` — or '' when the input
 * genuinely is not a card, so callers can drop it rather than print a word.
 */

/** s | h | d | c, from a letter, a full word, or a glyph. */
const SUIT_LETTER: Record<string, string> = {
  s: 's',
  h: 'h',
  d: 'd',
  c: 'c',
  spade: 's',
  spades: 's',
  heart: 'h',
  hearts: 'h',
  diamond: 'd',
  diamonds: 'd',
  club: 'c',
  clubs: 'c',
  '♠': 's',
  '♥': 'h',
  '♦': 'd',
  '♣': 'c',
};

/** A, K, Q, J, T, 9..2. Ten is normalised to T so the code is always 2 chars. */
const RANKS = new Set(['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']);

function normaliseRank(raw: string): string {
  const r = raw.trim().toUpperCase();
  if (r === '10') return 'T';
  return RANKS.has(r) ? r : '';
}

function normaliseSuit(raw: string): string {
  return SUIT_LETTER[raw.trim().toLowerCase()] ?? '';
}

/**
 * @returns canonical `<rank><suit>` (e.g. "Jd"), or '' if the input is not a card.
 */
export function toCardCode(input: unknown): string {
  if (input == null) return '';

  // Object form: { rank, suit } — the hole_cards column, and the engine's Card.
  if (typeof input === 'object') {
    const c = input as { rank?: unknown; suit?: unknown };
    const rank = normaliseRank(String(c.rank ?? ''));
    const suit = normaliseSuit(String(c.suit ?? ''));
    return rank && suit ? `${rank}${suit}` : '';
  }

  if (typeof input !== 'string') return '';
  const s = input.trim();
  if (!s) return '';

  // The literal string "undefined"/"null" reached the renderer for months.
  // Refuse it explicitly rather than letting it parse as a 9-letter rank.
  const lower = s.toLowerCase();
  if (lower === 'undefined' || lower === 'null') return '';

  // Longest suit spelling first, so "Jdiamonds" cannot match "d" and leave
  // "iamonds" behind, and "10hearts" is read before "10h".
  const suitNames = Object.keys(SUIT_LETTER).sort((a, b) => b.length - a.length);
  for (const name of suitNames) {
    if (lower.endsWith(name)) {
      const rank = normaliseRank(s.slice(0, s.length - name.length));
      const suit = SUIT_LETTER[name];
      if (rank && suit) return `${rank}${suit}`;
    }
  }

  return '';
}

/** Map a list of anything-shaped cards, dropping the ones that will not parse. */
export function toCardCodes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map(toCardCode).filter(Boolean);
}
