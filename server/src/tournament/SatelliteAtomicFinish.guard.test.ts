import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const SQL = readFileSync(
  join(
    root,
    'supabase/migrations/20260907205500_a_satellite_finish_pays_one_frozen_entitlement_plan.sql'
  ),
  'utf8'
);
const MANAGER = readFileSync(join(here, 'TournamentManager.ts'), 'utf8');
const ELIMINATIONS = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
const MANIFEST = readFileSync(
  join(root, 'scripts/ci/schema-manifest.d/tournament-finish-certificate.json'),
  'utf8'
);

function body(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const end = SQL.indexOf('$function$;', SQL.indexOf('AS $function$', start));
  expect(end, `${name} closes`).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe('a satellite finish has one frozen economic authority', () => {
  it('freezes target price and funded seat promise when the source starts', () => {
    const capture = body('trg_capture_satellite_economics_on_start');
    expect(SQL).toContain(
      'CREATE TABLE IF NOT EXISTS public.tournament_satellite_economic_snapshots'
    );
    expect(capture).toContain('NEW.satellite_seats');
    expect(capture).toContain('v_target.buy_in_amount');
    expect(capture).toContain('v_target.buy_in_fee');
    expect(capture).toContain('NEW.prize_pool');
    expect(capture).toContain('satellite cannot start: funded pool');
  });

  it('materializes one contiguous immutable plan consumed by H4H and finish', () => {
    const materialize = body('fn_materialize_satellite_entitlements_locked');
    expect(materialize).toContain('generate_series(1,v_expected_depth)');
    expect(materialize).toContain('v_economics.ticket_value');
    expect(materialize).not.toMatch(/v_target\.(buy_in_amount|buy_in_fee)/);
    expect(body('fn_get_tournament_satellite_entitlement_depth')).toContain(
      'fn_materialize_satellite_entitlements_locked'
    );
    expect(body('fn_settle_satellite_finish_atomic')).toContain(
      'fn_materialize_satellite_entitlements_locked'
    );
  });
});

describe('the atomic finalizer cannot certify partial money', () => {
  const settle = body('fn_settle_satellite_finish_atomic');
  const check = body('fn_check_atomic_satellite_finish');

  it('runs common rake and bounty proofs before the payout subtransaction', () => {
    expect(settle.indexOf("'satellite_rake_not_settled'")).toBeLessThan(
      settle.indexOf('FOR e IN SELECT * FROM public.tournament_satellite_entitlements')
    );
    expect(settle.indexOf("'satellite_bounty_not_certified'")).toBeLessThan(
      settle.indexOf('FOR e IN SELECT * FROM public.tournament_satellite_entitlements')
    );
    expect(check).toContain("'satellite_escrow_not_zero'");
  });

  it('checks its own writes with a fresh command snapshot before COMPLETED', () => {
    expect(check).toMatch(/LANGUAGE plpgsql\s+VOLATILE/);
    expect(settle.indexOf('fn_check_atomic_satellite_finish')).toBeLessThan(
      settle.indexOf("SET status='COMPLETED'")
    );
    expect(settle).toContain('on_break=false');
  });

  it('records combined ticket plus remainder value on the one finisher row', () => {
    expect(settle).toContain('SET prize=round(e.ticket_value+e.remainder_value,2)');
    expect(check).toContain('round(e.ticket_value+e.remainder_value,2)');
  });

  it('proves an adopted legacy seat was fully backed, never merely present', () => {
    const deliver = body('fn_deliver_satellite_ticket_exact');
    expect(deliver).toContain('existing target seat has no exact fully-backed payout event');
    expect(deliver).toContain("l.metadata->>'moved'");
    expect(deliver).toContain("l.metadata->>'unbacked'");
    expect(deliver).toContain('v_ledger_count<>1');
  });
});

describe('the engine and ACL expose only the atomic doors', () => {
  it('calls the atomic RPC after bounty and rake, and fails closed', () => {
    expect(MANAGER).toContain("supabase.rpc('fn_settle_satellite_finish_atomic'");
    expect(MANAGER).not.toContain("supabase.rpc('fn_award_satellite_seat'");
    const finish = ELIMINATIONS.slice(ELIMINATIONS.indexOf('protected async finishTournament'));
    expect(finish.indexOf('recoverPendingBountyObligations')).toBeLessThan(
      finish.indexOf('settleTournamentRake(tournament)')
    );
    expect(finish.indexOf('settleTournamentRake(tournament)')).toBeLessThan(
      finish.indexOf('processSatelliteAwards(tournament)')
    );
    expect(finish).toMatch(/if \(isSatelliteFinish && !\(await this\.processSatelliteAwards/);
  });

  it('keeps browser roles out and gives service no table mutation grants', () => {
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)'
    );
    expect(SQL).toContain('FROM PUBLIC,anon,authenticated');
    expect(SQL).toContain('TO service_role');
    expect(SQL).not.toMatch(
      /GRANT (INSERT|UPDATE|DELETE|ALL).*tournament_satellite_(economic_snapshots|entitlements|settlement_batches)/
    );
  });

  it('publishes every new table and public RPC through the schema manifest', () => {
    for (const name of [
      'tournament_satellite_economic_snapshots',
      'tournament_satellite_entitlements',
      'tournament_satellite_settlement_batches',
      'fn_get_tournament_satellite_entitlement_depth',
      'fn_check_atomic_satellite_finish',
      'fn_settle_satellite_finish_atomic',
    ]) {
      expect(MANIFEST).toContain(`"${name}"`);
    }
  });
});
