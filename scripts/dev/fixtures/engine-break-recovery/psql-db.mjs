// The database scripts/ci/check-engine-break-recoveries.mjs is given in
// scripts/dev/probe-engine-break-recovery.sh: the probe's throwaway cluster,
// reached through psql instead of node-postgres (which the probe does not
// install). The same SQL runs, with each $n parameter inlined as a literal and
// every row query wrapped in json_agg so the rows come back as JSON. Never
// pointed at production: PROBE_PSQL, PROBE_HOST and PROBE_PORT are the probe's.
import { execFileSync } from 'node:child_process';

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

export const db = {
  async query(text, params = []) {
    const sql = text.replace(/\$(\d+)/g, (_, i) => lit(params[Number(i) - 1]));
    const rows = /^\s*(select|with)\b/i.test(sql);
    const out = execFileSync(
      process.env.PROBE_PSQL,
      [
        '-X',
        '-q',
        '-t',
        '-A',
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        process.env.PROBE_HOST,
        '-p',
        process.env.PROBE_PORT,
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-c',
        rows ? `select coalesce(json_agg(q), '[]') from (${sql}) q` : sql,
      ],
      { encoding: 'utf8' }
    );
    return { rows: rows ? JSON.parse(out.trim() || '[]') : [] };
  },
};
