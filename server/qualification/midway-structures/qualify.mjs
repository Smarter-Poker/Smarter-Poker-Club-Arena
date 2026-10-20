import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// An explicitly started private local PostgreSQL instance only. No production
// URL, credentials, env-file loader, database fallback or external connection.
const [socket, port, work] = process.argv.slice(2);
if (
  !socket?.startsWith('/Volumes/SmarterWork/agent-work/') ||
  !/^\d+$/.test(port ?? '') ||
  !work?.startsWith('/Volumes/SmarterWork/agent-work/')
)
  throw Error('Supply owned SSD socket, port and work directory');
const migration = resolve(
  'supabase/migrations/20261020163928_midway_standard_tournament_structures.sql'
);
const bytes = readFileSync(migration, 'utf8');
const definitions = JSON.parse(bytes.match(/\$definitions\$([\s\S]*?)\$definitions\$/)[1]);
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const args = ['-X', '-h', socket, '-p', port, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const log = [];
function sql(input, mustPass = true) {
  const r = spawnSync('psql', args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  log.push(r.stdout, r.stderr);
  if (mustPass && r.status !== 0) throw Error(r.stderr);
  return r;
}
let fixture = `DROP TABLE IF EXISTS schedules_once,after_once,originals,fixture_kinds,tournament_players,tournaments,tournament_schedules CASCADE;
CREATE TABLE tournament_schedules(id uuid PRIMARY KEY,club_id uuid,union_id uuid,active boolean,config jsonb,updated_at timestamptz);
CREATE TABLE tournaments(id uuid PRIMARY KEY,schedule_id uuid,club_id uuid,union_id uuid,status text,start_time timestamptz,entry_contract_locked boolean,prize_pool_finalized boolean,current_players integer,starting_chips integer,blind_structure text,blind_speed text,is_turbo boolean,late_reg_levels integer,late_reg_mins integer,rebuy_chips integer,rebuy_levels integer,addon_chips integer,addon_levels integer,addon_from_start boolean,addon_break_minutes integer,big_blind_ante boolean,guaranteed_prize numeric,table_size integer,updated_at timestamptz);
CREATE TABLE tournament_players(tournament_id uuid);
CREATE TABLE fixture_kinds(id uuid,kind text);
CREATE OR REPLACE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
`;
for (const d of definitions) {
  fixture += `INSERT INTO tournament_schedules VALUES(${quote(d.id)},'fade0000-0000-0000-0000-000000000001',NULL,true,${quote(JSON.stringify(d.before))}::jsonb,'2000-01-01');\n`;
  for (const kind of ['eligible', 'registered', 'running', 'foreign', 'finalized', 'locked']) {
    const id = `md5(${quote(d.id + kind)})::uuid`;
    fixture += `INSERT INTO fixture_kinds VALUES(${id},${quote(kind)});
INSERT INTO tournaments VALUES(${id},${quote(d.id)},${quote(kind === 'foreign' ? '00000000-0000-0000-0000-000000000099' : 'fade0000-0000-0000-0000-000000000001')},NULL,${quote(kind === 'running' ? 'RUNNING' : 'REGISTERING')},now()+interval '20 days',${kind === 'locked'},${kind === 'finalized'},0,3000,'[{"level":1,"smallBlind":12,"bigBlind":25,"ante":1,"durationMinutes":6}]','standard',false,11,60,3000,11,10000,1,true,1,false,500,9,'2000-01-01');\n`;
    if (kind === 'registered') fixture += `INSERT INTO tournament_players VALUES(${id});\n`;
  }
}
fixture += `INSERT INTO tournament_schedules VALUES('10f642b9-2ec8-4b05-93d4-a6e26b1e9218','fade0000-0000-0000-0000-000000000001',NULL,true,'{"fixedBoard":"Coffee Break Freeroll (PLO4)"}'::jsonb,'2000-01-01');
INSERT INTO tournament_schedules VALUES('00000000-0000-4000-8000-000000000099','002c2d27-9584-4e52-835a-bb2be148fc81',NULL,true,'{"fixedBoard":"Coffee Break Freeroll (PLO4)"}'::jsonb,'2000-01-01');
CREATE TABLE originals AS SELECT * FROM tournaments;`;

writeFileSync(resolve(work, 'native-fixture.sql'), fixture);
try {
  sql(fixture);
  sql(bytes);
  sql(`DO $$ BEGIN
IF (SELECT active FROM tournament_schedules WHERE id='10f642b9-2ec8-4b05-93d4-a6e26b1e9218') IS DISTINCT FROM false OR (SELECT active FROM tournament_schedules WHERE id='00000000-0000-4000-8000-000000000099') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Midway retirement scope differs'; END IF;
IF (SELECT count(*) FROM tournaments WHERE updated_at>'2000-01-01')<>${definitions.length} THEN RAISE EXCEPTION 'Wrong changed cohort'; END IF;
IF EXISTS(SELECT 1 FROM tournaments t JOIN originals o USING(id) JOIN fixture_kinds k USING(id) WHERE k.kind<>'eligible' AND to_jsonb(t) IS DISTINCT FROM to_jsonb(o)) THEN RAISE EXCEPTION 'Protected contract changed'; END IF;
IF EXISTS(SELECT 1 FROM tournaments t JOIN fixture_kinds k USING(id) WHERE k.kind='eligible' AND (t.blind_structure::jsonb->0->>'smallBlind'<>'25' OR t.blind_structure::jsonb->0->>'bigBlind'<>'25')) THEN RAISE EXCEPTION 'Bad opening'; END IF;
IF EXISTS(SELECT 1 FROM tournaments t JOIN fixture_kinds k USING(id) JOIN tournament_schedules s ON s.id=t.schedule_id WHERE k.kind='eligible' AND (t.table_size<>(s.config->>'tableSize')::integer OR t.starting_chips<>(s.config->>'startingStack')::integer OR t.blind_structure::jsonb<>s.config->'blindStructure' OR t.guaranteed_prize<>(s.config->>'guaranteedPrize')::numeric)) THEN RAISE EXCEPTION 'Event and schedule contract differ'; END IF;
END $$;
CREATE TABLE after_once AS SELECT * FROM tournaments;
CREATE TABLE schedules_once AS SELECT * FROM tournament_schedules;`);
  sql(bytes);
  sql(`DO $$ BEGIN
IF EXISTS(SELECT 1 FROM tournaments t JOIN after_once o USING(id) WHERE to_jsonb(t) IS DISTINCT FROM to_jsonb(o)) THEN RAISE EXCEPTION 'Replay changed events'; END IF;
IF EXISTS(SELECT 1 FROM tournament_schedules t JOIN schedules_once o USING(id) WHERE to_jsonb(t) IS DISTINCT FROM to_jsonb(o)) THEN RAISE EXCEPTION 'Replay changed schedules'; END IF;
END $$;
UPDATE tournament_schedules SET config=config||'{"concurrent_owner_edit":true}'::jsonb WHERE id=${quote(definitions[0].id)};`);
  const refused = sql(bytes, false);
  if (refused.status === 0 || !refused.stderr.includes('drifted'))
    throw Error('Concurrent configuration drift was not refused');
  console.log(
    `PASS: ${definitions.length} eligible normalized; ${definitions.length * 5} protected unchanged; Midway-only removal; exact replay no-op; concurrent configuration drift refused.`
  );
} finally {
  writeFileSync(resolve(work, 'native-qualification.log'), log.join('\n'));
}
