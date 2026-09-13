import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { root, options } = JSON.parse(process.argv[2]);
const { Client } = createRequire(root + '/server/package.json')('pg');
const client = new Client(options),
  calls = [];
await client.connect();
try {
  await client.query('SET ROLE service_role');
  const supabase = {
    rpc(name, args) {
      calls.push(name);
      return {
        async abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal);
          const specification = {
            fn_claim_horse_adaptive_batch: [
              'SELECT fn_claim_horse_adaptive_batch($1) value',
              [args.p_lease_token],
            ],
            fn_append_horse_adaptive_observations: [
              'SELECT fn_append_horse_adaptive_observations($1) value',
              [args.p_batch],
            ],
            fn_finish_horse_adaptive_batch: [
              'SELECT fn_finish_horse_adaptive_batch($1,$2,$3) value',
              [args.p_batch_key, args.p_lease_token, args.p_outcome],
            ],
          }[name];
          assert.ok(specification, 'Restart work may not query or replace its source snapshot');
          const r = await client.query(...specification);
          return { data: r.rows[0].value, error: null };
        },
      };
    },
  };
  globalThis.horseWorkRestart = { supabase };
  const load = async (name) => {
    const path = root + '/server/dist/services/' + name + '.js';
    const source = readFileSync(path, 'utf8')
      .replace(
        /import \{ supabase \} from '\.\/supabase\.js';/,
        'const {supabase}=globalThis.horseWorkRestart;'
      )
      .replace(
        /import\s*\{([^}]+)\}\s*from\s*'\.\/HorseAdaptiveObservationJournal\.js';/,
        'const {$1}=globalThis.horseWorkRestart.journal;'
      )
      .replace(/from '([^']+)'/g, (whole, relative) =>
        relative.startsWith('.')
          ? "from '" + new URL(relative, pathToFileURL(path)).href + "'"
          : whole
      );
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  };
  globalThis.horseWorkRestart.journal = await load('HorseAdaptiveObservationJournal');
  const { processAdaptiveJournalWork } = await load('HorseAdaptiveJournalWork');
  const result = await processAdaptiveJournalWork();
  assert.equal(result.status, 'completed');
  console.log(JSON.stringify({ result, calls }));
} finally {
  await client.end();
}
