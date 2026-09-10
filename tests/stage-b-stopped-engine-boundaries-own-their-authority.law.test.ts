import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

function stagedMigration(suffix: string): string {
  const matches = readdirSync(resolve(root, 'supabase', 'migrations')).filter((file) =>
    file.endsWith(`_${suffix}.sql`)
  );
  expect(matches, `${suffix} migration`).toHaveLength(1);
  return readFileSync(resolve(root, 'supabase', 'migrations', matches[0]), 'utf8');
}

const boundaries = [
  {
    name: '#2 exact-precondition repair',
    sql: stagedMigration('stage_b_exact_precondition_repairs'),
    firstWork: "SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'));",
    authenticatesEntryPredicate: true,
    statementTimeoutSeconds: 120,
    transactionTimeoutSeconds: 150,
  },
  {
    name: '#5 current-postimage contraction',
    sql: stagedMigration('stage_b_current_postimage_contraction'),
    firstWork: 'DO $require_move_receipt_preimage$',
    authenticatesEntryPredicate: true,
    statementTimeoutSeconds: 120,
    transactionTimeoutSeconds: 150,
  },
  {
    name: '#6 lease-keyshare cutover',
    sql: stagedMigration('stage_b_lease_keyshare_once'),
    firstWork: 'DO $require_strict_stage_b_topology$',
    authenticatesEntryPredicate: false,
    statementTimeoutSeconds: 30,
    transactionTimeoutSeconds: 150,
  },
] as const;

const contraction = boundaries[1].sql;
const stageBAuthorityTag = 'require_stage_b_stopped_engine_authority';
const pristineRelations = [
  'auth.users',
  'public.clubs',
  'public.tournaments',
  'public.tables',
  'public.chip_ledger',
  'public.tournament_tickets',
] as const;

function stripSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ');
}

function compactSql(source: string): string {
  return stripSqlComments(source).replace(/\s+/g, ' ').trim();
}

function occurrences(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function localTimeoutSeconds(source: string, setting: string): number {
  const matches = [
    ...source.matchAll(
      new RegExp(`^\\s*SET\\s+LOCAL\\s+${setting}\\s*=\\s*'(\\d+)(ms|s|min)'\\s*;\\s*$`, 'gim')
    ),
  ];
  expect(matches, `one SET LOCAL ${setting}`).toHaveLength(1);

  const value = Number(matches[0][1]);
  const unit = matches[0][2].toLowerCase();
  if (unit === 'ms') return value / 1_000;
  if (unit === 'min') return value * 60;
  return value;
}

function taggedBodies(source: string, tag: string): string[] {
  const delimiter = `$${tag}$`;
  const bodies: string[] = [];
  let cursor = 0;

  while (true) {
    const opening = source.indexOf(delimiter, cursor);
    if (opening < 0) break;
    const closing = source.indexOf(delimiter, opening + delimiter.length);
    expect(closing, `closing ${delimiter}`).toBeGreaterThan(opening);
    bodies.push(source.slice(opening + delimiter.length, closing));
    cursor = closing + delimiter.length;
  }

  return bodies;
}

function functionBody(source: string, identity: string): string {
  const definition = source.indexOf(`CREATE OR REPLACE FUNCTION ${identity}(`);
  expect(definition, `${identity} definition`).toBeGreaterThanOrEqual(0);

  const tail = source.slice(definition);
  const opening = tail.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/i);
  expect(opening, `${identity} body delimiter`).not.toBeNull();
  const delimiter = opening![1];
  const bodyStart = definition + opening!.index! + opening![0].length;
  const bodyEnd = source.indexOf(delimiter, bodyStart);
  expect(bodyEnd, `${identity} body terminator`).toBeGreaterThan(bodyStart);
  return source.slice(bodyStart, bodyEnd);
}

function posixPatternForJavaScript(pattern: string): RegExp {
  const translated = pattern.replaceAll('[[:space:]]', '\\s').replaceAll('[[:blank:]]', '[\\t ]');
  return new RegExp(translated, 'i');
}

describe('each stopped-engine Stage-B boundary owns its full authority', () => {
  for (const boundary of boundaries) {
    it(`${boundary.name} authenticates the durable freeze before any cutover work`, () => {
      const executable = stripSqlComments(boundary.sql);
      const firstWork = executable.indexOf(boundary.firstWork);
      expect(firstWork, `${boundary.name} first workload marker`).toBeGreaterThanOrEqual(0);
      const authorityBodies = taggedBodies(executable, stageBAuthorityTag);
      expect(authorityBodies).toHaveLength(1);
      const authenticationBodies = taggedBodies(
        executable,
        'authenticate_stage_b_stopped_engine_authority'
      );
      expect(authenticationBodies).toHaveLength(1);
      const authentication = authenticationBodies[0];
      const authorityEnd =
        executable.indexOf(`$${stageBAuthorityTag}$;`) + `$${stageBAuthorityTag}$;`.length;
      expect(authorityEnd).toBeGreaterThan(0);
      expect(firstWork).toBeGreaterThan(authorityEnd);
      const prefix = executable.slice(0, authorityEnd);

      const sharedMaintenanceLock = prefix.search(
        /\bSELECT\s+pg_advisory_xact_lock_shared\s*\(\s*530090\s*,\s*1\s*\)\s*;/i
      );
      const platformPredicate = prefix.indexOf("to_regprocedure('public.fn_platform_frozen()')");
      const maintenanceWriter = prefix.indexOf(
        "to_regprocedure('public.fn_serialize_engine_maintenance_break_write()')",
        platformPredicate
      );

      expect(sharedMaintenanceLock).toBeGreaterThanOrEqual(0);
      expect(prefix).not.toMatch(/\bpg_try_advisory_xact_lock_shared\s*\(/i);
      expect(platformPredicate).toBeGreaterThan(sharedMaintenanceLock);
      expect(maintenanceWriter).toBeGreaterThan(platformPredicate);
      expect(prefix).toMatch(/md5\s*\(\s*p\.prosrc\s*\)\s*=\s*'112b1265824ee082b8adc67ea367d826'/i);
      expect(prefix).toMatch(/md5\s*\(\s*p\.prosrc\s*\)\s*=\s*'084ed24f99e9d08765bd86ff8b920284'/i);
      if (boundary.authenticatesEntryPredicate) {
        expect(authentication).toContain("to_regprocedure('public.fn_entry_purchases_frozen()')");
        expect(authentication).toMatch(
          /md5\s*\(\s*p\.prosrc\s*\)\s*=\s*'a29498531e4b7d3889532e80fafc8d57'/i
        );
      } else {
        expect(authentication).not.toContain('fn_entry_purchases_frozen');
        expect(authentication).not.toContain('a29498531e4b7d3889532e80fafc8d57');
      }
      expect(prefix).toContain("tg.tgname = 'aa_serialize_maintenance_break_write'");
      expect(prefix).toContain('tg.tgfoid = v_writer');
      expect(prefix).toContain("tg.tgenabled = 'O'");
      expect(prefix).toContain('tg.tgtype = 62');
      expect(prefix).toContain("tg.tgattr::text = ''");
      expect(prefix).toContain('tg.tgqual IS NULL');
      expect(prefix).toContain('tg.tgnargs = 0');
    });

    it(`${boundary.name} takes the canonical global and engine relation order before work`, () => {
      const executable = stripSqlComments(boundary.sql);
      const firstWork = executable.indexOf(boundary.firstWork);
      expect(firstWork, `${boundary.name} first workload marker`).toBeGreaterThanOrEqual(0);
      const authorityEnd =
        executable.indexOf(`$${stageBAuthorityTag}$;`) + `$${stageBAuthorityTag}$;`.length;
      expect(authorityEnd).toBeGreaterThan(0);
      expect(firstWork).toBeGreaterThan(authorityEnd);
      const prefix = executable.slice(0, authorityEnd);

      const realtime = prefix.search(
        /LOCK\s+TABLE\s+realtime\.subscription\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE\s+NOWAIT\s*;/i
      );
      const maintenance = prefix.search(
        /LOCK\s+TABLE\s+public\.engine_maintenance_break\s+IN\s+SHARE\s+MODE\s+NOWAIT\s*;/i
      );
      const leader = prefix.search(
        /LOCK\s+TABLE\s+public\.engine_leader\s+IN\s+(?:ACCESS\s+)?EXCLUSIVE\s+MODE\s+NOWAIT\s*;/i
      );
      const table = prefix.search(
        /LOCK\s+TABLE\s+public\.engine_table_leases\s+IN\s+(?:ACCESS\s+)?EXCLUSIVE\s+MODE\s+NOWAIT\s*;/i
      );
      const tournament = prefix.search(
        /LOCK\s+TABLE\s+public\.engine_tournament_leases\s+IN\s+(?:ACCESS\s+)?EXCLUSIVE\s+MODE\s+NOWAIT\s*;/i
      );

      expect(realtime).toBeGreaterThanOrEqual(0);
      expect(maintenance).toBeGreaterThan(realtime);
      expect(leader).toBeGreaterThan(maintenance);
      expect(table).toBeGreaterThan(leader);
      expect(tournament).toBeGreaterThan(table);
    });

    it(`${boundary.name} permits only the exact pristine shape to bypass freeze, never fleet staleness`, () => {
      const executable = stripSqlComments(boundary.sql);
      const firstWork = executable.indexOf(boundary.firstWork);
      expect(firstWork, `${boundary.name} first workload marker`).toBeGreaterThanOrEqual(0);
      const authorityBodies = taggedBodies(executable, stageBAuthorityTag);
      expect(authorityBodies).toHaveLength(1);
      const authorityEnd =
        executable.indexOf(`$${stageBAuthorityTag}$;`) + `$${stageBAuthorityTag}$;`.length;
      expect(firstWork).toBeGreaterThan(authorityEnd);
      const gate = authorityBodies[0];
      const compact = compactSql(gate);

      const pristineEnd = compact.indexOf('INTO v_database_is_pristine;');
      expect(pristineEnd).toBeGreaterThanOrEqual(0);
      const pristineProof = compact.slice(0, pristineEnd);
      for (const relation of pristineRelations) {
        expect(pristineProof, `${boundary.name} pristine proof checks ${relation}`).toContain(
          `EXISTS (SELECT 1 FROM ${relation})`
        );
      }
      expect(occurrences(pristineProof, /EXISTS \(SELECT 1 FROM /g)).toBe(pristineRelations.length);
      expect(compact).toContain(
        `SELECT NOT ( ${pristineRelations
          .map((relation) => `EXISTS (SELECT 1 FROM ${relation})`)
          .join(' OR ')} ) INTO v_database_is_pristine;`
      );

      expect(compact).toContain('public.fn_platform_frozen()');
      expect(compact).toMatch(/\bb\.id\b/i);
      expect(compact).toMatch(/\bb\.enforce_freeze\b/i);
      expect(compact).toMatch(/\bb\.phase\s*=\s*'counting_down'/i);
      expect(compact).toMatch(/\bb\.break_started_at\s+IS\s+NOT\s+NULL/i);
      expect(compact).toMatch(
        /\bb\.break_ends_at\s*>=\s*clock_timestamp\s*\(\s*\)\s*\+\s*interval\s*'3 minutes'/i
      );
      expect(compact).not.toContain('fn_entry_purchases_frozen');
      expect(compact).toMatch(
        /IF\s+NOT\s+v_database_is_pristine\s+AND\s*\(\s*public\.fn_platform_frozen\(\)\s+IS\s+NOT\s+TRUE\s+OR/i
      );

      const freezeHeadroom = compact.search(
        /\bb\.break_ends_at\s*>=\s*clock_timestamp\s*\(\s*\)\s*\+\s*interval\s*'3 minutes'/i
      );
      const freezeEnd = compact.indexOf('END IF;', freezeHeadroom);
      const freshFleetCheck = compact.indexOf(
        'EXISTS ( SELECT 1 FROM public.engine_leader',
        freezeHeadroom
      );
      expect(freezeEnd).toBeGreaterThan(freezeHeadroom);
      expect(freshFleetCheck).toBeGreaterThan(freezeEnd);
      expect(occurrences(compact.slice(pristineEnd, freshFleetCheck), /\bIF\b/g)).toBe(3);

      for (const relation of ['engine_leader', 'engine_table_leases', 'engine_tournament_leases']) {
        expect(compact, `${boundary.name} rejects fresh ${relation}`).toMatch(
          new RegExp(
            `EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+public\\.${relation}\\s+\\w+\\s+WHERE\\s+\\w+\\.heartbeat_at\\s*>=\\s*clock_timestamp\\s*\\(\\s*\\)\\s*-\\s*interval\\s*'30 seconds'`,
            'i'
          )
        );
      }

      expect(compact).toMatch(/requires[^;]*(?:engine|fleet)[^;]*(?:stale|stopped)/i);
      expect(compact).toContain("ERRCODE = '55006'");
    });

    it(`${boundary.name} fits its statement and transaction budgets inside the authenticated freeze`, () => {
      const authorityBodies = taggedBodies(stripSqlComments(boundary.sql), stageBAuthorityTag);
      expect(authorityBodies).toHaveLength(1);
      const headroomMatches = [
        ...authorityBodies[0].matchAll(
          /\bb\.break_ends_at\s*>=\s*clock_timestamp\s*\(\s*\)\s*\+\s*interval\s*'(\d+) minutes'/gi
        ),
      ];
      expect(headroomMatches, `${boundary.name} freeze headroom`).toHaveLength(1);

      const freezeHeadroomSeconds = Number(headroomMatches[0][1]) * 60;
      const statementTimeoutSeconds = localTimeoutSeconds(boundary.sql, 'statement_timeout');
      const transactionTimeoutSeconds = localTimeoutSeconds(boundary.sql, 'transaction_timeout');

      expect(freezeHeadroomSeconds).toBe(180);
      expect(statementTimeoutSeconds).toBe(boundary.statementTimeoutSeconds);
      expect(transactionTimeoutSeconds).toBe(boundary.transactionTimeoutSeconds);
      expect(statementTimeoutSeconds).toBeLessThan(transactionTimeoutSeconds);
      expect(transactionTimeoutSeconds).toBeLessThanOrEqual(freezeHeadroomSeconds - 30);
    });
  }
});

describe('#5 preserves one realtime boundary and a semantic manager lease fence', () => {
  it('takes realtime.subscription exactly once for the whole transaction', () => {
    const executable = stripSqlComments(contraction);
    expect(
      occurrences(
        executable,
        /LOCK\s+TABLE\s+realtime\.subscription\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE\s+NOWAIT\s*;/gi
      )
    ).toBe(1);
  });

  it('uses the same comment-tolerant semantic write-lease predicate in both validators', () => {
    const executable = stripSqlComments(contraction);
    const patterns = taggedBodies(executable, 'manager_write_lease_pattern').map((pattern) =>
      pattern.trim()
    );
    expect(patterns).toHaveLength(2);
    expect(new Set(patterns).size).toBe(1);

    const preflight = taggedBodies(executable, 'require_stage_a_request_authority');
    const postcondition = taggedBodies(executable, 'assert_strict_manager_request_fence');
    expect(preflight).toHaveLength(1);
    expect(postcondition).toHaveLength(1);

    for (const [validator, sourceName] of [
      [preflight[0], 'v_source'],
      [postcondition[0], 'v_hook_source'],
    ] as const) {
      expect(validator).toContain('[[:space:]]+');
      expect(validator).toMatch(
        new RegExp(
          `v_hook_semantic\\s*:=\\s*regexp_replace\\(\\s*${sourceName}\\s*,\\s*'/\\\\\\*\\.\\*\\?\\\\\\*/'\\s*,\\s*' '\\s*,\\s*'gs'\\s*\\)`,
          'i'
        )
      );
      expect(validator).toMatch(/v_hook_semantic\s*!~\s*v_manager_write_lease_pattern/i);
      expect(validator).toMatch(/v_hook_semantic\s*~/i);
      expect(validator).toContain(
        'engine_tournament_leases[[:space:]]+l[[:space:]][^;]*FOR[[:space:]]+SHARE[[:space:]]*;'
      );
    }

    const predicate = posixPatternForJavaScript(patterns[0]);
    const canonical = `
      PERFORM 1
        FROM public.engine_tournament_leases l
       WHERE l.tournament_id = v_tournament_id
         AND l.protocol_version = 2
         AND l.lease_generation = v_lease_generation
         AND l.heartbeat_at >=
             clock_timestamp() - make_interval(secs => v_stale_seconds)
       /* SKIP LOCKED; FOR SHARE is intentionally not used by this audited path. */
       FOR KEY SHARE;
    `;
    const canonicalSemantic = canonical.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const whitespaceVariant = canonical
      .replaceAll('       ', '\t')
      .replace('AND l.protocol_version', '\n\nAND\n  l.protocol_version');
    const whitespaceSemantic = whitespaceVariant.replace(/\/\*[\s\S]*?\*\//g, ' ');

    expect(predicate.test(canonical)).toBe(false);
    expect(predicate.test(canonicalSemantic)).toBe(true);
    expect(predicate.test(whitespaceSemantic)).toBe(true);

    for (const invalid of [
      canonicalSemantic.replace('AND l.protocol_version = 2', ''),
      canonicalSemantic.replace('AND l.lease_generation = v_lease_generation', ''),
      canonicalSemantic.replace(
        'AND l.heartbeat_at >=\n             clock_timestamp() - make_interval(secs => v_stale_seconds)',
        ''
      ),
      canonicalSemantic.replace('FOR KEY SHARE', 'FOR SHARE'),
      canonicalSemantic.replace('FOR KEY SHARE;', '; FOR KEY SHARE'),
    ]) {
      expect(predicate.test(invalid)).toBe(false);
    }
  });

  it('retains exact live-ledger and lease-function hashes beside semantic checks', () => {
    const executable = stripSqlComments(contraction);
    for (const hash of [
      '2e95299dd7693a09ee310a4086b2dcdf16f0f942582007bdede0c4c81024e07d',
      '5816d16550ef470f9359cae427aec0c5346df92f5c6d35b07385def4ab9b4c04',
      'c57716917b5ec20ccdf19c90e7a86427',
      'ab227471f29f2944ebd64909622b6af7',
      '73abfc4523de42cb4b8bca5443602cbd',
      'd1b5100c2b9f92bec5fd1680b0b4f230',
      '4a41b0124e75e46ed8121e6a56014758',
      '5e6c99545e07c21efcb50e5cb3441c14',
      'e3a2120fc6db33ad84fc4967126fe9b8',
      '457ad8f1e1528ad205f7bd43488f3e14',
      '276314a02cecc35607cde1afdc2fdf21',
      '8ab94f005d1dcc695c7094eec3fd279d',
      '0af954ab1264dc12ebce7741b7845343',
      '4abef1a7ccd6d56c2523fe6cb02396b6',
    ]) {
      expect(executable, `#5 retains ${hash}`).toContain(hash);
    }
  });

  it('the installed manager hook locks one exact fresh protocol-2 generation, never FOR SHARE', () => {
    const hook = compactSql(
      functionBody(contraction, 'smarter_private.fn_smarter_data_api_pre_request')
    );
    const leaseStatements =
      hook.match(/PERFORM\s+1\s+FROM\s+public\.engine_tournament_leases\s+l\s+[^;]*;/gi) ?? [];
    const writeLeaseStatements = leaseStatements.filter((statement) =>
      /\bFOR\s+KEY\s+SHARE\s*;$/i.test(statement)
    );

    expect(writeLeaseStatements).toHaveLength(1);
    expect(writeLeaseStatements[0]).toMatch(
      /WHERE\s+l\.tournament_id\s*=\s*v_tournament_id\s+AND\s+l\.protocol_version\s*=\s*2\s+AND\s+l\.lease_generation\s*=\s*v_lease_generation\s+AND\s+l\.heartbeat_at\s*>=\s*clock_timestamp\s*\(\s*\)\s*-\s*make_interval\s*\(\s*secs\s*=>\s*v_stale_seconds\s*\)\s+FOR\s+KEY\s+SHARE\s*;$/i
    );
    expect(writeLeaseStatements[0]).not.toMatch(/\bFOR\s+SHARE\b/i);
  });
});
