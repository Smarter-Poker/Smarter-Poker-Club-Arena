// Explicit, finite installation qualification of existing report facts.
// Each day uses the original writer key in its own transaction. No retry,
// scheduled work, financial write, or qualification of missing source history.
export const RAKE_REPORT_MIGRATION =
  '20261013121004_rake_agent_reports_read_qualified_days_and_uncovered_commiss.sql';
export const RAKE_REPORT_HELPER = 'smarter_private.qualify_rake_agent_report_day(uuid,date)';
export const RAKE_REPORT_HELPER_MD5 = '0b733de335781420b914576889e3294b';
const MAX_DAYS = 1024;
const BUDGET_MS = 600000;

export function rakeReportRequest(file, requested, recovery, batches) {
  if (!requested) return false;
  if (file !== RAKE_REPORT_MIGRATION || recovery || batches)
    throw new Error('rake history qualification requires its exact migration and no other operation');
  return true;
}

export async function qualifyRakeReportHistory(client, sql, dryRun, log = console.log) {
  // A fresh native fixture estimates millions of generated rows although the
  // bounded plan has fewer than 1025 days. LLVM compile overhead can consume
  // the whole five-second budget; this finite installation needs no JIT.
  await client.query(
    "SET jit=off; SET statement_timeout='5s'; SET transaction_timeout='6s'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='5s'"
  );
  const installed = await client.query(
    `SELECT h.statements = ARRAY[$2::text] AS exact,
            md5(pg_get_functiondef($3::regprocedure)) = $4 AS helper_exact,
            p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v'
              AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']
              AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                             WHERE a.grantee<>'postgres'::regrole) AS helper_private,
            md5(pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure))
              ='1a07fad61faa37c4f9c1c78835fb7843'
              AND md5(pg_get_functiondef('smarter_private.invalidate_agent_commission_report_days()'::regprocedure))
                ='2a1cde231f6a8036f51179d630fbbd2d'
              AND (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.agent_commissions'::regclass
                   AND tgname IN('zz_commission_report_invalidate_update','zz_commission_report_invalidate_delete',
                                  'zz_commission_report_invalidate_truncate') AND tgenabled='O'
                   AND tgfoid='smarter_private.invalidate_agent_commission_report_days()'::regprocedure)=3
              AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.agent_commissions'::regclass
                   AND tgname='trg_agent_commission_rollup_ins' AND tgenabled='O' AND tgnewtable='new_rows'
                   AND tgfoid='public.trg_agent_commission_rollup_insert()'::regprocedure) AS writers_exact
       FROM supabase_migrations.schema_migrations h
       JOIN pg_proc p ON p.oid=$3::regprocedure WHERE h.version=$1`,
    [RAKE_REPORT_MIGRATION.slice(0, 14), sql, RAKE_REPORT_HELPER, RAKE_REPORT_HELPER_MD5]
  );
  if (installed.rows.length !== 1 || installed.rows[0].exact !== true ||
      installed.rows[0].helper_exact !== true || installed.rows[0].helper_private !== true ||
      installed.rows[0].writers_exact !== true)
    throw new Error('exact private report qualification source is not installed; nothing sent');
  // Indexed first-source lookup, then a bounded list frozen for this operation.
  // Explicit invalidation overrides the transaction-owned future frontier.
  const plan = await client.query(`
    WITH clubs AS MATERIALIZED (
      SELECT c.id, (SELECT a.created_at FROM public.agent_commissions a
                     WHERE a.club_id=c.id ORDER BY a.created_at LIMIT 1) AS first_source
        FROM public.clubs c
    ), days AS (
      SELECT c.id AS club_id,g::date AS day
        FROM clubs c CROSS JOIN LATERAL generate_series(
          GREATEST((c.first_source AT TIME ZONE 'UTC')::date,
                   (clock_timestamp() AT TIME ZONE 'UTC')::date-731),
          (clock_timestamp() AT TIME ZONE 'UTC')::date-1,interval '1 day') g
        LEFT JOIN smarter_private.agent_commission_report_days m ON m.club_id=c.id AND m.day=g::date
        LEFT JOIN smarter_private.agent_commission_report_frontiers f ON f.club_id=c.id
       WHERE c.first_source IS NOT NULL
         AND ((m.complete IS TRUE OR (m.club_id IS NULL AND g::date>=f.first_complete_day)) IS NOT TRUE)
    ) SELECT club_id,day::text AS day FROM days ORDER BY club_id,day LIMIT ${MAX_DAYS + 1}`);
  if (plan.rows.length > MAX_DAYS)
    throw new Error(`qualification exceeds the finite ${MAX_DAYS}-day operation; nothing sent`);
  log(`[apply] rake report history: ${plan.rows.length} unqualified closed club-days`);
  if (dryRun) {
    log('[apply] DRY RUN: exact installation and bounded history plan verified; no facts written');
    return;
  }
  const deadline = Date.now() + BUDGET_MS;
  for (const {club_id: club, day} of plan.rows) {
    if (Date.now() >= deadline)
      throw new Error('finite qualification budget exhausted; inspect committed day markers before another explicit operation');
    // The function is VOLATILE, obtains the original club writer key, refuses
    // a qualified-day replay and uses fresh snapshots. Autocommit gives each
    // SELECT its own transaction; a month never holds one club key.
    log(`[apply] rake report day club=${club} day=${day} sending once`);
    await client.query(`SELECT ${RAKE_REPORT_HELPER.split('(')[0]}($1::uuid,$2::date) AS rows`, [club, day]);
    const receipt = await client.query(
      'SELECT complete,computed_at FROM smarter_private.agent_commission_report_days WHERE club_id=$1::uuid AND day=$2::date',
      [club, day]
    );
    if (receipt.rows.length !== 1 || receipt.rows[0].complete !== true)
      throw new Error(`qualification marker unreadable or invalidated club=${club} day=${day}; do not retry blindly`);
    log(`[apply] QUALIFIED club=${club} day=${day} computed_at=${receipt.rows[0].computed_at}`);
  }
  log('[apply] RAKE REPORT HISTORY QUALIFIED: every day in this finite plan committed and read back');
}
