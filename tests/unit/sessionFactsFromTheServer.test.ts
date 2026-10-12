/**
 * Dan 2026-10-12: "THE END OF SESSION RECAP WAS NOT ACCURATE, I 100% LOST, AND
 * ITS SAYING I WON. SMH BUY IN IS OFF, AMOUNT OF HANDS PLAYED, EVERYTHING IS
 * 100% WRONG." Bought in 4,000 Diamonds, left with 1,376 after 20 hands and
 * 33 minutes; the card said +400, buy-in 976, 5 hands, 3 minutes, because a
 * reload restarted every counter and the buy-in read could not see a Diamond
 * seat.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeSessionFacts, sessionBuyInTotal } from '../../src/utils/sessionBuyInTotal';

const ROOT = join(__dirname, '..', '..');
const MIGRATION = readFileSync(
  join(
    ROOT,
    'supabase/migrations/20261012062409_the_session_recap_reads_the_whole_session_from_the_server.sql'
  ),
  'utf8'
);

describe('the Session Complete card reads the whole session', () => {
  it("Dan's session: the server's figures replace the counts that restarted at the reload", () => {
    const reloadAt = Date.parse('2026-10-12T06:17:00Z');
    const atAsk = { startMs: reloadAt, handsPlayed: 0, handsWon: 0, peakStack: 976 };
    const merged = mergeSessionFacts({
      serverFacts: {
        started_at: '2026-10-12T05:47:04.687Z',
        hands_played: 15,
        hands_won: 9,
        peak_stack: 4099,
      },
      atAsk,
      now: { startMs: reloadAt, handsPlayed: 2, handsWon: 1, peakStack: 1046 },
    });
    expect(merged.startMs).toBe(Date.parse('2026-10-12T05:47:04.687Z'));
    expect(merged.handsPlayed).toBe(17);
    expect(merged.handsWon).toBe(10);
    expect(merged.peakStack).toBe(4099);
    // And the buy-in: the server's 4,000, not the 976 on the felt at the reload.
    expect(sessionBuyInTotal({ serverBaseline: '4000', totalAtAsk: 976, totalNow: 976 })).toBe(4000);
  });

  it('an unreadable answer leaves the page figures alone', () => {
    const now = { startMs: 5, handsPlayed: 3, handsWon: 1, peakStack: 100 };
    for (const bad of [null, undefined, 'x', 7]) {
      expect(mergeSessionFacts({ serverFacts: bad, atAsk: now, now })).toEqual(now);
    }
    expect(
      mergeSessionFacts({
        serverFacts: { started_at: 'nope', hands_played: -1, hands_won: 'x', peak_stack: 0 },
        atAsk: now,
        now,
      })
    ).toEqual(now);
  });

  it('the table page asks for the facts on the same once-per-table ask', () => {
    const src = readFileSync(join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');
    expect(src).toContain("supabase.rpc('fn_my_table_session_facts', { p_table_id: askedFor })");
    expect(src).toContain('handsPlayedRef.current = merged.handsPlayed;');
  });

  it('the buy-in read answers for a Diamond seat, and both reads are bound to the caller', () => {
    expect(MIGRATION).toContain("JOIN public.poker_diamond_movements m ON m.custody_id = c.id AND m.action = 'reserve'");
    expect(MIGRATION).toContain("AND c2.purpose = 'cash_seat'");
    expect(MIGRATION.match(/auth\.uid\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.fn_my_table_session_facts(uuid) FROM PUBLIC, anon;'
    );
    expect(MIGRATION).not.toMatch(/^GRANT[^;]*\banon\b/im);
  });
});
