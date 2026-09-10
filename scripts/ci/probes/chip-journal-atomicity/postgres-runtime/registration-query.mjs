// The registration rehearsal uses the same pinned pg client as the CI database suite.
// One JSON-encoded SQL request per line keeps a transaction open across test barriers.
import pg from 'pg';
import { createInterface } from 'node:readline';

const client = new pg.Client();
try {
  await client.connect();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const result = await client.query(JSON.parse(line));
    for (const statement of Array.isArray(result) ? result : [result]) {
      for (const row of statement.rows ?? []) {
        const value = Object.values(row)[0];
        console.log(
          value == null
            ? ''
            : typeof value === 'boolean'
              ? value
                ? 't'
                : 'f'
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value)
        );
      }
    }
  }
} catch (error) {
  console.error(error.code || 'PG_ERROR', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
