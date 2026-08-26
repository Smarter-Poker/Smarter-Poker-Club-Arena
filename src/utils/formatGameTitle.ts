/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  formatGameTitle — game variants are acronyms, so print them as acronyms
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: "these icon pop ups need to have the game title (nlh) all
 * caps like NLH."
 *
 * Table names reach the UI from three different producers and only one of them
 * agrees on casing:
 *   - `tables.name` written at creation, e.g. "NLH 2.00/5.00"  (correct)
 *   - names assembled from `tables.game_variant`, which is a lowercase enum
 *     ('nlh', 'plo4', 'plo6'), giving "nlh 0.1/0.2"             (wrong)
 *   - whatever a club owner typed into the create-table form   (anything)
 *
 * Fixing one producer would leave the other two, and a club owner can always
 * type "nlh" by hand. So this normalises at the point of DISPLAY: any token
 * that is a known game variant is uppercased, and everything else is left
 * exactly as written. "Coffee Break Freeroll (plo4) - Table 1" keeps its
 * capitalisation and gets PLO4; a stakes pair like 0.1/0.2 is untouched.
 */

/**
 * Variant acronyms. Order does not matter — each token is matched whole, so
 * 'plo' cannot eat the '4' off 'plo4'.
 *
 * Deliberately acronyms only. 'Pineapple' is a word, not an initialism, so it
 * is left to whatever casing it arrived with rather than being shouted.
 */
const VARIANT_TOKENS = new Set([
  'nlh',
  'nlhe',
  'plo',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flh',
  'flo8',

  'flo',
  'sng',
  'mtt',
  'pko',
]);

/* AUDIT 2026-08-20 — the two-letter variants are deliberately NOT in that set.
   'nl', 'pl', 'fl' and 'hu' are real poker abbreviations, but they are also
   ordinary words and name fragments, and this function runs over every table
   and club name a human can type. A home game called "Fl Keys Friday" or a
   host named Hu would have been shouted at. The four-plus letter acronyms
   above carry no such ambiguity, and a table named "NL Hold'em" already
   arrives capitalised from whoever typed it. */

/**
 * Uppercase every game-variant token in a display string.
 *
 * Splits on word boundaries rather than spaces so variants inside brackets,
 * after slashes or joined by hyphens ("6-Max NLH", "(plo4)", "nlh/plo") are all
 * caught. Non-variant text is returned byte-identical.
 */
export function formatGameTitle(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/[a-z0-9+]+/gi, (token) => {
      const lower = token.toLowerCase();
      if (VARIANT_TOKENS.has(lower)) return lower.toUpperCase();
      // '6+' arrives as '6' plus a separate '+' under this regex; the short-deck
      // marker is already digit-only so there is nothing to case.
      return token;
    })
    .replace(/\b(\d+)\.(\d{2})\b/g, (match, p1, p2) => {
      if (p2 === '00') {
        return p1;
      }
      if (p1 === '0') {
        return '.' + p2;
      }
      return match;
    });
}

export default formatGameTitle;
