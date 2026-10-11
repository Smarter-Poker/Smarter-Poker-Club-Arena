-- the_paid_entry_restriction_guard_is_a_declared_money_trigger
--
-- Dan, 2026-10-10 01:09 CT: "do anything and everything you feel is necessary
-- to get us launch ready."
--
-- Migration 20261010053702 player_restrictions_converge_and_logout_is_durable
-- created four triggers that run fn_ca_refuse_restricted_entry and declared
-- three of them. The fourth, tournament_players.zz_restriction_tourney_paid_guard
-- (BEFORE UPDATE OF user_id, rebuys, add_on, status: a seat changing hands, a
-- rebuy, an add-on, or a re-entry), was left out of ca_declared_money_triggers,
-- so UndeclaredTriggerOnAMoneyTable fired at 05:40 UTC and paged the owner.
--
-- It is the same guard as its three declared siblings: it asks
-- fn_ca_assert_player_action whether a restricted player may take this paid
-- tournament action and refuses with insufficient_privilege if not. It moves
-- no money. This is its declaration and the proof the register no longer
-- lists it.
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('tournament_players', 'zz_restriction_tourney_paid_guard',
  'From migration 20261010053702 player_restrictions_converge_and_logout_is_durable: BEFORE UPDATE OF user_id, rebuys, add_on, status, it runs fn_ca_refuse_restricted_entry(''tournaments''), the same guard as the declared zz_restriction_tourney_guard, so a restricted player cannot take over a seat, rebuy, add on or re-enter a paid tournament. It refuses; it moves no money. Declared 2026-10-10 after its omission paged the owner at 05:40 UTC.')
ON CONFLICT DO NOTHING;

DO $prove$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_undeclared_money_triggers() u
              WHERE u.trigger_name = 'zz_restriction_tourney_paid_guard') THEN
    RAISE EXCEPTION 'PAID_ENTRY_RESTRICTION_GUARD_STILL_UNDECLARED';
  END IF;
END
$prove$;

COMMIT;