/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CONTROL THAT SAYS "DONE" HAS WRITTEN SOMETHING DOWN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-03, phase 2)
 *
 * Three controls across the integrity pages ran a client UPDATE against a table
 * with no UPDATE policy for `authenticated`. PostgREST answers that with 204,
 * zero rows and NO error, so every one of them reported success:
 *
 *   Anti-Cheat "Submit Review"   anti_cheat_flags  -> "Flag reviewed successfully."
 *   Disputes "Start Review"      disputes          -> threw, shown as a failure
 *   Disputes "Escalate"          disputes          -> threw, shown as a failure
 *
 * The first is the dangerous shape: a decision an operator believes is recorded
 * and is not. This suite pins the replacements from both ends - the migration
 * that added the write paths, and the client that must now go through them.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sliceSqlStatement } from '../helpers/sourceWindow';

const MIGRATION = readFileSync(
  'supabase/migrations/20260903170000_an_integrity_decision_is_written_down.sql',
  'utf8'
);
const ANTI_CHEAT = readFileSync('src/pages/AntiCheatPage.tsx', 'utf8');
const DISPUTES = readFileSync('src/services/DisputeService.ts', 'utf8');
const REPORTS = readFileSync('src/pages/ReportReviewPage.tsx', 'utf8');
const BLACKLIST = readFileSync('src/pages/BlacklistManagerPage.tsx', 'utf8');

const NEW_FUNCTIONS = [
  'fn_ca_can_review_integrity',
  'fn_club_anti_cheat_flags',
  'fn_review_anti_cheat_flag',
  'get_anti_cheat_stats',
  'detect_collusion_pairs',
  'fn_ca_dismiss_collusion_pair',
  'fn_dispute_start_review',
  'fn_dispute_escalate',
];

describe('the migration gives every integrity write a gated path', () => {
  it.each(NEW_FUNCTIONS)('%s is defined, definer, and search-path pinned', (fn) => {
    expect(MIGRATION).toContain(`FUNCTION public.${fn}(`);
    // Bounded by the statement, never by a byte count: a window sized in
    // characters drifts off the end of the thing it guards as soon as the
    // function grows (tests/unit/noFixedSizeSourceWindows.test.ts).
    const body = sliceSqlStatement(MIGRATION, `FUNCTION public.${fn}(`);
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public'");
  });

  it.each(NEW_FUNCTIONS)('%s is revoked from anon and granted to authenticated', (fn) => {
    expect(MIGRATION).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM anon`)
    );
    expect(MIGRATION).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`)
    );
  });

  it('routes every gate through one function rather than five inline copies', () => {
    // Five call sites plus the definition itself.
    const uses = MIGRATION.match(/fn_ca_can_review_integrity\(/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(7);
    expect(MIGRATION).toContain("cm.role IN ('owner', 'co_owner', 'admin')");
  });

  it('refuses a caller with no account, in the gate itself', () => {
    const gate = sliceSqlStatement(MIGRATION, 'FUNCTION public.fn_ca_can_review_integrity(');
    expect(gate).toContain('auth.uid() IS NOT NULL');
    expect(gate).not.toMatch(/auth\.uid\(\)\s+IS\s+NULL\s+OR/i);
  });

  it('treats a zero-row write as a failure, not a quiet success', () => {
    expect(MIGRATION).toContain('GET DIAGNOSTICS v_updated = ROW_COUNT');
    expect(MIGRATION).toContain("'ok', false");
  });

  it('only accepts the three review decisions the console offers', () => {
    expect(MIGRATION).toContain("NOT IN ('reviewed', 'dismissed', 'actioned')");
    expect(ANTI_CHEAT).toContain('<option value="reviewed">');
    expect(ANTI_CHEAT).toContain('<option value="dismissed">');
    expect(ANTI_CHEAT).toContain('<option value="actioned">');
  });

  it('indexes the table the collusion screen scans on every visit', () => {
    // 169,530 rows, and its only index was the primary key.
    expect(MIGRATION).toContain('idx_collusion_tracking_window');
    expect(MIGRATION).toContain('idx_collusion_tracking_pair');
  });
});

describe('the client no longer writes to a table that refuses it', () => {
  it('reviews a flag through the RPC and checks the outcome', () => {
    expect(ANTI_CHEAT).toContain("supabase.rpc('fn_review_anti_cheat_flag'");
    expect(ANTI_CHEAT).toContain('if (!outcome.ok)');
    expect(ANTI_CHEAT).not.toContain("from('anti_cheat_flags')\n        .update(");
  });

  it('reads the flags through the RPC, because the table grants no staff read', () => {
    expect(ANTI_CHEAT).toContain("supabase.rpc('fn_club_anti_cheat_flags'");
    expect(ANTI_CHEAT).not.toContain(".from('anti_cheat_flags')");
  });

  it('moves a dispute through the RPCs and reports a refusal honestly', () => {
    expect(DISPUTES).toContain("supabase.rpc('fn_dispute_start_review'");
    expect(DISPUTES).toContain("supabase.rpc('fn_dispute_escalate'");
    expect(DISPUTES).toContain("'This dispute is no longer open.'");
  });

  it('never closes a seat from the browser', () => {
    // CLAUDE.md 11.5: a seat closed outside a cash-out destroys the stack in
    // it, and ca_seat_stack_exits files every such exit as critical.
    expect(ANTI_CHEAT).not.toContain("from('table_seats')\n          .update(");
    expect(ANTI_CHEAT).not.toContain("status: 'kicked'");
    expect(ANTI_CHEAT).toContain('adminRemovePlayerFromClubTables');
  });

  it('resolves the club before it queries anything', () => {
    // The page took the route param - a slug - and passed it into uuid
    // arguments, so every read answered 22P02 and every catch painted an empty
    // state. It has shown "Club Is Clean" on every slug URL since it shipped.
    expect(ANTI_CHEAT).toContain('resolvedClub = await resolveClubUUID(targetClub)');
    expect(ANTI_CHEAT).toContain('setClubId(resolvedClub)');
    expect(ANTI_CHEAT).not.toContain('setClubId(targetClub)');
  });

  it('says which it is when a read fails, instead of painting zeros', () => {
    expect(ANTI_CHEAT).toContain('setLoadError');
    expect(ANTI_CHEAT).not.toContain('No Open Flags - Club Is Clean!');
  });
});

describe('the surfaces around them stopped promising what they cannot do', () => {
  it('does not subscribe to a table that is not published', () => {
    // user_reports is absent from supabase_realtime AND its RLS grants a
    // moderator nothing, so the subscription could never deliver a row.
    expect(REPORTS).not.toContain("table: 'user_reports'");
    expect(REPORTS).toContain('REPORT_POLL_MS');
  });

  it('says when the moderation queue is showing its own ceiling', () => {
    expect(REPORTS).toContain('REPORT_PAGE_SIZE');
    expect(REPORTS).toContain('Showing The');
  });

  it('excludes a person from the roster rather than a uuid typed by hand', () => {
    expect(BLACKLIST).toContain("supabase.rpc('ca_club_members'");
    expect(BLACKLIST).not.toContain('placeholder="Player UUID"');
  });

  it('tells the operator an exclusion does not empty a seat', () => {
    expect(BLACKLIST).toContain('Is Still Seated At');
    expect(BLACKLIST).toContain('adminRemovePlayerFromClubTables');
  });

  it('offers a broom for the expired rows nothing sweeps', () => {
    expect(BLACKLIST).toContain('clearExpired');
    expect(BLACKLIST).toContain('expiredEntries');
  });
});
