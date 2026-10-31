/**
 * Hand-row formatting shared by the Analysis tab and the page. Moved verbatim
 * out of PlayerStatsPage.tsx (Stats Page Programme phase 2).
 */
// hand_history stores board cards as "8hearts" / "Aspades". Render them as
// rank + suit symbol rather than dumping the raw token at the player.
const SUIT_SYMBOLS: Record<string, string> = {
  hearts: '\u2665',
  diamonds: '\u2666',
  clubs: '\u2663',
  spades: '\u2660',
};

/** A short date, or a dash. `new Date('')` renders "Invalid Date" at the user. */
export function handDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '-';
}

export function formatCard(card: string): string {
  const m = /^([0-9TJQKA]{1,2})(hearts|diamonds|clubs|spades)$/i.exec(card.trim());
  if (!m) return card;
  return `${m[1].toUpperCase()}${SUIT_SYMBOLS[m[2].toLowerCase()] ?? ''}`;
}

/**
 * SILENT ZEROS ARE NOT MEASUREMENTS (Stats contract truth, 2026-09-20).
 *
 * Every rate on this page arrives from `ca_player_stats_overview_v2` as a
 * plain number, and the SQL writes 0 whenever the denominator was empty:
 * `CASE WHEN cash_hands > 0 THEN round(cash_bb_profit / cash_hands * 100, 2)
 * ELSE 0 END` and its siblings for ITM %, ROI and the showdown split. `num()`
 * in ./types then coerces a null to 0 as well. Both are correct defences
 * against a crash, and both produce the same lie on screen: a player who has
 * never played a cash hand is told their win rate is "0.00" BB/100, and a
 * player who has never reached a showdown is told they win "0.0%" of them.
 * A zero is a result. Never having been measured is not, and the difference
 * is the whole point of a stats page.
 *
 * `value` is the ratio the RPC already computed; `sample` is the denominator
 * it was divided by (cash hands, showdowns, entries, buy-ins). When the sample
 * is empty the formatter is never reached and the row says so in words.
 *
 * NOT a dash and not a blank cell: an empty row reads as a rendering fault,
 * and a glyph is banned copy (CLAUDE.md section 5.7). It is a sentence, in
 * Title Case, that a player can read.
 */
export const NOT_YET_MEASURED = 'Not Yet Measured';

export function ratioOrUnmeasured(
  value: number,
  sample: number,
  format: (value: number) => string
): string {
  if (!Number.isFinite(sample) || sample <= 0) return NOT_YET_MEASURED;
  if (!Number.isFinite(value)) return NOT_YET_MEASURED;
  return format(value);
}

/** Cash panels render only the cash population selected by the separated RPC. */
export const SCOPE_CASH = 'Cash';
/** Compatibility for external tab consumers; new code names the cash scope directly. */
export const SCOPE_ALL_GAMES = SCOPE_CASH;
