/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - STAFF RUN A DIAMOND GAME, ON THE RECORD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 4 (staff-only game
 * configuration). Platform staff can edit an empty Diamond cash table, close
 * one no seat holds custody at, remove a player from a Diamond event through
 * the estate's one withdrawal authority, cancel a Diamond event through the
 * existing Diamond cancellation, and open a Diamond seat-first board (a Spin or
 * a heads-up sit-and-go) with its table in one transaction. Every Diamond
 * configuration door - the five that existed and the five new ones - files one
 * admin_audit_log row naming its operator, with the row before and after.
 *
 * The club-role gate (fn_can_create_games) is not touched: widening it would
 * hand Diamond games to club roles and undo Phase 2. The one chip function
 * that changes, the managed lifecycle guard, changes in place and opens for
 * one named event in the staff door's own transaction only.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_staff_run_a_diamond_game_on_the_record.sql'))
  .at(-1);
if (!NAME) throw new Error('the staff doors migration is missing');
const MIG = migrationText(NAME);
const DOCTRINE_NAME = migrationNames()
  .filter((n) => n.endsWith('_the_staff_diamond_cancellation_is_a_reviewed_lane_authority.sql'))
  .at(-1);
if (!DOCTRINE_NAME) throw new Error('the lane doctrine follow-up migration is missing');
const DOCTRINE = migrationText(DOCTRINE_NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const EXPECTS = section(
  '-- 0. THE ESTATE THIS MIGRATION EXPECTS',
  '-- 1. THE NEW NAMES ARE DECLARED BEFORE THEY EXIST'
);
const REGISTRY = section(
  '-- 1. THE NEW NAMES ARE DECLARED BEFORE THEY EXIST',
  '-- 2. ONE AUDIT HOME'
);
const AUDIT = section(
  '-- 2. ONE AUDIT HOME',
  '-- 3. THE FOUR TABLE DOORS THAT EXIST GO ON THE RECORD'
);
const TABLE_DOORS = section(
  '-- 3. THE FOUR TABLE DOORS THAT EXIST GO ON THE RECORD',
  '-- 4. THE CREATION DOOR GOES ON THE RECORD'
);
const CREATION = section(
  '-- 4. THE CREATION DOOR GOES ON THE RECORD',
  '-- 4b. THE MANAGED LIFECYCLE GUARD ADMITS THE STAFF CANCELLATION OF ONE EVENT'
);
const GUARD = section(
  '-- 4b. THE MANAGED LIFECYCLE GUARD ADMITS THE STAFF CANCELLATION OF ONE EVENT',
  '-- 5. AN EMPTY DIAMOND CASH TABLE CAN BE EDITED'
);
const EDIT = section(
  '-- 5. AN EMPTY DIAMOND CASH TABLE CAN BE EDITED',
  '-- 6. A DIAMOND CASH TABLE CAN BE CLOSED WHEN NO SEAT HOLDS CUSTODY'
);
const CLOSE = section(
  '-- 6. A DIAMOND CASH TABLE CAN BE CLOSED WHEN NO SEAT HOLDS CUSTODY',
  '-- 7. A PLAYER CAN BE REMOVED FROM A DIAMOND EVENT'
);
const REMOVE = section(
  '-- 7. A PLAYER CAN BE REMOVED FROM A DIAMOND EVENT',
  '-- 8. STAFF CAN CANCEL A DIAMOND EVENT'
);
const CANCEL = section(
  '-- 8. STAFF CAN CANCEL A DIAMOND EVENT',
  '-- 9. A DIAMOND SEAT-FIRST BOARD OPENS WITH ITS TABLE'
);
const BOARD = section(
  '-- 9. A DIAMOND SEAT-FIRST BOARD OPENS WITH ITS TABLE',
  '-- 10. THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 10. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});
const count = (s: string, needle: string) => s.split(needle).length - 1;

const NEW_DOORS = {
  fn_poker_diamond_edit_cash_table: [
    EDIT,
    'uuid, text, integer, integer, integer, integer, integer',
  ],
  fn_poker_diamond_close_cash_table: [CLOSE, 'uuid'],
  fn_poker_diamond_remove_tournament_player: [REMOVE, 'uuid, uuid, uuid'],
  fn_poker_diamond_cancel_tournament: [CANCEL, 'uuid'],
  fn_poker_diamond_create_seat_first_board: [BOARD, 'jsonb'],
} as const;

describe('LAW: staff run a Diamond game, on the record', () => {
  it('opens no switch, prices nothing and leaves the club-role gate alone', () => {
    expect(code(MIG)).not.toMatch(/SET\s+(tournaments_enabled|cash_games_enabled)\s*=\s*true/i);
    expect(MIG).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.fn_can_create_games/);
    expect(MIG).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.is_club_admin/);
    expect(EXPECTS).toContain(
      "('public.fn_can_create_games(uuid,uuid)', 'a79e8264252e7f05bc2103a6ee8718f1')"
    );
    expect(FINAL).toContain("'a79e8264252e7f05bc2103a6ee8718f1'");
    expect(FINAL).toContain('fn_can_create_games moved; this migration must not widen it');
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    // staff lobby posting stays refused (Dan's decision 4)
    expect(code(MIG)).not.toMatch(/fn_manage_club_announcement|fn_save_club_identity_messages/);
  });

  it('declares every new name before it exists', () => {
    for (const name of [
      'fn_poker_diamond_staff_audit',
      'fn_poker_diamond_audit_tournament_created',
      ...Object.keys(NEW_DOORS),
    ]) {
      expect(REGISTRY).toContain(`('${name}', `);
      expect(EXPECTS).toContain(`'${name}'`);
    }
    expect(REGISTRY).toContain("('fn_poker_diamond_remove_tournament_player', 'approved',");
    expect(REGISTRY).toContain("('fn_poker_diamond_cancel_tournament', 'approved',");
  });

  it('has one audit home: admin_audit_log through fn_log_admin_action, for a platform operator only', () => {
    expect(AUDIT).toContain('RETURN public.fn_log_admin_action(');
    expect(AUDIT).toContain('IF v_actor IS NULL OR NOT public.fn_is_platform_admin() THEN');
    expect(AUDIT).toContain(
      "OR p_target_type IS NULL OR p_target_type NOT IN ('diamond_table','diamond_tournament')"
    );
    expect(AUDIT).toContain(
      "WHERE a.key <> 'updated_at' AND a.value IS DISTINCT FROM p_before -> a.key;"
    );
    for (const sig of [
      'fn_poker_diamond_staff_audit(text, text, uuid, jsonb, jsonb, jsonb)',
      'fn_poker_diamond_audit_tournament_created(jsonb)',
    ]) {
      expect(AUDIT).toContain(
        `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated, service_role;`
      );
    }
    expect(AUDIT).not.toContain('GRANT ');
    expect(code(MIG)).not.toMatch(
      /INSERT\s+INTO\s+public\.(admin_audit_log|table_settings_changes)/i
    );
  });

  it('puts the four table doors that exist on the record, pinned and redefined with the same signature', () => {
    for (const [sig, pin] of [
      [
        'fn_poker_diamond_open_cash_table(text,integer,integer,integer,integer,integer,text)',
        'f45465677a693da31100898b465b8210',
      ],
      [
        'fn_poker_diamond_set_table_straddle(uuid,boolean,boolean)',
        'ce002ad2be7891a84f489d58a1db24f9',
      ],
      ['fn_poker_diamond_set_table_run_it_twice(uuid,boolean)', '6ff7bcb1b51da39d7f1f998605b56ebe'],
      [
        'fn_poker_diamond_set_table_bomb_pot(uuid,boolean,integer,smallint)',
        'c1ebcba27664f73cec418400f33d22c1',
      ],
    ]) {
      expect(EXPECTS).toContain(`('public.${sig}', '${pin}')`);
    }
    for (const header of [
      "CREATE OR REPLACE FUNCTION public.fn_poker_diamond_open_cash_table(p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer DEFAULT 6, p_game_variant text DEFAULT 'nlh'::text)",
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_straddle(p_table_id uuid, p_enabled boolean, p_auto_utg boolean DEFAULT false)',
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_run_it_twice(p_table_id uuid, p_enabled boolean)',
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_bomb_pot(p_table_id uuid, p_enabled boolean, p_ante_multiplier integer DEFAULT 2, p_board_count smallint DEFAULT 1)',
    ]) {
      expect(TABLE_DOORS).toContain(header);
    }
    for (const action of ['table_open', 'table_straddle', 'table_run_it_twice', 'table_bomb_pot']) {
      expect(count(TABLE_DOORS, `fn_poker_diamond_staff_audit('diamond.${action}'`)).toBe(1);
    }
    // the open door writes its operator on the row it opens
    expect(TABLE_DOORS).toContain('cap_enabled,\n    created_by\n  ) VALUES (');
    expect(TABLE_DOORS).toContain('false, false, false, false, false,\n    v_actor\n  )');
    // every refusal they had, they still have
    expect(count(TABLE_DOORS, "RAISE EXCEPTION 'diamond_table_staff_only'")).toBe(4);
    expect(count(TABLE_DOORS, "RAISE EXCEPTION 'diamond_plain_cash_table_required'")).toBe(3);
    expect(TABLE_DOORS).toContain("RAISE EXCEPTION 'diamond_table_would_not_be_admitted'");
    expect(TABLE_DOORS).not.toMatch(/GRANT EXECUTE[^\n]*\banon\b/);
  });

  it('puts the shared creation door on the record in place: both answers wrapped, nothing else moved', () => {
    expect(pinnedEdits(CREATION)).toEqual({ pins: 1, reversals: 1 });
    expect(CREATION).toContain("'11cd470d16bc4cd343e3e38b70caff76'");
    expect(CREATION).toContain(
      'RETURN public.fn_poker_diamond_audit_tournament_created(public.fn_poker_diamond_create_spin(p_config, v_arena));'
    );
    expect(CREATION).toContain(
      "RETURN public.fn_poker_diamond_audit_tournament_created(jsonb_build_object('success',true,'tournamentId',v_id,"
    );
    expect(CREATION).toContain('EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);');
    expect(MIG).not.toContain(
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_tournament'
    );
    expect(FINAL).toContain('the creation door does not file its audit row on both of its answers');
  });

  it('opens the managed lifecycle guard for one named event only, in place', () => {
    expect(pinnedEdits(GUARD)).toEqual({ pins: 1, reversals: 1 });
    expect(GUARD).toContain("'e4e6dbe534f8ed1fc7fa03fcad968114'");
    expect(GUARD).toContain(
      "AND COALESCE(current_setting('app.poker_diamond_staff_cancel', true), '') IS DISTINCT FROM NEW.id::text THEN"
    );
    expect(
      count(
        GUARD,
        "RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'"
      )
    ).toBe(2);
    // only the staff cancellation door names an event, and it clears it again
    expect(count(code(MIG), "set_config('app.poker_diamond_staff_cancel'")).toBe(2);
    expect(CANCEL).toContain(
      "PERFORM set_config('app.poker_diamond_staff_cancel', p_tournament_id::text, true);"
    );
    expect(CANCEL).toContain("PERFORM set_config('app.poker_diamond_staff_cancel', '', true);");
    expect(FINAL).toContain('the lifecycle guard is not as this migration states');
  });

  it('gives each new door a platform operator, a live session, one audit row and a signed-in grant only', () => {
    for (const [name, [body, sig]] of Object.entries(NEW_DOORS)) {
      expect(body).toContain(`CREATE FUNCTION public.${name}(`);
      expect(body).toContain(' SECURITY DEFINER');
      expect(body).toContain('IF NOT public.fn_is_platform_admin() THEN');
      expect(body).toContain('IF NOT public.fn_caller_session_is_live() THEN');
      expect(body).toContain(
        "RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';"
      );
      expect(count(body, 'public.fn_poker_diamond_staff_audit(')).toBe(1);
      expect(body).toContain(
        `REVOKE ALL ON FUNCTION public.${name}(${sig}) FROM PUBLIC, anon, authenticated, service_role;`
      );
      expect(body).toContain(
        `GRANT EXECUTE ON FUNCTION public.${name}(${sig}) TO authenticated, service_role;`
      );
    }
    expect(FINAL).toContain(
      'the five new doors do not each ask for staff, a live session and an audit row'
    );
    expect(FINAL).toContain('is reachable without an account');
    expect(FINAL).toContain('is reachable from outside the doors; it is owner-only');
  });

  it('edits only an empty table and re-proves it plain as written', () => {
    expect(EDIT).toContain(
      "IF lower(COALESCE(v_t.status,'')) <> 'waiting' OR COALESCE(v_t.current_players,0) <> 0"
    );
    expect(EDIT).toContain(
      "WHERE c.purpose='cash_seat' AND c.target_id=p_table_id AND c.state<>'released') THEN"
    );
    expect(EDIT).toContain("RAISE EXCEPTION 'diamond_table_must_be_empty_to_edit'");
    expect(EDIT).toContain('OR v_after.small_blind >= v_after.big_blind');
    expect(EDIT).toContain('OR v_after.big_blind > v_after.min_buy_in');
    expect(EDIT).toContain("WHEN 'plo6' THEN 6 WHEN 'plo5' THEN 7 WHEN 'plo4' THEN 8");
    expect(EDIT).toContain('IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN');
    expect(EDIT).toContain('IF NOT public.fn_poker_diamond_plain_cash_table(v_row) THEN');
    expect(EDIT).toContain('FOR UPDATE OF t;');
  });

  it('closes a table only when no seat holds custody and nobody sits', () => {
    expect(CLOSE).toContain("RAISE EXCEPTION 'diamond_table_seat_holds_custody'");
    expect(CLOSE).toContain("RAISE EXCEPTION 'diamond_table_has_a_seated_player'");
    expect(CLOSE.indexOf('diamond_table_seat_holds_custody')).toBeLessThan(
      CLOSE.indexOf("UPDATE public.tables SET status='closed', current_players=0")
    );
    expect(CLOSE).toContain('FOR UPDATE OF t;');
  });

  it('removes a player through the one withdrawal authority, in its own lock order', () => {
    const body = code(REMOVE);
    expect(body).toContain('public.fn_ca_unregister_tournament_player_exact(');
    expect(body.indexOf('PERFORM public.fn_ca_lock_mtt_admission_contract();')).toBeLessThan(
      body.indexOf('PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);')
    );
    expect(
      body.indexOf('PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);')
    ).toBeLessThan(
      body.indexOf('FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;')
    );
    expect(body).toContain("AND NOT COALESCE((v_result->>'replayed')::boolean, false) THEN");
    expect(body).not.toMatch(/fn_poker_diamond_tournament_(refund|unregister)\(/);
  });

  it('cancels through the existing Diamond cancellation, lane first', () => {
    const body = code(CANCEL);
    expect(body.indexOf('PERFORM public.fn_ca_lock_settlement_lane_global();')).toBeLessThan(
      body.indexOf('FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;')
    );
    expect(body).toContain(
      'v_receipt := public.fn_poker_diamond_tournament_cancel(p_tournament_id, v_actor);'
    );
    expect(body).toContain("PERFORM set_config('app.managed_game_lifecycle', 'on', true);");
    expect(body).toContain("PERFORM set_config('app.managed_game_lifecycle', '', true);");
    expect(body).toContain('IF NOT v_replay THEN');
  });

  it('opens a seat-first board through the creation door, with its one table, in the same transaction', () => {
    const body = code(BOARD);
    expect(body).toContain(
      "IF NOT (v_type = 'spin' OR (v_type = 'sng' AND COALESCE(p_config->>'maxPlayers', '') = '2')) THEN"
    );
    expect(body.indexOf('diamond_board_requires_a_spin_or_a_heads_up_sit_and_go')).toBeLessThan(
      body.indexOf('v_result := public.fn_poker_diamond_create_tournament(p_config);')
    );
    expect(body).toContain('OR NOT public.fn_ca_tournament_recorded_seat_first(v_id, false) THEN');
    expect(body).toContain(
      "v_t.club_id, v_id, v_t.name, 'tournament', lower(v_t.game_type), v_sb::text || '/' || v_bb::text,"
    );
    expect(body).toContain("v_t.max_players, 0, 'waiting', v_actor)");
    expect(body).toContain("RAISE EXCEPTION 'diamond_board_requires_exactly_one_joinable_table'");
    expect(body).not.toMatch(/INSERT\s+INTO\s+public\.tournaments/i);
    expect(body).not.toContain('poker_diamond_spin_reserve_source');
  });

  it("puts the staff cancellation on the settlement lane doctrine's reviewed list, in place", () => {
    // the cancellation door is the one new caller of the global lane
    expect(count(code(MIG), 'PERFORM public.fn_ca_lock_settlement_lane_global();')).toBe(1);
    expect(code(CANCEL)).toContain('PERFORM public.fn_ca_lock_settlement_lane_global();');
    expect(pinnedEdits(DOCTRINE)).toEqual({ pins: 1, reversals: 1 });
    expect(DOCTRINE).toContain("'9508891e4815a9bdb13a51f231a75de5'");
    expect(DOCTRINE).toContain(
      "'fn_get_tournament_deal_consensus','fn_mystery_bounty_settle','fn_poker_diamond_cancel_tournament',"
    );
    expect(DOCTRINE).toContain('v_answer := public.fn_ca_settlement_lane_doctrine();');
    expect(DOCTRINE).toContain('the settlement lane doctrine does not hold');
    expect(DOCTRINE).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
  });

  it('asserts at the end that the identity is whole and every watched guard is on its baseline', () => {
    expect(FINAL).toContain('does not file its audit row as this migration states');
    expect(FINAL).toContain('the open door does not write its operator to created_by');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });
});
