"""Exercise the installed played-Spin read proof with controlled evidence inputs.

These cases certify predicate composition and receipt replay, not the writers
that produce hands, seats, funding journals or escrow in production.
"""
import json


def run_played_proof_cases(q, check, rpc, uid, n):
    tournament = uid(n)
    proof_sql = f"public.fn_prove_played_spin_launch_recovery('{tournament}')"
    proof = json.loads(q('SELECT ' + proof_sql))
    check('installed played proof accepts three paid identities and two conserved live stacks',
          proof['ok'] is True and proof['original_field'] == 3
          and proof['active_field'] == 2 and proof['paid_users'] == 3
          and proof['hand_count'] == 1 and proof['roster_chips'] == 900
          and proof['seat_chips'] == 900
          and len(proof['original_player_ids']) == 3
          and len(proof['active_player_ids']) == 2)

    cases = [
        ('missing persisted hand',
         f"DELETE FROM public.hand_history WHERE tournament_id='{tournament}'"),
        ('hand recorded before this draw',
         f"UPDATE public.hand_history SET created_at='2000-01-01' WHERE tournament_id='{tournament}'"),
        ('hand belonging to a different table',
         f"UPDATE public.hand_history SET table_id=gen_random_uuid() WHERE tournament_id='{tournament}'"),
        ('busted player still occupies a live chair',
         f"UPDATE public.table_seats SET left_at=NULL WHERE table_id='{tournament}' AND seat_number=1"),
        ('chips disagree across live seat and roster',
         f"UPDATE public.table_seats SET stack=stack+1 WHERE table_id='{tournament}' AND seat_number=2"),
        ('inflated stacks agree but exceed three starting stacks',
         f"UPDATE public.table_seats SET stack=stack+1 WHERE table_id='{tournament}' AND seat_number=2;"
         f"UPDATE public.tournament_players SET chips=chips+1 WHERE tournament_id='{tournament}' AND seat_number=2"),
        ('duplicate buy-in receipt',
         f"INSERT INTO public.wallet_transactions(related_entity_id,user_id,type,category,amount) "
         f"SELECT related_entity_id,user_id,type,category,amount FROM public.wallet_transactions "
         f"WHERE related_entity_id='{tournament}' LIMIT 1"),
        ('entry entitlement is absent',
         f"DELETE FROM public.tournament_refund_entitlements WHERE id=(SELECT id FROM "
         f"public.tournament_refund_entitlements WHERE tournament_id='{tournament}' LIMIT 1)"),
        ('original debit names another wallet',
         f"UPDATE public.chip_ledger SET from_entity_id=gen_random_uuid() "
         f"WHERE tournament_id='{tournament}' AND category='tournament_buyin'"),
        ('entry journal has the wrong resulting reserve balance',
         f"UPDATE public.chip_ledger SET post_to_balance=post_to_balance+1 "
         f"WHERE tournament_id='{tournament}' AND category='spin_entry'"),
        ('draw journal has the wrong reserve counterparty',
         f"UPDATE public.chip_ledger SET from_entity_id=gen_random_uuid() "
         f"WHERE tournament_id='{tournament}' AND category='spin_prize'"),
        ('escrow no longer covers the drawn prize',
         f"UPDATE public.tournament_escrow SET prize_balance=prize_balance-1 WHERE tournament_id='{tournament}'"),
        ('two-seat SNG is presented as played Spin recovery',
         f"UPDATE public.tournaments SET tournament_type='SNG',max_players=2 WHERE id='{tournament}'"),
        ('live table has two-seat capacity',
         f"UPDATE public.tables SET max_players=2 WHERE tournament_id='{tournament}'"),
    ]
    relations = [
        'tournaments', 'tournament_players', 'wallet_transactions', 'chip_ledger',
        'tournament_refund_entitlements', 'tournament_refund_tranches',
        'spin_bonus_pools', 'spin_reserve_ledger', 'spin_draw_receipts',
        'tournament_escrow', 'tables', 'table_seats', 'hand_history',
    ]
    fingerprint = "jsonb_build_array(" + ",".join(
        f"(SELECT jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text) FROM public.{table} r)"
        for table in relations) + ")"
    for name, mutation in cases:
        result = q(
            "BEGIN; " + mutation + "; CREATE TEMP TABLE probe_before AS SELECT "
            + fingerprint + " value; SELECT jsonb_build_object('proof',"
            + proof_sql + ",'atomic'," + rpc(n) + "); SELECT value="
            + fingerprint + " FROM probe_before; ROLLBACK;"
        ).splitlines()
        verdict = json.loads(result[-2])
        check('actual played proof rejects ' + name + ' without atomic writes',
              verdict['proof']['ok'] is False
              and verdict['atomic']['ok'] is False
              and result[-1] == 't')
