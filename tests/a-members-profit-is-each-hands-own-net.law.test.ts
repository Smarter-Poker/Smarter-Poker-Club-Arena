/**
 * ===========================================================================
 *  LAW: A MEMBER'S PROFIT IS EACH HAND'S OWN NET
 * ===========================================================================
 *
 * club_member_daily_stats.profit is what the club dashboard shows as a
 * member's result per table per day. Until 20260922144812 no writer recorded
 * the result of a hand. All three (the live projection, the chunked rebuild
 * the World Hub route runs every 15 minutes, and the manual whole-table
 * rebuild) differenced the END-of-hand stacks of consecutive hands and kept a
 * difference only when a heuristic called it "attributable". A player's
 * first hand at a table has no previous stack, so its result was dropped
 * every time; a top-up between hands was misjudged.
 *
 * fn_reconcile_club_member_daily_profit existed to rewrite completed days
 * afterwards from player_stats snapshots, from two schedulers: pg_cron
 * reconcile-club-member-daily-profit and the World Hub route. It corrected
 * 2,541 / 3,115 / 7,107 rows for the three days before the fix.
 *
 * The exact figure was always available: what the seat won
 * (hand_history.winners) minus what it put in (the accepted-hand envelope's
 * contributor list, hand_atomic_commits.post_commit_payload ->
 * 'promo_playthrough', written in the same transaction as the hand). Measured
 * before the fix: 8,794 of 8,794 cash hands in an hour conserve to the cent.
 *
 * WHAT THIS LAW PINS
 *
 *   1. All three writers record won - contributed when the hand carries a
 *      contributor list, and keep the old figure only for a hand without one
 *      (THE OTHER DIRECTION: such a hand is not silently zeroed).
 *   2. The projection normalises the list in plpgsql, so no SQL expression
 *      asks the length of a non-array, and a rebuild guards the same way.
 *   3. The reconciler stands down from 2026-09-23, the first day exact end to
 *      end: it still measures and logs each club-day ('exact_at_source',
 *      applied false), and keeps its guarded correction for earlier days.
 *   4. The migration proves its data on live hands before it commits.
 *   5. THE ONE THAT MATTERS LATER: no migration after it brings back a
 *      stack-delta-only profit, or a reconciler that rewrites exact days.
 *
 * NOTE ON ASSERTING THE NEGATIVE (CLAUDE.md 7.3): the header quotes the old
 * expressions and the patch quotes them as the text it replaces, so the
 * forward guard reads every migration AFTER the fix with comments blanked,
 * and the pins on the fix read the replacement side of each patch.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sliceDollarQuoted } from './helpers/sourceWindow';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FIX = '20260922144812_a_members_profit_is_each_hands_own_net.sql';

const read = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8');

/**
 * `sql` with every SQL comment blanked; literals and dollar-quoted bodies are
 * kept where they were. Dollar quotes are transparent because a function body
 * is code and a comment inside it is still a comment.
 */
const withoutComments = (sql: string): string => {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < n) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      const to = nl < 0 ? n : nl;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      const to = close < 0 ? n : close + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
};

/** The replacement side of one ca_patch call, by its dollar tag. */
const patched = (sql: string, tag: string): string => sliceDollarQuoted(sql, `$${tag}$`);

/** Every way a later migration could bring the stack-delta-only profit back. */
const offendersIn = (sqlSource: string): string[] => {
  const code = withoutComments(sqlSource);
  const found: string[] = [];
  if (
    /WHEN\s+calc\.attributable\s+THEN\s+calc\.delta\b/i.test(code) &&
    !/WHEN\s+calc\.exact_net\s+IS\s+NOT\s+NULL\s+THEN\s+calc\.exact_net\b/i.test(code)
  ) {
    found.push('the projection records a stack delta with no exact net ahead of it');
  }
  if (
    /coalesce\s*\(\s*sum\s*\(\s*delta\s*\)\s*FILTER\s*\(\s*WHERE\s+attributable\s*\)/i.test(code)
  ) {
    found.push("a rebuild sums stack deltas instead of each hand's own net");
  }
  if (/SET\s+profit\s*=\s*f\.share/i.test(code) && !/p_date\s*<\s*v_exact_from/i.test(code)) {
    found.push('the reconciler rewrites profit without standing down for exact days');
  }
  return found;
};

describe("a member's profit is each hand's own net", () => {
  const sql = read(FIX);

  describe('the live projection', () => {
    it('reads the contributor list once and normalises it in plpgsql', () => {
      const load = patched(sql, 'w2b');
      expect(load).toContain("SELECT c.post_commit_payload->'promo_playthrough' INTO v_promo");
      expect(load).toContain('WHERE c.hand_id = v_h.id;');
      // An IF chain, not an SQL AND: plpgsql evaluates the branches in order,
      // so the length of a non-array is never asked.
      expect(load).toContain("IF jsonb_typeof(v_promo) IS DISTINCT FROM 'array' THEN");
      expect(load).toContain("ELSIF v_promo = '[]'::jsonb THEN");
      expect(load).not.toMatch(/jsonb_array_length/);
    });

    it('computes each seat as won minus contributed', () => {
      const calc = patched(sql, 'w3b');
      expect(calc).toContain('CASE WHEN v_promo IS NOT NULL');
      expect(calc).toContain("THEN b.won - COALESCE((SELECT sum((x->>'wagered')::numeric)");
      expect(calc).toContain("WHERE lower(x->>'user_id') = b.uid::text), 0)");
      expect(calc).toContain('END AS exact_net');
    });

    it('records the exact net first and keeps the old figure only as the fallback', () => {
      const profit = patched(sql, 'w5b');
      const exactAt = profit.indexOf('WHEN calc.exact_net IS NOT NULL THEN calc.exact_net');
      const fallbackAt = profit.indexOf('WHEN calc.attributable THEN calc.delta ELSE 0 END');
      expect(exactAt).toBeGreaterThanOrEqual(0);
      // THE OTHER DIRECTION: a hand without an envelope is not zeroed.
      expect(fallbackAt).toBeGreaterThan(exactAt);
      expect(profit).toContain('CASE WHEN v_tourney THEN 0');
      expect(patched(sql, 'w4b')).toContain(
        'WHEN calc.exact_net IS NOT NULL OR calc.attributable THEN 1 ELSE 0 END'
      );
    });
  });

  describe('both rebuilds', () => {
    it.each([
      ['r1b', 'r3b', "lower(pl->>'userId')", 'WHERE hac.hand_id = s.id) AS wagered'],
      ['t2b', 't4b', "lower(p->>'userId')", 'WHERE hac.hand_id = h.hand_id) AS wagered'],
    ])(
      "%s / %s read the contributor list and sum each hand's own net",
      (read1, agg, who, join1) => {
        const wagered = patched(sql, read1);
        expect(wagered).toContain(`WHERE lower(x->>'user_id') = ${who}), 0)`);
        expect(wagered).toContain(join1);
        // Guarded by nested CASE on a column value: the array is only expanded
        // once it is known to be a non-empty array.
        expect(wagered).toContain(
          "(SELECT CASE WHEN jsonb_typeof(hac.post_commit_payload->'promo_playthrough') = 'array'"
        );
        expect(wagered).toContain("<> '[]'::jsonb");
        const sums = patched(sql, agg);
        expect(sums).toContain('count(*) FILTER (WHERE exact_net IS NOT NULL OR attributable)');
        expect(sums).toContain('coalesce(sum(CASE WHEN exact_net IS NOT NULL THEN exact_net');
        expect(sums).toContain('WHEN attributable THEN delta ELSE 0 END), 0)');
      }
    );

    it('the whole-table rebuild carries the hand id it needs to find the envelope', () => {
      expect(patched(sql, 't1b')).toContain('SELECT hh.id AS hand_id, hh.hand_number');
    });
  });

  describe('the reconciler', () => {
    it('stands down from the first exact day and says why', () => {
      expect(patched(sql, 'c1b')).toContain("v_exact_from date := DATE '2026-09-23';");
      expect(patched(sql, 'c2b')).toContain(
        "IF (v_check ->> 'conserves')::boolean AND p_date < v_exact_from THEN"
      );
      const logged = patched(sql, 'c3b');
      expect(logged).toContain("(v_check ->> 'conserves')::boolean AND p_date < v_exact_from,");
      expect(logged).toContain("CASE WHEN p_date >= v_exact_from THEN 'exact_at_source'");
    });

    it('THE OTHER DIRECTION: the migration refuses to lose the correction for earlier days', () => {
      const verify = withoutComments(sliceDollarQuoted(sql, '$verify$'));
      expect(verify).toContain("position('IS DISTINCT FROM (f.share' in v_src) = 0");
      expect(verify).toContain("position('SET profit = f.share' in v_src) = 0");
    });
  });

  it('proves its data on live hands before it commits', () => {
    const verify = withoutComments(sliceDollarQuoted(sql, '$verify$'));
    expect(verify).toContain('abs(z.net + z.cut) > 0.005');
    expect(verify).toContain("h.created_at > now() - interval '30 minutes'");
    expect(verify).toContain('IF v_hands = 0 THEN');
    expect(verify).toContain('IF v_broken > 0 OR v_outside > 0 THEN');
  });

  it('declares the read-only proofs the live-migration check runs', () => {
    const proofs = sql.match(/^-- @live-proof: .*$/gm) ?? [];
    expect(proofs).toHaveLength(4);
    for (const fn of [
      'fn_project_hand_side_effects_after_post_commit_20260908',
      'ca_rebuild_table_chunk',
      'ca_rebuild_club_member_stats_table',
      'fn_reconcile_club_member_daily_profit',
    ]) {
      expect(proofs.some((p) => p.includes(`p.proname = '${fn}'`))).toBe(true);
    }
  });

  describe('the detector is live', () => {
    it.each([
      ['    CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN calc.delta ELSE 0 END,'],
      ['    coalesce(sum(delta) FILTER (WHERE attributable), 0),'],
      ['UPDATE x SET profit = f.share + 0 FROM fixed f WHERE true;'],
    ])('refuses: %s', (shape) => {
      expect(offendersIn(shape).length).toBeGreaterThan(0);
    });

    it.each([
      [
        'CASE WHEN v_tourney THEN 0 WHEN calc.exact_net IS NOT NULL THEN calc.exact_net WHEN calc.attributable THEN calc.delta ELSE 0 END',
      ],
      [
        'coalesce(sum(CASE WHEN exact_net IS NOT NULL THEN exact_net WHEN attributable THEN delta ELSE 0 END), 0)',
      ],
      [
        'IF ok AND p_date < v_exact_from THEN UPDATE x SET profit = f.share + 0 FROM fixed f WHERE true; END IF;',
      ],
      ['-- coalesce(sum(delta) FILTER (WHERE attributable), 0)\nSELECT 1;'],
    ])('allows: %s', (shape) => {
      expect(offendersIn(shape)).toEqual([]);
    });
  });

  it('THE ONE THAT MATTERS LATER: nothing after the fix brings the stack-delta profit back', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS)) {
      if (!file.endsWith('.sql') || file <= FIX) continue;
      for (const why of offendersIn(read(file))) offenders.push(`${file}: ${why}`);
    }
    expect(offenders).toEqual([]);
  });
});
