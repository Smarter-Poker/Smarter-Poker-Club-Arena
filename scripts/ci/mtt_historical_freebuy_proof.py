"""Exact three-source historical Free Buy proof using the existing native owner.

The caller supplies its genuine pre-preparation composed template, Execution,
and the maintained complete data/catalog rollback comparison. This module owns
only cloned case databases. It creates no cluster or production connection.
"""
from pathlib import Path
import hashlib
import json

FIXTURE = Path("scripts/ci/fixtures/mtt-historical-freebuy")
MIGRATION = Path("supabase/migrations/20260917205610_mtt_three_original_freebuy_fee_proofs.sql")


def bound_inputs(root):
    """Refuse stale or changed qualification input bytes before any SQL."""
    root = Path(root).resolve()
    manifest_path = root / FIXTURE / "source-binding.json"
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("version") != 1 or not isinstance(manifest.get("files"), dict):
        raise ValueError("invalid historical Free Buy source binding")
    hashes = {}
    for relative, expected in manifest["files"].items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError("historical Free Buy input outside checkout or absent: " + relative)
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError("historical Free Buy input drift: " + relative)
        hashes[relative] = actual
    required = {str(MIGRATION), str(FIXTURE / "current-authority-supplement.sql"),
                str(FIXTURE / "historical-input-fixture.sql"), str(FIXTURE / "production-probe.sql"),
                str(FIXTURE / "exact-plan.json"), str(FIXTURE / "input-provenance.json"),
                "scripts/ci/mtt_historical_freebuy_proof.py"}
    if set(hashes) != required:
        raise ValueError("historical Free Buy binding has missing or unexpected inputs")
    hashes[str(FIXTURE / "source-binding.json")] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    return hashes


def qualify(execution, root, composed_template, assert_rollback):
    """Run the finite original-proof cases, never the R46 activation candidate."""
    root = Path(root).resolve()
    hashes = bound_inputs(root)
    e = execution
    e.report["source_sha256"].update(hashes)
    ev = root / FIXTURE
    migration = root / MIGRATION
    owned = []

    def database(parent):
        value = e.database(parent)
        owned.append(value)
        return value

    def discard(value):
        e.discard(value)
        owned.remove(value)

    template = database(composed_template)
    try:
        e.sql(template,file=ev/'current-authority-supplement.sql',label='captured-current-earning-authorities')
        e.sql(template,file=ev/'historical-input-fixture.sql',label='captured-three-charge-inputs')
        # Pin original producer refusal before adding explicit historical proof.
        e.sql(template,query="DO $negative$ BEGIN BEGIN PERFORM public.fn_capture_accounting_tournament_fee('1229290b-448b-4015-99d2-955a093965fc'); RAISE EXCEPTION 'unexpected historical capture'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'tournament_fee_not_captured_by_original_producer' THEN RAISE;END IF;END;RAISE NOTICE 'FEE PASS: original producer rejects historical capture';END $negative$;",label='original-producer-cutoff-refusal')
        # A real net-plan failure before the missing source evidence is repaired.
        e.sql(template,query="DO $negative$ BEGIN BEGIN PERFORM public.fn_accounting_tournament_fee_net_plan('2c684c36-a1c0-40c6-b92a-610a86083c1b'); RAISE EXCEPTION 'unexpected fee plan';EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'tournament_fee_sources_require_reconciliation' THEN RAISE;END IF;END;RAISE NOTICE 'FEE PASS: original missing sources refuse';END $negative$;",label='original-missing-sources')
        db=database(template)
        e.sql(db,query="CREATE TABLE public.fixture_unchanged AS SELECT 'rake' kind,to_jsonb(r) doc FROM public.rake_records r UNION ALL SELECT 'ledger',to_jsonb(l) FROM public.chip_ledger l UNION ALL SELECT 'entitlement',to_jsonb(l) FROM public.tournament_refund_entitlements l UNION ALL SELECT 'registration',to_jsonb(l) FROM public.tournament_players l UNION ALL SELECT 'history',to_jsonb(l) FROM public.accounting_agreement_history l UNION ALL SELECT 'terms',to_jsonb(l) FROM public.managed_game_contract_versions l UNION ALL SELECT 'wallet',to_jsonb(l) FROM public.club_members l UNION ALL SELECT 'bank',to_jsonb(l) FROM public.club_wallets l;",label='business-preimages')
        e.sql(db,file=migration,label='exact-historical-proof')
        post='''DO $proof$ DECLARE p jsonb; expected numeric; t uuid;n integer;BEGIN
        IF (SELECT count(*) FROM public.accounting_tournament_fee_batches)<>3 OR (SELECT count(*) FROM public.accounting_tournament_fee_sources)<>3
          OR (SELECT sum(rake_credit) FROM public.accounting_tournament_fee_sources)<>0.30 THEN RAISE EXCEPTION 'wrong appended source total';END IF;
        FOR t,expected,n IN SELECT * FROM (VALUES('2c684c36-a1c0-40c6-b92a-610a86083c1b'::uuid,0.20,2),('fea2579a-643b-45d1-b22f-de654ce8ed23'::uuid,0.10,1))v LOOP
         p:=public.fn_accounting_tournament_fee_net_plan(t);
         IF p->>'status'<>'proven' OR (p->>'net_fee')::numeric<>expected OR (p->>'refunded_fee')::numeric<>0
           OR jsonb_array_length(p->'active_source_ids')<>n OR p->>'payable'<>'false' THEN RAISE EXCEPTION 'wrong current fee plan: %',p;END IF;
        END LOOP;
        IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE recorded_at<=charged_at)
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b JOIN public.rake_records r ON r.id=b.rake_record_id WHERE b.captured_at<=r.created_at) THEN RAISE EXCEPTION 'fabricated old capture timestamp';END IF;
        IF EXISTS(WITH actual AS(SELECT 'rake' kind,to_jsonb(r) doc FROM public.rake_records r UNION ALL SELECT 'ledger',to_jsonb(l) FROM public.chip_ledger l UNION ALL SELECT 'entitlement',to_jsonb(l) FROM public.tournament_refund_entitlements l UNION ALL SELECT 'registration',to_jsonb(l) FROM public.tournament_players l UNION ALL SELECT 'history',to_jsonb(l) FROM public.accounting_agreement_history l UNION ALL SELECT 'terms',to_jsonb(l) FROM public.managed_game_contract_versions l UNION ALL SELECT 'wallet',to_jsonb(l) FROM public.club_members l UNION ALL SELECT 'bank',to_jsonb(l) FROM public.club_wallets l)
        (SELECT * FROM actual EXCEPT ALL SELECT * FROM public.fixture_unchanged) UNION ALL(SELECT * FROM public.fixture_unchanged EXCEPT ALL SELECT * FROM actual)) THEN RAISE EXCEPTION 'original financial evidence changed';END IF;
        RAISE NOTICE 'FEE PASS: exact 0.30 original sources, current net plans, honest timestamps and unchanged original financial evidence';
        END $proof$;'''
        e.sql(db,query=post,label='real-current-net-plans-and-no-money-effect')
        before=e.snapshot(db,'replay-before-data');catalog=e.catalog_snapshot(db,'replay-before-catalog')
        e.sql(db,file=migration,label='exact-historical-replay')
        assert_rollback(e,db,before,catalog,'replay-no-write')
        e.report['native'].append({'case':'three-source-append-and-exact-replay','net_fees':['0.20','0.10'],'total_original_rake_credit':'0.30','money_writes':False,'current_original_capture_unchanged':True})
        discard(db)
        cases=[
        ('partial-capture',"INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,source_manifest,status,source_version,captured_at) VALUES('1229290b-448b-4015-99d2-955a093965fc','2c684c36-a1c0-40c6-b92a-610a86083c1b','a607d51e27491cef54245600dbea38e6',0.10,'{}','captured',2,transaction_timestamp());",'HISTORICAL_FEE_PARTIAL_CAPTURE_REFUSED'),
        ('raw-fingerprint',"UPDATE public.rake_records SET rake_amount=0.11 WHERE id='1229290b-448b-4015-99d2-955a093965fc';",'HISTORICAL_FEE_RAW_SOURCE_DRIFT'),
        ('charge-amount',"UPDATE public.chip_ledger SET amount=2 WHERE id='9e29e593-5f51-431a-a7e0-a5f4ce357e65';",'HISTORICAL_FEE_CHARGE_DRIFT'),
        ('entitlement-fee',"UPDATE public.tournament_refund_entitlements SET refund_fee=0.11,refund_prize=0.89 WHERE id='35fd34f5-a24c-47fa-aedf-c17ebd079bd4';",'HISTORICAL_FEE_ENTITLEMENT_DRIFT'),
        ('registration-club',"UPDATE public.tournament_players SET club_id='a0000000-0000-0000-0000-000000000001' WHERE id='ff7f6f0a-5313-4be6-8fba-b18e0cbe6da8';",'HISTORICAL_FEE_REGISTRATION_DRIFT'),
        ('managed-hash',"UPDATE public.managed_game_contract_versions SET contract_hash=repeat('0',64) WHERE game_id='2c684c36-a1c0-40c6-b92a-610a86083c1b' AND version=1;",'HISTORICAL_FEE_MANAGED_PROVENANCE_DRIFT'),
        ('original-earning-terms',"UPDATE public.accounting_agreement_history SET after_terms=jsonb_set(after_terms,'{commission_rate}','0.50') WHERE id=81;",'HISTORICAL_FEE_EARNING_PROVENANCE_DRIFT'),
        ('earning-acl',"GRANT EXECUTE ON FUNCTION public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz) TO authenticated;",'HISTORICAL_FEE_AUTHORITY_DRIFT'),
        ('immutable-trigger',"ALTER TABLE public.accounting_tournament_fee_sources DISABLE TRIGGER accounting_tournament_fee_sources_immutable;",'HISTORICAL_FEE_RECEIPT_SCHEMA_DRIFT'),
        ]
        for name,fault,expected in cases:
         db=database(template)
         e.sql(db,query='BEGIN;SET LOCAL session_replication_role=replica;'+fault+'SET LOCAL session_replication_role=origin;COMMIT;',label=name+'-fixture-fault')
         before=e.snapshot(db,name+'-before-data');catalog=e.catalog_snapshot(db,name+'-before-catalog')
         code,stdout,stderr=e.sql(db,file=migration,label=name+'-refusal',check=False)
         errors=[s.split('ERROR:',1)[1].strip() for s in stderr.splitlines() if 'ERROR:' in s]
         if code!=3 or len(errors)!=1 or not errors[0].startswith(expected):raise ValueError(name+' unexpected refusal: '+stderr)
         assert_rollback(e,db,before,catalog,name);discard(db)
         e.report['migration_refusals'].append({'case':name,'error':errors[0],'exact_rollback':True})
        # The review-only production probe is also exercised locally; expected raised
        # error proves the entire append is rolled back. It invokes no money function.
        db=database(template);before=e.snapshot(db,'self-abort-before-data');catalog=e.catalog_snapshot(db,'self-abort-before-catalog')
        code,stdout,stderr=e.sql(db,file=ev/'production-probe.sql',label='single-call-self-aborting-proof',check=False)
        if code!=3 or 'ERROR:  HISTORICAL_FEE_PROBE_ROLLBACK:' not in stderr:raise ValueError('self-abort mismatch '+stderr)
        assert_rollback(e,db,before,catalog,'self-abort');discard(db)
        e.report['native'].append({'case':'production-shaped-self-aborting-proof','exact_rollback':True,'production_execution':False})

        if bound_inputs(root) != hashes:
            raise ValueError("historical Free Buy inputs changed during qualification")
        return {"status": "passed", "source_count": 3, "original_fee_credit": "0.30",
                "net_fees": ["0.20", "0.10"], "negative_cases": 9,
                "exact_replay": True, "self_aborting_probe": True, "money_writes": False,
                "production_execution": False}
    finally:
        # Only this module's clones. Cluster cleanup remains the existing owner.
        for value in reversed(owned[:]):
            discard(value)
