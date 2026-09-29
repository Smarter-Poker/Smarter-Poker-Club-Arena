/**
 * LAW: a chip figure and a Diamond figure never sum into one number.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Created 2026-09-20, before the damage rather than after it: this defect has
 * not happened yet, because Diamond cash play has never been open. It is
 * scheduled to happen on the day it is.
 *
 * WHAT IS WRONG, read off production on 2026-09-20:
 *
 * `fn_project_hand_side_effects_after_post_commit_20260908` runs four
 * projections after a hand commits. Three of them know about Diamonds:
 *
 *     Projection 1  IF v_club IS NOT NULL AND NOT COALESCE(v_diamond,false)
 *     Projection 2  IF NOT COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL
 *     Projection 3  IF NOT COALESCE(v_diamond,false)      -- "Positional profit
 *                   -- has no asset dimension. Keep Diamond amounts out of" it
 *
 * Projection 4 - the one that writes `ca_hand_player_idx` and
 * `ca_hand_player_stat` - has no such gate. And `ca_hand_player_stat` has no
 * club column and no asset column: its 28 columns are user_id, hand_id,
 * tournament_id, is_cash, game_variant, seat_position, profit, won_amt,
 * big_blind ... and nothing at all that says which currency any of it is in.
 *
 * Every read over that table takes `p_user` and no scope:
 *
 *     ca_player_stats_overview_v2(p_user, p_days, p_tz)
 *     ca_player_stats_pulse(p_user)
 *     ca_player_ev_curve(p_user, p_days, p_limit)
 *     ca_player_hand_grid(p_user, p_position, p_variant, p_days)
 *     ca_player_class_hands(p_user, p_hand_class, p_position, p_variant, p_days, p_limit)
 *     ca_player_nemesis(p_user, p_days, p_min_hands, p_limit)
 *     ca_player_rake_stats(p_user, p_days)
 *
 * So the first Diamond hand ever played adds its `profit`, `won_amt`, `net`
 * and `rake_paid` to the player's chip totals, in one number, with nothing
 * anywhere able to tell them apart again. Not a display bug - the rows lose
 * the distinction at write time.
 *
 * WHAT THIS LAW PINS, AND WHY IT IS SHAPED THIS WAY:
 *
 * The repair had two halves that MUST land together: a migration that gives
 * the fact tables an asset dimension and scopes every reader, and a client
 * that asks for a scope. Until 2026-09-29 only the client half existed, so
 * this law pinned the two halves to EACH OTHER rather than demanding SQL that
 * was not there. Both halves landed together on 2026-09-29
 * (20260920065728_a_diamond_hand_keeps_its_own_statistics): the two tables
 * carry `asset`, set from the hand by a BEFORE INSERT trigger for every
 * writer, and every reader takes `p_asset`. So this now pins:
 *
 *   - every stats read in the client carries a scope, always, and sends it;
 *   - `STATS_RPCS_ARE_SCOPED` is true exactly while that migration is in the
 *     repository, and the migration labels both tables and scopes all seven
 *     RPCs;
 *   - the other three projections still keep Diamond hands out of the chip
 *     aggregates that have no asset dimension.
 *
 * The design is in the migration's header and in
 * `docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md`.
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const PROJECTION = 'fn_project_hand_side_effects_after_post_commit_20260908';

/** Every stats RPC that reads the per-hand fact table. */
const UNSCOPED_STATS_RPCS = [
  'ca_player_stats_overview_v2',
  'ca_player_stats_pulse',
  'ca_player_ev_curve',
  'ca_player_hand_grid',
  'ca_player_class_hands',
  'ca_player_nemesis',
  'ca_player_rake_stats',
];

function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The newest migration that DECLARES the projection's body.
 *
 * Later migrations edit it by substitution against the live catalogue rather
 * than retyping 200 lines of money path, so "newest file mentioning the name"
 * is the wrong question - it has to be the newest one carrying the body.
 */
function newestProjectionBody(): { file: string; sql: string } {
  const dir = join(ROOT, 'supabase', 'migrations');
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse();
  for (const file of candidates) {
    const sql = readFileSync(join(dir, file), 'utf8');
    if (sql.includes(PROJECTION) && /Projection 4/i.test(sql)) return { file, sql };
  }
  throw new Error(`no migration in supabase/migrations/ carries the body of ${PROJECTION}`);
}

describe('chip and Diamond figures never sum', () => {
  describe('every stats read carries a scope', () => {
    it('the scope contract states which asset a figure is denominated in', async () => {
      const { CHIP_STATS, DIAMOND_STATS, statsScopeIsReadable, statsScopeArgs } =
        await import('../src/services/statsScope');
      expect(CHIP_STATS).toBe('chips');
      expect(DIAMOND_STATS).toBe('diamonds');
      expect(CHIP_STATS).not.toBe(DIAMOND_STATS);

      /* The RPCs separate the assets, so both scopes are answerable, and each
         read sends the asset it is about - never nothing, which would be the
         RPC's default and therefore a chip figure whatever the heading. */
      expect(statsScopeIsReadable(CHIP_STATS)).toBe(true);
      expect(statsScopeIsReadable(DIAMOND_STATS)).toBe(true);
      expect(statsScopeArgs(CHIP_STATS)).toEqual({ p_asset: 'chips' });
      expect(statsScopeArgs(DIAMOND_STATS)).toEqual({ p_asset: 'diamonds' });
    });

    it('a Diamond read asks the database for Diamonds and keeps its scope', async () => {
      const { StatsFactsService } = await import('../src/services/StatsFactsService');
      const { DIAMOND_STATS } = await import('../src/services/statsScope');

      rpc.mockReset();
      rpc.mockResolvedValueOnce({ data: { points: [], summary: null }, error: null });
      const payload = await StatsFactsService.getEVCurve('some-user', DIAMOND_STATS);
      expect(rpc).toHaveBeenCalledWith('ca_player_ev_curve', {
        p_user: 'some-user',
        p_days: null,
        p_limit: 5000,
        p_asset: 'diamonds',
      });
      expect(payload.scope).toBe(DIAMOND_STATS);
      expect(payload.error).toBeUndefined();
    });

    it('a one-hand read sends no scope its RPC does not declare', async () => {
      const { StatsFactsService } = await import('../src/services/StatsFactsService');
      const { DIAMOND_STATS } = await import('../src/services/statsScope');

      rpc.mockReset();
      rpc.mockResolvedValueOnce({ data: { found: false }, error: null });
      const payload = await StatsFactsService.getHandRakeShare('some-hand', DIAMOND_STATS);
      /* ca_player_hand_rake_share(p_hand_id) reads one hand, which is in one
         asset already; an undeclared p_asset would be a PGRST202. */
      expect(rpc).toHaveBeenCalledWith('ca_player_hand_rake_share', { p_hand_id: 'some-hand' });
      expect(payload.scope).toBe(DIAMOND_STATS);
    });

    it('no stats RPC is called anywhere in src/ without a scope', () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(join(ROOT, 'src'))) {
        const code = codeOf(readFileSync(file, 'utf8'));
        for (const rpc of UNSCOPED_STATS_RPCS) {
          /* Only a real call site counts: `.rpc('name'` or the service's own
             `'name',` argument. A mention in prose is not a read. */
          const called = new RegExp(`rpc\\(\\s*['"\`]${rpc}['"\`]`).test(code);
          const viaService = new RegExp(`['"\`]${rpc}['"\`]\\s*,`).test(code);
          if (!called && !viaService) continue;
          if (!/statsScopeArgs\(|scope\b/.test(code)) {
            offenders.push(`${file.replace(ROOT + '/', '')} calls ${rpc} with no scope`);
          }
        }
      }
      expect(
        offenders,
        'a stats read that does not name its asset can print a mixed figure'
      ).toEqual([]);
    });

    it('the service threads the scope into every payload it returns', () => {
      const code = codeOf(read('src/services/StatsFactsService.ts'));
      expect(code).toContain('statsScopeIsReadable(scope)');
      expect(code, 'a payload that loses its scope can be printed under any heading').toMatch(
        /scope\s*}\s*as ScopedRead|,\s*scope,/
      );
    });
  });

  describe('ca_hand_player_stat writes are labelled per asset', () => {
    it('the client flag and the migration agree that the assets are separable', () => {
      const dir = join(ROOT, 'supabase', 'migrations');
      const file = readdirSync(dir)
        .filter((f) => f.endsWith('_a_diamond_hand_keeps_its_own_statistics.sql'))
        .sort()
        .at(-1);
      expect(
        file,
        'the migration that labels and scopes the stats is in the repository'
      ).toBeTruthy();
      const sql = readFileSync(join(dir, file!), 'utf8');

      /* Both tables learn the asset, and it is set from the hand for EVERY
         writer - not stamped by one writer that another can race. */
      for (const table of ['ca_hand_player_idx', 'ca_hand_player_stat']) {
        expect(sql).toMatch(
          new RegExp(
            `ALTER TABLE public\\.${table}\\s+ADD COLUMN asset text NOT NULL DEFAULT 'chips'`
          )
        );
        expect(sql).toMatch(
          new RegExp(
            `BEFORE INSERT OR UPDATE OF asset, hand_id ON public\\.${table}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.fn_ca_hand_player_row_takes_its_hands_asset\\(\\)`
          )
        );
      }

      /* Every reader takes the asset, its old signature is dropped (an extra
         defaulted parameter would otherwise be an overload and every call
         ambiguous), and an unknown asset is refused. */
      for (const rpcName of UNSCOPED_STATS_RPCS) {
        expect(sql, `${rpcName} is redefined with p_asset`).toMatch(
          new RegExp(
            `\\$f\\$CREATE OR REPLACE FUNCTION public\\.${rpcName}\\([^\\n]*p_asset text DEFAULT 'chips'::text\\)`
          )
        );
        expect(sql, `${rpcName}'s old signature is dropped`).toMatch(
          new RegExp(`DROP FUNCTION public\\.${rpcName}\\(`)
        );
      }
      expect(sql).toContain(
        "RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';"
      );

      const scoped = /export const STATS_RPCS_ARE_SCOPED\s*=\s*true/.test(
        read('src/services/statsScope.ts')
      );
      expect(
        scoped,
        `${file} scopes every stats RPC, so the client must send p_asset: ` +
          'STATS_RPCS_ARE_SCOPED must be true in src/services/statsScope.ts.'
      ).toBe(true);
    });

    it('the other three projections still keep Diamond hands out', () => {
      const { sql } = newestProjectionBody();
      /* If one of these loses its gate, Diamond amounts reach club-member
         state, legacy player_stats and positional profit as well, and this
         law is the only thing looking. */
      expect(sql).toMatch(/Projection 1[\s\S]{0,200}NOT COALESCE\(v_diamond,false\)/i);
      expect(sql).toMatch(/Projection 2[\s\S]{0,200}NOT COALESCE\(v_diamond,false\)/i);
      expect(sql).toMatch(/Projection 3[\s\S]{0,300}NOT COALESCE\(v_diamond,false\)/i);
    });

    it('the remaining SQL is written down where the owner can find it', () => {
      const runbook = read('docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md');
      expect(runbook).toContain(PROJECTION);
      expect(runbook).toContain('ca_hand_player_stat');
      for (const name of UNSCOPED_STATS_RPCS) expect(runbook).toContain(name);
    });
  });
});
