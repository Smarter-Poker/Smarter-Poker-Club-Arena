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

  it('holds only the two that were read line by line', () => {
    expect(Object.keys(baseline.reviewedExceptions).sort()).toEqual([
      'get_current_settlement_period',
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
  it('runs daily in the workflow that already holds the key', () => {
    expect(WF).toContain('node scripts/ci/audit-live-definer-exposure.mjs');
    expect(WF).toContain("cron: '20 5 * * *'");
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
