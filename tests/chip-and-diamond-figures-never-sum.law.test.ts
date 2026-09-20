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
 * The repair has two halves that MUST land together: a migration that gives
 * the fact table an asset dimension and gates projection 4, and a client that
 * asks for a scope. Only the client half can ship in this pull request (a
 * production migration is applied through its own route). A law demanding the
 * SQL alone would simply be red, which teaches everyone to ignore it.
 *
 * So this pins the two halves to EACH OTHER:
 *
 *   - every stats read in the client carries a scope, always;
 *   - a scope the database cannot separate is refused, never answered with
 *     the unscoped figure wearing that scope's label;
 *   - `STATS_RPCS_ARE_SCOPED` is false exactly while the newest definition of
 *     the projection leaves `ca_hand_player_stat` ungated, and true exactly
 *     once it is gated.
 *
 * That last one is the load-bearing part. Land the migration and forget the
 * client, and this goes red. Flip the client flag without the migration, and
 * this goes red. The remaining SQL is written out in
 * `docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** The text of projection 4: from its banner to the end of its stat insert. */
function projectionFourOf(sql: string): string {
  const start = sql.search(/--\s*Projection 4/i);
  expect(start, 'projection 4 must be findable by its banner comment').toBeGreaterThan(-1);
  const after = sql.slice(start);
  const end = after.search(/DELETE FROM public\.hand_projection_outbox/i);
  return end === -1 ? after : after.slice(0, end);
}

describe('chip and Diamond figures never sum', () => {
  describe('every stats read carries a scope', () => {
    it('the scope contract states which asset a figure is denominated in', async () => {
      const { CHIP_STATS, DIAMOND_STATS, statsScopeIsReadable, statsScopeArgs } =
        await import('../src/services/statsScope');
      expect(CHIP_STATS).toBe('chips');
      expect(DIAMOND_STATS).toBe('diamonds');
      expect(CHIP_STATS).not.toBe(DIAMOND_STATS);

      /* A scope the database cannot separate is refused outright. Answering it
         with the unscoped figure would hand back a chip total under a Diamond
         heading, which renders perfectly and is a lie. */
      expect(statsScopeIsReadable(CHIP_STATS)).toBe(true);
      expect(
        statsScopeIsReadable(DIAMOND_STATS),
        'until the RPCs can separate the assets, a Diamond read has no answer'
      ).toBe(false);

      /* And nothing may be sent that the RPCs do not declare: an undeclared
         argument is a PGRST202 on every stats read in the app. */
      expect(statsScopeArgs(CHIP_STATS)).toEqual({});
    });

    it('a refused scope returns an unknown and no figures', async () => {
      const { StatsFactsService } = await import('../src/services/StatsFactsService');
      const { DIAMOND_STATS, STATS_SCOPE_UNREADABLE } = await import('../src/services/statsScope');

      const payload = await StatsFactsService.getEVCurve('some-user', DIAMOND_STATS);
      expect(payload.error).toBe(STATS_SCOPE_UNREADABLE);
      expect(payload.scope).toBe(DIAMOND_STATS);
      expect(
        payload.points ?? [],
        'a refused scope must carry no rows at all, not chip rows'
      ).toHaveLength(0);
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

  describe('ca_hand_player_stat writes are gated per asset', () => {
    it('the client flag and the projection agree about whether the assets are separable', () => {
      const { file, sql } = newestProjectionBody();
      const projectionFour = projectionFourOf(sql);

      const writesTheFactTable = /INSERT INTO public\.ca_hand_player_stat/i.test(projectionFour);
      expect(writesTheFactTable, `${file} projection 4 should write ca_hand_player_stat`).toBe(
        true
      );

      /* Gated means projection 4 itself is conditional on the asset, the same
         way projections 1, 2 and 3 are - or the row it writes carries an asset
         column so a reader can separate them afterwards. Either repair makes
         the figures separable; neither has landed yet. */
      const gatedByFlag = /\bv_diamond\b/.test(projectionFour);
      const carriesAsset = /\basset\b/i.test(projectionFour);
      const separable = gatedByFlag || carriesAsset;

      const scoped = /export const STATS_RPCS_ARE_SCOPED\s*=\s*true/.test(
        read('src/services/statsScope.ts')
      );

      expect(
        scoped,
        separable
          ? `${file} now separates Diamond hands in projection 4, so the client must ask for a ` +
              'scope: set STATS_RPCS_ARE_SCOPED = true in src/services/statsScope.ts and send ' +
              'p_asset. See docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md.'
          : `${file} still writes ca_hand_player_stat for Diamond hands with no asset dimension, ` +
              'so the scoped RPCs cannot exist yet and STATS_RPCS_ARE_SCOPED must stay false. ' +
              'The remaining SQL is in docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md.'
      ).toBe(separable);
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
      for (const rpc of UNSCOPED_STATS_RPCS) expect(runbook).toContain(rpc);
    });
  });
});
