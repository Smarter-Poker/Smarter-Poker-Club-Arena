"""Connected qualification of accepted statistics and lifetime retention.
Runs only inside the existing isolated key/cash PostgreSQL owner. No production.
"""
from pathlib import Path
from satellite_qualifier_fixture import module,sha

ADAPTIVE=Path('supabase/migrations/20261012170542_horse_adaptive_raw_facts_become_exact_sufficient_statistics.sql')
FACTS=Path('supabase/migrations/20261012170919_horse_fact_cards_age_out_without_erasing_player_totals.sql')

def qualify(e,template):
 root=e.root;base=e.database(template)
 e.report['source_sha256'].update({str(p):sha(root/p) for p in [ADAPTIVE,FACTS,Path(__file__).relative_to(root)]})
 # Apply the real original20260928031344 witness constraint transition.
 # The older supersession fixture incorrectly required a strictly later hand.
 source=(root/'supabase/migrations/20260928031344_retention_closes_the_settlement_request_it_prunes.sql').read_text()
 start=source.index('ALTER TABLE smarter_private.hand_submission_disposals')
 end=source.index('CREATE OR REPLACE FUNCTION smarter_private.hand_submission_retention_disposal',start)
 e.sql(base,source[start:end],label='derived-original-retention-witness-constraint')
 # The key/cash fixture contains the exact current classifier and financial
 # readers. Bind the actual immutable raw owner before installing its successor.
 src=(root/'supabase/migrations/20261012153428_settled_horse_request_payloads_age_out_with_their_history.sql').read_text()
 start=src.index('CREATE OR REPLACE FUNCTION smarter_private.hand_submission_immutable()')
 end=src.index('$function$;',start)+len('$function$;')
 e.sql(base,src[start:end]+"REVOKE ALL ON FUNCTION smarter_private.hand_submission_immutable() FROM PUBLIC,anon,authenticated,service_role; CREATE TRIGGER hand_submission_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submissions FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable(); CREATE TRIGGER hand_submission_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();",label='derived-original-raw-owner')
 for name in [
  '20260913170729_horse_adaptive_observation_journal.sql',
  '20260913175935_recoverable_horse_adaptive_journal_batches.sql',
  '20260913181841_durable_horse_adaptive_journal_work.sql',
  '20260913193221_bounded_horse_adaptive_retention.sql',
  '20260914113838_consume_journaled_horse_opponent_models.sql',
  '20260927220647_journaled_model_store_reclaims_by_capacity_not_only_age.sql',
  '20260927221452_journaled_model_finish_and_claim_are_engine_only.sql']:
  e.sql(base,file=root/'supabase/migrations'/name,label='derived-original-'+name[:14])
 e.sql(base,file=root/ADAPTIVE,label='derived-qualified-adaptive-transition')
 facts=module(root/'scripts/verification-harness/horse-fact-card-proof.py','derived_fact_proof')
 captured=facts.qualify(e,base,FACTS,keep_template=True)
 review=module(root/'scripts/verification-harness/horse-review-raw-retention.py','derived_review_proof')
 reviewed=review.qualify(e,captured,keep_template=True)
 snapshot=module(root/'scripts/verification-harness/horse-snapshot-retention.py','derived_snapshot_proof')
 snapshotted=snapshot.qualify(e,reviewed,keep_template=True)
 lifetime=module(root/'scripts/verification-harness/horse-lifetime-retention.py','derived_lifetime_proof')
 lifetime.qualify(e,snapshotted,connected=True)
 e.discard(snapshotted);e.discard(reviewed);e.discard(captured);e.discard(base)
