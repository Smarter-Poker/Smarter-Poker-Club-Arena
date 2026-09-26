"""Read-only independent oracle for genuine three-seat entry output; no SQL/IO."""
import hashlib
import json
import re
from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid5

OWNER = '47965354-0e56-43ef-931c-ddaab82af765'
ACTOR = '2d1cd6c3-5700-4af9-a271-d4863fdab20d'
STAGES = ['positive_fee_reference_data', 'structural_setup_committed',
          'mint_intent', 'mint_committed', 'bank1_intent', 'bank1_committed',
          'bank2_intent', 'bank2_committed', 'bank3_intent', 'bank3_committed',
          'creator_intent', 'creator_committed', 'seat1_intent', 'seat1_committed',
          'seat2_intent', 'seat2_committed', 'seat3_intent', 'seat3_committed',
          'positive_fee_entry_committed_observation', 'positive_fee_replay_baseline',
          'seat3_replay_intent', 'seat3_replay_committed', 'book_replay_intent',
          'book_replay_committed', 'positive_fee_entry_final_observation']
EXCLUDED = {'spin_draw_receipts', 'tournament_launch_receipts', 'hand_history',
            'hand_atomic_commits', 'tournament_payouts', 'tournament_terminal_settlements',
            'accounting_tournament_fee_recognitions', 'accounting_tournament_recognized_sources'}


RESTORATION_COLUMNS = {'entry_purchase_idempotency_receipts': ['claimed_at', 'completed_at', 'idempotency_key', 'key_domain', 'request', 'response'], 'club_wallets': ['chip_balance', 'club_id', 'created_at', 'id', 'insurance_balance', 'lifetime_bbj_contribution', 'lifetime_commission_paid', 'lifetime_rake_collected', 'period_bbj_contribution', 'period_commission_paid', 'period_rake_collected', 'period_started_at', 'updated_at'], 'union_wallets': ['bbj_wallet', 'chip_balance', 'created_at', 'id', 'insurance_wallet', 'promo_wallet', 'rake_wallet', 'spin_reserve_wallet', 'total_rake_collected', 'total_settlements', 'union_id', 'updated_at'], 'union_clubs': ['club_commission_rate', 'club_id', 'id', 'joined_at', 'rate_cash', 'rate_mtt', 'rate_satellite', 'rate_sng', 'rate_spin', 'union_id'], 'accounting_agreement_history': ['actor_id', 'after_terms', 'before_terms', 'club_id', 'entity_key', 'entity_type', 'event_type', 'id', 'observed_at', 'subject_user_id', 'transaction_id', 'union_id'], 'union_pnl_transaction_frames': ['book_start', 'observed_at', 'transaction_id'], 'union_pnl_inventory_events': ['after_row', 'before_row', 'event_id', 'observed_at', 'operation', 'row_id', 'source_name', 'transaction_id'], 'ca_op_claims': ['claimed_at', 'claimed_by', 'finalized_at', 'fn_name', 'op_id', 'result'], 'ca_mint_policy': ['id', 'note', 'per_operation_cap_chips', 'per_operation_cap_diamonds', 'rolling_24h_cap_chips', 'rolling_24h_cap_diamonds', 'updated_at', 'updated_by']}

def require(ok, label):
    if not ok:
        raise ValueError('positive-fee entry evidence: ' + label)


def money(value):
    require(type(value) in (int, Decimal), 'amount must be a native JSON number')
    value = Decimal(value)
    require(value.is_finite() and value == value.quantize(Decimal('.01')), 'finite cent amount')
    return value


def uid(value):
    require(isinstance(value, str) and str(UUID(value)) == value, 'canonical UUID')
    return value


def instant(value):
    require(isinstance(value, str), 'timestamp string')
    # PostgreSQL JSON omits trailing microsecond zeroes. Python 3.9 accepts
    # only three or six fractional digits, so normalize losslessly after
    # validating the exact timestamp domain used by these observations.
    match = re.fullmatch(
        r'([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}:[0-9]{2}:[0-9]{2})'
        r'(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}:[0-9]{2})', value)
    require(match is not None, 'timestamp format, timezone and microsecond precision')
    day, clock, fraction, zone = match.groups()
    require(int(clock[:2]) < 24 and int(clock[3:5]) < 60 and int(clock[6:]) < 60,
            'timestamp clock range')
    if zone == 'Z':
        zone = '+00:00'
    else:
        # datetime can normalize invalid minutes instead of refusing them.
        require(int(zone[1:3]) < 24 and int(zone[4:6]) < 60, 'timestamp timezone range')
    normalized = day + 'T' + clock + ('.' + fraction.ljust(6, '0') if fraction else '') + zone
    return datetime.fromisoformat(normalized)


def fields(row, **expected):
    require(isinstance(row, dict), 'row object')
    for key, value in expected.items():
        require(key in row and row[key] == value and
                (not isinstance(value, bool) or row[key] is value) and
                (type(value) not in (int, Decimal) or type(row[key]) in (int, Decimal)), 'field ' + key)


def _jsonb_text(value):
    """Canonical jsonb text for the captured fingerprint's finite JSON fields."""
    if value is None: return 'null'
    if type(value) is bool: return 'true' if value else 'false'
    if isinstance(value, str): return json.dumps(value, ensure_ascii=False)
    if type(value) in (int, Decimal):
        require(Decimal(value).is_finite(), 'finite fingerprint number')
        return format(value, 'f') if type(value) is Decimal else str(value)
    if isinstance(value, list): return '[' + ', '.join(_jsonb_text(v) for v in value) + ']'
    require(isinstance(value, dict), 'fingerprint JSON type')
    keys = sorted(value, key=lambda k: (len(k.encode('utf-8')), k.encode('utf-8')))
    return '{' + ', '.join(_jsonb_text(k) + ': ' + _jsonb_text(value[k]) for k in keys) + '}'


def _fee_fingerprint(fee):
    names = ['id','hand_id','table_id','club_id','rake_amount','bbj_contribution','pot_size','num_players',
             'created_at','player_contributions','global_hand_id','is_tournament','tournament_id','source',
             'metadata','rake_method','returned_uncalled']
    require(all(k in fee for k in names), 'complete original fee fingerprint fields')
    return hashlib.md5(_jsonb_text({k: fee[k] for k in names}).encode('utf-8')).hexdigest()


def rows(value, count, key='id'):
    require(isinstance(value, list) and len(value) == count, 'row cardinality')
    result = {}
    for row in value:
        require(isinstance(row, dict) and key in row, 'row identity')
        ident = row[key]
        require(ident not in result, 'duplicate row identity')
        result[ident] = row
    return result


def _decode(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 4194304, 'bounded original stdout bytes')
    text = raw.decode('utf-8', errors='strict')
    require(not re.search(r'(?m)(?:^|\s)(?:ERROR|FATAL|PANIC):', text), 'SQL diagnostic in stdout')
    def unique(pairs):
        answer = {}
        for key, value in pairs:
            require(key not in answer, 'duplicate JSON key ' + key)
            answer[key] = value
        return answer
    def constant(value):
        raise ValueError('nonfinite JSON constant: ' + value)
    def number(value):
        result = Decimal(value)
        require(result.is_finite() and abs(result.adjusted()) <= 128
                and len(result.as_tuple().digits) <= 128, 'bounded finite JSON decimal')
        return result
    decoder = json.JSONDecoder(parse_float=number, parse_constant=constant, object_pairs_hook=unique)
    answer = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith('{'):
            value, end = decoder.raw_decode(line)
            suffix = line[end:]
            if suffix:
                # Original SELECT set_config(...),set_config(...),set_config(...)
                # emits one JSON claims object and two pipe-delimited scalar GUCs.
                require('stage' not in value and set(value) <= {'role', 'sub', 'session_id'}
                        and value.get('role') in ('authenticated', 'service_role')
                        and suffix == '|' + value.get('sub', '') + '|' + value['role'],
                        'unexpected JSON suffix')
                continue
            require(isinstance(value, dict) and value.get('stage') in STAGES, 'unknown stage object')
            answer.append(value)
        else:
            require(re.fullmatch(r'(?:BEGIN|COMMIT|SET|RESET|GRANT|DO|CREATE (?:TABLE|FUNCTION)|'
                                 r'INSERT 0 [0-9]+|SELECT [0-9]+|join_club|'
                                 r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', line),
                    'unrecognized non-JSON stdout')
    require([x['stage'] for x in answer] == STAGES, 'exact stage sequence, once each')
    return {x['stage']: x for x in answer}



def validate_restoration_inputs(value, q):
    """Lossless bounded raw input witness; does not infer absent rows or outputs."""
    fields(value, kind='genuine-entry-restoration-inputs-v1', complete=True, historical_evidence=False)
    require(set(value) == {'kind','complete','historical_evidence','relations'}, 'restoration envelope fields')
    relation = value['relations']
    require(isinstance(relation, dict) and set(relation) == set(RESTORATION_COLUMNS), 'restoration relation inventory')
    for name, expected_columns in RESTORATION_COLUMNS.items():
        item = relation[name]
        require(set(item) == {'columns','row_count','rows','rows_jsonb_text','rows_md5','complete'}, 'restoration relation fields')
        fields(item, complete=True)
        require(item['columns'] == expected_columns, 'complete captured columns ' + name)
        require(type(item['row_count']) is int and 0 <= item['row_count'] <= 256 and
                isinstance(item['rows'], list) and len(item['rows']) == item['row_count'], 'restoration count ' + name)
        body = item['rows_jsonb_text']
        require(isinstance(body,str) and len(body.encode()) <= 262144 and
                hashlib.md5(body.encode()).hexdigest() == item['rows_md5'], 'restoration raw bytes ' + name)
        require(_jsonb_text(item['rows']) == body, 'restoration full JSON value ' + name)
        require(all(isinstance(r,dict) and sorted(r) == expected_columns for r in item['rows']),
                'restoration whole rows ' + name)
        serialized = [_jsonb_text(r) for r in item['rows']]
        require(len(set(serialized)) == len(serialized), 'restoration duplicate rows ' + name)
    require(len(_jsonb_text(relation).encode()) <= 1048576, 'restoration total byte cap')
    history = relation['accounting_agreement_history']['rows']
    for member in q['membership_history']:
        require(sum(row == member for row in history) == 1, 'restoration original membership equality')
    frames = {row['transaction_id']: row for row in relation['union_pnl_transaction_frames']['rows']}
    require(len(frames) == relation['union_pnl_transaction_frames']['row_count'], 'unique restoration frame')
    for flow in q['original_flows']:
        require(flow['transaction_id'] in frames and
                frames[flow['transaction_id']]['observed_at'] == flow['recognized_at'], 'original flow frame binding')
    for row in relation['club_wallets']['rows']:
        require(row['club_id'] == q['club'], 'restoration club wallet scope')
    for row in relation['union_wallets']['rows']:
        require(row['union_id'] == q['club'], 'restoration Union wallet scope')
    for row in relation['union_clubs']['rows']:
        require(row['club_id'] == row['union_id'] == q['club'], 'restoration Union membership scope')


def validate_output(raw: bytes, execution: str, tournament: str):
    """Validate original stdout only. Caller owns exit/stderr/source/cleanup proof."""
    execution, tournament = uid(execution), uid(tournament)
    require(UUID(tournament).version == 4, 'fresh v4 tournament')
    stage = _decode(raw)
    for item in stage.values():
        if 'execution' in item: require(item['execution']==execution, 'stage execution binding')
        if 'tournament' in item: require(item['tournament']==tournament, 'stage tournament binding')
    fields(stage['positive_fee_reference_data'], captured_cutover_rows=2, captured_store_rows=2,
           financial_rows_seeded=0, full_qualification=False)
    q = stage['positive_fee_entry_committed_observation']
    fields(q, execution=execution, tournament=tournament, club=execution, owner=OWNER)
    people = q['players']
    require(isinstance(people, list) and len(people) == 3, 'three entrants')
    p1, p2, owner = map(uid, people)
    require(owner == OWNER and p2 == str(uuid5(UUID(execution), 'spin-player-2')) and
            len({execution, tournament, p1, p2, OWNER, ACTOR}) == 6, 'distinct bound principals')
    players = set(people)
    fields(stage['structural_setup_committed'], tournament=tournament, club=execution, owner=OWNER, players=people)
    fields(stage['mint_intent'], idempotency_key='spin-expiry-fixture:'+execution)
    table = uid(q['table'])
    require(table not in {execution, tournament, *players, ACTOR}, 'distinct table')
    before, observed = instant(q['preparation_started_at']), instant(q['observed_at'])
    require(before <= observed, 'ordered observation timestamps')
    for name in ['financial_business_qualification_passed', 'mixed_history_qualification',
                 'terminal_qualification', 'historical_qualification', 'production_qualification']:
        require(q.get(name) is False, 'no widened claim ' + name)
    require(set(q['excluded_counts']) == EXCLUDED and
            all(type(n) is int and n == 0 for n in q['excluded_counts'].values()), 'excluded actual row counts')
    for name, amount in [('entry_amount','3'), ('fee_amount','.24'), ('reserve_amount','2.76'), ('credit_per_player','.08')]:
        require(money(q[name]) == Decimal(amount), 'independent ' + name)
    fields(q['club_row'], id=execution, owner_id=OWNER, is_union=True, chip_treasury=97, chip_pool=0)
    fields(q['union_row'], id=execution, owner_id=OWNER, chip_balance=0, rake_wallet=0, bbj_wallet=0, promo_wallet=0, total_rake=0)
    fields(q['tournament_row'], id=tournament, club_id=execution, union_id=execution,
           format_contract='spin-v1', restart_source_id=None, status='REGISTERING', started_at=None,
           current_players=3, buy_in_amount=1, buy_in_fee=0, prize_pool=3, total_rake=0, bounty_pool=0)
    fields(q['table_row'], id=table, tournament_id=tournament, club_id=execution, union_id=execution,
           status='waiting', current_players=3)
    members = rows(q['members'], 3, 'user_id')
    require(set(members) == players, 'member identity set')
    for user, row in members.items():
        fields(row, club_id=execution, user_id=user, chip_balance=0, status='active')
    profiles = rows(q['profiles'], 3)
    require(set(profiles) == players, 'profile identity set')
    for row in profiles.values(): fields(row, diamonds=0, diamond_balance=0, is_horse=False)
    sessions = rows(q['sessions'], 3, 'user_id')
    require(set(sessions) == players, 'session identity set')
    for user, token in zip(people, ['spin-session-1', 'spin-session-2', 'spin-owner-session']):
        row = sessions[user]
        fields(row, id=str(uuid5(UUID(execution), token)))
        require(before <= instant(row['created_at']) <= observed < instant(row['not_after']), 'actual live session interval')
    roster = rows(q['roster'], 3, 'user_id')
    seats = rows(q['seats'], 3, 'user_id')
    require(set(roster) == set(seats) == players, 'roster/seat identities')
    for seat_no, user in enumerate(people, 1):
        fields(seats[user], table_id=table, seat_number=seat_no, stack=1000, left_at=None)
        fields(roster[user], tournament_id=tournament, club_id=execution, table_id=table,
               seat_number=seat_no, status='playing', chips=1000)
        require(before <= instant(seats[user]['joined_at']) <= observed, 'real seat timestamp')
    ledger = rows(q['source_journals'], 8)
    require(all(r['status'] == 'posted' and money(r['amount']) > 0 for r in ledger.values()), 'positive posted journals')
    def one(category):
        result = [r for r in ledger.values() if r['category'] == category]
        require(len(result) == 1, 'single ' + category + ' journal')
        return result[0]
    mint = one('mint')
    fields(mint, amount=100, from_type='issuance_reserve', to_type='club_treasury', to_entity_id=execution,
           idempotency_key='mint:spin-expiry-fixture:' + execution)
    fields(q['mint_ledger'], action='mint', asset='chips', holder_type='club', holder_id=execution,
           amount=100, balance_before=0, balance_after=100, chip_ledger_id=mint['id'], op_id='spin-expiry-fixture:' + execution)
    bank = rows([r for r in ledger.values() if r['category']=='club_bank_send'], 3, 'to_entity_id')
    charge = rows([r for r in ledger.values() if r['category']=='tournament_buyin'], 3, 'from_entity_id')
    require(set(bank) == set(charge) == players, 'bank and charge entrants')
    tx = rows(q['chip_transactions'], 7)
    mint_tx = [r for r in tx.values() if r.get('transaction_type')=='treasury_mint']
    require(len(mint_tx)==1, 'one actual Mint transaction')
    fields(mint_tx[0], club_id=execution, from_user_id=OWNER, to_user_id=None, amount=100, balance_after=100)
    wallets = rows(q['wallet_transactions'], 3, 'user_id')
    entitlements = rows(q['entitlements'], 3, 'user_id')
    require(set(wallets) == set(entitlements) == players, 'charge receipt entrants')
    for name in ['source_journals','chip_transactions','wallet_transactions','entitlements','roster','seats','fee_sources']:
        ids = [uid(r['id']) for r in q[name]]
        require(len(set(ids))==len(ids), 'distinct raw identities '+name)
    for number, user in enumerate(people, 1):
        operation = str(uuid5(UUID(execution), 'spin-bank-' + str(number)))
        fields(stage['bank'+str(number)+'_intent'], operation=operation, recipient=user)
        fields(bank[user], amount=1, club_id=execution, from_type='club_treasury', from_entity_id=execution,
               to_type='player_wallet', correlation_id=operation, idempotency_key='club_bank_send:' + operation)
        fields(charge[user], amount=1, club_id=execution, tournament_id=tournament, from_type='player_wallet',
               to_type='prize_liability', to_entity_id=tournament)
        fields(wallets[user], wallet_type='PLAYER', type='debit', category='tournament_buyin',
               amount=1, balance_after=0, related_entity_id=tournament)
        fields(entitlements[user], tournament_id=tournament, gross=1, refund_prize=1, refund_fee=0, refund_bounty=0,
               entitlement_kind='wallet_charge', charge_category='tournament_buyin', registration_id=None,
               refund_wallet_club_id=execution, source_ledger_id=charge[user]['id'])
        require(instant(entitlements[user]['created_at']) == instant(charge[user]['created_at']) ==
                instant(roster[user]['registered_at']), 'exact paid-entry timestamp link')
        matches = [r for r in tx.values() if r.get('transaction_type')=='club_bank_send' and
                   r.get('metadata',{}).get('op_id')==operation]
        require(len(matches)==1, 'actual bank transaction')
        fields(matches[0], club_id=execution, from_user_id=OWNER, to_user_id=user, amount=1, balance_after=100-number)
        purchases=[r for r in tx.values() if r.get('transaction_type')=='tournament_buyin' and r.get('from_user_id')==user]
        require(len(purchases)==1, 'actual purchase transaction')
        fields(purchases[0], club_id=execution, amount=1)
    pool, reserve = q['pool'], q['reserve']
    uid(pool['id']); uid(reserve['id'])
    fields(pool, club_id=execution, balance=Decimal('2.76'), total_deposited=Decimal('2.76'), total_drawn=0,
           spin_count=1, bonus_count=0, seeded_amount=0, highest_stake=1, surplus_returned=0, seed_returned_amount=0)
    fields(reserve, club_id=execution, tournament_id=tournament, kind='contribution', amount=Decimal('2.76'),
           balance_after=Decimal('2.76'), multiplier=None, buy_in=1, seats=3, house_rake=Decimal('.24'), terminal_closed_at=None)
    reserve_leg=one('spin_entry')
    fields(reserve_leg, amount=Decimal('2.76'), tournament_id=tournament, from_type='prize_liability',
           from_entity_id=tournament, to_type='spin_reserve', to_entity_id=pool['id'], idempotency_key='spin:'+tournament+':entry')
    escrow=q['escrow']
    fields(escrow, tournament_id=tournament, enforced=True, closed_at=None, terminal_closed_at=None,
           gross_in=3, fee_entries_in=Decimal('.24'), reserve_out=Decimal('2.76'), prize_balance=0,
           fee_balance=Decimal('.24'), bounty_balance=0)
    for name in ['satellite_fee_in','bounty_in','overlay_in','satellite_in','prize_out','bounty_out','fee_out',
                 'refund_prize','refund_bounty','refund_fee','reserve_in']:
        require(money(escrow[name])==0, 'no unrelated escrow movement '+name)
    require(money(q['club_row']['chip_treasury'])+sum(money(m['chip_balance']) for m in members.values())+
            money(pool['balance'])+sum(money(escrow[k]) for k in ['prize_balance','fee_balance','bounty_balance'])==100,
            'independent conserved estate')
    fee,batch=q['fee'],q['fee_batch'];uid(fee['id'])
    fields(fee, tournament_id=tournament, club_id=execution, source='fn_spin_book_entry', hand_id=None,
           table_id=None, is_tournament=True, rake_amount=Decimal('.24'), pot_size=3, num_players=3, bbj_contribution=0)
    require(fee['player_contributions']=={u:1 for u in people}, 'three exact original fee contributors')
    fields(fee['metadata'], kind='spin_rake', buy_in=1, rake_rate=Decimal('.08'), booked_at='third_paid_seat',
           reserve_owner=execution, treasury_credited=False, rake_per_player=Decimal('.08'), seats_attributed=3)
    fields(batch, rake_record_id=fee['id'], tournament_id=tournament, status='captured', source_version=2, rake_amount=Decimal('.24'))
    require(instant(batch['captured_at'])==instant(fee['created_at']) and
            batch['source_fingerprint']==_fee_fingerprint(fee), 'captured original fee timestamp/fingerprint')
    manifest=batch['source_manifest']
    fields(manifest, union_id=execution, game_type='spin', spin_reserve_id=reserve['id'])
    contributors=rows(manifest['contributors'],3,'player_id')
    sources=rows(q['fee_sources'],3,'player_id')
    require(set(contributors)==set(sources)==players and sum(money(r['rake_credit']) for r in sources.values())==Decimal('.24'),
            'exact source set and independent credit total')
    history=rows(q['membership_history'],3)
    for user,s in sources.items():
        fields(s, rake_record_id=fee['id'], tournament_id=tournament, club_id=execution, union_id=execution,
               coordinator_union_id=execution, game_type='spin', registration_id=roster[user]['id'],
               source_charge_ledger_id=charge[user]['id'], source_entitlement_id=entitlements[user]['id'], rake_credit=Decimal('.08'))
        when=instant(s['charged_at'])
        require(when==instant(charge[user]['created_at']) and before<=when<=instant(fee['created_at'])<=observed
                and instant(s['recorded_at'])==instant(batch['captured_at']), 'source charge chronology')
        fields(contributors[user], club_id=execution, registration_id=roster[user]['id'],
               charge_ledger_id=charge[user]['id'], entitlement_id=entitlements[user]['id'], weight=1)
        require(instant(contributors[user]['charged_at'])==when, 'manifest charge timestamp')
        contract=s['contract']
        fields(contract, player_id=user, club_id=execution, union_id=execution, coordinator_union_id=execution,
               rake_credit=Decimal('.08'), club_residual=Decimal('.08'), is_union_house=True, tiers=[], union_agreement=None)
        require(instant(contract['terms_at'])==when, 'contract terms timestamp')
        member=contract['membership'];h=history[member['history_id']]
        fields(h, entity_type='club_members', club_id=execution, subject_user_id=user)
        require(member=={'history_id':h['id'],'observed_at':h['observed_at'],'terms':h['after_terms']}
                and instant(h['observed_at'])<=when and h['after_terms']['status']=='active', 'authentic membership history binding')
    flows=rows(q['original_flows'],3,'ledger_id')
    require(set(flows)=={r['id'] for r in charge.values()} and len({f['transaction_id'] for f in flows.values()})==3,
            'three actual original charge flows/transactions')
    for lid,f in flows.items():
        require(f['ledger_snapshot']==ledger[lid], 'original full ledger snapshot')
        require(before<=instant(f['recognized_at'])<=observed, 'original flow observation time')
        require(f['game_scope']=={'game_union_id':execution,'host_club_id':execution,'tournament_id':tournament,
                                 'is_private':False,'asset':'chips','unit_scale':2}, 'original flow scope')
    validate_restoration_inputs(q['restoration_inputs'], q)
    # Independently connect emitted request receipts to the raw committed estate.
    receipts=q['request_receipts']
    require(set(receipts)=={'mint','bank1','bank2','bank3','create','seat1','seat2','seat3'}, 'fresh request receipt set')
    for name in receipts:
        emitted='creator' if name=='create' else name
        require(stage[emitted+'_committed']['receipt']==receipts[name], 'request stage receipt binding')
    fields(receipts['mint'], ok=True, replayed=False, balance_before=0, balance_after=100, ledger_id=mint['id'])
    fields(receipts['create'], ok=True, replayed=False, table_id=table)
    require(receipts['create']['tournament']['id']==tournament, 'creator response identity')
    for n,user in enumerate(people,1):
        fields(receipts['bank'+str(n)], success=True, replayed=False, amount=1, destination='player_wallet',
               bank_before=101-n, bank_after=100-n, recipient_balance_after=1,
               op_id=str(uuid5(UUID(execution),'spin-bank-'+str(n))))
        bank_transaction = [r for r in tx.values() if r.get('transaction_type')=='club_bank_send'
                            and r.get('metadata',{}).get('op_id')==receipts['bank'+str(n)]['op_id']]
        require(len(bank_transaction)==1 and receipts['bank'+str(n)]['transaction_id']==bank_transaction[0]['id'],
                'bank response names exact committed transaction')
        fields(receipts['seat'+str(n)], ok=True, table_id=table, seat_number=n, stack=1000, seat_reserved=True,
               seats_taken=n, seats_needed=3, starts_now=(n==3), cost=1, asset='chips')
        fields(stage['seat'+str(n)+'_intent'], execution=execution, user=user, session=sessions[user]['id'], table=table, seat=n)
    final=stage['positive_fee_entry_final_observation']
    fields(final, execution=execution, tournament=tournament, entry_slice_observed=True, seat_replay_unchanged=True, book_replay_unchanged=True)
    for name in ['full_financial_qualification','mixed_history_qualification','historical_qualification','terminal_qualification','production_qualification']:
        require(final.get(name) is False, 'final scope refusal '+name)
    digest=stage['positive_fee_replay_baseline']['estate_digest_md5']
    require(re.fullmatch('[0-9a-f]{32}',digest) and final['estate_digest_md5']==digest, 'full-estate baseline/final digest')
    for name in ['seat3_replay_committed','book_replay_committed']:
        fields(stage[name], all_relation_rows_unchanged=True, estate_digest_md5=digest)
    require(stage['seat3_replay_committed']['receipt']=={'ok':True,'already_seated':True,'table_id':table,'seat_number':3}, 'exact seat replay')
    require(stage['book_replay_committed']['receipt']=={'ok':True,'reason':'already_booked','collected':3,
            'house_rake':Decimal('.24'),'reserve_in':Decimal('2.76'),'balance':Decimal('2.76'),
            'owner_id':execution,'pool_id':pool['id'],'seats':3,'paid_users':3,
            'entry_reserve_id':reserve['id'],'entry_journal_id':reserve_leg['id']}, 'exact book replay')
    require(instant(final['observed_at'])>=observed, 'final observation follows committed observation')
    return {'status':'entry_output_validated','execution':execution,'tournament':tournament,
            'stdout_sha256':hashlib.sha256(raw).hexdigest(),'stage_count':len(STAGES),'paid_entrants':3,
            'issued':'100.00','treasury':'97.00','reserve':'2.76','fee_liability':'0.24','fee_credit_each':'0.08',
            'fee_sources':3,'original_entry_flows':3,'restoration_inputs_verified':True,'seat_replay_unchanged':True,'book_replay_unchanged':True,
            'replay_estate_digest_md5':digest,'process_exit_verified':False,'stderr_verified':False,
            'source_custody_verified':False,'backend_cleanup_verified':False,'allocation_disposal_verified':False,
            'full_financial_qualification':False,'mixed_history_qualification':False,'terminal_qualification':False,
            'historical_qualification':False,'production_qualification':False,'incident_closed':False}


def _control_records():
    """Synthetic OUTPUT objects for validator controls only; never database input."""
    execution='11111111-1111-4111-8111-111111111111'
    tournament='22222222-2222-4222-8222-222222222222'
    make=lambda name: str(uuid5(UUID(execution), name))
    people=[make('ordinary-user'),make('spin-player-2'),OWNER]
    table=make('table'); at='2026-09-18T01:00:00+00:00'; later='2026-09-18T01:10:00+00:00'
    states={name:{'stage':name,'execution':execution} for name in STAGES}
    q=states['positive_fee_entry_committed_observation']
    q.update(tournament=tournament,club=execution,owner=OWNER,players=people,table=table,
             preparation_started_at=at,observed_at=later,entry_amount=3,fee_amount=Decimal('.24'),
             reserve_amount=Decimal('2.76'),credit_per_player=Decimal('.08'),
             financial_business_qualification_passed=False,mixed_history_qualification=False,
             terminal_qualification=False,historical_qualification=False,production_qualification=False,
             excluded_counts={name:0 for name in EXCLUDED})
    states['positive_fee_reference_data'].update(captured_cutover_rows=2,captured_store_rows=2,financial_rows_seeded=0,full_qualification=False)
    states['structural_setup_committed'].update(tournament=tournament,club=execution,owner=OWNER,players=people)
    states['mint_intent']['idempotency_key']='spin-expiry-fixture:'+execution
    q['club_row']={'id':execution,'owner_id':OWNER,'is_union':True,'chip_treasury':97,'chip_pool':0}
    q['union_row']={'id':execution,'owner_id':OWNER,**{k:0 for k in ['chip_balance','rake_wallet','bbj_wallet','promo_wallet','total_rake']}}
    q['tournament_row']={'id':tournament,'club_id':execution,'union_id':execution,'format_contract':'spin-v1',
                        'status':'REGISTERING','restart_source_id':None,'started_at':None,'current_players':3,'buy_in_amount':1,
                        'buy_in_fee':0,'prize_pool':3,'total_rake':0,'bounty_pool':0}
    q['table_row']={'id':table,'tournament_id':tournament,'club_id':execution,'union_id':execution,'status':'waiting','current_players':3}
    q['members']=[{'user_id':u,'club_id':execution,'chip_balance':0,'status':'active'} for u in people]
    q['profiles']=[{'id':u,'diamonds':0,'diamond_balance':0,'is_horse':False} for u in people]
    q['sessions']=[{'id':make(token),'user_id':u,'created_at':at,'not_after':'2026-09-18T02:00:00+00:00'}
                   for u,token in zip(people,['spin-session-1','spin-session-2','spin-owner-session'])]
    q['roster']=[{'id':make('roster'+str(n)),'user_id':u,'tournament_id':tournament,'club_id':execution,
                  'table_id':table,'seat_number':n,'status':'playing','chips':1000,'registered_at':at}
                 for n,u in enumerate(people,1)]
    q['seats']=[{'id':make('seat'+str(n)),'user_id':u,'table_id':table,'seat_number':n,'stack':1000,'left_at':None,'joined_at':at}
                for n,u in enumerate(people,1)]
    mint={'id':make('mint'),'category':'mint','amount':100,'status':'posted','from_type':'issuance_reserve',
          'to_type':'club_treasury','to_entity_id':execution,'idempotency_key':'mint:spin-expiry-fixture:'+execution}
    q['mint_ledger']={'action':'mint','asset':'chips','holder_type':'club','holder_id':execution,'amount':100,
                      'balance_before':0,'balance_after':100,'chip_ledger_id':mint['id'],'op_id':'spin-expiry-fixture:'+execution}
    q['source_journals']=[mint];q['chip_transactions']=[];q['entitlements']=[];q['wallet_transactions']=[]
    receipts={'mint':{'ok':True,'replayed':False,'balance_before':0,'balance_after':100,'ledger_id':mint['id']},
              'create':{'ok':True,'replayed':False,'table_id':table,'tournament':{'id':tournament}}}
    for n,u in enumerate(people,1):
        op=make('spin-bank-'+str(n));legid=make('charge'+str(n))
        states['bank'+str(n)+'_intent'].update(operation=op,recipient=u)
        q['source_journals'].append({'id':make('bank'+str(n)),'category':'club_bank_send','amount':1,'status':'posted',
                                    'club_id':execution,'from_type':'club_treasury','from_entity_id':execution,
                                    'to_type':'player_wallet','to_entity_id':u,'correlation_id':op,'idempotency_key':'club_bank_send:'+op})
        q['source_journals'].append({'id':legid,'category':'tournament_buyin','amount':1,'status':'posted','club_id':execution,
                                    'tournament_id':tournament,'from_type':'player_wallet','from_entity_id':u,
                                    'to_type':'prize_liability','to_entity_id':tournament,'created_at':at})
        q['chip_transactions'] += [{'id':make('banktx'+str(n)),'transaction_type':'club_bank_send','metadata':{'op_id':op},
                                   'club_id':execution,'from_user_id':OWNER,'to_user_id':u,'amount':1,'balance_after':100-n},
                                  {'id':make('entrytx'+str(n)),'transaction_type':'tournament_buyin','from_user_id':u,'club_id':execution,'amount':1}]
        q['entitlements'].append({'id':make('entitlement'+str(n)),'user_id':u,'tournament_id':tournament,'gross':1,
                                  'refund_prize':1,'refund_fee':0,'refund_bounty':0,'entitlement_kind':'wallet_charge',
                                  'charge_category':'tournament_buyin','registration_id':None,'refund_wallet_club_id':execution,
                                  'source_ledger_id':legid,'created_at':at})
        q['wallet_transactions'].append({'id':make('wallet'+str(n)),'user_id':u,'wallet_type':'PLAYER','type':'debit',
                                        'category':'tournament_buyin','amount':1,'balance_after':0,'related_entity_id':tournament})
        receipts['bank'+str(n)]={'success':True,'replayed':False,'amount':1,'destination':'player_wallet',
                                 'bank_before':101-n,'bank_after':100-n,'recipient_balance_after':1,'op_id':op,
                                 'transaction_id':make('banktx'+str(n))}
        receipts['seat'+str(n)]={'ok':True,'table_id':table,'seat_number':n,'stack':1000,'seat_reserved':True,
                                 'seats_taken':n,'seats_needed':3,'starts_now':n==3,'cost':1,'asset':'chips'}
        states['seat'+str(n)+'_intent'].update(user=u,session=q['sessions'][n-1]['id'],table=table,seat=n)
    q['chip_transactions'].append({'id':make('minttx'),'transaction_type':'treasury_mint','amount':100,
                                  'club_id':execution,'from_user_id':OWNER,'to_user_id':None,'balance_after':100})
    q['pool']={'id':make('pool'),'club_id':execution,'balance':Decimal('2.76'),'total_deposited':Decimal('2.76'),
               'total_drawn':0,'spin_count':1,'bonus_count':0,'seeded_amount':0,'highest_stake':1,'surplus_returned':0,'seed_returned_amount':0}
    q['reserve']={'id':make('reserve'),'club_id':execution,'tournament_id':tournament,'kind':'contribution',
                  'amount':Decimal('2.76'),'balance_after':Decimal('2.76'),'multiplier':None,'buy_in':1,'seats':3,
                  'house_rake':Decimal('.24'),'terminal_closed_at':None}
    reserve_leg={'id':make('reserveleg'),'category':'spin_entry','amount':Decimal('2.76'),'status':'posted',
                 'tournament_id':tournament,'from_type':'prize_liability','from_entity_id':tournament,
                 'to_type':'spin_reserve','to_entity_id':q['pool']['id'],'idempotency_key':'spin:'+tournament+':entry'}
    q['source_journals'].append(reserve_leg)
    q['escrow']={'tournament_id':tournament,'enforced':True,'closed_at':None,'terminal_closed_at':None,'gross_in':3,
                 'fee_entries_in':Decimal('.24'),'reserve_out':Decimal('2.76'),'prize_balance':0,'fee_balance':Decimal('.24'),
                 **{k:0 for k in ['bounty_balance','satellite_fee_in','bounty_in','overlay_in','satellite_in','prize_out',
                                  'bounty_out','fee_out','refund_prize','refund_bounty','refund_fee','reserve_in']}}
    fee={'id':make('fee'),'tournament_id':tournament,'club_id':execution,'source':'fn_spin_book_entry',
         'hand_id':None,'table_id':None,'is_tournament':True,'rake_amount':Decimal('.24'),'pot_size':3,
         'num_players':3,'bbj_contribution':0,'player_contributions':{u:1 for u in people},'created_at':at,
         'global_hand_id':1000000,'rake_method':None,'returned_uncalled':0,
         'metadata':{'kind':'spin_rake','buy_in':1,'rake_rate':Decimal('.08'),'booked_at':'third_paid_seat',
                     'reserve_owner':execution,'treasury_credited':False,'rake_per_player':Decimal('.08'),'seats_attributed':3}}
    q['fee']=fee;q['membership_history']=[];q['fee_sources']=[];contributors=[]
    for n,u in enumerate(people,1):
        h={'id':n,'entity_type':'club_members','club_id':execution,'subject_user_id':u,'observed_at':at,'after_terms':{'status':'active'}}
        q['membership_history'].append(h)
        contributor={'player_id':u,'club_id':execution,'registration_id':q['roster'][n-1]['id'],
                     'charge_ledger_id':q['entitlements'][n-1]['source_ledger_id'],
                     'entitlement_id':q['entitlements'][n-1]['id'],'charged_at':at,'weight':1}
        contributors.append(contributor)
        q['fee_sources'].append({'id':make('feesource'+str(n)),'player_id':u,'rake_record_id':fee['id'],'tournament_id':tournament,
                                'club_id':execution,'union_id':execution,'coordinator_union_id':execution,'game_type':'spin',
                                'registration_id':contributor['registration_id'],'source_charge_ledger_id':contributor['charge_ledger_id'],
                                'source_entitlement_id':contributor['entitlement_id'],'rake_credit':Decimal('.08'),'charged_at':at,'recorded_at':at,
                                'contract':{'player_id':u,'club_id':execution,'union_id':execution,'coordinator_union_id':execution,
                                            'rake_credit':Decimal('.08'),'club_residual':Decimal('.08'),'is_union_house':True,'tiers':[],
                                            'union_agreement':None,'terms_at':at,'membership':{'history_id':n,'observed_at':at,'terms':h['after_terms']}}})
    q['fee_batch']={'rake_record_id':fee['id'],'tournament_id':tournament,'status':'captured','source_version':2,
                    'rake_amount':Decimal('.24'),'captured_at':at,'source_fingerprint':_fee_fingerprint(fee),
                    'source_manifest':{'union_id':execution,'game_type':'spin','spin_reserve_id':q['reserve']['id'],'contributors':contributors}}
    q['original_flows']=[{'ledger_id':leg['id'],'transaction_id':str(n),'recognized_at':at,'ledger_snapshot':dict(leg),
                         'game_scope':{'game_union_id':execution,'host_club_id':execution,'tournament_id':tournament,
                                       'is_private':False,'asset':'chips','unit_scale':2}}
                        for n,leg in enumerate([r for r in q['source_journals'] if r['category']=='tournament_buyin'],1)]
    restoration = {}
    for name, cols in RESTORATION_COLUMNS.items():
        data = []
        if name == 'accounting_agreement_history':
            data = [{**dict.fromkeys(cols), **row} for row in q['membership_history']]
            q['membership_history'] = data
        if name == 'union_pnl_transaction_frames':
            data = [{'transaction_id':str(n),'observed_at':at,'book_start':at} for n in range(1,4)]
        body = _jsonb_text(data)
        restoration[name] = {'columns':cols, 'rows':data, 'row_count':len(data), 'rows_jsonb_text':body,
                             'rows_md5':hashlib.md5(body.encode()).hexdigest(), 'complete':True}
    q['restoration_inputs'] = {'kind':'genuine-entry-restoration-inputs-v1', 'complete':True,
                               'historical_evidence':False, 'relations':restoration}
    q['request_receipts']=receipts
    for name,receipt in receipts.items(): states[('creator' if name=='create' else name)+'_committed']['receipt']=receipt
    digest='1'*32
    states['positive_fee_replay_baseline']['estate_digest_md5']=digest
    states['seat3_replay_committed'].update(all_relation_rows_unchanged=True,estate_digest_md5=digest,
                                          receipt={'ok':True,'already_seated':True,'table_id':table,'seat_number':3})
    states['book_replay_committed'].update(all_relation_rows_unchanged=True,estate_digest_md5=digest,
        receipt={'ok':True,'reason':'already_booked','collected':3,'house_rake':Decimal('.24'),'reserve_in':Decimal('2.76'),
                 'balance':Decimal('2.76'),'owner_id':execution,'pool_id':q['pool']['id'],'seats':3,'paid_users':3,
                 'entry_reserve_id':q['reserve']['id'],'entry_journal_id':reserve_leg['id']})
    states['positive_fee_entry_final_observation'].update(tournament=tournament,observed_at=later,estate_digest_md5=digest,
        entry_slice_observed=True,seat_replay_unchanged=True,book_replay_unchanged=True,
        **{k:False for k in ['full_financial_qualification','mixed_history_qualification','historical_qualification','terminal_qualification','production_qualification']})
    return execution,tournament,[states[n] for n in STAGES]


def run_negative_controls():
    """Finite existing-wrapper controls; no database or filesystem access."""
    from copy import deepcopy
    execution,tournament,original=_control_records()
    def encode(value):
        return ('\n'.join(_jsonb_text(row) for row in value)+'\n').encode()
    positive=validate_output(encode(original),execution,tournament)
    require(positive['issued']=='100.00' and positive['fee_sources']==3, 'positive parser control')
    # Fixed literal checks serializer semantics independently of the generated receipt.
    require(_jsonb_text({'bbb':Decimal('0.0800'),'a':None,'aa':True}) ==
            '{"a": null, "aa": true, "bbb": 0.0800}', 'captured jsonb text domain')
    negatives=[]
    def edit(label, action):
        records=deepcopy(original);q=records[STAGES.index('positive_fee_entry_committed_observation')]
        action(q,records);negatives.append((label,encode(records)))
    edit('treasury',(lambda q,r:q['club_row'].__setitem__('chip_treasury',98)))
    edit('reserve',(lambda q,r:q['pool'].__setitem__('balance',Decimal('2.77'))))
    edit('escrow',(lambda q,r:q['escrow'].__setitem__('fee_balance',Decimal('.25'))))
    edit('charge amount',(lambda q,r:q['source_journals'][2].__setitem__('amount',2)))
    edit('wrong charge link',(lambda q,r:q['entitlements'][0].__setitem__('source_ledger_id',q['source_journals'][0]['id'])))
    edit('duplicate paid identity',(lambda q,r:q['seats'][1].__setitem__('user_id',q['seats'][0]['user_id'])))
    edit('fee source missing',(lambda q,r:q['fee_sources'].pop()))
    edit('fee credit redistributed',(lambda q,r:q['fee_sources'][0].__setitem__('rake_credit',Decimal('.09'))))
    edit('legacy fallback',(lambda q,r:q['fee_batch'].__setitem__('status','legacy_unverified')))
    edit('fingerprint',(lambda q,r:q['fee_batch'].__setitem__('source_fingerprint','0'*32)))
    edit('wrong reserve identity',(lambda q,r:q['fee_batch']['source_manifest'].__setitem__('spin_reserve_id',tournament)))
    edit('wrong membership terms',(lambda q,r:q['membership_history'][0].__setitem__('subject_user_id',OWNER)))
    edit('original flow tamper',(lambda q,r:q['original_flows'][0]['ledger_snapshot'].__setitem__('amount',2)))
    edit('collapsed original transactions',(lambda q,r:q['original_flows'][1].__setitem__('transaction_id',q['original_flows'][0]['transaction_id'])))
    edit('unknown fee number type',(lambda q,r:q.__setitem__('fee_amount','0.24')))
    edit('bool amount',(lambda q,r:q['source_journals'][2].__setitem__('amount',True)))
    edit('expired session',(lambda q,r:q['sessions'][0].__setitem__('not_after',q['preparation_started_at'])))
    edit('early launch',(lambda q,r:q['tournament_row'].__setitem__('status','RUNNING')))
    edit('preinserted terminal',(lambda q,r:q['excluded_counts'].__setitem__('tournament_terminal_settlements',1)))
    edit('historical overclaim',(lambda q,r:q.__setitem__('historical_qualification',True)))
    edit('seat replay digest',(lambda q,r:r[STAGES.index('seat3_replay_committed')].__setitem__('estate_digest_md5','2'*32)))
    edit('booking replay ID',(lambda q,r:r[STAGES.index('book_replay_committed')]['receipt'].__setitem__('entry_journal_id',tournament)))
    edit('missing stage',(lambda q,r:r.pop(STAGES.index('seat3_committed'))))
    edit('duplicate stage',(lambda q,r:r.append(deepcopy(r[-1]))))
    edit('wrong stage order',(lambda q,r:r.reverse()))
    edit('final overclaim',(lambda q,r:r[-1].__setitem__('full_financial_qualification',True)))
    edit('duplicate fee source ID',(lambda q,r:q['fee_sources'][1].__setitem__('id',q['fee_sources'][0]['id'])))
    edit('wrong stage execution',(lambda q,r:r[STAGES.index('bank1_intent')].__setitem__('execution',tournament)))
    edit('wrong Mint transaction',(lambda q,r:q['chip_transactions'][-1].__setitem__('amount',99)))
    edit('restart source',(lambda q,r:q['tournament_row'].__setitem__('restart_source_id',tournament)))
    edit('bank receipt names wrong transaction',(lambda q,r:q['request_receipts']['bank1'].__setitem__('transaction_id',tournament)))
    edit('restoration missing',(lambda q,r:q.pop('restoration_inputs')))
    edit('restoration relation omitted',(lambda q,r:q['restoration_inputs']['relations'].pop('entry_purchase_idempotency_receipts')))
    edit('restoration wrong columns',(lambda q,r:q['restoration_inputs']['relations']['club_wallets']['columns'].pop()))
    edit('restoration row count',(lambda q,r:q['restoration_inputs']['relations']['club_wallets'].__setitem__('row_count',1)))
    edit('restoration body hash',(lambda q,r:q['restoration_inputs']['relations']['club_wallets'].__setitem__('rows_md5','0'*32)))
    edit('restoration body disagreement',(lambda q,r:q['restoration_inputs']['relations']['accounting_agreement_history']['rows'][0].__setitem__('actor_id',OWNER)))
    edit('restoration false completeness',(lambda q,r:q['restoration_inputs'].__setitem__('complete',False)))
    edit('restoration historical claim',(lambda q,r:q['restoration_inputs'].__setitem__('historical_evidence',True)))
    valid=encode(original)
    negatives += [('duplicate JSON key',valid.replace(b'"stage":',b'"stage":"shadow", "stage":',1)),
                  ('nonfinite NaN',valid.replace(b'"fee_amount": 0.24',b'"fee_amount": NaN',1)),
                  ('nonfinite Infinity',valid.replace(b'"fee_amount": 0.24',b'"fee_amount": Infinity',1)),
                  ('unbounded exponent',valid.replace(b'"fee_amount": 0.24',b'"fee_amount": 1e999999999',1)),
                  ('SQL ERROR',b'ERROR: refusal\n'+valid),('invalid UTF8',valid+b'\xff'),
                  ('JSON trailing text',valid+b'{"stage":"mint_committed"}|other\n')]
    for label,raw in negatives:
        try:
            validate_output(raw,execution,tournament)
        except (ValueError,KeyError,TypeError,ArithmeticError):
            continue
        raise AssertionError('corrupt evidence accepted: '+label)
    return len(negatives)
