import { execFileSync } from 'node:child_process';
const database = process.env.SATELLITE_PROOF_DATABASE;
if (!['satellite_running_restart_sep10', 'satellite_recovery_sep10'].includes(database))
  throw new Error('Owned private database only');
const socket =
  database === 'satellite_recovery_sep10'
    ? '/tmp/codex-satellite-recovery-pg17/socket'
    : '/tmp/codex-satellite-cohort-pg17/socket';
const port = database === 'satellite_recovery_sep10' ? '55388' : '55387';
const dataDirectory = socket.slice(0, socket.lastIndexOf('/')) + '/data';
const allowed = new Set([
  'tournaments',
  'tournament_players',
  'tournament_satellite_qualification_boundaries',
]);
export const trace = [];
export const errors = [];
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
function query(sql) {
  const guard =
    'DO $$BEGIN IF current_database()<>' +
    literal(database) +
    " OR current_setting('data_directory')<>" +
    literal(dataDirectory) +
    " THEN RAISE EXCEPTION 'Owned private database only'; END IF; END$$;";
  const output = execFileSync(
    '/opt/homebrew/opt/postgresql@17/bin/psql',
    ['-X', '-qAt', '-h', socket, '-p', port, '-d', database, '-v', 'ON_ERROR_STOP=1'],
    {
      input:
        guard +
        'BEGIN; SET LOCAL application_name=\'satellite-recovery-proof\'; SET LOCAL ROLE service_role; SET LOCAL request.jwt.claims=\'{"role":"service_role"}\';' +
        sql +
        ';COMMIT;',
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const lines = output.trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)) : null;
}
function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid identifier');
  return value;
}
export const supabase = {
  from(table) {
    if (!allowed.has(table)) throw new Error('Unexpected recovery relation ' + table);
    let columns = '*',
      filters = [],
      single = false;
    const builder = {
      select(value) {
        columns = value
          .split(',')
          .map((s) => identifier(s.trim()))
          .join(',');
        return builder;
      },
      eq(key, value) {
        filters.push(identifier(key) + '=' + literal(value));
        return builder;
      },
      maybeSingle() {
        single = true;
        return builder;
      },
      then(resolve, reject) {
        trace.push({ type: 'select', table, columns, filters });
        try {
          const rows = query(
            "SELECT coalesce(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) FROM (SELECT " +
              columns +
              ' FROM public.' +
              table +
              (filters.length ? ' WHERE ' + filters.join(' AND ') : '') +
              ') rows'
          );
          return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(
            resolve,
            reject
          );
        } catch (error) {
          return Promise.resolve({ data: null, error: { message: error.message } }).then(
            resolve,
            reject
          );
        }
      },
    };
    return builder;
  },
  async rpc(name, args) {
    const signatures = {
      fn_prepare_satellite_qualification: [
        'p_tournament_id',
        'p_qualified_user_ids',
        'p_lease_generation',
      ],
      fn_complete_satellite_qualification: ['p_tournament_id', 'p_qualified_user_ids'],
      fn_resolve_satellite_qualification_outcome: ['p_tournament_id', 'p_qualified_user_ids'],
    };
    if (!signatures[name]) throw new Error('Unexpected recovery RPC ' + name);
    const values = signatures[name].map((key) =>
      Array.isArray(args[key])
        ? 'ARRAY[' + args[key].map(literal).join(',') + ']::uuid[]'
        : literal(args[key]) + '::uuid'
    );
    const call = { type: 'rpc', name, args };
    trace.push(call);
    try {
      const data = query('SELECT public.' + name + '(' + values.join(',') + ')');
      call.committed = true;
      call.receiptVersion = data?.receipt_version ?? null;
      if (
        process.env.SATELLITE_DROP_COMPLETION === '1' &&
        name === 'fn_complete_satellite_qualification'
      )
        return {
          data: null,
          error: { message: 'Injected lost response after committed native RPC' },
        };
      return { data, error: null };
    } catch (error) {
      call.committed = false;
      return { data: null, error: { message: error.message } };
    }
  },
};
export const maintenanceSupabase = supabase;
export function reportError(error, context) {
  errors.push({ context, message: String(error?.message ?? error) });
}
export async function raiseFinancialAlert(...args) {
  errors.push({ alert: args });
  return { persisted: true };
}
export function isMaintenanceFrozen() {
  return process.env.SATELLITE_PROOF_FROZEN === '1';
}
