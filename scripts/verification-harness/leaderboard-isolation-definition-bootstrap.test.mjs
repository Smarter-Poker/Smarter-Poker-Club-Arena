// Source/native portability proof, not faithful financial qualification.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const source = readFileSync(
  new URL('./leaderboard-isolation-definition-bootstrap.sql', import.meta.url),
  'utf8'
);
const recipes = [
  [
    'referrals',
    'referrals_status_check',
    'status',
    ['pending', 'completed'],
    '204ebceef853e1cca602532124b1bc49',
    'ecb7ab55a2dcdb103d4040a78598bb13',
  ],
  [
    'crew_members',
    'crew_members_role_check',
    'role',
    ['owner', 'admin', 'member'],
    '0a22183107e42f9ded5a4c577fcadc53',
    '786ed034d0f919820f0eab0cca6017fd',
  ],
  [
    'insurance_transactions',
    'insurance_transactions_bank_type_check',
    'bank_type',
    ['union', 'club'],
    'ec32ac972d9cd6ceed034236e4b5e0c0',
    '485e7e61ee7cbab4ae4036f7d79af1de',
  ],
  [
    'insurance_offer_events',
    'insurance_offer_events_event_check',
    'event',
    ['offered', 'accepted', 'declined', 'timeout', 'cashed_out', 'settled'],
    'bffb535b26bae3162098e2eb3bfb987a',
    '4d6f49d45a6e7742a81087eed33ae7b0',
  ],
];
test('SELECT-only source admission pins five exact identities and emits quoted isolated recipe blocks', () => {
  assert.match(source, /admission AS MATERIALIZED/);
  assert.match(source, /SELECT 1\/CASE WHEN/);
  assert.match(source, /FROM recipes r CROSS JOIN admission a WHERE a.allowed=1/);
  assert.doesNotMatch(source, /^DO |^CREATE |^ALTER |^BEGIN;|^COMMIT;|^ROLLBACK;/m);
  assert.equal(source.match(/SELECT format\('DO %L;',format\(\$body\$/g)?.length, 2);
  for (const r of recipes) for (const v of [r[0], r[1], r[4], r[5]]) assert.ok(source.includes(v));
  for (const pin of ['3c7b8637c106ae00162e4f449445838d', '92630e7e7ff7b3fc84cf14c70d26c3dd'])
    assert.ok(source.includes(pin));
  for (const guard of [
    "session_user<>'leaderboard_qualification_bootstrap'",
    'current_user<>session_user',
    'inet_server_addr() IS NOT NULL',
    "current_database()<>'postgres'",
    'after_dependencies IS DISTINCT FROM before_dependencies',
    "obj_description(observed.oid,'pg_constraint')",
    'before_columns',
    'before_relation',
  ])
    assert.ok(source.includes(guard));
});
test(
  'native PG17 repairs all five exact dump images, preserves metadata/validation and refuses drift atomically',
  { skip: process.env.LEADERBOARD_NATIVE_PG17_TEST !== '1' },
  () => {
    const parent = process.env.TMPDIR;
    assert.ok(
      parent?.startsWith('/Volumes/SmarterWork/agent-work/') ||
        (process.platform === 'linux' &&
          process.env.GITHUB_ACTIONS === 'true' &&
          parent === process.env.RUNNER_TEMP)
    );
    const scratchParent =
      process.platform === 'darwin' ? '/Volumes/SmarterWork/agent-work/' : parent;
    const directory = mkdtempSync(join(scratchParent, 'lb-def-')),
      data = join(directory, 'db'),
      socket = join(directory, 's');
    mkdirSync(socket);
    assert.ok((socket + '/.s.PGSQL.5432').length < 104);
    const bin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
    const command = (name, args, input) =>
      spawnSync(join(bin, name), args, { input, encoding: 'utf8', timeout: 30000 });
    const success = (r) => {
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    const psql = (db, sql) =>
      command(
        'psql',
        [
          '-XAtq',
          '-h',
          socket,
          '-U',
          'leaderboard_qualification_bootstrap',
          '-d',
          db,
          '-v',
          'ON_ERROR_STOP=1',
        ],
        sql
      );
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    const view = source.split('$recipe$')[1];
    assert.ok(view);
    const hashes = `SET search_path=pg_catalog;SELECT json_build_array(
  ${recipes.map((r) => `(SELECT md5(pg_get_constraintdef(oid,true)) FROM pg_constraint WHERE conrelid='public.${r[0]}'::regclass AND conname='${r[1]}')`).join(',')},
  md5(pg_get_viewdef('public.v_spin_draw_fairness'::regclass,true)));`;
    try {
      assert.match(success(command('pg_dump', ['--version'])), /PostgreSQL\) 17\./);
      success(
        command('initdb', [
          '-D',
          data,
          '-U',
          'leaderboard_qualification_bootstrap',
          '-A',
          'trust',
          '--no-sync',
          '--locale=C',
        ])
      );
      success(
        command('pg_ctl', [
          '-D',
          data,
          '-l',
          join(directory, 'log'),
          '-w',
          '-o',
          `-k ${socket} -c listen_addresses=`,
          'start',
        ])
      );
      success(
        psql(
          'postgres',
          'CREATE ROLE postgres;CREATE ROLE service_role;CREATE DATABASE source_fixture;'
        )
      );
      success(
        psql(
          'source_fixture',
          `
   ${recipes.map((r) => `CREATE TABLE public.${r[0]}(${r[2]} varchar,CONSTRAINT ${r[1]} CHECK(${r[2]} IN(${r[3].map(quote).join(',')})));ALTER TABLE public.${r[0]} OWNER TO postgres;COMMENT ON CONSTRAINT ${r[1]} ON public.${r[0]} IS ${quote("Quoted ' comment $body$ ;")};`).join('\n')}
   CREATE TABLE public.spin_tier_spec(freq bigint,multiplier integer);
   CREATE TABLE public.tournaments(created_at timestamptz,spin_multiplier numeric,spin_locked_tiers jsonb,variant text);
   ${view}
   ALTER VIEW public.v_spin_draw_fairness OWNER TO postgres;
   ALTER VIEW public.v_spin_draw_fairness SET(security_invoker=true);
   REVOKE ALL ON public.v_spin_draw_fairness FROM PUBLIC;GRANT SELECT ON public.v_spin_draw_fairness TO service_role;
   COMMENT ON VIEW public.v_spin_draw_fairness IS 'Preserve view comment';`
        )
      );
      assert.deepEqual(JSON.parse(success(psql('source_fixture', hashes))), [
        ...recipes.map((r) => r[4]),
        '3c7b8637c106ae00162e4f449445838d',
      ]);
      const emitted = success(psql('source_fixture', source));
      assert.equal(emitted.match(/DO /g)?.length, 5);
      const archive = join(directory, 'dump');
      success(
        command('pg_dump', [
          '-h',
          socket,
          '-U',
          'leaderboard_qualification_bootstrap',
          '-d',
          'source_fixture',
          '--schema-only',
          '--format=custom',
          '--file',
          archive,
        ])
      );
      success(
        command('pg_restore', [
          '-h',
          socket,
          '-U',
          'leaderboard_qualification_bootstrap',
          '-d',
          'postgres',
          '--exit-on-error',
          archive,
        ])
      );
      assert.deepEqual(JSON.parse(success(psql('postgres', hashes))), [
        ...recipes.map((r) => r[5]),
        '92630e7e7ff7b3fc84cf14c70d26c3dd',
      ]);
      success(psql('postgres', 'BEGIN;' + emitted + 'COMMIT;'));
      assert.deepEqual(JSON.parse(success(psql('postgres', hashes))), [
        ...recipes.map((r) => r[4]),
        '3c7b8637c106ae00162e4f449445838d',
      ]);
      success(psql('postgres', 'BEGIN;' + emitted + 'ROLLBACK;')); // exact already-restored no-op
      assert.equal(
        success(
          psql(
            'postgres',
            "SELECT reloptions::text||'|'||obj_description(oid,'pg_class') FROM pg_class WHERE oid='public.v_spin_draw_fairness'::regclass;"
          )
        ).trim(),
        '{security_invoker=true}|Preserve view comment'
      );
      const wrongDatabase = psql('source_fixture', 'BEGIN;' + emitted + 'ROLLBACK;');
      assert.notEqual(wrongDatabase.status, 0);
      assert.match(wrongDatabase.stderr, /Exact isolated definition\/source image required/);
      const wrongSession = psql(
        'postgres',
        'SET SESSION AUTHORIZATION postgres;BEGIN;' + emitted + 'ROLLBACK;'
      );
      assert.notEqual(wrongSession.status, 0);
      assert.match(wrongSession.stderr, /Exact isolated definition\/source image required/);
      for (const r of recipes) {
        success(psql('postgres', `INSERT INTO public.${r[0]} VALUES(${quote(r[3][0])});`));
        const bad = psql('postgres', `INSERT INTO public.${r[0]} VALUES('invalid');`);
        assert.notEqual(bad.status, 0);
        assert.match(bad.stderr, /violates check constraint/);
      }
      // Unsupported source must fail its SELECT-only admission before output.
      success(
        psql(
          'source_fixture',
          'ALTER TABLE public.referrals DROP CONSTRAINT referrals_status_check;ALTER TABLE public.referrals ADD CONSTRAINT referrals_status_check CHECK(status IS NOT NULL);'
        )
      );
      const sourceRefusal = psql('source_fixture', source);
      assert.notEqual(sourceRefusal.status, 0);
      assert.match(sourceRefusal.stderr, /division by zero/);
      assert.equal(sourceRefusal.stdout, '');
      // Unsupported destination shape must fail and roll back earlier writes.
      success(
        psql(
          'postgres',
          'ALTER TABLE public.referrals DROP CONSTRAINT referrals_status_check;ALTER TABLE public.referrals ADD CONSTRAINT referrals_status_check CHECK(status IS NOT NULL);'
        )
      );
      const destinationRefusal = psql(
        'postgres',
        "BEGIN;INSERT INTO public.crew_members VALUES('member');" + emitted + 'COMMIT;'
      );
      assert.notEqual(destinationRefusal.status, 0);
      assert.match(destinationRefusal.stderr, /Exact destination constraint image required/);
      assert.equal(
        success(
          psql('postgres', "SELECT count(*) FROM public.crew_members WHERE role='member';")
        ).trim(),
        '0'
      );
      const restoreReferrals =
        "ALTER TABLE public.referrals DROP CONSTRAINT referrals_status_check;ALTER TABLE public.referrals ADD CONSTRAINT referrals_status_check CHECK(status IN('pending','completed'));COMMENT ON CONSTRAINT referrals_status_check ON public.referrals IS 'Quoted '' comment $body$ ;';";
      success(psql('source_fixture', restoreReferrals));
      success(psql('source_fixture', view.replace('d.draws>=2000', 'd.draws>=2001')));
      const sourceViewRefusal = psql('source_fixture', source);
      assert.notEqual(sourceViewRefusal.status, 0);
      assert.match(sourceViewRefusal.stderr, /division by zero/);
      assert.equal(sourceViewRefusal.stdout, '');
      success(psql('postgres', restoreReferrals));
      success(psql('postgres', view.replace('d.draws>=2000', 'd.draws>=2001')));
      const destinationViewRefusal = psql(
        'postgres',
        "BEGIN;INSERT INTO public.crew_members VALUES('member');" + emitted + 'COMMIT;'
      );
      assert.notEqual(destinationViewRefusal.status, 0);
      assert.match(destinationViewRefusal.stderr, /Exact destination view image required/);
      assert.equal(
        success(
          psql('postgres', "SELECT count(*) FROM public.crew_members WHERE role='member';")
        ).trim(),
        '0'
      );
    } finally {
      if (existsSync(join(data, 'PG_VERSION'))) {
        const s = command('pg_ctl', ['-D', data, 'status']);
        if (s.status === 0)
          success(command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']));
        else assert.equal(s.status, 3, 'Unknown native state retains owned evidence');
        assert.equal(command('pg_ctl', ['-D', data, 'status']).status, 3);
        assert.equal(existsSync(join(data, 'postmaster.pid')), false);
      }
      rmSync(directory, { recursive: true, force: false });
      assert.equal(existsSync(directory), false);
    }
  }
);
