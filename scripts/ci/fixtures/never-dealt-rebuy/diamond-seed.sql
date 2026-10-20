-- Synthetic Diamond funding for the existing anonymous original rebuy chairs.
-- No financial RPC, profile, wallet or production data is used.
INSERT INTO poker_diamond_tournament_ledger
SELECT row_number() OVER (ORDER BY f.id),f.tournament_id,(f.tournament_snapshot->>'club_id')::uuid,f.user_id,
 md5('custody:'||f.user_id::text)::uuid,f.operation,f.amount,f.amount,0,0,f.purchase_key,
 md5('journal:'||f.id::text)::uuid,NULL,f.registration_id,
 jsonb_build_object('request_id',md5('request:'||f.id::text)::uuid),f.observed_at
FROM tournament_participant_funding_receipts f WHERE f.operation='rebuy';
INSERT INTO poker_diamond_custody
SELECT DISTINCT custody_id,user_id,arena_id,'tournament_entry',tournament_id,'active' FROM poker_diamond_tournament_ledger;
INSERT INTO poker_diamond_movements
SELECT (d.request->>'request_id')::uuid,d.custody_id,d.user_id,'reserve',d.amount,
 'player:'||d.user_id,'arena_custody:'||d.custody_id,d.wallet_journal_id,
 jsonb_build_object('user_id',d.user_id,'custody_id',d.custody_id,'amount',d.amount,'action','tournament_add'),
 jsonb_build_object('success',true,'amount',d.amount,'custody_id',d.custody_id,'journal_id',d.wallet_journal_id,'request_id',d.request->>'request_id'),d.created_at
FROM poker_diamond_tournament_ledger d;
UPDATE tournament_participant_funding_receipts f SET asset='diamonds',entitlement_id=NULL,ledger_id=NULL,wallet_transaction_id=NULL,
 ledger_snapshot=NULL,wallet_snapshot=NULL,custody_result=jsonb_build_object('success',true,'amount',d.amount,'ledger_id',d.id,
 'custody_id',d.custody_id,'journal_id',d.wallet_journal_id,'request_id',d.request->>'request_id')
FROM poker_diamond_tournament_ledger d WHERE d.idempotency_key=f.purchase_key;
