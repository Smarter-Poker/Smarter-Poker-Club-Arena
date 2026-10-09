/**
 * LAW: THE MONEY CHECKS READ THE DIAMOND BOOK (2026-10-09).
 *
 * A platform Diamond tournament writes no wallet_transactions, chip_ledger or
 * rake_records row: every entry, overlay, prize, bounty, seat and fee is a leg
 * of poker_diamond_tournament_ledger. Five checks read only the chip book, so
 * fully paid Diamond events read as unfunded, unpaid or uncollected: 7
 * conservation warnings, 97 earner_not_paid criticals, 26 underpaid events and
 * 546 uncollected entries in one pass, every one of them paid to the last
 * Diamond. The two migrations below teach each check the Diamond legs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const BOOK = read(
  'supabase/migrations/20261009151510_a_diamond_tournament_is_conserved_by_its_own.sql'
);
const PLACE = read(
  'supabase/migrations/20261009151711_a_diamond_place_and_entry_are_read_from_the.sql'
);

const isDiamond = "c.id = t.club_id AND c.asset = 'diamonds'\n";

describe('the money checks read the Diamond book', () => {
  for (const [name, sql] of [
    ['conservation', BOOK],
    ['place and entry', PLACE],
  ] as const) {
    it(`${name}: one transaction, a live proof, a pinned preimage and a proof block`, () => {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
      expect(sql).toMatch(/^-- @live-proof: /m);
      expect(sql).toMatch(/_PREIMAGE_CHANGED/);
      expect(sql).toMatch(/DO \$prove\$/);
      expect(sql).toMatch(/v_n <> 1 THEN\s*RAISE EXCEPTION '[A-Z_]+_ANCHOR_CHANGED/);
      expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(
        /\b(?:DROP|cron\.(?:schedule|alter_job|unschedule)|GRANT|REVOKE)\b/i
      );
    });
  }

  it('a Diamond event is conserved by its escrow, in the scalar and the set function alike', () => {
    expect(BOOK).toContain('FROM public.fn_poker_diamond_tournament_escrow(t.id) x)');
    expect(BOOK).toContain('FROM public.fn_poker_diamond_tournament_escrow(e.id) x)');
    expect(BOOK).toContain(
      'CASE WHEN m.diamond_book IS NOT NULL THEN round(m.diamond_book, 2) ELSE round('
    );
    expect(BOOK).toContain('CASE WHEN e.diamond THEN');
    // Both read the same Diamond test: platform, diamonds, no union.
    expect(BOOK.split(isDiamond).length - 1).toBeGreaterThanOrEqual(3);
    expect(BOOK).toMatch(
      /c\.is_platform IS TRUE AND c\.union_id IS NULL\s*AND t\.union_id IS NULL/
    );
  });

  it('the chip shortfall sweep never pays a Diamond event', () => {
    expect(BOOK).toMatch(
      /A Diamond event is paid from its own diamond escrow[\s\S]*?AND NOT EXISTS \(SELECT 1 FROM public\.clubs c/
    );
  });

  it('a Diamond place counts its prize and bounty legs wherever the wallet is read', () => {
    const legs = PLACE.match(/FROM public\.poker_diamond_tournament_ledger l/g) ?? [];
    expect(legs.length).toBeGreaterThanOrEqual(7); // 5 guarantee + 1 mismatch + 1 entry
    expect(PLACE).toContain("l.kind IN ('prize','bounty')), 0) + 0.05 < o.place_worth");
    expect(PLACE).toContain("WHERE l.tournament_id = t.id AND l.kind = 'prize'), 0) AS paid");
  });

  it('a Diamond entry is witnessed by its entry leg, inside the same evidence buffer', () => {
    expect(PLACE).toContain("WHERE l.kind IN ('entry','rebuy','reentry','addon')");
    expect(PLACE).toContain('AND l.created_at >= v_since - c_evidence_buffer');
    expect(PLACE).toMatch(/AND a\.user_id IS NULL\s*AND d\.user_id IS NULL/);
  });
});
