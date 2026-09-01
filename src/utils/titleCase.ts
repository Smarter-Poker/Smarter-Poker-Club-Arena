/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  titleCase — house capitalisation for user-facing text
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: "Capitalize the first letter of every word inside the entire
 * club arena, and forbid the use of em bars anywhere."
 *
 * WHAT "EM BARS" MEANS, BECAUSE IT HAS ALREADY BEEN MISREAD TWICE
 *
 * Dan's phrase "em bars" means EM DASHES: the punctuation mark, U+2014.
 * This is a rule about COPY -- the characters inside text a player reads.
 * It is NOT a rule about artwork, icons, or anything shaped like a line,
 * and it does NOT ban the hamburger menu.
 *
 * Read the other way it has now cost the hamburger menu twice in two days:
 * #2321 replaced it with a gear on every trigger, deleted the approved
 * rasters, and added a law forbidding its return; #2429 did it again with a
 * six-tile grid after #2401 reverted the first one. Each time Dan opened the
 * app and found a different icon where his menu button used to be.
 *
 * If you are about to ban "bars" anywhere near an ICON, you have misread this
 * sentence. The hamburger is the menu. See
 * tests/hamburger-never-regresses.law.test.ts.
 *
 * TWO RULES, ONE HELPER
 *
 *   1. Every word starts with a capital.       "hands played" -> "Hands Played"
 *   2. No em dashes anywhere in UI copy.       "3rd — of 128"  -> "3rd - Of 128"
 *
 * WHY A FUNCTION RATHER THAN `text-transform: capitalize`
 *
 * CSS capitalize is a lie on this product's vocabulary. It uppercases the first
 * letter of every word and touches nothing else, so "nlh" becomes "Nlh" and
 * "plo4" becomes "Plo4" — the exact defect formatGameTitle exists to fix. It
 * also cannot be read back: a screen reader, an aria-label and a copied string
 * all still carry the original casing, so the visible text and the accessible
 * text disagree. Doing it in JS means one answer everywhere.
 *
 * ACRONYMS SURVIVE. The variant tokens (NLH, PLO4, SNG, MTT, PKO...) and the
 * product's own initialisms (BBJ, VIP, ID, XMTT) are shouted, not Title Cased,
 * because that is what they are.
 *
 * ON EM DASHES: the character is stripped from OUTPUT here, and
 * scripts/ci/check-ui-text.mjs blocks new ones from entering JSX text and UI
 * string literals in the first place. Source COMMENTS are exempt — this file
 * and its neighbours are full of them, they never reach a player, and a
 * repo-wide comment rewrite is a large diff with no user-visible effect.
 */

/** Initialisms that must stay fully uppercase. Superset of formatGameTitle's. */
const ACRONYMS = new Set([
  // Game variants
  'nlh',
  'nlhe',
  'plo',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flh',
  'flo',
  'nl',
  'pl',
  'fl',
  // Formats
  'sng',
  'mtt',
  'xmtt',
  'pko',
  'ko',
  'gtd',
  'hu',
  'wsop',
  // Product
  'bbj',
  'vip',
  'id',
  'ok',
  'pnl',
  'rtp',
  'eco',
  'utg',
  'sb',
  'bb',
  'ante',
]);

/**
 * Replace em and en dashes with plain punctuation.
 *
 * An em dash between clauses becomes a hyphen with its spacing kept, so
 * "Held In Trust - 400 To Clubs" still reads as an aside. A NUMERIC en dash
 * ("1-9", a range) becomes a bare hyphen with no spaces.
 */
/**
 * NOTE THE ESCAPES. These patterns are written — / – rather than as
 * literal characters on purpose: scripts/ci/check-ui-text.mjs --fix rewrites
 * every non-comment dash in src/ to a hyphen, and on its first run it happily
 * rewrote THIS function's own character class into `[--]` — a valid but
 * meaningless range that silently stopped matching anything. The one file
 * allowed to talk about the character must not contain it.
 */
const EM_DASH_RUN = /\s*[—–]\s*/g;
const OTHER_DASHES = /[‒―−]/g;

export function stripEmDashes(input: string): string {
  return String(input ?? '')
    .replace(EM_DASH_RUN, (m) => (/^\S/.test(m) && /\S$/.test(m) ? '-' : ' - '))
    .replace(OTHER_DASHES, '-');
}

/**
 * Title Case a user-facing string.
 *
 * Preserves any word that is ALREADY all-caps (so "BBJ" and a deliberately
 * shouted "LIVE" survive), uppercases known acronyms, and capitalises every
 * prose word. Hyphenated and slashed compounds are cased on both sides:
 * "add-ons" -> "Add-Ons". Machine-readable examples remain unchanged.
 */
export function titleCase(input: string | null | undefined): string {
  if (!input) return '';
  const cleaned = stripEmDashes(String(input));
  const trimmed = cleaned.trim();

  if (
    /^\S+:\/\/\S+$/.test(trimmed) ||
    /^\S+@\S+\.\S+$/.test(trimmed) ||
    /^\/\S+$/.test(trimmed) ||
    /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(trimmed)
  ) {
    return cleaned;
  }

  // Split on whitespace but KEEP it, so the original spacing survives verbatim.
  const parts = cleaned.split(/(\s+)/);

  return parts
    .map((part) => {
      if (/^\s+$/.test(part) || part === '') return part;

      /* Case each side of a hyphen/slash compound independently.
         The leading character class INCLUDES digits on purpose. Matching only
         on [A-Za-z] made the match start at the 'r' of "3rd", which then got
         capitalised to "3Rd" — and ordinals are the tournament card's entire
         hero line ("3rd Of 128"). A token that begins with a digit is an
         ordinal, a stake or a seat count ("6max", "2x"); its letters are a
         suffix and are never title-cased. */
      return part.replace(/[A-Za-z0-9][A-Za-z0-9'’]*/g, (word, offset, whole) => {
        if (/^[0-9]/.test(word)) return word;
        const lower = word.toLowerCase();
        if (whole[offset - 1] === '(' && (lower === 's' || lower === 'es')) return lower;
        if (ACRONYMS.has(lower)) return lower.toUpperCase();
        // Already shouting (LIVE, GTD, a name in caps) - leave it alone.
        if (word.length > 1 && word === word.toUpperCase()) return word;
        return word.charAt(0).toUpperCase() + word.slice(1);
      });
    })
    .join('');
}

/**
 * Alias. The Players tab and the three pages behind it (Member Management,
 * Player Statistics, Promo Vault) were written against `toTitleCase`, which is
 * the name the same transform carries inside utils/popupStyle.ts. Exporting it
 * here rather than renaming call sites keeps one implementation -- the
 * acronym-aware one above, which is the reason NLH does not render as "Nlh".
 */
export const toTitleCase = titleCase;

/**
 * Postgres hands roles and statuses over as snake_case enums: 'super_agent',
 * 'sub_agent', 'vip_card'. An underscore is not a word boundary a reader sees,
 * so it becomes a space before the casing runs: 'super_agent' -> 'Super Agent'.
 *
 * Acronyms still survive the trip, which is the whole point of routing through
 * titleCase rather than doing this inline: 'mtt_fee' -> 'MTT Fee'.
 */
export function enumToTitleCase(value: string | null | undefined): string {
  if (!value) return '';
  return titleCase(String(value).replace(/_/g, ' '));
}

export default titleCase;
