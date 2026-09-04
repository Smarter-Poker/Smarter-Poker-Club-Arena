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
