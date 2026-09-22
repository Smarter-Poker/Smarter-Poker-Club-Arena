/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A GATE ON THE REPOSITORY, AND AN EYE ON PRODUCTION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * check-definer-authorization stops a new unauthenticated SECURITY DEFINER
 * writer arriving through a MIGRATION IN THIS REPOSITORY. It cannot see the live
 * database, and this estate applies schema straight to production through the
 * Supabase MCP. That is the normal path, and it is how all three of the most
 * recent ones arrived:
 *
 *   fn_pay_backed_payout_shortfalls  hours after the original sweep
 *   fn_backpay_spin_unpaid_winners   found by the audit's very first run
 *   fn_requeue_unbanked_fees         found by the audit's very first run
 *
 * So the sweep that found nineteen by hand became a daily job. These pin the
 * parts of it that decide whether it can be trusted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const SCRIPT = read('scripts/ci/audit-live-definer-exposure.mjs');
const WF = read('.github/workflows/schema-manifest-refresh.yml');
const MIG = read('supabase/migrations/20260828050000_the_definer_sweep_becomes_a_daily_job.sql');
const MIG2 = read(
  'supabase/migrations/20260828070000_the_auditor_learns_the_shape_that_slipped_past_it.sql'
);
const MIG3 = read(
  'supabase/migrations/20260828080000_pinned_search_paths_and_a_watch_on_rls_off_tables.sql'
);

/** Comments quote the very things the code must not do. Strip them first. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('the audit asks production, and asks it the same question the gate asks', () => {
  it('reads the live answer from the database, not from the repo', () => {
    expect(code(SCRIPT)).toContain('rpc/fn_definer_exposure_audit');
    expect(code(SCRIPT)).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('uses word for word the predicate the CI gate uses', () => {
    // If these two ever disagree about what is dangerous, one of them is
    // reassuring somebody for no reason.
    expect(MIG).toContain('p.prosecdef');
    expect(MIG).toContain("p.prorettype <> 'pg_catalog.trigger'::regtype");
    expect(MIG).toContain("'(^|[^a-z_])(insert into|update |delete from)'");
    expect(MIG).toContain('auth\\.uid\\(\\)|auth\\.role\\(\\)|auth\\.jwt\\(\\)');
  });

  it('cannot change what it audits', () => {
    // An auditor with write access is not an auditor. The function is STABLE
    // and selects from the catalog only.
    expect(MIG).toContain('LANGUAGE sql');
    expect(MIG).toContain('STABLE');
    expect(MIG).not.toMatch(/fn_definer_exposure_audit[\s\S]*?(INSERT INTO|UPDATE |DELETE FROM)/);
  });

  it('is not callable from a browser itself', () => {
    expect(MIG).toContain(
      'REVOKE ALL ON FUNCTION public.fn_definer_exposure_audit() FROM PUBLIC, anon, authenticated'
    );
  });
});

describe('it fails in the safe direction', () => {
  it('treats an unreachable database as unknown, never as clean and never as a finding', () => {
    // A network problem is not a security finding, and a script that cries wolf
    // when Supabase hiccups is one whose red runs get waved through.
    expect(SCRIPT).toContain('DEFINER AUDIT DID NOT RUN');
    expect(code(SCRIPT)).toMatch(/catch[\s\S]{0,400}?process\.exit\(0\)/);
  });

  it('writes its summary with an import, not require', () => {
    /**
     * `require` does not exist in an ES module. A first draft called it inside a
     * try/catch, so every summary line would have thrown ReferenceError and been
     * swallowed: the step would report success and write nothing. That is the
     * exact silent-no-op shape this whole body of work is about, reproduced
     * inside the tool built to catch it.
     */
    expect(code(SCRIPT)).not.toContain("require('node:fs')");
    expect(SCRIPT).toContain('appendFileSync');
  });

  it('says when the baseline could shrink, rather than quietly carrying it', () => {
    expect(SCRIPT).toContain('the baseline can shrink');
  });
});

describe('the baseline is small, reasoned, and shrink-only', () => {
  const baseline = JSON.parse(read('scripts/ci/definer-exposure-baseline.json'));

  it('holds only the one still exposed, read line by line', () => {
    // get_current_settlement_period left on 2026-09-22: retired to a refusal
    // that writes nothing on 2026-09-17 and closed to every browser role on
    // 2026-09-20. A list that may only shrink is pinned at its new size.
    expect(Object.keys(baseline.reviewedExceptions).sort()).toEqual([
      'recalculate_leaderboard_ranks',
    ]);
  });

  it('gives each one a reason long enough to be a reason', () => {
    for (const [name, why] of Object.entries(baseline.reviewedExceptions)) {
      expect((why as string).length, name).toBeGreaterThan(150);
    }
  });

  it('says out loud that the list may only shrink', () => {
    expect(baseline._comment).toContain('only ever SHRINK');
  });
});

describe('and the alarm reaches a person', () => {
  it('runs in the workflow that already holds the key', () => {
    expect(WF).toContain('node scripts/ci/audit-live-definer-exposure.mjs');
    expect(WF).toContain("cron: '20 5 * * *'");
  });

  it('runs HOURLY, because a hole applied straight to production waits for nobody', () => {
    /**
     * 2026-09-01. This job is the only thing on the estate that can see a
     * grant made outside a migration, and almost all schema here is applied
     * that way through the Supabase MCP. At one run a day, a function that
     * ships anon-executable at 09:00 answers strangers until 05:20 the next
     * morning.
     *
     * Both of the last two findings had been live for hours when it caught
     * them: fn_collect_bounty, which pays knockout bounties, callable by any
     * logged-in player; and fn_seat_club_for_user_membership_unchecked, which
     * handed a caller with no account any player's club membership and live
     * seating.
     */
    expect(WF).toContain("cron: '40 * * * *'");
  });

  it('does not open a manifest pull request every hour', () => {
    // The hourly cron is for the audit alone. A refresh PR an hour would bury
    // the one thing in this workflow that needs a person.
    expect(WF).toMatch(
      /refresh:\n\s*#[\s\S]{0,400}?if: github\.event\.schedule != '40 \* \* \* \*'/
    );
  });

  it('is its own job, so a manifest problem cannot mask a security finding', () => {
    expect(WF).toMatch(/^ {2}definer-exposure:$/m);
    expect(WF).toMatch(/^ {2}refresh:$/m);
  });

  it('opens a self-closing issue, because a red scheduled run is a tree nobody hears', () => {
    expect(WF).toContain('issues: write');
    expect(WF).toContain('gh issue create');
    expect(WF).toContain('gh issue close');
    // The plain list endpoint, never the search index, which is eventually
    // consistent and has filed duplicate issues in this estate before. Asserted
    // on the COMMAND, because the YAML comment above it names the thing the
    // command must not do - the same trap these tests keep re-learning.
    const listCalls = WF.split('\n').filter((l) => l.includes('gh issue list'));
    expect(listCalls.length).toBeGreaterThan(0);
    for (const call of listCalls) expect(call).not.toContain('--search');
  });
});

describe('the two the audit found on day one are shut', () => {
  it('revokes them from every browser role and proves the revoke took', () => {
    expect(MIG).toContain('fn_backpay_spin_unpaid_winners(boolean, integer)');
    expect(MIG).toContain('fn_requeue_unbanked_fees(boolean, integer)');
    expect(MIG).toContain('FROM PUBLIC, anon, authenticated');
    expect(MIG).toContain("RAISE EXCEPTION 'revoke did not take: %', bad");
  });

  it('and there is no allowlist entry quietly forgiving them', () => {
    const baseline = JSON.parse(read('scripts/ci/definer-exposure-baseline.json'));
    expect(baseline.reviewedExceptions.fn_backpay_spin_unpaid_winners).toBeUndefined();
    expect(baseline.reviewedExceptions.fn_requeue_unbanked_fees).toBeUndefined();
  });
});

it('the auditor script is not accidentally left unreferenced', () => {
  expect(existsSync(resolve(__dirname, '..', 'scripts/ci/audit-live-definer-exposure.mjs'))).toBe(
    true
  );
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE QUESTION THE FIRST PREDICATE COULD NOT ASK
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `unauthenticated_writers` finds functions that never reference auth.uid(),
 * auth.role() or auth.jwt(). process_tournament_rebuy DOES reference auth.uid()
 * - just uselessly:
 *
 *     IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN ... refuse
 *
 * which skips the check for a caller who has no auth.uid() at all. `anon` had
 * EXECUTE, so an unauthenticated call bought a rebuy for a real seated player
 * and took the chips out of their balance (#1570).
 *
 * Mentioning the request is not the same as being bound by it, and no predicate
 * about the TEXT of a guard can tell those apart. So the auditor asks a second,
 * blunter question that needs no reasoning at all.
 */
describe('the auditor learns the shape that slipped past it', () => {
  it('asks whether a logged-out caller can execute a writing function', () => {
    expect(MIG2).toContain("'anon_writers'");
    expect(MIG2).toContain("has_function_privilege('anon', p.oid, 'EXECUTE')");
    // Deliberately says nothing about auth.uid(): the grant IS the finding.
    const anonBlock = MIG2.slice(MIG2.indexOf("'anon_writers'"));
    expect(anonBlock).not.toContain('auth\\.uid');
  });

  it('keeps the original question too, in one auditor', () => {
    expect(MIG2).toContain("'unauthenticated_writers'");
    expect(MIG2).toContain('auth\\.uid\\(\\)|auth\\.role\\(\\)|auth\\.jwt\\(\\)');
  });

  it('gives the anon rule no allowlist at all', () => {
    // The live answer is zero after #1570, so there is nothing to forgive. A
    // baseline entry here would be a decision to leave a logged-out caller able
    // to write, which is never the right decision.
    expect(SCRIPT).toContain('There is no allowlist for this one');
    const baseline = JSON.parse(read('scripts/ci/definer-exposure-baseline.json'));
    expect(baseline.anonWriters).toBeUndefined();
  });

  it('still reads an older database honestly instead of throwing', () => {
    // The RPC returned a bare array before it learned the second question. A
    // manifest-refresh run against a database without this migration must
    // report, not crash.
    expect(SCRIPT).toContain('Array.isArray(live) ? live : (live?.unauthenticated_writers ?? [])');
    expect(SCRIPT).toContain('Array.isArray(live) ? [] : (live?.anon_writers ?? [])');
  });

  it('fails the run when the count is anything but zero', () => {
    expect(SCRIPT).toContain('if (anonWriters.length > 0)');
    expect(SCRIPT).toContain('A LOGGED-OUT CALLER CAN EXECUTE A WRITING FUNCTION');
    expect(SCRIPT).toContain('(must be 0)');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A TABLE WITH RLS OFF HAS NO GUARD AT ALL: THE GRANT IS THE WHOLE STORY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The single ERROR-level Supabase advisory: spatial_ref_sys sits in `public`
 * with RLS disabled while anon and authenticated hold every write privilege.
 * Confirmed reachable with the public anon key - GET returns rows, OPTIONS
 * advertises POST - and find_live_games_nearby resolves coordinates through
 * PostGIS, so corrupting SRID 4326 breaks venue search for everybody.
 *
 * It could NOT be fixed from the MCP connection: the table is owned by
 * supabase_admin and the grants were made BY supabase_admin, so postgres's
 * REVOKE is a silent no-op and SET ROLE supabase_admin is denied 42501. Both
 * were tried. So it is baselined with that reasoning and watched daily, which
 * is the honest response to something you cannot close: make sure it cannot be
 * forgotten, and make sure a NEW one still fails loudly.
 */
describe('a table with RLS off that a browser can write is watched daily', () => {
  it('the audit asks the question', () => {
    expect(MIG3).toContain("'rls_disabled_writable'");
    expect(MIG3).toContain('NOT c.relrowsecurity');
    expect(MIG3).toContain("has_table_privilege('anon', c.oid, 'INSERT')");
    // The owner is reported, because the owner decides whether a REVOKE can work.
    expect(MIG3).toContain('pg_get_userbyid(c.relowner)');
  });

  it('the script fails on any table that is not baselined', () => {
    expect(SCRIPT).toContain('A TABLE WITH RLS OFF IS WRITABLE FROM A BROWSER');
    expect(SCRIPT).toContain('const newTables = rlsOffWritable.filter');
    expect(SCRIPT).toContain('(${newTables.length} new)');
  });

  it('and tells the reader why a REVOKE may do nothing', () => {
    // The trap that made the first attempt at this fix a silent no-op.
    expect(SCRIPT).toContain('A REVOKE only removes grants YOU made');
  });

  it('baselines spatial_ref_sys with what was actually tried', () => {
    const baseline = JSON.parse(read('scripts/ci/definer-exposure-baseline.json'));
    const why = baseline.reviewedTables?.spatial_ref_sys as string;
    expect(why).toBeTruthy();
    expect(why).toContain('42501');
    expect(why).toContain('silent no-op');
    expect(why).toContain('owner-level action');
  });

  it('does not pretend the advisory was resolved', () => {
    expect(MIG3).toContain('I COULD NOT FIX IT');
    expect(MIG3).toContain('SET LOCAL ROLE supabase_admin        -> 42501 permission denied');
  });
});

describe('four search paths are pinned, and said to be the smaller fix they are', () => {
  it('pins all four with ALTER FUNCTION rather than rewriting correct bodies', () => {
    for (const fn of ['fn_horse_hash(text)', 'fn_horse_hash_fnv(text)', 'fn_horse_lane(text)']) {
      expect(MIG3).toContain(`ALTER FUNCTION public.${fn}`);
    }
    expect(MIG3).toContain('fn_place_entitlement(numeric, anyelement, integer)');
    expect(MIG3).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it('says plainly that these are SECURITY INVOKER, so not the escalation shape', () => {
    // Overstating a small fix is how a report stops being worth reading.
    expect(MIG3).toContain('All four are SECURITY INVOKER');
    expect(MIG3).toContain('NOT the privilege-escalation shape');
  });

  it('proves the pin took instead of assuming it', () => {
    expect(MIG3).toContain("RAISE EXCEPTION 'search_path is still unpinned on: %', bad");
  });
});
