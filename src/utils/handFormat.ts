/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND FORMATTING — one behaviour per figure, across every hand surface
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The jackpot popup, the winners list, the jackpot rundown and the table's
 * Previous Hand between them carried THREE copies of `stamp`, THREE of
 * `gameTypeLabel` and FOUR of `money` — and I wrote two of the `gameTypeLabel`
 * copies myself on 2026-08-27 while fixing the surface these all belong to.
 *
 * That is not a tidiness complaint. These render chip amounts and timestamps
 * side by side on screens a player compares:
 *
 *   - `HandDetailModal.fmt` was NOT NaN-safe while every other copy was, so one
 *     tab could print the string "NaN" where its neighbour printed 0.00;
 *   - one `stamp` guarded a null argument and the other two did not;
 *   - `gameTypeLabel` mapped `short_deck` in two copies and printed the raw
 *     column key in the third.
 *
 * Every divergence above was a real difference in what a player saw for the
 * same value. One module, one behaviour, no per-surface drift.
 */

/**
 * Chips, always with two decimals and always finite.
 *
 * `Number(n || 0)` handles null, undefined and NaN in one step — `NaN || 0` is
 * 0 — which is why the copies that used it never printed "NaN" and the one
 * that reached for `Math.abs(n) >= 1` first did.
 */
export function money(n: number | null | undefined, dp = 2): string {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/**
 * Stakes print as typed: 0.05/0.1, never 0.05/0.10.
 *
 * A blind is a level, not a balance — padding it to two decimals makes 1/2 read
 * as 1.00/2.00, which is not how anybody names a game.
 */
export function blindLabel(n: number | null | undefined): string {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Absolute timestamp, the way a hand record states one. Null-safe. */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Game types print the way the lobby names them.
 *
 * The stored value is a column key (`short_deck`, `plo5`), and a surface that
 * prints it raw shows the player SHORT_DECK, underscore and all. Returns null
 * for an empty variant so a caller can omit the chip entirely rather than
 * render an empty one.
 */
export function gameTypeLabel(variant: string | null | undefined): string | null {
  const v = String(variant || '')
    .toLowerCase()
    .trim();
  if (!v) return null;
  if (v === 'nlh') return 'NLH';
  if (v === 'flh') return 'FLH';
  if (v === 'short_deck' || v === 'shortdeck' || v === 'sixplus') return 'Short Deck';
  /* PHASE 4 2026-09-01 - THE FELT WAS NAMING THE WRONG GAME.
  
     The `pineapple` variant key has always run CRAZY Pineapple: three cards,
     and the discard comes AFTER the flop. In plain Pineapple you throw a card
     BEFORE it, which is a different game with a different strategy - and the
     one the table was announcing to anybody who knows the difference.
  
     The variant KEY stays `pineapple`. It is written into millions of
     hand_history rows, ~120 live table rows, every horse profile and every
     lobby filter, and renaming a key to fix a label is how a rename becomes
     an outage. Only what a player READS changes. */
  /* 2026-09-22 - NOTHING HERE IS OFC (owner decision: Open-Face Chinese is
     excluded, and Crazy Pineapple is never described as OFC).

     Every table that ever carried `ofc_pineapple` was a Crazy Pineapple table
     wearing the wrong label (20260823_retire_ofc_pineapple_variant.sql), and
     hand_history was deliberately not rewritten, so a legacy row reads as the
     game it was. A bare `ofc` was never stored by any row and names a game this
     platform does not run: it takes the label the platform already uses when
     it cannot name a variant ('Poker', which SearchPage prints for a missing
     variant and the jackpot feed defaults to), because the words path below
     would hand the retired name back as "Ofc". */
  if (v === 'pineapple' || v === 'ofc_pineapple') return 'Crazy Pineapple';
  if (v === 'ofc') return 'Poker';
  if (/^(plo|flo)\d*8?$/.test(v)) return v.toUpperCase();
  // Anything unrecognised prints as words rather than as a column key.
  return v.replace(/_/g, ' ').replace(/\b([a-z])/g, (c) => c.toUpperCase());
}
