import { readFileSync } from 'node:fs';
import { splitConcurrentPreamble } from '../../migration-concurrent-preamble.mjs';
const sql = readFileSync('supabase/migrations/20261010030115_funding_receipts_recovery_covering_scan.sql', 'utf8');
const split = splitConcurrentPreamble(sql);
if (!split.ok || split.indexes.length !== 1) throw new Error('maintained index splitter refused');
// The VM and CI use only temporary objects. These exact fixture adaptations
// preserve the real guard clauses, changing only schema and persistence.
let guard = split.body.match(/DO \$guard\$\n([\s\S]+?)\nEND \$guard\$;/)?.[1];
if (!guard) throw new Error('owning guard not found');
guard = guard.replaceAll('public.', 'pg_temp.').replaceAll("relpersistence='p'", "relpersistence='t'").replaceAll("ix.relpersistence<>'p'", "ix.relpersistence<>'t'");
const index = split.indexes[0].statement.replace(' CONCURRENTLY', '').replaceAll('public.', 'pg_temp.');
const shape = 'CREATE INDEX idx_tournament_funding_recovery_cover ON pg_temp.tournament_participant_funding_receipts';
const variants = [
 ['omitted inclusion', shape+'(ledger_id) INCLUDE(asset,amount);'],
 ['partial index', shape+'(ledger_id) INCLUDE(asset,amount,wallet_transaction_id) WHERE ledger_id IS NOT NULL;'],
 ['unique index', shape.replace('CREATE INDEX','CREATE UNIQUE INDEX')+'(ledger_id) INCLUDE(asset,amount,wallet_transaction_id);'],
 ['descending key', shape+'(ledger_id DESC) INCLUDE(asset,amount,wallet_transaction_id);'],
 ['wrong inclusion order', shape+'(ledger_id) INCLUDE(amount,asset,wallet_transaction_id);']
];
const refuse = (message) => `DO $test$ BEGIN BEGIN PERFORM pg_temp.qualify_funding_cover(); RAISE EXCEPTION 'fixture accepted incompatible index'; EXCEPTION WHEN OTHERS THEN IF SQLERRM <> '${message}' THEN RAISE; END IF; END; END $test$;`;
const statements = [
 'BEGIN;', "SET LOCAL statement_timeout='19s';", 'SET LOCAL ROLE postgres;',
 'CREATE TEMP TABLE tournament_participant_funding_receipts(ledger_id uuid,asset text,amount numeric,wallet_transaction_id uuid);',
 'ALTER TABLE pg_temp.tournament_participant_funding_receipts ENABLE ROW LEVEL SECURITY;',
 'GRANT SELECT ON pg_temp.tournament_participant_funding_receipts TO service_role;',
 "INSERT INTO pg_temp.tournament_participant_funding_receipts VALUES(NULL,'chips',1.25,NULL),('00000000-0000-0000-0000-000000000001','diamonds',0.5,NULL);",
 `CREATE FUNCTION pg_temp.qualify_funding_cover() RETURNS void LANGUAGE plpgsql AS $fixture$\n${guard}\nEND\n$fixture$;`,
 refuse('funding_recovery_cover_missing')
];
for (const [name, statement] of variants) statements.push('-- '+name, statement, refuse('funding_recovery_cover_shape_changed'), 'DROP INDEX pg_temp.idx_tournament_funding_recovery_cover;');
statements.push(index, 'SELECT pg_temp.qualify_funding_cover();',
 'REVOKE SELECT ON pg_temp.tournament_participant_funding_receipts FROM service_role;', refuse('funding_recovery_relation_preimage_changed'),
 'GRANT SELECT ON pg_temp.tournament_participant_funding_receipts TO service_role;', 'SELECT pg_temp.qualify_funding_cover();',
 "DO $test$ BEGIN IF (SELECT count(*) FROM pg_temp.tournament_participant_funding_receipts)<>2 OR (SELECT sum(amount) FROM pg_temp.tournament_participant_funding_receipts)<>1.75 THEN RAISE EXCEPTION 'fixture data changed'; END IF; END $test$;",
 "SELECT jsonb_build_object('guardCases',8,'matchingIndexAccepted',true,'dataPreserved',true,'temporaryOnly',true,'productionConnections',0,'nativeInvalidReadinessTest',false,'invalidReadinessCoveredByMaintainedApplier',true);", 'ROLLBACK;');
console.log(statements.join('\n'));
