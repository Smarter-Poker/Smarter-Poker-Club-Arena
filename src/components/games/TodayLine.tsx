/**
 * WHAT THE DAY HAS COST, AND HOW MUCH OF IT IS LEFT (Phase 4, 2026-09-11)
 *
 * Every host sets a per-player daily ceiling, 200 on both live hosts, and at
 * 100 diamonds a spin that is 20,000 diamonds a day per player per host. The
 * wheel printed the COUNT against its ceiling in a bay. Plinko and Crash
 * printed nothing and simply refused at the wall. None of the three ever showed
 * a player what they had actually spent.
 *
 * One line, one component, three pages, so the games cannot tell a player
 * three different things about the same day. It is deliberately quiet at the
 * start of a session and gets louder as the ceiling comes up: muted, then gold
 * at four fifths of the way, then red at the wall, where it also says so in
 * words rather than leaving a plate mysteriously dead.
 */
import { compactChips } from '../../utils/format';

export default function TodayLine({
  used,
  cap,
  spentDiamonds,
  noun,
  showCount = true,
}: {
  /** Spins or rounds taken today at this host. */
  used: number;
  /** The host's per-player daily ceiling. 0 means it did not set one. */
  cap: number;
  /** Diamonds put through all three games at this host today. */
  spentDiamonds: number;
  noun: 'Spins' | 'Rounds';
  /**
   * The wheel already prints the count against its ceiling in a painted bay,
   * and saying it twice on one screen is noise. It passes false and this line
   * carries only what the bay cannot: what the day has cost.
   */
  showCount?: boolean;
}) {
  const capped = cap > 0;
  const atWall = capped && used >= cap;
  const near = capped && !atWall && used >= cap * 0.8;
  const ink = atWall ? 'red' : near ? 'gold' : 'muted';
  const count = showCount
    ? capped
      ? `Today: ${compactChips(used)} Of ${compactChips(cap)} ${noun}`
      : `Today: ${compactChips(used)} ${noun}`
    : '';
  const spent = spentDiamonds > 0 ? `${compactChips(spentDiamonds)} Diamonds Spent Today` : '';
  const wall = atWall ? "That Is Today's Limit Here" : '';
  const parts = [count, spent, wall].filter(Boolean);
  // Nothing to say is said by saying nothing, not by an empty line.
  if (parts.length === 0) return null;
  return <p className={`sc-copy sc-copy--center sc-ink--${ink}`}>{parts.join(' \u00B7 ')}</p>;
}
