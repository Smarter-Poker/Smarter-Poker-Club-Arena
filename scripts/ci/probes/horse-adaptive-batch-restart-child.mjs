// Native-only recovery consumer: no source snapshot or hand history is supplied.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { root, options, batchKey } = JSON.parse(process.argv[2]);
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
          const query =
            name === 'fn_horse_adaptive_journal_batch'
              ? 'SELECT fn_horse_adaptive_journal_batch($1) value'
              : name === 'fn_append_horse_adaptive_observations'
                ? 'SELECT fn_append_horse_adaptive_observations($1) value'
                : null;
          assert.ok(query, 'Restart consumer must not reacquire a changed history snapshot');
          const r = await client.query(query, [args.p_batch_key ?? args.p_batch]);
          return { data: r.rows[0].value, error: null };
        },
      };
    },
  };
  globalThis.horseJournalRestart = { supabase };
  const path = root + '/server/dist/services/HorseAdaptiveObservationJournal.js';
  const source = readFileSync(path, 'utf8')
    .replace(
      /import \{ supabase \} from '\.\/supabase\.js';/,
      'const {supabase}=globalThis.horseJournalRestart;'
    )
    .replace(/from '([^']+)'/g, (whole, relative) =>
      relative.startsWith('.')
        ? "from '" + new URL(relative, pathToFileURL(path)).href + "'"
        : whole
    );
  const journal = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  const batch = await journal.readAdaptiveJournalBatch(batchKey);
  assert.equal(batch.status, 'prepared');
  const result = await journal.persistPreparedAdaptiveJournalBatch(batch);
  assert.equal(result.status, 'recorded');
  console.log(
    JSON.stringify({
      batchKey: batch.batchKey,
      batchDigest: batch.batchDigest,
      observations: batch.observations,
      calls,
      status: result.status,
    })
  );
} finally {
  await client.end();
}
