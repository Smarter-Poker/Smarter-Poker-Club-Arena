"""Actual two-backend consumption of one funded voucher at distinct destinations."""
import hashlib
import json
import re


def qualify(e, root, native, template, output, seed, scene, diamond_seed, diamond_scene):
    # Retain the actual funded opening and issuance assertions, stopping before
    # either scene consumes a ticket. No money owner or guard is substituted.
    def opening(text, tag):
        marker = ' u:=q[1];SELECT ticket_id INTO tk'
        if text.count(marker) != 1:
            raise ValueError('funded scene consumption seam changed')
        return text.partition(marker)[0] + '\nEND;\n$' + tag + '$;\n'

    context = """
CREATE TABLE public.native_value_ticket_race_context(asset text PRIMARY KEY,data jsonb NOT NULL);
DO $context$ DECLARE a text; source_id uuid; dest uuid; other uuid; tk public.tournament_tickets%ROWTYPE; BEGIN
 FOR a IN SELECT unnest(ARRAY['chips','diamonds']) LOOP
  source_id:=md5('l04:'||CASE WHEN a='chips' THEN 'value_closed' ELSE 'diamond_value' END||':source')::uuid;
  dest:=md5(CASE WHEN a='chips' THEN 'value-ticket-new-destination' ELSE 'diamond-value-destination' END)::uuid;
  other:=md5(a||':value-ticket-race-other')::uuid;
  SELECT t.* INTO STRICT tk FROM public.tournament_tickets t WHERE source_satellite_id=source_id ORDER BY holder_id LIMIT 1;
  INSERT INTO public.tournaments SELECT x.* FROM public.tournaments t,
   LATERAL jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
    'id',other,'format_contract',NULL,'name',a||' Race Alternate Destination',
    'entry_contract_locked',false,'current_players',0,'prize_pool',0,'total_rake',0,'bounty_pool',0)) x WHERE t.id=dest;
  INSERT INTO public.native_value_ticket_race_context VALUES(a,jsonb_build_object(
   'ticket',tk.id,'holder',tk.holder_id,'source',source_id,'dest',dest,'other',other,
   'wallets',(SELECT jsonb_agg(jsonb_build_array(club_id,user_id,chip_balance) ORDER BY club_id,user_id) FROM public.club_members),
   'diamonds',(SELECT jsonb_agg(jsonb_build_array(id,diamonds) ORDER BY id) FROM public.profiles),
   'diamond_total',(SELECT sum(diamonds)+public.fn_ca_arena_diamonds() FROM public.profiles),
   'receipt',public.fn_ca_satellite_cohort_receipt(source_id,ARRAY(SELECT user_id FROM public.tournament_satellite_awards WHERE tournament_id=source_id ORDER BY user_id))));
 END LOOP;
END $context$;
UPDATE public.ca_arena_settings SET tournaments_enabled=true WHERE id=1;
DROP TRIGGER native_qualifier_final_close ON public.tables;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
"""
    text = seed + opening(scene, 'value_chips') + diamond_seed + opening(diamond_scene, 'diamond_value') + context
    path = output / 'concurrent-funded-opening.sql'
    path.write_text(text)
    e.sql(template, file=path, label='actual-funded-concurrent-opening', seconds=180)
    spec_path = root / 'tests/fixtures/satellite-value-awards/consumption.spec'
    spec = spec_path.read_text()
    binary = native.stock_isolationtester(e.pg)
    e.report['source_sha256'][str(spec_path.relative_to(root))] = hashlib.sha256(spec_path.read_bytes()).hexdigest()
    e.report['isolationtester'] = {'path': str(binary), 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
    for asset in ['chips', 'diamonds']:
        for release in ['commit', 'rollback']:
            db = e.database(template)
            case = 'value-ticket-' + asset + '-' + release
            selected = spec.replace('@ASSET@', asset).replace('@RELEASE@', release)
            conn = f'host={e.socket} port={e.port} dbname={db} user=postgres'
            code, stdout, stderr = e.run(case, [binary, conn], text=selected, seconds=75, check=False)
            expected = ['VALUE_TICKET_FIRST_ENTRY', 'VALUE_TICKET_DISTINCT_BACKEND_WAIT_PROVEN',
                        'VALUE_TICKET_SECOND_REFUSED' if release == 'commit' else 'VALUE_TICKET_SECOND_ENTRY',
                        'VALUE_TICKET_EXACT_EFFECTS_PROVEN']
            notices = re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*(VALUE_TICKET_[A-Z_]+)\s*$', stdout + '\n' + stderr, re.M)
            errors = re.findall(r'^(?:[a-z_]+: )?(?:ERROR|FATAL|PANIC|WARNING):', stdout + '\n' + stderr, re.M)
            waits = re.findall(r'^(?:[a-z_]+: )?NOTICE:\s*VALUE_TICKET_WAIT_EVIDENCE=(.+)$', stdout + '\n' + stderr, re.M)
            wait = json.loads(waits[0]) if len(waits) == 1 else {}
            if (code or errors or notices != expected or stdout.count('Parsed test spec with 2 sessions') != 1
                    or stdout.count('<waiting ...>') != 1 or stdout.count('<... completed>') != 1
                    or type(wait.get('first_pid')) is not int or type(wait.get('second_pid')) is not int
                    or wait.get('first_pid') == wait.get('second_pid')
                    or wait.get('first_pid') not in wait.get('blocking_pids', [])
                    or wait.get('wait_event') not in ('transactionid','tuple')):
                raise RuntimeError(case + ' lacks exact overlap, authoritative outcome or financial proof')
            e.discard(db)
            e.report['races'].append({'case': case, 'asset': asset, 'release': release,
                'distinct_backends': True, 'observed_blocking_owner': True,
                'wait_evidence': wait,
                'distinct_destinations': True, 'single_consumption': True,
                'authoritative_second_outcome': 'ticket_already_used' if release == 'commit' else 'funded_entry',
                'exact_funded_rails': True, 'wallets_unchanged': True,
                'original_operation_replay': True, 'database_removed': True})
