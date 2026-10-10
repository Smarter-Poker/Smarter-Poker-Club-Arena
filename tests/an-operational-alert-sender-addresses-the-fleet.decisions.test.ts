/**
 * The decision cases of tests/helpers/operational-sender-addressing.mjs, the rule
 * behind tests/an-operational-alert-sender-addresses-the-fleet.law.test.ts.
 *
 * They live under tests/ so that a pull request which changes only the rule is
 * sent to the required Client Unit Tests (vitest) check by
 * scripts/ci/classify-ci-changes.mjs; they used to run only in an advisory
 * workflow, where a weakened checker could merge on green (review round 2).
 * Each case names the shape it pins: the #5428 body, the payload forms that
 * prove the address, every bypass the round-2 reviewers ran against the old
 * "one assignment proves it" rule, and what the rule honestly cannot see.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitFixtureEnvironment } from './helpers/gitFixtureEnvironment';
import {
  FLEET_TASK_ID,
  SUPERSEDED_HISTORY,
  UNADDRESSED,
  UNKNOWN,
  audit,
  run,
} from './helpers/operational-sender-addressing.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const CLI = join(ROOT, 'scripts', 'ci', 'check-operational-sender-addressing.mjs');
const PRE_FIX = '20260927143752_owner_accounting_notifications_routed_to_production_alerts.sql';
const FIX = '20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql';
const RECORDED_AS = '20260927214610_owner_accounting_notifications_routed_to_production_alerts.sql';
const real = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const SLOW = 30_000;

type Audit = {
  senders: Array<{ name: string; file: string }>;
  unaddressed: Array<{ name: string; file: string; reason: string }>;
  unknown: string[];
  assumed: Array<{ name: string; assumption: string }>;
};
const judge = (files: Record<string, string>): Audit =>
  audit(Object.entries(files).map(([file, sql]) => ({ file, sql })));

/** A directory holding `files`, removed after `use` returns. */
function withTree<T>(files: Record<string, string>, use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sender-addressing-'));
  try {
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ADDRESSED = `jsonb_build_object('target_task_id','${FLEET_TASK_ID}','k',1)`;
const BARE = `jsonb_build_object('k',1)`;
const call = (payload: string) =>
  `PERFORM public.fn_record_operational_alert('src','key','Name','info','info',${payload});`;
const fn = (name: string, statements: string, declare = '', args = '') =>
  `CREATE OR REPLACE FUNCTION public.${name}(${args}) RETURNS void
LANGUAGE plpgsql SET search_path=public AS $function$
${declare ? `DECLARE ${declare}\n` : ''}BEGIN
  ${statements}
END $function$;
`;
const sender = (name: string, payload: string, declare = '') => fn(name, call(payload), declare);
const quiet = (name: string) =>
  `CREATE OR REPLACE FUNCTION public.${name}() RETURNS void LANGUAGE plpgsql AS $$BEGIN NULL; END$$;\n`;

/** The reason the only sender in `sql` is unaddressed, or null when it is addressed. */
function reason(sql: string): string | null {
  const a = judge({ '1_a.sql': sql });
  expect(a.senders, JSON.stringify(a)).toHaveLength(1);
  expect(a.unknown).toEqual([]);
  return a.unaddressed.length ? a.unaddressed[0].reason : null;
}

describe('the rule, on the bodies it was written for', () => {
  it('the pre-fix #5428 body alone is UNADDRESSED, naming the call', () => {
    const r = withTree({ [PRE_FIX]: real(PRE_FIX) }, (dir) => run(['--dir', dir]));
    expect(r.code).toBe(UNADDRESSED);
    expect(r.lines.join('\n')).toContain(
      `UNADDRESSED fn_mirror_notification_to_push_outbox() (${PRE_FIX}): the call at body line 70 builds its payload without target_task_id`
    );
  });

  it('the fix on top of #5428 is the latest body, addresses both of its calls and exits 0', () => {
    const r = withTree({ [PRE_FIX]: real(PRE_FIX), [FIX]: real(FIX) }, (dir) =>
      run(['--dir', dir])
    );
    expect(r.code, r.lines.join('\n')).toBe(0);
    expect(r.lines.join('\n')).toMatch(/exempt: 1 superseded history/);
    const a = judge({ [PRE_FIX]: real(PRE_FIX), [FIX]: real(FIX) });
    expect(a.senders).toEqual([{ name: 'fn_mirror_notification_to_push_outbox()', file: FIX }]);
    expect(SUPERSEDED_HISTORY.map((h: { file: string; md5: string }) => [h.file, h.md5])).toEqual([
      [PRE_FIX, md5(real(PRE_FIX))],
    ]);
  });

  it(
    'every real sender on main is proven, with no false positive, and record_strict under one printed assumption',
    () => {
      const expected: Record<string, string[]> = {
        '20260916111614_owner_operational_notification_destination.sql': [
          'fn_try_record_owner_notification(uuid)',
        ],
        '20260917054616_cash_pot_check_evidence_and_failed_run_intake.sql': [
          'fn_ca_cash_failed_run_intake()',
          'fn_cash_pot_conservation_check(integer)',
        ],
        '20260917062322_direct_operational_source_intake.sql': [
          'operational_source_intake.record_strict(text,jsonb,text,uuid)',
        ],
        '20260927144455_the_rakeback_settler_reads_only_what_every_writer_has_commit.sql': [
          'fn_rakeback_settler_stranded_source_check()',
        ],
      };
      for (const [file, names] of Object.entries(expected)) {
        const a = judge({ [file]: real(file) });
        expect(
          a.senders.map((s) => s.name),
          file
        ).toEqual(names);
        expect(a.unaddressed, file).toEqual([]);
        expect(a.unknown, file).toEqual([]);
      }
      const strict = judge({
        '20260917062322_direct_operational_source_intake.sql': real(
          '20260917062322_direct_operational_source_intake.sql'
        ),
      });
      expect(strict.assumed.map((x) => x.assumption)).toEqual([
        "removes the key (m->>'field'), computed at run time, and is assumed not to remove target_task_id",
      ]);
      // fn_try_record_owner_notification passes d.target_task_id: proven only by
      // the column's NOT NULL CHECK (target_task_id = the fleet id).
      const file = '20260916111614_owner_operational_notification_destination.sql';
      const unpinned = real(file).replace(`CHECK (target_task_id='${FLEET_TASK_ID}'::uuid)`, '');
      expect(unpinned).not.toBe(real(file));
      expect(judge({ [file]: unpinned }).unaddressed[0].reason).toMatch(
        /sets target_task_id to d\.target_task_id, which is not the fleet id/
      );
    },
    SLOW
  );
});

describe('which body is judged', () => {
  it('the latest body of a function decides its latest reading, in both directions', () => {
    const latest = (files: Record<string, string>) =>
      judge(files).unaddressed.map((u) => `${u.name} ${u.file}`);
    expect(latest({ '1_a.sql': sender('f', ADDRESSED), '2_b.sql': sender('f', BARE) })).toEqual([
      'f() 2_b.sql',
    ]);
    expect(latest({ '1_a.sql': sender('f', BARE), '2_b.sql': sender('f', ADDRESSED) })).toEqual([]);
    expect(
      latest({ '1_a.sql': sender('f', BARE), '2_b.sql': quiet('f') + sender('g', ADDRESSED) })
    ).toEqual([]);
  });

  it('every migration is also judged on its own: a superseded body that is not pinned history is refused', () => {
    const r = withTree({ '1_a.sql': sender('f', BARE), '2_b.sql': sender('f', ADDRESSED) }, (dir) =>
      run(['--dir', dir])
    );
    expect(r.code, r.lines.join('\n')).toBe(UNADDRESSED);
    expect(r.lines.join('\n')).toMatch(
      /UNADDRESSED f\(\) \(1_a\.sql\): the call at body line 3 builds its payload without target_task_id/
    );
  });

  it('a function is keyed by its argument types; only the writer itself, (text,text,text,text,text,jsonb), is not judged', () => {
    const def = (args: string, payload: string) =>
      `CREATE OR REPLACE FUNCTION public.f(${args}) RETURNS void LANGUAGE plpgsql AS $$BEGIN ${call(payload)} END$$;\n`;
    const two = (a: string, b: string) => judge({ '1_a.sql': a, '2_b.sql': b });
    const overload = two(def('p_x int4 DEFAULT 1', BARE), def('p_x text', ADDRESSED));
    expect(overload.unaddressed.map((u) => `${u.name} ${u.file}`)).toEqual(['f(integer) 1_a.sql']);
    const same = two(def('p_x int4 DEFAULT 1', BARE), def('q integer, OUT r bigint', ADDRESSED));
    expect([same.unaddressed, same.senders.map((s) => s.name)]).toEqual([[], ['f(integer)']]);
    const writerOverload = `CREATE FUNCTION public.fn_record_operational_alert(p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $x$ BEGIN RETURN public.fn_record_operational_alert('a','b','c','info','info',p_payload); END $x$;`;
    expect(reason(writerOverload)).toMatch(/passes p_payload, which is not proven/);
    const theWriter = `CREATE FUNCTION public.fn_record_operational_alert(p_source text,p_event_key text,p_alertname text,p_status text,p_severity text,p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $x$ BEGIN RETURN public.fn_record_operational_alert(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload); END $x$;\n`;
    expect(judge({ '1_a.sql': theWriter + sender('s', ADDRESSED) }).senders).toEqual([
      { name: 's()', file: '1_a.sql' },
    ]);
  });
});

describe('every call proves the address itself', () => {
  it('a second call cannot hide behind an addressed first one', () => {
    const two = (second: string) =>
      fn('two_calls', `${call(ADDRESSED)}\n  ${second}`, 'v_extra jsonb;');
    expect(reason(two(call(BARE)))).toBe(
      'the call at body line 5 builds its payload without target_task_id'
    );
    expect(reason(two(call(`'{}'::jsonb`)))).toMatch(/line 5 passes the literal '\{\}'/);
    expect(reason(two(call(`jsonb_build_object('k',1) || jsonb_build_object('j',2)`)))).toMatch(
      /none of them carries target_task_id/
    );
    expect(reason(two(call(`jsonb_strip_nulls(${ADDRESSED})`)))).toMatch(
      /a call to jsonb_strip_nulls\(\), which cannot be proven/
    );
    expect(reason(two(call(`${ADDRESSED} || v_extra`)))).toMatch(
      /concatenates v_extra with \|\|, and what that operand does to target_task_id cannot be proven/
    );
    expect(
      reason(
        two(
          `EXECUTE 'SELECT public.fn_record_operational_alert($1,$2,$3,$4,$5,$6)' USING 'a','b','c','info','info',${ADDRESSED};`
        )
      )
    ).toMatch(/line 5 runs as dynamic SQL/);
    expect(
      reason(
        two(
          `PERFORM public.fn_record_operational_alert(p_source => 'b', p_event_key => 'k', p_alertname => 'B',\n    p_payload => ${BARE}, p_status => 'info', p_severity => 'info');`
        )
      )
    ).toMatch(/line 5 builds its payload without target_task_id/);
    expect(
      reason(two(`PERFORM public.fn_record_operational_alert('a','b','c','info','info');`))
    ).toMatch(/passes no payload this check can find/);
    expect(
      reason(
        two(`PERFORM public."fn_record_operational_alert"('a','b','c','info','info',${BARE});`)
      )
    ).toMatch(/line 5 builds its payload without target_task_id/);
  });

  it('the payload forms that do prove it', () => {
    const upper = FLEET_TASK_ID.toUpperCase();
    const cases: Array<[string, string, string]> = [
      [`v_extra || ${ADDRESSED}`, 'v_extra jsonb;', ''],
      [`v_payload || jsonb_build_object('preview', 1)`, `v_payload jsonb := ${ADDRESSED};`, ''],
      [
        `(v_common || jsonb_build_object('k', 2))::jsonb`,
        'v_common jsonb;',
        `v_common := ${ADDRESSED};\n  `,
      ],
      [`'{"target_task_id":"${FLEET_TASK_ID}"}'::jsonb`, '', ''],
      [`pg_catalog.jsonb_build_object('target_task_id', '${FLEET_TASK_ID}'::uuid)`, '', ''],
      [
        `jsonb_build_object(v_key, 1, 'target_task_id', c_task)`,
        `v_key text := 'k'; c_task constant text := '${FLEET_TASK_ID}';`,
        '',
      ],
      // jsonb prints a uuid lower-case, so a ::uuid literal may be written in any case.
      [`jsonb_build_object('target_task_id', '${upper}'::uuid)`, '', ''],
      [`jsonb_build_object('target_task_id', c_task)`, `c_task constant uuid := '${upper}';`, ''],
      [`v_payload - 'k'`, `v_payload jsonb := ${ADDRESSED};`, ''],
    ];
    for (const [payload, declare, before] of cases) {
      expect(reason(fn('proven', `${before}${call(payload)}`, declare)), payload).toBe(null);
    }
  });

  it('the value of target_task_id must be the fleet id, spelled as the fleet reads it', () => {
    const value = (v: string, declare = '', before = '') =>
      reason(
        fn(
          'valued',
          `${before}${call(`jsonb_build_object('target_task_id', ${v}, 'k', 1)`)}`,
          declare
        )
      );
    expect(value('NULL')).toMatch(/sets target_task_id to NULL, which is not the fleet id/);
    expect(value(`'00000000-0000-4000-8000-000000000000'`)).toMatch(
      /sets target_task_id to '00000000-/
    );
    expect(value(`'${FLEET_TASK_ID.toUpperCase()}'`)).toMatch(/sets target_task_id to '01A09B86-/);
    expect(value(`coalesce(p->>'target_task_id','')`, 'p jsonb;')).toMatch(
      /sets target_task_id to coalesce/
    );
    expect(value('c_task', `c_task text := 'x';`)).toMatch(/sets target_task_id to c_task/);
    expect(value('c_task', `c_task text := '${FLEET_TASK_ID}';`, `c_task := 'x';\n  `)).toMatch(
      /sets target_task_id to c_task/
    );
    expect(value('c_task', `c_task constant text := '${FLEET_TASK_ID}';`)).toBe(null);
    expect(
      reason(
        sender(
          'dup',
          `jsonb_build_object('target_task_id','${FLEET_TASK_ID}','target_task_id',NULL)`
        )
      )
    ).toMatch(/sets target_task_id to NULL/);
    expect(
      reason(
        sender(
          'late',
          `jsonb_build_object('target_task_id','${FLEET_TASK_ID}',v_key,1)`,
          `v_key text := 'k';`
        )
      )
    ).toMatch(/builds the key v_key at run time after target_task_id/);
    const reads = fn(
      'reads',
      `IF coalesce(v_in->>'target_task_id','') = '' THEN NULL; END IF;\n  ${call('v_payload')}`,
      'v_in jsonb; v_payload jsonb;'
    );
    expect(reason(reads)).toMatch(/passes v_payload, which is not proven to carry the fleet id/);
  });

  it('a column value proves it only when the schema pins that column and the row is read STRICT', () => {
    const table = (column: string) =>
      `CREATE TABLE public.dest (id bigint PRIMARY KEY,\n  target_task_id uuid ${column});\n`;
    const pinned = `NOT NULL DEFAULT '${FLEET_TASK_ID}'::uuid CHECK (target_task_id = '${FLEET_TASK_ID}'::uuid)`;
    const rowSender = (
      fill = 'SELECT * INTO STRICT d FROM public.dest WHERE id = 1;',
      extra = ''
    ) =>
      fn(
        'from_row',
        `${fill}\n  ${extra}${call(`jsonb_build_object('k', 1, 'target_task_id', d.target_task_id)`)}`,
        'd public.dest%ROWTYPE;'
      );
    const verdict = (sql: string) => judge({ '1_a.sql': sql }).unaddressed.map((u) => u.name);
    expect(verdict(table(pinned) + rowSender())).toEqual([]);
    expect(
      verdict(
        table(
          `DEFAULT '${FLEET_TASK_ID}'::uuid CHECK (target_task_id = '${FLEET_TASK_ID}'::uuid)`
        ) + rowSender()
      ),
      'no NOT NULL'
    ).toEqual(['from_row()']);
    expect(
      verdict(table(`NOT NULL DEFAULT '${FLEET_TASK_ID}'::uuid`) + rowSender()),
      'no CHECK'
    ).toEqual(['from_row()']);
    expect(
      verdict(
        table(pinned) +
          'ALTER TABLE public.dest DROP CONSTRAINT dest_target_task_id_check;\n' +
          rowSender()
      ),
      'dropped'
    ).toEqual(['from_row()']);
    expect(
      verdict(table(pinned) + rowSender(undefined, 'd.target_task_id := NULL;\n  ')),
      'overwritten'
    ).toEqual(['from_row()']);
    expect(
      verdict(
        table(pinned) + rowSender('SELECT * INTO STRICT d FROM public.elsewhere WHERE id = 1;')
      ),
      'another table'
    ).toEqual(['from_row()']);
    // QQ (review round 2): without STRICT a SELECT that finds nothing leaves every field NULL.
    expect(
      reason(table(pinned) + rowSender('SELECT * INTO d FROM public.dest WHERE id = 1;'))
    ).toMatch(/d is not filled by SELECT \* INTO STRICT/);
  });
});

describe('a payload variable is judged where the call reads it, on every path (review round 2, A/C)', () => {
  const at = (statements: string, declare = 'p jsonb;') => reason(fn('flow', statements, declare));
  it('an assignment that breaks the proof after it was made is seen', () => {
    for (const breaking of [
      `p := p || jsonb_build_object('target_task_id','00000000-0000-4000-8000-000000000000');`,
      `p := '{}';`,
      `p := NULL;`,
      `p := p - 'target_task_id';`,
      `p := p - ARRAY['k','target_task_id'];`,
      `SELECT payload INTO p FROM public.operational_alert_events LIMIT 1;`,
    ]) {
      expect(at(`p := ${ADDRESSED};\n  ${breaking}\n  ${call('p')}`), breaking).toMatch(
        /passes p, which is not proven to carry the fleet id on every path/
      );
    }
  });

  it('a proof on only some paths proves nothing: IF false, one CASE arm, a handler after a break, the next loop iteration', () => {
    expect(at(`IF false THEN p := ${ADDRESSED}; END IF;\n  ${call('p')}`)).toMatch(/passes p/);
    expect(
      at(
        `CASE x WHEN 1 THEN p := ${ADDRESSED}; ELSE p := '{}'; END CASE;\n  ${call('p')}`,
        'p jsonb; x int := 1;'
      )
    ).toMatch(/passes p/);
    expect(
      at(
        `p := ${ADDRESSED};\n  BEGIN\n    p := '{}';\n    PERFORM 1/0;\n  EXCEPTION WHEN OTHERS THEN\n    ${call('p')}\n  END;`
      )
    ).toMatch(/passes p/);
    // The handler can run from any point of the block, not only its end, which here re-proves p.
    expect(
      at(
        `BEGIN\n    p := '{}';\n    PERFORM 1/0;\n    p := ${ADDRESSED};\n  EXCEPTION WHEN OTHERS THEN\n    ${call('p')}\n  END;`
      )
    ).toMatch(/passes p/);
    expect(
      at(
        `p := ${ADDRESSED};\n  FOR r IN SELECT 1 LOOP\n    ${call('p')}\n    p := '{}';\n  END LOOP;`,
        'p jsonb; r record;'
      )
    ).toMatch(/passes p/);
  });

  it("the real senders' shapes still pass: reset after the call, re-proven each iteration, carried out by EXIT", () => {
    expect(at(`p := ${ADDRESSED};\n  ${call('p')}\n  p := NULL;`)).toBe(null);
    expect(
      at(
        `FOR r IN SELECT 1 LOOP\n    p := ${ADDRESSED};\n    ${call('p')}\n    p := NULL;\n  END LOOP;`,
        'p jsonb; r record;'
      )
    ).toBe(null);
    expect(at(`LOOP\n    p := ${ADDRESSED};\n    EXIT;\n  END LOOP;\n  ${call('p')}`)).toBe(null);
    expect(
      at(
        `p := ${ADDRESSED};\n  IF x THEN p := p || jsonb_build_object('k', 2); END IF;\n  ${call('p')}`,
        'p jsonb; x boolean;'
      )
    ).toBe(null);
  });

  it('a removal of a key computed at run time passes only as a printed assumption', () => {
    const a = judge({
      '1_a.sql': fn(
        'assumed',
        `p := ${ADDRESSED};\n  p := (p - k) || jsonb_build_object('z',1);\n  ${call('p')}`,
        "p jsonb; k text := current_setting('x');"
      ),
    });
    expect([a.unaddressed, a.assumed.map((x) => x.assumption)]).toEqual([
      [],
      ['removes the key k, computed at run time, and is assumed not to remove target_task_id'],
    ]);
    const r = withTree(
      {
        '1_a.sql': fn(
          'assumed',
          `p := ${ADDRESSED};\n  p := p - k;\n  ${call('p')}`,
          "p jsonb; k text := 'j';"
        ),
      },
      (dir) => run(['--dir', dir])
    );
    expect(r.lines.join('\n')).toMatch(
      /ASSUMED assumed\(\) \(1_a\.sql\): the call at body line 6 removes the key k/
    );
  });
});

describe('a name that could hold anything proves nothing (review round 2, B and PP)', () => {
  it('a parameter set to the fleet id in only one branch', () => {
    expect(
      reason(
        fn(
          'param',
          `IF x THEN p_task := '${FLEET_TASK_ID}'; END IF;\n  ${call(`jsonb_build_object('target_task_id',p_task)`)}`,
          '',
          'p_task text, x boolean'
        )
      )
    ).toMatch(/p_task is a parameter: its value comes from the caller/);
  });

  it('a constant shadowed by a nested DECLARE', () => {
    expect(
      reason(
        fn(
          'shadow',
          `DECLARE c_task text;\n  BEGIN\n    ${call(`jsonb_build_object('target_task_id',c_task)`)}\n  END;`,
          `c_task constant text := '${FLEET_TASK_ID}';`
        )
      )
    ).toMatch(/c_task is declared more than once/);
  });
});

describe('a writer it cannot read is refused, not trusted (review round 2, F, I and II)', () => {
  it('the batch writer fn_record_operational_alerts(jsonb)', () => {
    expect(
      reason(
        fn('batch', `PERFORM public.fn_record_operational_alerts(jsonb_build_array(${ADDRESSED}));`)
      )
    ).toMatch(/calls the batch writer fn_record_operational_alerts\(jsonb\)/);
  });

  it("the writer named in a string, as format('%I') needs it", () => {
    expect(
      reason(
        fn(
          'named',
          `EXECUTE format('SELECT %I.%I($1,$2,$3,$4,$5,$6)','public','fn_record_operational_alert') USING 'a','b','c','info','info','{}'::jsonb;`
        )
      )
    ).toMatch(/names fn_record_operational_alert in a string/);
  });

  it('a multi-statement EXECUTE whose text also holds a definition header', () => {
    expect(
      reason(
        fn(
          'multi',
          `EXECUTE $x$CREATE FUNCTION pg_temp.z() RETURNS int LANGUAGE sql AS 'SELECT 1'; SELECT public.fn_record_operational_alert('a','b','c','info','info','{}'::jsonb)$x$;`
        )
      )
    ).toMatch(/runs as dynamic SQL/);
  });
});

describe('what the rule cannot see is said, and the store answers for it', () => {
  it('a writer name assembled from pieces at run time is not seen, and the header says so', () => {
    const split = fn(
      'split',
      `EXECUTE 'SELECT public.fn_record_' || 'operational_alert($1,$2,$3,$4,$5,$6)' USING 'a','b','c','info','info','{}'::jsonb;`
    );
    expect(judge({ '1_a.sql': split }).senders).toEqual([]);
    const header = readFileSync(
      join(ROOT, 'tests', 'helpers', 'operational-sender-addressing.mjs'),
      'utf8'
    )
      .split('*/')[0]
      .replace(/\n \* ?/g, ' ');
    expect(header).toContain(
      "WHAT IT CANNOT SEE, and what does: a writer name assembled from pieces at run time ('fn_record_' || 'operational_alert')"
    );
    expect(header).toContain(
      "For source 'owner-accounting-notifications' the store refuses such a row whatever wrote it (20260928032225)"
    );
  });

  it('a comment is neither a call nor an address', () => {
    const mentions = `CREATE FUNCTION public.mentions() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Production Alerts are recorded elsewhere, through fn_record_operational_alert().
  /* never public.fn_record_operational_alert('a','b','c','d','e','{}') from here */
  NULL;
END $$;`;
    const spelled = `CREATE FUNCTION public.spelled() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_payload jsonb;
BEGIN
  -- v_payload := jsonb_build_object('target_task_id', '${FLEET_TASK_ID}');
  PERFORM public.fn_record_operational_alert('a','k','A','info','info',v_payload);
END $$;`;
    const a = judge({ '1_a.sql': mentions + '\n' + spelled + '\n' + sender('real', ADDRESSED) });
    expect(a.senders.map((s) => s.name)).toEqual(['real()', 'spelled()']);
    expect(a.unaddressed.map((u) => u.name)).toEqual(['spelled()']);
  });

  it('not senders: pg_temp helpers, signature references and headers in comments', () => {
    const sql = `-- CREATE OR REPLACE FUNCTION public.ghost() RETURNS void AS $$ PERFORM public.fn_record_operational_alert(1,2,3,4,5,'{}'); $$;
CREATE FUNCTION pg_temp.probe() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.fn_record_operational_alert('a','b','c','info','info','{}'::jsonb); END $$;
CREATE FUNCTION public.guard() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)') IS NULL THEN RAISE EXCEPTION 'missing'; END IF;
END $$;
/* CREATE FUNCTION public.ghost2() RETURNS void AS $x$ SELECT public.fn_record_operational_alert('a','b','c','d','e','{}'); $x$; */
${sender('the_sender', ADDRESSED)}`;
    const a = judge({ '1_a.sql': sql });
    expect(a.senders).toEqual([{ name: 'the_sender()', file: '1_a.sql' }]);
    expect([a.unaddressed, a.unknown]).toEqual([[], []]);
  });

  it('a definition held as DDL text inside another dollar quote and EXECUTEd is read', () => {
    const sql = `DO $component$
DECLARE v_ddl constant text := $ddl$CREATE OR REPLACE FUNCTION public.nested_sender() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','public' AS $body$BEGIN
  PERFORM public.fn_record_operational_alert('s','k','N','firing','critical',jsonb_build_object('k',1));
  RETURN NEW;
END
$body$;$ddl$;
BEGIN EXECUTE v_ddl; END $component$;`;
    const r = withTree({ '1_a.sql': sql }, (dir) => run(['--dir', dir]));
    expect(r.code).toBe(UNADDRESSED);
    expect(r.lines.join('\n')).toMatch(/UNADDRESSED nested_sender\(\) \(1_a\.sql\)/);
  });

  it(
    'it reads a body in linear time: 4,000 calls in one body (the old reading took about a minute)',
    () => {
      const calls = Array.from({ length: 4000 }, (_, i) =>
        call(`jsonb_build_object('target_task_id','${FLEET_TASK_ID}','i',${i})`)
      ).join('\n  ');
      const started = Date.now();
      const a = judge({ '1_a.sql': fn('many', calls) });
      expect([a.senders.length, a.unaddressed, a.unknown]).toEqual([1, [], []]);
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    SLOW
  );
});

/** A throwaway git repository with supabase/migrations and, optionally, a recordings manifest. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'sender-addressing-git-'));
  const dir = join(root, 'supabase', 'migrations');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: root, stdio: 'pipe', encoding: 'utf8', env: gitFixtureEnvironment() }
    );
  git('init', '-q');
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-qm', message);
  };
  const manifest = (rows: unknown[]) =>
    writeFileSync(
      join(root, 'scripts', 'ci', 'recorded-migrations.manifest.json'),
      JSON.stringify({ recordings: rows })
    );
  const done = () => rmSync(root, { recursive: true, force: true });
  return { root, dir, git, commit, manifest, done };
}

describe('--added-since, renames, recordings and history', () => {
  it(
    'the #5489 shape: an added migration whose version sorts before the addressed body is refused on its own',
    () => {
      const { dir, commit, done } = repo();
      try {
        writeFileSync(join(dir, '20260928000000_fix.sql'), sender('mirror', ADDRESSED));
        commit('base: the addressed body is on main');
        writeFileSync(join(dir, '20260927000000_same_preimage.sql'), sender('mirror', BARE));
        commit('branch: an older version replaces it unaddressed');
        for (const argv of [
          ['--dir', dir],
          ['--dir', dir, '--added-since', 'HEAD~1'],
        ]) {
          const r = run(argv);
          expect(r.code, r.lines.join('\n')).toBe(UNADDRESSED);
          expect(r.lines.join('\n')).toMatch(
            /UNADDRESSED mirror\(\) \(20260927000000_same_preimage\.sql\)/
          );
        }
      } finally {
        done();
      }
    },
    SLOW
  );

  it(
    '--added-since does not re-judge a pure rename (R100); an edited rename is new work',
    () => {
      const { dir, git, commit, done } = repo();
      try {
        writeFileSync(join(dir, PRE_FIX), real(PRE_FIX));
        writeFileSync(join(dir, FIX), real(FIX));
        commit('base: #5428 and its fix');
        git('mv', `supabase/migrations/${PRE_FIX}`, `supabase/migrations/${RECORDED_AS}`);
        commit('branch: the #5428 file takes its production stamp');
        const pure = run(['--dir', dir, '--added-since', 'HEAD~1']);
        expect(pure.code, pure.lines.join('\n')).toBe(0);
        expect(pure.lines.join('\n')).toContain(`1 pure rename(s) not re-judged (${RECORDED_AS})`);
        writeFileSync(
          join(dir, RECORDED_AS),
          `${real(PRE_FIX)}\n-- recorded on production as 20260927214610\n`
        );
        commit('branch: and edits it');
        const edited = run(['--dir', dir, '--added-since', 'HEAD~2']);
        expect(edited.code, edited.lines.join('\n')).toBe(UNADDRESSED);
        expect(edited.lines.join('\n')).toContain(
          `UNADDRESSED fn_mirror_notification_to_push_outbox() (${RECORDED_AS})`
        );
      } finally {
        done();
      }
    },
    SLOW
  );

  it(
    'a verified recording is not re-judged on its own; an unverified one is',
    () => {
      const { dir, commit, manifest, done } = repo();
      try {
        writeFileSync(join(dir, FIX), real(FIX));
        commit('base: the fix');
        const recording = `${real(PRE_FIX)}\n`;
        writeFileSync(join(dir, RECORDED_AS), recording);
        const row = (sum: string) => [
          { version: '20260927214610', file: `supabase/migrations/${RECORDED_AS}`, md5: sum },
        ];
        manifest(row(md5(recording)));
        commit('branch: record what production applied as 20260927214610');
        for (const argv of [
          ['--dir', dir],
          ['--dir', dir, '--added-since', 'HEAD~1'],
        ]) {
          const r = run(argv);
          expect(r.code, r.lines.join('\n')).toBe(0);
          expect(r.lines.join('\n')).toMatch(
            new RegExp(`recording-only: ${RECORDED_AS} - byte-identical`)
          );
        }
        manifest(row(md5('something else')));
        expect(run(['--dir', dir, '--added-since', 'HEAD~1']).code).toBe(UNADDRESSED);
      } finally {
        done();
      }
    },
    SLOW
  );

  it('the history exemption holds for exactly one file: a byte-identical copy of #5428 loses it for both', () => {
    const r = withTree(
      { [PRE_FIX]: real(PRE_FIX), '20260927150000_copy.sql': real(PRE_FIX), [FIX]: real(FIX) },
      (dir) => run(['--dir', dir])
    );
    expect(r.code, r.lines.join('\n')).toBe(UNADDRESSED);
    expect(
      r.lines.filter((l: string) =>
        l.startsWith('UNADDRESSED fn_mirror_notification_to_push_outbox()')
      )
    ).toHaveLength(2);
  });
});

describe('COULD NOT TELL (exit 3) is never clean', () => {
  it('no migrations, no sender, an unreadable body, a body whose flow cannot be followed, a git answer it cannot get', () => {
    withTree({}, (empty) => {
      expect(run(['--dir', empty]).code).toBe(UNKNOWN);
      expect(run(['--dir', join(empty, 'missing')]).code).toBe(UNKNOWN);
      const cli = spawnSync(process.execPath, [CLI, '--dir', empty], { encoding: 'utf8' });
      expect(cli.status).toBe(UNKNOWN);
      expect(cli.stderr).toMatch(/COULD NOT TELL/);
    });
    withTree({ '1_a.sql': quiet('f') }, (dir) => expect(run(['--dir', dir]).code).toBe(UNKNOWN));
    const cut = `CREATE FUNCTION public.cut() RETURNS void LANGUAGE plpgsql AS $x$ BEGIN
  PERFORM public.fn_record_operational_alert('a','b','c','info','info',${BARE});`;
    withTree({ '1_a.sql': sender('f', ADDRESSED), '2_b.sql': cut }, (dir) => {
      const r = run(['--dir', dir]);
      expect(r.code, r.lines.join('\n')).toBe(UNKNOWN);
      expect(r.lines.join('\n')).toMatch(
        /COULD NOT TELL {2}2_b\.sql: an unterminated dollar quote \$x\$/
      );
    });
    const tangled = fn('tangled', `IF x THEN ${call(ADDRESSED)}`, 'x boolean;');
    withTree({ '1_a.sql': tangled }, (dir) => {
      const r = run(['--dir', dir]);
      expect(r.code, r.lines.join('\n')).toBe(UNKNOWN);
      expect(r.lines.join('\n')).toMatch(/could not be read as plpgsql/);
    });
    withTree({ '1_a.sql': sender('f', ADDRESSED) }, (dir) =>
      expect(run(['--dir', dir, '--added-since', 'HEAD~1']).code).toBe(UNKNOWN)
    );
  });

  it('the command line prints UNADDRESSED and exits 1 on the pre-fix #5428 body', () => {
    withTree({ [PRE_FIX]: real(PRE_FIX) }, (dir) => {
      const cli = spawnSync(process.execPath, [CLI, '--dir', dir], { encoding: 'utf8' });
      expect(cli.status).toBe(UNADDRESSED);
      expect(cli.stderr).toMatch(
        /UNADDRESSED fn_mirror_notification_to_push_outbox\(\) \(20260927143752_/
      );
    });
  });
});
