import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => resolve(__dirname, '..', path);
const migration = '20260909183657_seat_first_unregistration_uses_actual_start_truth.sql';
const sql = readFileSync(root(`supabase/migrations/${migration}`), 'utf8');
const probe = readFileSync(
  root('scripts/ci/probes/seat-first-unregistration-actual-start.sql'),
  'utf8'
);
const schemaFragment = JSON.parse(
  readFileSync(
    root('scripts/ci/schema-manifest.d/codex-seat-first-unregistration-actual-start.json'),
    'utf8'
  )
) as { columns?: Record<string, string[]> };

function taggedBody(tag: string): string {
  const delimiter = `$${tag}$`;
  const first = sql.indexOf(delimiter);
  const second = sql.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return sql.slice(first + delimiter.length, second);
}

const receipt = taggedBody('actual_start_unregistration_receipt');
const unregister = taggedBody('actual_start_unregister_core');
const spinContract = taggedBody('seat_first_spin_contract');
const verify = taggedBody('verify_actual_start_unregistration');

describe('seat-first unregistration follows actual start truth', () => {
  it('treats Spins as their own product and ignores the expired fill-window clock', () => {
    expect(unregister).toContain("v_start_authority:='spin_actual_start'");
    expect(unregister).toMatch(
      /lower\(COALESCE\(v_t\.variant::text,''\)\)='spin'[\s\S]*?upper\(COALESCE\(v_t\.tournament_type::text,''\)\)='SPIN'/
    );
    expect(unregister).toContain('v_t.satellite_target_id IS NULL');
    expect(unregister).toMatch(
      /IF v_start_authority='scheduled_clock' THEN[\s\S]*?clock_timestamp\(\)>=v_t\.start_time/
    );
    expect(unregister).not.toMatch(
      /IF v_start_authority='spin_actual_start' THEN[\s\S]{0,900}?clock_timestamp\(\)>=v_t\.start_time/
    );
    expect(probe).toContain("'Spin Fill Window Expired But Not Started'");
    expect(probe).toContain("start_authority='spin_actual_start'");
  });

  it('keeps unfilled Spin pool contributions and refunds possible before the draw', () => {
    expect(spinContract).toContain("IN ('ANNOUNCED','REGISTERING')");
    expect(spinContract).toContain('OLD.started_at IS NULL');
    expect(spinContract).toContain('NEW.started_at IS NULL');
    expect(spinContract).toContain('r.completed_at IS NOT NULL');
    expect(spinContract).toContain("r.kind IN ('contribution','jackpot_draw')");
    expect(spinContract).toContain('COALESCE(NEW.spin_multiplier,0)=0');
    expect(spinContract).toContain('NEW.spin_locked_tiers IS NULL');
    expect(spinContract).not.toContain('start_time');
    expect(spinContract).toContain('published draw contract is immutable');
    expect(probe).toContain('Spin Fill Window Expired But Not Started');
  });

  it('treats Heads-Up Sit & Go as a distinct two-seat product', () => {
    expect(unregister).toContain("v_start_authority:='heads_up_sng_actual_start'");
    expect(unregister).toMatch(
      /upper\(COALESCE\(v_t\.tournament_type::text,''\)\)='SNG'[\s\S]*?COALESCE\(v_t\.max_players,0\)=2/
    );
    expect(unregister).toMatch(
      /v_start_authority='scheduled_clock'[\s\S]*?ELSE[\s\S]*?v_t\.started_at IS NOT NULL[\s\S]*?v_launch_completed_at IS NOT NULL/
    );
    expect(probe).toContain("'Heads-Up SNG Fill Window Expired But Not Started'");
    expect(probe).toContain("start_authority='heads_up_sng_actual_start'");
  });

  it('refuses both products once database launch truth says play started', () => {
    expect(unregister).toContain('v_t.started_at IS NOT NULL');
    expect(unregister).toContain('v_launch_completed_at IS NOT NULL');
    expect(unregister).toContain("'reason','tournament_started'");
    expect(unregister).toMatch(
      /SELECT r\.completed_at[\s\S]*?FROM public\.tournament_launch_receipts r[\s\S]*?WHERE r\.tournament_id=p_tournament_id/
    );
    expect(probe).toContain('spin_after_launch_refusal');
    expect(probe).toContain('heads_up_after_launch_refusal');
  });

  it('treats any persisted tournament hand as irreversible actual-start truth', () => {
    expect(unregister.match(/hh\.tournament_id=p_tournament_id/g)).toHaveLength(2);
    expect(
      unregister.match(/JOIN public\.hand_history hh ON hh\.table_id=hand_table\.id/g)
    ).toHaveLength(2);
    expect(unregister).toContain('v_persisted_hand_exists');
    expect(unregister).toContain(
      "RETURN jsonb_build_object('ok',false,'reason','tournament_started')"
    );
    expect(unregister).toContain("'tournament hand persisted before unregistration could commit'");
    expect(unregister.indexOf('hh.tournament_id=p_tournament_id')).toBeLessThan(
      unregister.indexOf('FROM public.tournament_refund_entitlements e')
    );

    expect(probe).toContain("'Spin Persisted Hand Refusal'");
    expect(probe).toContain("'Heads-Up SNG Persisted Hand Refusal'");
    expect(probe).toContain('spin_after_hand_refusal');
    expect(probe).toContain('heads_up_after_hand_refusal');
    expect(probe).toContain('table-linked legacy identity');
    expect(probe.trimEnd().endsWith('ROLLBACK;')).toBe(true);
  });

  it('records why the old scheduled cutoff did not govern the immutable receipt', () => {
    expect(sql).toContain('ADD COLUMN start_authority text');
    expect(sql).toContain("DEFAULT 'scheduled_clock'");
    expect(sql).toContain('tournament_unregistration_actual_start_check');
    expect(sql).toContain("start_authority='scheduled_clock'");
    expect(sql).toContain('settled_at<scheduled_start_at');
    expect(receipt).toContain("v_r.start_authority='scheduled_clock'");
    expect(receipt).toContain("v_r.start_authority='spin_actual_start'");
    expect(receipt).toContain("v_r.start_authority='heads_up_sng_actual_start'");
    expect(receipt).toContain('launch.completed_at<=v_r.settled_at');
    expect(receipt).toContain("'start_authority',v_r.start_authority");
    expect(schemaFragment.columns?.tournament_unregistration_receipts).toEqual(['start_authority']);
  });

  it('keeps wallet and ticket provenance inside the same atomic refund core', () => {
    expect(unregister).toContain("e.entitlement_kind='wallet_charge'");
    expect(unregister).toContain("e.entitlement_kind IN ('satellite_seat','tournament_ticket')");
    expect(unregister).toContain('v_ent.refund_wallet_club_id');
    expect(unregister).toContain('public.fn_ca_return_satellite_entitlement_as_ticket(');
    expect(receipt).toContain("'wallet_chips_from_satellite_entitlements',0");
    expect(unregister).toContain('INSERT INTO public.tournament_unregistration_receipts(');
    expect(unregister).toContain('v_start_authority,v_unregistered_at');
  });

  it('installs forward-only under a bounded lock and verifies the canonical bodies', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain("SET LOCAL lock_timeout = '10s';");
    expect(sql).toContain("hashtextextended('ca:tournament-terminal-settlement:v1',0)");
    expect(sql).toMatch(
      /LOCK TABLE public\.tournament_unregistration_receipts\s+IN SHARE ROW EXCLUSIVE MODE/
    );
    expect(verify).toContain('actual-start unregistration migration did not install exactly');
    expect(verify).toContain("position('spin_actual_start' IN v_unregister_source)=0");
    expect(verify).toContain("position('heads_up_sng_actual_start' IN v_unregister_source)=0");
    expect(verify).toContain(
      "position('hh.tournament_id=p_tournament_id' IN v_unregister_source)=0"
    );
    expect(verify).toContain("position('JOIN public.hand_history hh ON hh.table_id=hand_table.id'");
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
