// Native deparser proof only; not faithful schema/Auth/financial qualification.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const catalog = readFileSync(
  new URL('./leaderboard-isolation-catalog.sql', import.meta.url),
  'utf8'
);
test('catalog uses native pretty definitions without suppressing validation or trigger states', () => {
  assert.equal(catalog.match(/pg_get_constraintdef\(k\.oid,true\),k\.convalidated/g)?.length, 2);
  assert.ok(catalog.includes('pg_get_triggerdef(t.oid,true),t.tgenabled'));
  assert.ok(catalog.includes('md5(pg_get_viewdef(c.oid,true))'));
  assert.doesNotMatch(catalog, /regexp_replace\([^\n]*pg_get_(?:constraintdef|triggerdef|viewdef)/);
});
test(
  'native PG17 dump/reparse grouping differs literally but native pretty equality retains semantic differences',
  { skip: process.env.LEADERBOARD_NATIVE_PG17_TEST !== '1' },
  () => {
    const parent = process.env.TMPDIR;
    assert.ok(
      parent?.startsWith('/Volumes/SmarterWork/agent-work/') ||
        (process.platform === 'linux' &&
          process.env.GITHUB_ACTIONS === 'true' &&
          parent === process.env.RUNNER_TEMP)
    );
    const directory = mkdtempSync(join(parent, 'dp-'));
    const data = join(directory, 'db'),
      socket = join(directory, 's');
    mkdirSync(socket);
    assert.ok((socket + '/.s.PGSQL.5432').length < 104);
    const bin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
    const command = (name, args, input) =>
      spawnSync(join(bin, name), args, { input, encoding: 'utf8', timeout: 30000 });
    const success = (result) => {
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
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
    const definitions = (pretty) => `SET search_path=pg_catalog;
    SELECT json_build_array(
      (SELECT pg_get_constraintdef(oid,${pretty}) FROM pg_constraint WHERE conrelid='public.toy'::regclass AND conname='toy_check'),
      (SELECT pg_get_triggerdef(oid,${pretty}) FROM pg_trigger WHERE tgname='toy_trigger'),
      pg_get_viewdef('public.toy_view'::regclass,${pretty}));`;
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
          `-k ${socket} -c listen_addresses=`,
          'start',
        ])
      );
      success(
        psql(
          'postgres',
          `CREATE DATABASE destination;
      CREATE TABLE public.toy(a integer,b integer,c integer,
        CONSTRAINT toy_check CHECK(((a>=1 AND b<=32)::boolean) AND c>=0));
      CREATE FUNCTION public.toy_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END $$;
      CREATE TRIGGER toy_trigger BEFORE UPDATE ON public.toy FOR EACH ROW
        WHEN(((NEW.a>=1 OR NEW.b>=2)::boolean) OR NEW.c>=3) EXECUTE FUNCTION public.toy_trigger();
      CREATE VIEW public.toy_view AS SELECT * FROM public.toy WHERE ((a>=1 AND b<=32)::boolean) AND c>=0;`
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
          'postgres',
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
          'destination',
          '--exit-on-error',
          archive,
        ])
      );
      const before = JSON.parse(success(psql('postgres', definitions(false))));
      const restored = JSON.parse(success(psql('destination', definitions(false))));
      assert.equal(before.length, 3);
      for (let i = 0; i < 3; i++)
        assert.notEqual(before[i], restored[i], `Literal nested grouping case ${i}`);
      assert.deepEqual(
        JSON.parse(success(psql('postgres', definitions(true)))),
        JSON.parse(success(psql('destination', definitions(true))))
      );
      // Native deparser retains different operators, meaningful casts and mixed
      // precedence. Same trigger/view identity avoids name-only false positives.
      success(
        psql(
          'destination',
          `SET search_path=pg_catalog;
      CREATE TABLE public.negative(a integer,b integer,c integer,
        CONSTRAINT op_and CHECK(a>=1 AND b>=2),CONSTRAINT op_or CHECK(a>=1 OR b>=2),
        CONSTRAINT prec_one CHECK((a>=1 OR b>=2) AND c>=3),CONSTRAINT prec_two CHECK(a>=1 OR (b>=2 AND c>=3)),
        CONSTRAINT cast_one CHECK(a::numeric>=1.1),CONSTRAINT cast_two CHECK(a>=1));
      DO $$ BEGIN
        IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conname='op_and')=
          (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conname='op_or')
        OR (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conname='prec_one')=
          (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conname='prec_two')
        OR (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conname='cast_one')=
          (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conname='cast_two')
        THEN RAISE EXCEPTION 'Native pretty erased a constraint semantic difference'; END IF;
      END $$;
      CREATE VIEW public.vnegative AS SELECT * FROM public.toy WHERE (a>=1 OR b>=2) AND c>=3;
      CREATE TEMP TABLE vbefore AS SELECT pg_get_viewdef('public.vnegative'::regclass,true) definition;
      CREATE OR REPLACE VIEW public.vnegative AS SELECT * FROM public.toy WHERE a>=1 OR (b>=2 AND c>=3);
      DO $$ BEGIN IF (SELECT definition FROM vbefore)=pg_get_viewdef('public.vnegative'::regclass,true)
        THEN RAISE EXCEPTION 'Native pretty erased view precedence'; END IF; END $$;
      CREATE TRIGGER tnegative BEFORE UPDATE ON public.toy FOR EACH ROW WHEN((NEW.a>=1 OR NEW.b>=2) AND NEW.c>=3)
        EXECUTE FUNCTION public.toy_trigger();
      CREATE TEMP TABLE tbefore AS SELECT pg_get_triggerdef(oid,true) definition FROM pg_trigger WHERE tgname='tnegative';
      DROP TRIGGER tnegative ON public.toy;
      CREATE TRIGGER tnegative BEFORE UPDATE ON public.toy FOR EACH ROW WHEN(NEW.a>=1 OR (NEW.b>=2 AND NEW.c>=3))
        EXECUTE FUNCTION public.toy_trigger();
      DO $$ BEGIN IF (SELECT definition FROM tbefore)=(SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgname='tnegative')
        THEN RAISE EXCEPTION 'Native pretty erased trigger precedence'; END IF; END $$;`
        )
      );
    } finally {
      if (existsSync(join(data, 'PG_VERSION'))) {
        const state = command('pg_ctl', ['-D', data, 'status']);
        if (state.status === 0)
          success(command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']));
        else assert.equal(state.status, 3, 'Unknown native state retains owned evidence');
        assert.equal(command('pg_ctl', ['-D', data, 'status']).status, 3);
        assert.equal(existsSync(join(data, 'postmaster.pid')), false);
      }
      rmSync(directory, { recursive: true, force: false });
      assert.equal(existsSync(directory), false);
    }
  }
);
