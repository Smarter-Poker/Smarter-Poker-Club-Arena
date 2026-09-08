import pg from 'pg';

let sql = '';
for await (const chunk of process.stdin) sql += chunk;
const client = new pg.Client();
try {
  await client.connect();
  await client.query(sql);
} catch (error) {
  console.error(error.code || 'PG_ERROR', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
