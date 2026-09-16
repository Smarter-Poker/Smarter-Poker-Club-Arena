"""SOURCE ONLY / UNRUN. Exact two-wallet-entry R2 observation oracle.

No database access, money creation, payer or repair exists in this module.
Inputs are Decimal-parsed observations from the actual isolated provider.
"""
from decimal import Decimal
from copy import deepcopy


def require(value, message):
    if not value:
        raise RuntimeError('R2 oracle: ' + message)


def money(value):
    require(type(value) is int or isinstance(value, Decimal), 'money is not exact numeric')
    result = Decimal(value)
    require(result.is_finite() and result == result.quantize(Decimal('.01')),
            'money is not finite exact cents')
    return result


def matching(rows, **fields):
    require(isinstance(rows, list), 'missing relation/array')
    return [row for row in rows if all(key in row and row[key] == value
                                    for key, value in fields.items())]


def one(rows, **fields):
    result = matching(rows, **fields)
    require(len(result) == 1, 'missing or ambiguous exact row: ' + str(fields))
    return result[0]


def indexed(rows, key):
    require(isinstance(rows, list), 'missing row set')
    require(all(isinstance(row, dict) and row.get(key) is not None for row in rows),
            'row identity absent')
    result = {row[key]: row for row in rows}
    require(len(result) == len(rows), 'duplicate row identity')
    return result


def additions(before, after, key, count):
    old, new = indexed(before, key), indexed(after, key)
    require(all(new.get(identity) == row for identity, row in old.items()),
            'prior immutable row removed or changed')
    added = [row for identity, row in new.items() if identity not in old]
    require(len(added) == count, 'incorrect number of new immutable rows')
    return added


def initial(state, tournament):
    parent = one(state['tournaments'], id=tournament)
    require(parent['variant'] == 'spin' and parent['max_players'] == 3
            and parent['started_at'] is None and parent['status'] in ('REGISTERING','ANNOUNCED'),
            'unsupported parent')
    require(money(parent['buy_in_amount']) > 0 and money(parent['buy_in_fee']) == 0
            and money(parent['bounty_pool']) == 0 and money(parent['total_rake']) == 0,
            'only ordinary zero-fee/bounty wallet entries supported')
    players = matching(state['tournament_players'], tournament_id=tournament)
    require(len(players) == 2 and len(indexed(players,'user_id')) == 2,
            'two distinct original players required')
    table = one(state['tables'], tournament_id=tournament)
    seats = matching(state['table_seats'], table_id=table['id'])
    require(len(seats) == 2 and len(indexed(seats,'user_id')) == 2
            and {r['user_id'] for r in seats} == {r['user_id'] for r in players}
            and all(s['left_at'] is None for s in seats), 'two exact live seats required')
    entitlements = matching(state['tournament_refund_entitlements'], tournament_id=tournament)
    require(len(entitlements) == 2 and len(indexed(entitlements,'user_id')) == 2,
            'two distinct immutable entitlements required')
    require(state['refund_authorizations_count'] == 0, 'outstanding one-use authorization')
    for relation in ('tournament_refund_tranches','tournament_obligations',
                     'tournament_cancellation_receipts','spin_reserve_ledger',
                     'spin_draw_receipts','tournament_launch_receipts',
                     'tournament_spin_cancellation_unwinds','rake_records'):
        require(not matching(state[relation], tournament_id=tournament),
                'prior or unsupported financial state: ' + relation)
    require(not state['tournament_tickets'], 'ticket-free allocation required')
    source_ids, keys, total = [], [], Decimal(0)
    for entitlement in entitlements:
        player = one(players, user_id=entitlement['user_id'])
        gross = money(entitlement['gross'])
        require(entitlement['entitlement_kind'] == 'wallet_charge'
                and entitlement['registration_id'] is None
                and gross == money(parent['buy_in_amount']) and gross > 0
                and money(entitlement['refund_prize']) == gross
                and money(entitlement['refund_bounty']) == 0
                and money(entitlement['refund_fee']) == 0
                and entitlement['charge_category'] == 'tournament_buyin',
                'unsupported entitlement rail')
        source = one(state['chip_ledger'], id=entitlement['source_ledger_id'])
        require(source['tournament_id'] == tournament
                and source['club_id'] == entitlement['refund_wallet_club_id']
                and source['from_type'] == 'player_wallet'
                and source['from_entity_id'] == player['user_id']
                and source['to_type'] == 'prize_liability' and source['to_entity_id'] == tournament
                and source['category'] == 'tournament_buyin' and source['status']=='posted'
                and money(source['amount']) == gross,
                'original paid wallet-debit journal does not bind entitlement')
        wallet = one(state['club_members'], user_id=player['user_id'],
                     club_id=entitlement['refund_wallet_club_id'])
        require(money(wallet['chip_balance']) >= 0, 'invalid original paid wallet balance')
        key = 'tourney:' + tournament + ':refund-entitlement:' + entitlement['id']
        require(not matching(state['wallet_credit_idempotency'], key=key), 'credit key already claimed')
        source_ids.append(source['id']); keys.append(key); total += gross
    require(len(set(source_ids)) == 2 and len(set(keys)) == 2, 'source/credit identity collapse')
    require({r['id'] for r in matching(state['chip_ledger'], tournament_id=tournament)}
            == set(source_ids), 'extra original tournament journal outside supported rail')
    original_reports=matching(state['wallet_transactions'],related_entity_id=tournament)
    require(len(original_reports)==2,'two original reporting debits required')
    for entitlement in entitlements:
        debit=one(original_reports,user_id=entitlement['user_id'])
        require(debit['type']=='debit' and debit['wallet_type']=='PLAYER'
                and debit['category']=='tournament_buyin'
                and money(debit['amount'])==money(entitlement['gross']),
                'original reporting debit disagrees with paid entitlement')
    escrow = one(state['tournament_escrow'], tournament_id=tournament)
    require(escrow['enforced'] is True and escrow['closed_at'] is None
            and money(escrow['prize_balance']) == total
            and money(parent['prize_pool']) == total
            and money(escrow['bounty_balance']) == 0 and money(escrow['fee_balance']) == 0,
            'actual paid escrow does not conserve both entries')
    require(money(escrow['gross_in'])==total and all(money(escrow[k])==0 for k in
        ('fee_entries_in','satellite_fee_in','bounty_in','overlay_in','satellite_in',
         'prize_out','bounty_out','fee_out','refund_prize','refund_bounty','refund_fee',
         'reserve_out','reserve_in')),'unsupported historical escrow rail')
    return {'players':players,'table':table,'seats':seats,
            'entitlements':entitlements,'total':total,'keys':keys}


def committed(before, after, tournament, returned_receipt, reader_receipt):
    basis = initial(before,tournament)
    total = basis['total']
    header = one(additions(before['tournament_cancellation_receipts'],
                          after['tournament_cancellation_receipts'],'tournament_id',1),
                 tournament_id=tournament)
    receipt = header['receipt']
    require(receipt == returned_receipt == reader_receipt, 'canonical receipt differs after COMMIT')
    require(receipt['ok'] is True and receipt['success'] is True
            and receipt['fully_settled'] is True and receipt['status'] == 'CANCELLED'
            and receipt['receipt_version'] == 2 and receipt['tournament_id'] == tournament,
            'invalid committed cancellation receipt')
    require(header['receipt_version']==2,'stored cancellation header version differs')
    for key, value in {'source_player_count':2,'refunded_count':2,'refund_line_count':2,
                       'ticket_return_count':0,'closed_table_count':1,
                       'source_seat_count':2,'released_seat_count':2}.items():
        require(header[key] == value and receipt[key] == value, 'receipt count mismatch: ' + key)
    require(header['zero_refund_count'] == 0 and header['zero_refund_registration_ids'] == []
            and header['ticket_return_ids'] == [] and receipt['ticket_returns'] == []
            and header['fee_reversal_ids'] == [] and header['spin_unwind_tournament_id'] is None,
            'unsupported/omitted cancellation disposition')
    for key in ('total_ticket_returned','fees_reversed'):
        require(money(header[key]) == 0 and money(receipt[key]) == 0, 'unexpected non-wallet refund')
    require(money(header['total_refunded']) == total and money(receipt['total_refunded']) == total
            and money(header['total_rake_before']) == 0 and money(header['total_rake_after']) == 0,
            'receipt monetary conservation differs')
    original_players = sorted(p['id'] for p in basis['players'])
    original_seats = sorted(s['id'] for s in basis['seats'])
    require(header['source_player_ids'] == original_players
            and header['refunded_registration_ids'] == original_players
            and header['source_seat_ids'] == original_seats
            and header['released_seat_ids'] == original_seats
            and header['closed_table_ids'] == [basis['table']['id']], 'frozen identity set differs')
    settled = header['settled_at']
    require(settled is not None and receipt['settled_at'] == settled
            and receipt['actor_id'] == header['actor_id'] and header['actor_id'] is not None
            and header['escrow_closed_at'] == settled
            and header['escrow_close_note'] == 'atomic cancellation receipt: exact zero',
            'terminal receipt timestamp/actor mismatch')
    lines = receipt['refunds']; require(len(lines) == 2, 'two actual refund lines required')
    for key in ('entitlement_id','obligation_id','idempotency_key','credit_ledger_id','wallet_transaction_id'):
        require(len(indexed(lines,key)) == 2, 'receipt bijection failed: ' + key)
    tranches = additions(before['tournament_refund_tranches'],after['tournament_refund_tranches'],
                         'wallet_transaction_id',2)
    obligations = additions(before['tournament_obligations'],after['tournament_obligations'],'id',2)
    credits = additions(before['chip_ledger'],after['chip_ledger'],'id',2)
    reports = additions(before['wallet_transactions'],after['wallet_transactions'],'id',2)
    registry = additions(before['wallet_credit_idempotency'],after['wallet_credit_idempotency'],'key',2)
    changed_wallets = set()
    for entitlement in basis['entitlements']:
        user, club, gross = entitlement['user_id'],entitlement['refund_wallet_club_id'],money(entitlement['gross'])
        player = one(basis['players'],user_id=user)
        line = one(lines,entitlement_id=entitlement['id'])
        key = 'tourney:' + tournament + ':refund-entitlement:' + entitlement['id']
        for name, expected in {'user_id':user,'registration_id':player['id'],
                'entitlement_kind':'wallet_charge','source_wallet_club_id':club,
                'idempotency_key':key}.items():
            require(line[name] == expected, 'refund line identity mismatch: ' + name)
        for name, expected in {'gross_paid':gross,'amount_paid_before':0,'amount_paid_now':gross,
                              'refund_prize':gross,'refund_bounty':0,'refund_fee':0}.items():
            require(money(line[name]) == expected, 'refund line amount mismatch: ' + name)
        tranche = one(tranches,wallet_transaction_id=line['wallet_transaction_id'])
        for name in ('user_id','entitlement_id','source_wallet_club_id','obligation_id',
                     'credit_ledger_id','idempotency_key','amount_paid_before','amount_paid_now',
                     'refund_prize','refund_bounty','refund_fee'):
            require(name in tranche and tranche[name] == line[name], 'tranche mismatch: ' + name)
        require(tranche['tournament_id'] == tournament and tranche['source'] == 'atomic_cancel_tournament',
                'tranche source mismatch')
        description='Tournament cancellation refund: '+(
            one(before['tournaments'],id=tournament)['name']
            if one(before['tournaments'],id=tournament)['name'] is not None else 'Unknown')
        require(tranche['description']==description,'tranche canonical description differs')
        obligation = one(obligations,id=line['obligation_id'],user_id=user,tournament_id=tournament)
        require(obligation['kind'] == 'refund' and obligation['place'] is None
                and obligation['source'] == 'atomic_cancel_tournament'
                and money(obligation['amount_owed']) == gross and money(obligation['amount_paid']) == gross
                and obligation['settled_at'] == settled, 'refund obligation not exactly closed')
        credit = one(credits,id=line['credit_ledger_id'],idempotency_key=key)
        require(credit['tournament_id'] == tournament and credit['club_id'] == club
                and credit['from_type'] == 'prize_liability' and credit['from_entity_id'] == tournament
                and credit['to_type'] == 'player_wallet' and credit['to_entity_id'] == user
                and credit['category'] == 'refund' and money(credit['amount']) == gross,
                'exact original-wallet refund journal missing')
        # The actual chip_balance writer omits balance metadata. The promo-balance
        # autoledger is a different trigger and cannot supply this leg's oracle.
        require(credit['status']=='posted' and all(credit[name] is None for name in
                ('pre_from_balance','post_from_balance','pre_to_balance','post_to_balance')),
                'fresh refund journal differs from actual wallet-writer/default shape')
        claim = one(registry,key=key,user_id=user)
        require(money(claim['amount']) == gross, 'credit registry amount missing/wrong')
        old_wallet = one(before['club_members'],user_id=user,club_id=club)
        new_wallet = one(after['club_members'],user_id=user,club_id=club)
        require(money(new_wallet['chip_balance'])-money(old_wallet['chip_balance']) == gross,
                'positive original-wallet credit differs from entitlement')
        require({k:v for k,v in old_wallet.items() if k not in ('chip_balance','updated_at')}
                == {k:v for k,v in new_wallet.items() if k not in ('chip_balance','updated_at')},
                'other original wallet fields changed')
        changed_wallets.add((user,club))
        report = one(reports,id=line['wallet_transaction_id'],user_id=user)
        require(report['wallet_type'] == 'PLAYER' and report['type'] == 'credit'
                and report['category'] == 'refund' and report['related_entity_id'] == tournament
                and report['description']==description
                and report['table_id'] is None and report['hand_id'] is None
                and money(report['amount']) == gross
                and money(report['balance_after']) == money(new_wallet['chip_balance']),
                'reporting credit does not bind actual wallet change')
    require(len(before['club_members']) == len(after['club_members']), 'wallet set changed')
    for old in before['club_members']:
        if (old['user_id'],old['club_id']) not in changed_wallets:
            require(one(after['club_members'],user_id=old['user_id'],club_id=old['club_id']) == old,
                    'unrelated wallet changed')
    parent = one(after['tournaments'],id=tournament)
    escrow = one(after['tournament_escrow'],tournament_id=tournament)
    require(parent['status'] == 'CANCELLED' and parent['ended_at'] == settled
            and parent['current_players'] == 0 and money(parent['prize_pool']) == 0
            and money(parent['bounty_pool']) == 0 and money(parent['total_rake']) == 0
            and parent['on_break'] is False and parent['break_started_at'] is None
            and parent['break_ends_at'] is None
            and escrow['enforced'] is True and escrow['closed_at'] == settled
            and escrow['close_note'] == header['escrow_close_note']
            and all(money(escrow[k]) == 0 for k in ('prize_balance','bounty_balance','fee_balance')),
            'terminal parent/escrow does not conserve wallet credits')
    require(money(escrow['refund_prize'])==total and money(escrow['refund_bounty'])==0
            and money(escrow['refund_fee'])==0,'escrow refund accumulation differs')
    old_escrow=one(before['tournament_escrow'],tournament_id=tournament)
    for name in ('gross_in','fee_entries_in','satellite_fee_in','bounty_in','overlay_in',
                 'satellite_in','prize_out','bounty_out','fee_out','reserve_out','reserve_in'):
        require(escrow[name]==old_escrow[name],'non-refund escrow rail changed: '+name)
    new_players=matching(after['tournament_players'],tournament_id=tournament)
    require(sorted(indexed(new_players,'id'))==original_players,'actual roster identity set changed')
    for player in new_players:
        old_player=one(basis['players'],id=player['id'])
        require(player['id'] in original_players and player['status'] == 'eliminated'
                and player['user_id']==old_player['user_id']
                and player['eliminated_at'] == settled and money(player['chips']) == 0
                and money(player['current_bounty']) == 0, 'roster not closed')
    table = one(after['tables'],id=basis['table']['id'])
    require(len(matching(after['tables'],tournament_id=tournament))==1
            and table['tournament_id']==tournament,'actual event/table identity set changed')
    require(table['status'] == 'closed' and table['lifecycle'] == 'closed'
            and table['current_players'] == 0 and table['terminal_closed_at'] == settled,
            'table not closed')
    new_seats=matching(after['table_seats'],table_id=table['id'])
    require(sorted(indexed(new_seats,'id'))==original_seats,'actual seat identity set changed')
    for seat in new_seats:
        old_seat=one(basis['seats'],id=seat['id'])
        require(seat['id'] in original_seats and seat['left_at'] == settled
                and seat['user_id']==old_seat['user_id'] and seat['table_id']==old_seat['table_id']
                and seat['status'] == 'left' and seat['leave_pending'] is False
                and seat['is_sitting_out'] is False and seat['is_away'] is False
                and seat['sit_out_at'] is None and seat['scheduled_leave_hands'] is None,
                'seat not released')
    target_updates={
        'tournaments':({'id':tournament},{'status','ended_at','updated_at','prize_pool','bounty_pool',
            'total_rake','current_players','on_break','break_started_at','break_ends_at'}),
        'tables':({'tournament_id':tournament},{'status','lifecycle','current_players','terminal_closed_at','updated_at'}),
        'table_seats':({'table_id':table['id']},{'left_at','status','leave_pending','is_sitting_out',
            'is_away','sit_out_at','scheduled_leave_hands','updated_at'}),
        'tournament_players':({'tournament_id':tournament},{'status','eliminated_at','chips','current_bounty','updated_at'}),
        'tournament_escrow':({'tournament_id':tournament},{'refund_prize','refund_bounty','refund_fee',
            'prize_balance','bounty_balance','fee_balance','updated_at','closed_at','close_note'}),
    }
    for relation,(scope,allowed) in target_updates.items():
        key='tournament_id' if relation=='tournament_escrow' else 'id'
        old_rows,new_rows=indexed(before[relation],key),indexed(after[relation],key)
        require(set(old_rows)==set(new_rows),'whole relation identity set changed: '+relation)
        for identity,old_row in old_rows.items():
            new_row=new_rows[identity]
            if all(old_row.get(k)==v for k,v in scope.items()):
                require({k:v for k,v in old_row.items() if k not in allowed}
                        =={k:v for k,v in new_row.items() if k not in allowed},
                        'unexpected target field changed: '+relation)
            else:
                require(old_row==new_row,'unrelated row changed: '+relation)
    mutable = {'tournaments','tables','table_seats','tournament_players','tournament_escrow',
               'club_members','tournament_cancellation_receipts','tournament_refund_tranches',
               'tournament_obligations','chip_ledger','wallet_transactions','wallet_credit_idempotency'}
    require(set(before) == set(after), 'selected evidence scope changed')
    for relation in set(before)-mutable:
        require(before[relation] == after[relation], 'unexpected selected state change: ' + relation)
    require(after['refund_authorizations_count'] == 0, 'one-use refund authority remains')
    return {'tournament_id':tournament,'total_refunded':total,
            'entitlement_ids':sorted(e['id'] for e in basis['entitlements']),
            'credit_keys':sorted(basis['keys']),'settled_at':settled}


def negative_controls(before, after, tournament):
    """Mutate copies of the ACTUAL qualified positive observation, never the DB.

    The canonical receipt argument is changed together with its copy where
    necessary, so line-identity controls cannot pass by only testing JSON equality.
    These controls are source only until invoked by the protected native runner.
    """
    original=one(after['tournament_cancellation_receipts'],tournament_id=tournament)
    lines=original['receipt']['refunds']
    entitlement=one(before['tournament_refund_entitlements'],id=lines[0]['entitlement_id'])
    def duplicate_line(value):
        receipt=one(value['tournament_cancellation_receipts'],tournament_id=tournament)['receipt']
        receipt['refunds'][1]=deepcopy(receipt['refunds'][0])
    def null_registry(value):
        one(value['wallet_credit_idempotency'],key=lines[0]['idempotency_key'])['amount']=None
    def missing_tranche(value):
        value['tournament_refund_tranches']=[r for r in value['tournament_refund_tranches']
            if r['wallet_transaction_id']!=lines[0]['wallet_transaction_id']]
    def wrong_wallet_delta(value):
        wallet=one(value['club_members'],user_id=entitlement['user_id'],
                   club_id=entitlement['refund_wallet_club_id'])
        wallet['chip_balance']-=Decimal('.01')
    def wrong_escrow_counter(value):
        one(value['tournament_escrow'],tournament_id=tournament)['refund_prize']-=Decimal('.01')
    def missing_player(value):
        value['tournament_players']=[r for r in value['tournament_players']
            if r['id']!=lines[0]['registration_id']]
    def changed_source(value):
        one(value['chip_ledger'],id=entitlement['source_ledger_id'])['amount']+=Decimal('.01')
    def retained_capability(value):
        value['refund_authorizations_count']=1
    def uncleared_seat(value):
        table=one(value['tables'],tournament_id=tournament)
        matching(value['table_seats'],table_id=table['id'])[0]['is_away']=True
    def unposted_credit(value):
        one(value['chip_ledger'],id=lines[0]['credit_ledger_id'])['status']='pending'
    def invented_balance_metadata(value):
        one(value['chip_ledger'],id=lines[0]['credit_ledger_id'])['pre_to_balance']=Decimal(0)
    controls=[('duplicated refund line',duplicate_line),('null credit registry amount',null_registry),
        ('missing tranche',missing_tranche),('incorrect actual wallet delta',wrong_wallet_delta),
        ('incorrect escrow refund counter',wrong_escrow_counter),('missing original roster row',missing_player),
        ('changed original paid source',changed_source),('unconsumed authorization',retained_capability),
        ('uncleared original seat',uncleared_seat),('unposted refund journal',unposted_credit),
        ('invented wallet-writer balance metadata',invented_balance_metadata)]
    results=[]
    for name,mutate in controls:
        damaged=deepcopy(after); mutate(damaged)
        receipt=one(damaged['tournament_cancellation_receipts'],tournament_id=tournament)['receipt']
        try:
            committed(before,damaged,tournament,receipt,receipt)
        except RuntimeError as error:
            require(str(error).startswith('R2 oracle: '),'unrelated error cannot qualify control')
            results.append({'control':name,'refusal':str(error)})
        else:
            raise RuntimeError('R2 oracle: malformed observation accepted: '+name)
    return results
