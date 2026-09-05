/**
 * THE CONTROLS ENFORCE (chip standard Phase 6, 2026-09-05). Pinned on the four
 * Phase 6 migrations, mirrored byte-exact from production.
 *
 * LAW 1 (6.1) - A SETTLEMENT FROM OUTSIDE THE PLATFORM NEEDS AN APPROVED
 *   ADJUSTMENT. fn_settle_tournament_obligation refuses a source that is not
 *   engine.* or a registered platform source (ca_settle_sources) unless it
 *   names an approved ca_manual_adjustments row for this event, this player
 *   wallet, in chips, at least this amount; the row is settled with the
 *   payment and the obligation carries its id. fn_ca_adjustment_under_10_9
 *   writes the agent's row: actor the chip standard, approver Dan under his
 *   standing written grant, reason at least 200 characters naming the migration.
 * LAW 2 (6.2) - THE KILL SWITCH TRIPS ITSELF. ca_kill_switch_policy holds
 *   Dan's threshold (1,000 chips) per meter; the supply meter, the BBJ meter
 *   and the escrow drift check call fn_ca_kill_switch_trip, which opens the
 *   payout freezes (tournament_payouts, bbj_payouts), files a critical
 *   incident, pages, and never takes the meter down with it. A frozen
 *   tournament payout is refused with payout_frozen; a frozen jackpot payout
 *   is refused with a message the engine retries. Clearing stays human.
 * LAW 3 (6.3) - EVERY DETECTOR HAS AN OWNER, AN SLA AND A WAY TO RETIRE.
 *   ca_detector_registry; a retired detector files nothing; a transient
 *   finding auto-resolves when not seen again within its clear window; the
 *   tick marks past_target at the detector's own SLA; v_ca_alert_board.
 * LAW 3b (gate) - A DETECTOR THAT FILES WITHOUT A REGISTRY ROW REGISTERS
 *   ITSELF as unassigned: the board is built from the registry, so an
 *   unregistered source would be invisible, which is the one way this control
 *   could fail silently.
 * LAW 4b (gate) - A PRIZE_LIABILITY SIDE IS THE EVENT AND A TABLE_STACK SIDE
 *   IS THE TABLE, on every category (777 tournament fee settlements and every
 *   cash buy-in, add-on and cash-out named nothing until the gate).
 * LAW 4 (6.4) - EVERY LEG NAMES ITS HAND OR ITS EVENT. The enrich trigger
 *   reads app.ledger_hand_id / app.ledger_tournament_id, derives the hand from
 *   a bbj:<hand> settlement, and a spin's reserve legs carry the spin; the
 *   BBJ drop and the rake door stamp the hand. Dedupe belongs on the door,
 *   never on a leg that could be refused while its balance write stands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const load = (re: RegExp): string => {
  const f = readdirSync(MIG).find((n) => re.test(n));
  if (!f) throw new Error(`not mirrored: ${re}`);
  return readFileSync(resolve(MIG, f), 'utf8');
};
const fn = (sql: string, name: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('the controls enforce', () => {
  it('LAW 1: a settlement from outside the platform needs an approved adjustment', () => {
    const s = load(/^\d{14}_phase_6_1_a_settlement_outside_the_platform_needs_an_approve\.sql$/);
    const settle = fn(s, 'fn_settle_tournament_obligation');
    expect(settle).toMatch(
      /IF NOT \(v_src LIKE 'engine\.%' OR EXISTS \(SELECT 1 FROM public\.ca_settle_sources s WHERE s\.source = v_src\)\) THEN/
    );
    expect(settle).toMatch(/'refused_reason', 'adjustment_required'/);
    expect(settle).toMatch(/'refused_reason', 'adjustment_mismatch'/);
    expect(settle).toMatch(/OR v_adj\.status <> 'approved' OR v_adj\.asset <> 'chips'/);
    expect(settle).toMatch(
      /OR v_adj\.target_kind <> 'player_wallet' OR v_adj\.target_id IS DISTINCT FROM p_user_id/
    );
    expect(settle).toMatch(
      /UPDATE public\.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj\.id;/
    );
    expect(settle).toMatch(/adjustment_id = COALESCE\(adjustment_id, p_adjustment_id\)/);
    const adj = fn(s, 'fn_ca_adjustment_under_10_9');
    expect(adj).toMatch(/length\(btrim\(COALESCE\(p_reason, ''\)\)\) < 200/);
    expect(adj).toMatch(
      /'2d1cd6c3-5700-4af9-a271-d4863fdab20d', 'Dan, standing written approval under CLAUDE\.md 10\.9/
    );
    expect(s).toMatch(
      /ALTER TABLE public\.tournament_obligations ADD COLUMN IF NOT EXISTS adjustment_id uuid REFERENCES public\.ca_manual_adjustments\(id\)/
    );
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_settle_sources/);
  });

  it('LAW 2: the kill switch trips itself at the threshold and the payout doors read the freeze', () => {
    const s = load(/^\d{14}_phase_6_2_the_kill_switch_trips_itself_at_a_thousand_chips\.sql$/);
    expect(s).toMatch(/\('fn_ca_supply_snapshot', 1000,/);
    expect(s).toMatch(/\('fn_bbj_reconcile', 1000,/);
    expect(s).toMatch(/\('fn_ca_escrow_balance_drift', 1000,/);
    const trip = fn(s, 'fn_ca_kill_switch_trip');
    expect(trip).toMatch(
      /IF NOT FOUND OR NOT pol\.armed OR p_amount IS NULL OR abs\(p_amount\) < pol\.threshold_chips THEN\s+RETURN false;/
    );
    expect(trip).toMatch(
      /INSERT INTO public\.ca_payout_freeze \(scope, reason, opened_by, opened_by_label\)/
    );
    expect(trip).toMatch(/'kill-switch:' \|\| p_detector \|\| ':' \|\| v_hour/);
    expect(trip).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(fn(s, 'fn_ca_supply_snapshot')).toMatch(
      /PERFORM public\.fn_ca_kill_switch_trip\('fn_ca_supply_snapshot', v_unexplained,/
    );
    expect(fn(s, 'fn_bbj_reconcile_all')).toMatch(
      /PERFORM public\.fn_ca_kill_switch_trip\('fn_bbj_reconcile', v_two,/
    );
    expect(fn(s, 'fn_ca_escrow_balance_drift')).toMatch(
      /PERFORM public\.fn_ca_kill_switch_trip\('fn_ca_escrow_balance_drift', v_gap,/
    );
    expect(fn(s, 'bbj_atomic_payout_v2')).toMatch(
      /f\.scope = 'bbj_payouts' AND f\.cleared_at IS NULL/
    );
    expect(fn(s, 'bbj_atomic_payout_v2')).toMatch(/USING ERRCODE = 'P0404'/);
    expect(s).toMatch(/'tournament_payouts'::text, 'bbj_payouts'::text/);
  });

  it('LAW 3: every detector has an owner, an SLA and a way to retire', () => {
    const s = load(/^\d{14}_phase_6_3_every_detector_has_an_owner_an_sla_and_a_way_to_re\.sql$/);
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_detector_registry/);
    expect(s).toMatch(/status IN \('active', 'retired'\)/);
    expect(fn(s, 'fn_ca_raise_drift_incident')).toMatch(
      /WHERE r\.source = p_source AND r\.status = 'retired'\) THEN\s+RETURN NULL;/
    );
    const tick = fn(s, 'fn_ca_incident_escalation_tick');
    expect(tick).toMatch(/auto-resolved on clear/);
    expect(tick).toMatch(
      /COALESCE\(i\.last_seen_at, i\.detected_at\) < now\(\) - make_interval\(hours => r\.auto_resolve_hours\)/
    );
    expect(tick).toMatch(/IF age_min >= v_sla \* 60 AND inc\.past_target IS NOT TRUE THEN/);
    expect(s).toMatch(/WHERE source = 'fn_ca_settle_hand_stacks_absolute'/);
    expect(s).toMatch(/WHERE source = 'fn_ca_escrow_vs_counter_check'/);
    expect(s).toMatch(/CREATE OR REPLACE VIEW public\.v_ca_alert_board AS/);
    expect(s).not.toMatch(/fn_ca_escrow_vs_counter_check\(3, 5\)/);
  });

  it('LAW 3b: a detector that files without a registry row registers itself, so the board cannot miss one', () => {
    const s = load(/^\d{14}_phase_6_gate_no_detector_is_unowned_and_every_leg_names_its_\.sql$/);
    const r = fn(s, 'fn_ca_raise_drift_incident');
    expect(r).toMatch(
      /INSERT INTO public\.ca_detector_registry \(source, owner, sla_hours, note\)\s+VALUES \(p_source, 'unassigned', 24, 'auto-registered on first sight \(Phase 6 gate\); give it an owner'\)\s+ON CONFLICT \(source\) DO NOTHING;/
    );
    // the retired check still comes first: a retired detector registers nothing and files nothing
    expect(r.indexOf("r.status = 'retired'")).toBeLessThan(
      r.indexOf('auto-registered on first sight')
    );
    expect(s).toMatch(/RAISE EXCEPTION '% incident sources are not on the board'/);
  });

  it('LAW 4b: a prize_liability side is the event and a table_stack side is the table, on every category', () => {
    const s = load(/^\d{14}_phase_6_gate_no_detector_is_unowned_and_every_leg_names_its_\.sql$/);
    const e = fn(s, 'fn_ca_chip_ledger_enrich');
    expect(e).toMatch(
      /IF NEW\.from_type = 'prize_liability' THEN NEW\.tournament_id := NEW\.from_entity_id;\s+ELSIF NEW\.to_type = 'prize_liability' THEN NEW\.tournament_id := NEW\.to_entity_id;/
    );
    expect(e).toMatch(
      /IF NEW\.to_type = 'table_stack' THEN NEW\.table_id := NEW\.to_entity_id;\s+ELSIF NEW\.from_type = 'table_stack' THEN NEW\.table_id := NEW\.from_entity_id;/
    );
    // the caller's own stamp always wins
    expect(e).toMatch(/IF NEW\.tournament_id IS NULL THEN/);
    expect(e).toMatch(/IF NEW\.table_id IS NULL THEN/);
  });

  it('LAW 4: every leg names its hand or its event, and dedupe stays on the door', () => {
    const s = load(/^\d{14}_phase_6_4_every_leg_names_its_hand_or_its_event\.sql$/);
    const enr = fn(s, 'fn_ca_chip_ledger_enrich');
    expect(enr).toMatch(
      /NEW\.hand_id := NULLIF\(current_setting\('app\.ledger_hand_id', true\), ''\)::uuid;/
    );
    expect(enr).toMatch(/NEW\.settlement_id ~ '\^bbj:\[0-9a-f\]\{8\}/);
    expect(enr).not.toMatch(/\^\(rake\|bbj\):/);
    expect(enr).toMatch(
      /IF NEW\.category = 'spin_entry' AND NEW\.from_type = 'prize_liability' THEN NEW\.tournament_id := NEW\.from_entity_id;/
    );
    expect(fn(s, 'bbj_record_contribution')).toMatch(/'bbj:' \|\| p_hand_id::text/);
    expect(fn(s, 'atomic_distribute_rake')).toMatch(
      /set_config\('app\.ledger_hand_id', COALESCE\(p_hand_id::text, ''\), true\)/
    );
    // no unique key is imposed on the legs: a refused leg beside a standing balance write is the failure this standard forbids
    expect(s).not.toMatch(/CREATE UNIQUE INDEX/);
  });
});
