/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A ONE-SHOT BROADCAST IS NOT A STATE (Dan 2026-08-28, bug 7)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "THE FINAL TABLE ... YOU CAN NOT SEE THE FINAL TABLE
 * BACKGROUND EITHER."
 *
 * `TournamentManager.isFinalTable` is an in-memory flag on one process, and
 * the `final_table` announcement is sent ONCE. Anyone not listening at that
 * instant never learns the tournament reached its final table: a player who
 * reconnects (which is exactly what happened, see bug 1), a second device, a
 * spectator arriving later, or every client at once if the engine restarts.
 *
 * The client's fallback was A REGEX ON THE TABLE NAME —
 * `/\bfinal table\b/i.test(table.name)` — on the stated grounds that
 * "TournamentService canonically names the consolidated table 'Final Table'".
 * Production disagrees: 4f42d847's final table is named "Union PKO Afternoon
 * (PLO4) - Table 2". The fallback matched nothing and the background never
 * loaded.
 *
 * Meanwhile `tournaments.final_table_triggered` had existed as a column the
 * whole time and NOTHING EVER WROTE IT: measured on production, 0 of 1,286
 * completed MTTs in thirty days had it set.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const MANAGER = read('server/src/tournament/TournamentManager.ts');
const TABLEPAGE = read('src/pages/TablePage.tsx');
const POST_DEPLOY = read('.github/workflows/post-deploy-e2e.yml');
const CUTOVER_SEALER = read('scripts/ci/seal-phase1-customization-cutover.mjs');
const FINAL_TABLE_PREREQUISITE = read(
  'supabase/migrations/20261005111453_phase_one_customization_ownership_face_decks_and_avatar_styl.sql'
);
const FINAL_TABLE_CLEANUP = read(
  'supabase/migrations/20261005111523_short_formats_never_reach_final_table.sql'
);
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the engine persists the final table, not just announces it', () => {
  const M = code(MANAGER);

  it('writes final_table_triggered when it declares', () => {
    expect(M).toMatch(/rpc\('fn_claim_final_table_transition'/);
  });

  it('scopes the write to this tournament', () => {
    expect(M).toMatch(
      /fn_claim_final_table_transition[\s\S]{0,180}?p_tournament_id: this\.tournamentId/
    );
  });

  it('is idempotent, so an engine restart cannot re-announce forever', () => {
    expect(M).toMatch(/p_ownership_token: ownershipToken/);
    expect(M).toMatch(/this\.finalTableTransitionOwner/);
    expect(M).toMatch(/fn_ack_final_table_announcement/);
  });

  it('still broadcasts — the write is additional, not a replacement', () => {
    expect(M).toMatch(/this\.broadcast\('final_table'/);
  });

  it('reports a failed write instead of swallowing it', () => {
    expect(M).toMatch(/final_table_flag_write_failed/);
  });

  it('still requires ONE live table, not just a headcount', () => {
    // Guarding the 2026-08-27 P0: nine players across three felts is not a
    // final table, and fn_final_table_deal would have chopped between them.
    expect(M).toMatch(/hasReachedFinalTableShape\(remainingPlayers, finalTableSize, liveTables\)/);
  });
});

describe('the client asks for the final table instead of inferring it', () => {
  const C = code(TABLEPAGE);

  it('selects final_table_triggered from the tournament row', () => {
    expect(C).toMatch(/final_table_triggered/);
    expect(C).toMatch(/\.select\(\s*'[^']*tournament_type[^']*final_table_triggered[^']*'\s*\)/);
  });

  it('turns the theme on when the tournament says so', () => {
    expect(C).toMatch(
      /tournData\?\.final_table_triggered[\s\S]{0,160}?getTournamentFormatKind\(tournData\) === 'mtt'/
    );
    expect(C).toMatch(/isFinalTable: true/);
  });

  it('only ever turns it ON, never off', () => {
    // The live broadcast remains a fast path; an unreadable durable row must
    // leave whatever it decided rather than clearing the theme.
    expect(C).toMatch(/prev\.isFinalTable \? prev : \{ \.\.\.prev, isFinalTable: true \}/);
  });

  it('still applies the final-table background off that state', () => {
    expect(C).toMatch(/isFinalTable \? 'final_table_broadcast'/);
  });

  it('a mounted client follows the durable event even if the owner crashes before broadcast', () => {
    expect(C).toMatch(/table: 'tournament_final_table_events'/);
    expect(C).toMatch(/applyDurableFinalTableState\(/);
    expect(C).toMatch(/select\('status, format_contract, final_table_triggered'\)/);
    expect(FINAL_TABLE_PREREQUISITE).toMatch(
      /ALTER PUBLICATION supabase_realtime[\s\S]*?ADD TABLE public\.tournament_final_table_events/
    );
    expect(FINAL_TABLE_CLEANUP).toMatch(
      /install 20261005111453 and release the compatible client and engine first/
    );
  });
});

describe('the Final Table database rollout is safe and ordered', () => {
  it('installs compatible prerequisites before the post-cutover constraint', () => {
    expect(FINAL_TABLE_PREREQUISITE).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.tournament_final_table_transition_receipts/
    );
    expect(FINAL_TABLE_PREREQUISITE).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.tournament_final_table_events/
    );
    expect(FINAL_TABLE_PREREQUISITE).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_claim_final_table_transition/
    );
    expect(FINAL_TABLE_PREREQUISITE).not.toMatch(
      /ADD CONSTRAINT tournaments_final_table_requires_mtt_check/
    );
    expect(FINAL_TABLE_CLEANUP).toMatch(
      /ADD CONSTRAINT tournaments_final_table_requires_mtt_check/
    );
    expect(FINAL_TABLE_CLEANUP).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_claim_final_table_transition/
    );
    expect(FINAL_TABLE_CLEANUP).not.toMatch(/CREATE TABLE/);
    expect(FINAL_TABLE_CLEANUP).not.toMatch(/ALTER PUBLICATION/);
  });

  it('keeps serving-client writers until the compatible client is live', () => {
    expect(FINAL_TABLE_PREREQUISITE).not.toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE\s+ON TABLE public\.user_theme_settings/
    );
    for (const legacySignature of [
      'fn_set_interface_theme\\(text\\)',
      'fn_mark_table_setting_touched\\(text\\[\\]\\)',
      'fn_seed_table_studio_preferences\\(text\\[\\], jsonb\\)',
      'fn_mutate_table_studio_preferences\\(text, boolean, integer, jsonb\\)',
    ]) {
      expect(FINAL_TABLE_PREREQUISITE).not.toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${legacySignature}`)
      );
      expect(FINAL_TABLE_CLEANUP).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${legacySignature}`)
      );
    }
    expect(FINAL_TABLE_CLEANUP).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE\s+ON TABLE public\.user_theme_settings/
    );
  });

  it('keeps transition ledgers off the hot tournaments foreign-key lock path', () => {
    expect(FINAL_TABLE_PREREQUISITE).not.toMatch(
      /tournament_final_table_(?:transition_receipts|events)[\s\S]{0,500}?REFERENCES public\.tournaments/
    );
  });

  it('cannot retire legacy paths until exact live client and engine artifacts are sealed', () => {
    expect(FINAL_TABLE_PREREQUISITE).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.phase_one_customization_cutover_seals/
    );
    expect(FINAL_TABLE_PREREQUISITE).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_seal_phase_one_customization_cutover/
    );
    expect(FINAL_TABLE_PREREQUISITE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_seal_phase_one_customization_cutover\(text, text\)\s+TO service_role/
    );
    expect(FINAL_TABLE_CLEANUP).toMatch(/FROM public\.phase_one_customization_cutover_seals/);
    expect(FINAL_TABLE_CLEANUP).toMatch(/the sealed engine is not the one currently heartbeating/);
    expect(FINAL_TABLE_CLEANUP.indexOf('phase_one_customization_cutover_seals')).toBeLessThan(
      FINAL_TABLE_CLEANUP.indexOf('REVOKE INSERT, UPDATE, DELETE, TRUNCATE')
    );
    expect(POST_DEPLOY).toContain('phase1-customization-cutover-v1.json');
    expect(POST_DEPLOY).toContain('seal-phase1-customization-cutover.mjs');
    expect(CUTOVER_SEALER).toContain('fn_seal_phase_one_customization_cutover');

    const sealJob = POST_DEPLOY.slice(POST_DEPLOY.indexOf('  phase1-customization-cutover-seal:'));
    expect(sealJob).toContain('needs: [publication-gate, production-e2e, live-table-e2e]');
    expect(sealJob).toContain("needs.production-e2e.outputs.certified == 'true'");
    expect(sealJob).toContain("needs.live-table-e2e.outputs.certified == 'true'");
    expect(sealJob).toContain("needs.live-table-e2e.outputs.phase1_mtt_certified == 'true'");
    expect(sealJob).toContain(
      'needs.production-e2e.outputs.client_sha == needs.live-table-e2e.outputs.client_sha'
    );
    expect(sealJob).toContain('production-e2e-provenance.mjs engine-live');
    expect(sealJob).toContain('production-e2e-provenance.mjs release-window "$CLIENT_SHA"');
    expect(sealJob).toContain('git merge-base --is-ancestor "$ENGINE_SHA" "$LIVE_ENGINE_SHA"');
    expect(sealJob).toContain('NON-VERDICT: engine');
    expect(sealJob).toContain('node scripts/ci/seal-phase1-customization-cutover.mjs');
    expect(
      POST_DEPLOY.match(/node scripts\/ci\/seal-phase1-customization-cutover\.mjs/g)
    ).toHaveLength(1);
    expect(POST_DEPLOY.indexOf('Did the live-table certificate actually execute?')).toBeLessThan(
      POST_DEPLOY.indexOf('  phase1-customization-cutover-seal:')
    );
    expect(POST_DEPLOY).toContain(
      'phase1_mtt_certified: ${{ steps.phase1_mtt.outputs.certified }}'
    );
    expect(POST_DEPLOY).toContain('Did the Phase 1 MTT certificate actually execute?');
    expect(POST_DEPLOY).toContain('phase1-mtt-certificate-verdict.mjs');
  });

  it('fails closed when a fresh heartbeat has no exact runtime version', () => {
    for (const migration of [FINAL_TABLE_PREREQUISITE, FINAL_TABLE_CLEANUP]) {
      expect(migration).toContain("count(DISTINCT coalesce(live.engine_version, '<null>'))");
      expect(migration).toMatch(
        /live\.engine_version IS DISTINCT FROM left\((?:p|v)_engine_sha, 8\)/
      );
    }
  });
});
