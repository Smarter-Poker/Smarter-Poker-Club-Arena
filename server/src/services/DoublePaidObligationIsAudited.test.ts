/**
 * The double-paid-obligation audit must stay wired, and stay bounty-blind.
 *
 * Three repair paths exist to make a short-paid player whole -
 * `overlay_backpay`, `reconcile`, `spin_backpay` - and each builds its
 * idempotency key out of its own name rather than out of the debt:
 *
 *   tourney:<tid>:overlay_backpay:<uid>
 *   tourney:<tid>:prize:<uid>:<place>:reconcile
 *
 * Same obligation, two names, so uq_tournament_payouts_idempotency_key cannot
 * collapse them and both pay. Measured 2026-09-02: 57 completed events in
 * seven days over-paid their prize pool by 3,808.52 chips, 56 obligations of
 * it provably this pattern.
 *
 * auditPrizeDisbursement already reported the TOTAL over-payment and had done
 * so for days without anyone being able to act, because it never named the
 * cause. This audit names the player, the place and the two paths. If it is
 * ever unwired the symptom returns to being an unattributable number.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RECONCILER = readFileSync(join(__dirname, 'FeeReconciler.ts'), 'utf8');
const GAMESERVER = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');

describe('double-paid prize obligations are audited', () => {
  it('exports the audit and calls the detector RPC', () => {
    expect(RECONCILER).toContain('export async function auditDoublePaidObligations(');
    expect(RECONCILER).toContain("supabase.rpc('fn_tournament_double_paid_obligations'");
  });

  it('raises a critical financial alert rather than repairing', () => {
    const fn = RECONCILER.slice(
      RECONCILER.indexOf('export async function auditDoublePaidObligations(')
    );
    const body = fn.slice(0, fn.indexOf('\nexport ') === -1 ? fn.length : fn.indexOf('\nexport '));
    expect(body).toContain(
      "raiseFinancialAlert('critical', 'FeeReconciler.double_paid_obligation'"
    );
    // Reporting only. Clawing back a payment from a player is Dan's decision,
    // so this must never gain an UPDATE/DELETE/insert-repair path.
    expect(body).not.toMatch(/\.(update|delete|upsert)\(/);
  });

  it('is invoked by the scheduled reconciler pass', () => {
    expect(GAMESERVER).toContain('auditDoublePaidObligations,');
    expect(GAMESERVER).toContain('await auditDoublePaidObligations(24);');
    // Must sit with the other tournament money audits, which run on the same
    // pass as auditPrizeDisbursement - the check it explains.
    const i = GAMESERVER.indexOf('await auditPrizeDisbursement(24);');
    const j = GAMESERVER.indexOf('await auditDoublePaidObligations(24);');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(j - i).toBeLessThan(900);
  });
});
