/**
 * ===========================================================================
 *  LAW: BOUNTIES USE OBLIGATIONS; REFUNDS USE EXACT FUNDING AUTHORITY
 * ===========================================================================
 *
 * Chip Accounting Standard 3.2 (MTT steps 5, 6 and 8) and rule R3. The
 * 2026-09-02 migration consolidated bounty payers behind tournament
 * obligations. Later exact-provenance authorities deliberately superseded
 * its refund routing: the generic eight-argument obligation dispatcher must
 * fail closed for kind=refund, wallet charges return only through
 * fn_settle_tournament_refund_exact, and noncash satellite/ticket entries
 * return only through fn_ca_return_satellite_entitlement_as_ticket.
 *
 * This law therefore keeps the original negative controls for the four
 * bounty payers and separately pins the executable current Stage-B refund
 * authority. It must never let the historical migration's generic refund
 * calls masquerade as the current contract.
 *
 * Measured before the migration (rolled-back probe on PKO f56e23ae): with
 * the knockout's idempotency key already spent, fn_collect_bounty paid
 * nothing and still wrote a 5.00 'bounty' ledger row (standard 2.6, the
 * phantom row). After: 0 rows unless chips moved, the obligation carries the
 * cumulative total, and every row stamps app.money_path.
 *
 * The pins are on the TEXT of the migration that carries the rule, so a later
 * CREATE OR REPLACE that starts from an older mirror cannot quietly bring a
 * direct credit back. Every pin is negative-controlled against the last
 * repo body of the same function.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIGRATION =
  'supabase/migrations/20260902222000_bounties_and_refunds_settle_through_obligations.sql';
const SQL = read(MIGRATION);
const cancellationSql = read(
  'supabase/migrations/20260909014444_tournament_cancellation_commits_one_stored_receipt.sql'
);
const contractionFiles = fs
  .readdirSync(path.join(process.cwd(), 'supabase/migrations'))
  .filter(
    (file) =>
      file.endsWith('_stage_b_current_postimage_contraction.sql') ||
      file.endsWith('_stage_b_current_postimage_contraction.sql.pending')
  );
if (contractionFiles.length !== 1) {
  throw new Error(
    `expected one staged-or-promoted Stage-B contraction, found ${contractionFiles.length}`
  );
}
const currentStageB = read(`supabase/migrations/${contractionFiles[0]}`);

/** The last CREATE FUNCTION or CREATE OR REPLACE FUNCTION body, by name. */
function functionBody(sql: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const definitions = [
    ...sql.matchAll(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION public\\.${escapedName}\\(`, 'g')),
  ];
  const start = definitions.at(-1)?.index ?? -1;
  expect(start, `${name} is defined in ${MIGRATION}`).toBeGreaterThan(-1);
  // Bodies are dollar-quoted with $function$, $fn$ or $$ depending on the
  // migration's author; the terminator is the same tag followed by ';'.
  const open = sql.slice(start).match(/\bAS\s+(\$[a-z_]*\$)/);
  expect(open, `${name} body is dollar-quoted`).not.toBeNull();
  const tag = open![1];
  const bodyStart = start + open!.index! + open![0].length;
  const end = sql.indexOf(`${tag};`, bodyStart);
  expect(end, `${name} body is terminated`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const PAYERS = [
  'fn_collect_bounty',
  'fn_finalize_bounty_pool',
  'fn_mystery_bounty_pay',
  'fn_mystery_bounty_settle',
] as const;

const BOUNTY_KINDS: Record<string, string> = {
  fn_collect_bounty: 'bounty',
  fn_finalize_bounty_pool: 'bounty_residual',
  fn_mystery_bounty_pay: 'mystery_bounty',
  fn_mystery_bounty_settle: 'mystery_bounty',
};

/** The direct credit primitives none of these bodies may call any more. */
const DIRECT_CREDIT = [
  /credit_player_wallet\(/,
  /fn_credit_and_log\(/,
  /log_wallet_transaction\(/,
  /fn_add_chips\(/,
  /UPDATE club_members/,
];

/**
 * NEGATIVE CONTROL: the last full repo body of each function before this
 * lane. Every pin below must fail against these, or it is not measuring the
 * rule. (atomic_tournament_unregister has no full body in the repo; its
 * live body was read with pg_get_functiondef and is quoted in the changelog.)
 */
const PREVIOUS: Record<string, string> = {
  fn_collect_bounty: read(
    'supabase/migrations/20260828023923_bounty_hybrid_tripwire_and_guarantee_alert_severity.sql'
  ),
  fn_finalize_bounty_pool: read(
    'supabase/migrations/20260829223000_the_bounty_residual_is_measured_from_the_ledger.sql'
  ),
  fn_mystery_bounty_pay: read(
    'supabase/migrations/20260830040000_a_settled_chest_cannot_be_paid_a_second_time.sql'
  ),
  fn_mystery_bounty_settle: read(
    'supabase/migrations/20260830040000_a_settled_chest_cannot_be_paid_a_second_time.sql'
  ),
};

describe('every bounty payer settles through the generic obligation function', () => {
  for (const name of PAYERS) {
    it(`${name} calls fn_settle_tournament_obligation and no direct credit primitive`, () => {
      const body = functionBody(SQL, name);
      expect(body).toMatch(/public\.fn_settle_tournament_obligation\(/);
      for (const primitive of DIRECT_CREDIT) {
        expect(body, `${name} must not call ${primitive}`).not.toMatch(primitive);
      }
    });
  }

  it('negative control: every previous body credited directly and never settled', () => {
    for (const [name, prev] of Object.entries(PREVIOUS)) {
      const body = functionBody(prev, name);
      expect(body, `${name} previous body`).not.toMatch(/fn_settle_tournament_obligation/);
      expect(
        DIRECT_CREDIT.some((p) => p.test(body)),
        `${name} previous body used a direct credit primitive`
      ).toBe(true);
    }
  });

  it('the migration asserts the same thing against pg_proc after apply', () => {
    expect(SQL).toMatch(/IF v_src NOT LIKE '%fn_settle_tournament_obligation\(%' THEN/);
    expect(SQL).toMatch(/still credits a player outside the obligation function/);
    for (const name of PAYERS) expect(SQL).toContain(`'${name}'`);
  });
});

describe('bounty obligations are user-keyed cumulative totals', () => {
  for (const [name, kind] of Object.entries(BOUNTY_KINDS)) {
    it(`${name} settles kind '${kind}' as (amount already paid on the row) + this award`, () => {
      const body = functionBody(SQL, name);
      expect(body).toMatch(
        new RegExp(
          `v_prior := COALESCE\\(\\(SELECT o\\.amount_paid FROM public\\.tournament_obligations o\\s+WHERE o\\.tournament_id = [a-z_.]+ AND o\\.kind = '${kind}'\\s+AND o\\.place IS NULL AND o\\.user_id = [a-z_.]+\\), 0\\);`
        )
      );
      expect(body).toMatch(new RegExp(`'${kind}', NULL, [a-z_.]+,\\s*round\\(v_prior \\+`));
    });
  }

  it('fn_collect_bounty refuses to record a share the obligation did not pay in full', () => {
    const body = functionBody(SQL, 'fn_collect_bounty');
    expect(body).toMatch(
      /IF round\(COALESCE\(\(v_settle->>'paid'\)::numeric, 0\), 2\) <> round\(v_cash, 2\) THEN\s+RAISE EXCEPTION/
    );
    expect(body).toMatch(
      /RAISE EXCEPTION 'fn_collect_bounty: bounty of % to % in tournament % refused/
    );
  });

  it('a refused residual or mystery settlement raises instead of voiding the chests unpaid', () => {
    expect(functionBody(SQL, 'fn_finalize_bounty_pool')).toMatch(
      /RAISE EXCEPTION 'fn_finalize_bounty_pool: residual of % to % in tournament % refused/
    );
    const settle = functionBody(SQL, 'fn_mystery_bounty_settle');
    const raiseAt = settle.indexOf("RAISE EXCEPTION 'fn_mystery_bounty_settle: residual");
    const voidAt = settle.indexOf("SET status = 'void'");
    expect(raiseAt).toBeGreaterThan(-1);
    expect(voidAt).toBeGreaterThan(raiseAt);
  });

  it('negative control: the previous fn_finalize_bounty_pool keyed the residual with no amount', () => {
    const prev = functionBody(PREVIOUS.fn_finalize_bounty_pool, 'fn_finalize_bounty_pool');
    expect(prev).toMatch(/':ownbounty:' \|\| p_winner_user_id/);
    expect(prev).not.toMatch(/tournament_obligations/);
  });
});

describe('refunds use exact funding-provenance authorities', () => {
  it('the generic dispatcher fails closed before reaching its legacy payer', () => {
    const generic = functionBody(currentStageB, 'fn_settle_tournament_obligation');
    const refusal = generic.indexOf("IF v_kind = 'refund' THEN");
    const legacy = generic.indexOf(
      'RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate('
    );
    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(generic.slice(refusal, legacy)).toContain("'exact_refund_authority_required'");
    expect(refusal).toBeLessThan(legacy);
  });

  it('cancellation returns wallet charges to their source wallet and noncash entries as tickets', () => {
    const cancel = functionBody(cancellationSql, 'atomic_cancel_tournament');
    expect(cancel).toMatch(
      /entitlement_kind='wallet_charge'[\s\S]*?fn_settle_tournament_refund_exact\([\s\S]*?v_entitlement\.refund_wallet_club_id/
    );
    expect(cancel).toMatch(
      /entitlement_kind IN \([\s\S]*?'satellite_seat','tournament_ticket'[\s\S]*?fn_ca_return_satellite_entitlement_as_ticket\(/
    );
    expect(cancel).not.toContain('fn_settle_tournament_obligation(');
  });

  it('unregistration settles exact cash/ticket entitlements before deleting the roster row', () => {
    const unregister = functionBody(
      currentStageB,
      'fn_ca_unregister_tournament_player_exact_seat_exit_core_v2'
    );
    const walletRefund = unregister.indexOf('public.fn_settle_tournament_refund_exact(');
    const ticketReturn = unregister.indexOf('public.fn_ca_return_satellite_entitlement_as_ticket(');
    const deleteAt = unregister.indexOf('DELETE FROM public.tournament_players');
    expect(walletRefund).toBeGreaterThanOrEqual(0);
    expect(ticketReturn).toBeGreaterThan(walletRefund);
    expect(deleteAt).toBeGreaterThan(ticketReturn);
    expect(unregister).not.toContain('public.fn_settle_tournament_obligation(');
    expect(unregister).toContain('v_ent.refund_wallet_club_id');
    expect(unregister).toContain("e.entitlement_kind IN ('satellite_seat','tournament_ticket')");
  });
});

describe('the engine-facing return shapes are unchanged', () => {
  it('fn_collect_bounty returns the keys TournamentManagerEliminations reads', () => {
    const body = functionBody(SQL, 'fn_collect_bounty');
    for (const key of [
      'ok',
      'mode',
      'funded',
      'head',
      'paid_cash',
      'added_to_head',
      'split',
      'shares',
      'capped',
      'pool_remaining',
    ]) {
      expect(body).toContain(`'${key}',`);
    }
    for (const reason of [
      'missing_party',
      'tournament_not_found',
      'not_a_bounty_tournament',
      'undefined_pko_mystery_hybrid',
      'mystery_phase_active',
      'already_collected',
      'eliminated_player_not_in_tournament',
      'no_head_value',
      'bounty_pool_exhausted',
    ]) {
      expect(body).toContain(`'reason', '${reason}'`);
      expect(functionBody(PREVIOUS.fn_collect_bounty, 'fn_collect_bounty')).toContain(
        `'reason', '${reason}'`
      );
    }
  });

  it('fn_mystery_bounty_settle still reports balance and variance; atomic_cancel_tournament still reports counts', () => {
    const settle = functionBody(SQL, 'fn_mystery_bounty_settle');
    for (const key of [
      'pool_cents',
      'settled_cents',
      'unclaimed_cents',
      'residual_paid_cents',
      'balanced',
      'variance_cents',
    ]) {
      expect(settle).toContain(`'${key}',`);
    }
    const cancel = functionBody(cancellationSql, 'atomic_cancel_tournament');
    for (const key of ['success', 'refunded_count', 'total_refunded', 'fees_reversed']) {
      expect(cancel).toContain(`'${key}',`);
    }
  });

  it('every ledger description string is the one the audits and the escrow shadow read', () => {
    for (const desc of [
      'PKO bounty (cash half) from eliminated player',
      'Bounty collected before the mystery phase opened',
      'Bounty collected from eliminated player',
      'Tournament champion: own bounty head collected',
      'Unclaimed bounty pool awarded to champion',
      'Mystery bounty revealed from eliminated player',
      'Unclaimed mystery bounty chests awarded to champion',
      'Tournament cancellation refund: ',
      'Tournament unregister refund: ',
      'Tournament unregistration refund: ',
      'Seat released: ',
    ]) {
      expect(SQL).toContain(desc);
    }
  });
});

describe('access is unchanged', () => {
  it('the engine-only payers stay service_role only', () => {
    for (const sig of [
      'fn_collect_bounty(uuid, uuid, uuid, jsonb)',
      'fn_finalize_bounty_pool(uuid, uuid)',
      'fn_mystery_bounty_pay(uuid)',
      'fn_mystery_bounty_settle(uuid, uuid)',
      'atomic_cancel_tournament(uuid, uuid)',
      'atomic_tournament_unregister(uuid, uuid, numeric)',
    ]) {
      expect(SQL).toContain(
        `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`
      );
      expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });

  it('the two player-facing refunds stay callable by authenticated', () => {
    for (const sig of ['fn_unregister_from_tournament(uuid)', 'fn_leave_seat_and_refund(uuid)']) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(SQL).toContain(
        `GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated, service_role;`
      );
    }
  });

  it('one migration, one transaction, no money moved by it', () => {
    expect(
      SQL.trim()
        .split('\n')
        .filter((l) => l.trim() === 'BEGIN;')
    ).toHaveLength(1);
    expect(SQL.trim().endsWith('COMMIT;')).toBe(true);
    // No INSERT INTO wallet_transactions / chip_ledger / UPDATE of a balance outside a function body.
    const outside = SQL.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, '').replace(
      /DO \$\$[\s\S]*?END \$\$;/g,
      ''
    );
    expect(outside).not.toMatch(
      /INSERT INTO (public\.)?(wallet_transactions|chip_ledger|club_members)/
    );
    expect(outside).not.toMatch(/UPDATE (public\.)?(club_members|tournaments|tournament_players)/);
  });
});
