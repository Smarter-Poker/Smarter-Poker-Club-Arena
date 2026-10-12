import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const source = readFileSync(
  new URL('./leaderboard-isolation-extension-trigger-bootstrap.sql', import.meta.url),
  'utf8'
);
test('source emits exact custom extension-table triggers without mutating the source', () => {
  assert.match(source, /relation_dependency\.deptype='e'/);
  assert.match(source, /NOT EXISTS\(SELECT 1 FROM pg_depend trigger_dependency/);
  assert.match(source, /NOT t\.tgisinternal AND t\.tgparentid=0/);
  assert.match(source, /pg_get_triggerdef\(t\.oid\),t\.tgenabled::text/);
  assert.ok(source.includes("SELECT format('DO %L;',format($body$"));
  for (const state of ['ENABLE', 'DISABLE', 'ENABLE REPLICA', 'ENABLE ALWAYS'])
    assert.ok(source.includes(`'${state}'`));
  assert.doesNotMatch(source, /^BEGIN;|^COMMIT;|^ROLLBACK;|^CREATE|^ALTER|^UPDATE|^DELETE/m);
});
test(
  'explicit native PG17 control proves omission, faithful trigger restoration and mismatch rollback',
  { skip: process.env.LEADERBOARD_NATIVE_PG17_TEST !== '1' },
  () => {
    const parent = process.env.TMPDIR;
    assert.ok(
      parent?.startsWith('/Volumes/SmarterWork/agent-work/') ||
        (process.platform === 'linux' &&
          process.env.GITHUB_ACTIONS === 'true' &&
          parent === process.env.RUNNER_TEMP)
    );
    const directory = mkdtempSync(join(parent, 'et-'));
    const data = join(directory, 'db'),
      socket = join(directory, 's');
    mkdirSync(socket);
    assert.ok((socket + '/.s.PGSQL.5432').length < 104);
    const bin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
    const command = (name, args, input) =>
      spawnSync(join(bin, name), args, { input, encoding: 'utf8', timeout: 30000 });
    const psql = (database, sql) =>
      command(
        'psql',
        [
          '-XAtq',
          '-h',
          socket,
          '-U',
          'leaderboard_qualification_bootstrap',
          '-d',
          database,
          '-v',
          'ON_ERROR_STOP=1',
        ],
        sql
      );
    const success = (result) => {
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
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
          join(directory, 'server.log'),
          '-w',
          '-o',
          `-k ${socket} -c listen_addresses= -c fsync=off`,
          'start',
        ])
      );
      success(psql('postgres', 'CREATE DATABASE source_fixture;'));
      const base = `CREATE TABLE public.toy_ext(id integer); CREATE FUNCTION public.toy_ext_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`;
      success(
        psql(
          'source_fixture',
          base +
            `CREATE TRIGGER "toy_custom$extension_trigger$" BEFORE INSERT ON public.toy_ext FOR EACH ROW EXECUTE FUNCTION public.toy_ext_trigger(); ALTER TABLE public.toy_ext ENABLE REPLICA TRIGGER "toy_custom$extension_trigger$"; ALTER EXTENSION plpgsql ADD TABLE public.toy_ext;`
        )
      );
      const archive = join(directory, 'schema.dump');
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
      const list = success(command('pg_restore', ['--list', archive]));
      assert.doesNotMatch(list, /TRIGGER public toy_ext toy_custom/);
      const emitted = success(psql('source_fixture', source));
      assert.match(emitted, /CREATE TRIGGER "toy_custom\$extension_trigger\$"/);
      success(psql('postgres', base));
      success(psql('postgres', 'BEGIN;' + emitted + 'COMMIT;'));
      assert.equal(
        success(
          psql(
            'postgres',
            "SELECT tgenabled FROM pg_trigger WHERE tgname='toy_custom$extension_trigger$';"
          )
        ).trim(),
        'R'
      );
      // Preserve the deliberately differing preimage and roll back every write
      // attempted by the same parent transaction; never rewrite a mismatch.
      success(
        psql(
          'postgres',
          'ALTER TABLE public.toy_ext ENABLE ALWAYS TRIGGER "toy_custom$extension_trigger$";'
        )
      );
      const refusal = psql(
        'postgres',
        'BEGIN; INSERT INTO public.toy_ext VALUES(1);' + emitted + 'COMMIT;'
      );
      assert.notEqual(refusal.status, 0);
      assert.match(refusal.stderr, /Existing extension-table trigger differs from source/);
      assert.equal(
        success(
          psql(
            'postgres',
            "SELECT count(*)::text||'|'||(SELECT tgenabled::text FROM pg_trigger WHERE tgname='toy_custom$extension_trigger$') FROM public.toy_ext;"
          )
        ).trim(),
        '0|A'
      );
    } finally {
      if (existsSync(join(data, 'PG_VERSION'))) {
        const state = command('pg_ctl', ['-D', data, 'status']);
        if (state.status === 0)
          success(command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']));
        else assert.equal(state.status, 3, 'Unknown native server state retains owned evidence');
        assert.equal(command('pg_ctl', ['-D', data, 'status']).status, 3);
        assert.equal(existsSync(join(data, 'postmaster.pid')), false);
      }
      rmSync(directory, { recursive: true, force: false });
      assert.equal(existsSync(directory), false);
    }
  }
);
test('destination refuses differing existing identity, recreates missing with native quoted SQL and verifies image', () => {
  assert.match(source, /session_user<>'leaderboard_qualification_bootstrap'/);
  assert.match(source, /inet_server_addr\(\) IS NOT NULL/);
  assert.match(source, /current_database\(\)<>'postgres'/);
  assert.equal(
    source.match(
      /observed\.definition IS DISTINCT FROM %3\$L OR observed\.enabled IS DISTINCT FROM %4\$L/g
    ).length,
    2
  );
  assert.match(source, /IF FOUND THEN[\s\S]*?RAISE EXCEPTION[\s\S]*?ELSE\n    EXECUTE %3\$L;/);
  assert.match(source, /EXECUTE %5\$L;/);
  assert.match(source, /INTO STRICT observed/);
  assert.doesNotMatch(source, /DROP TRIGGER|CREATE OR REPLACE TRIGGER|session_replication_role/);
});
