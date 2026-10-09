import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { batchNativeFunctions } from './leaderboard-native-function-batch.mjs';

test('unknown native source is refused without emitting a partially transformed exporter', () => {
  for (const source of ['', 'CREATE FUNCTION secret()', 'modified upstream bytes'])
    assert.throws(() => batchNativeFunctions(source), /Unsupported native source bytes/);
});

test(
  'batched native exporter preserves full output, dependencies and actual restored behavior',
  { skip: process.env.LEADERBOARD_NATIVE_BATCH_TEST !== '1' },
  () => {
    const parent = process.env.LEADERBOARD_NATIVE_BATCH_SCRATCH;
    assert.ok(
      parent?.startsWith('/Volumes/SmarterWork/agent-work/') ||
        (process.env.LEADERBOARD_NATIVE_BATCH_CONTAINER === '1' &&
          parent === '/tmp/native-batch-fixture')
    );
    const native = process.env.LEADERBOARD_NATIVE_BATCH_CLIENT;
    assert.ok(
      (native?.startsWith(parent + '/') ||
        (process.env.LEADERBOARD_NATIVE_BATCH_CONTAINER === '1' &&
          native === '/opt/lb-native/bin/pg_dump')) &&
        existsSync(native)
    );
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, 'f-')),
      data = join(directory, 'd'),
      socket = join(directory, 's'),
      log = join(directory, 'postgres.log');
    mkdirSync(socket);
    assert.ok((socket + '/.s.PGSQL.5432').length < 104);
    const bin =
      process.env.LEADERBOARD_NATIVE_BATCH_RUNTIME_BIN || '/opt/homebrew/opt/postgresql@17/bin';
    assert.ok(
      bin === '/opt/homebrew/opt/postgresql@17/bin' ||
        (process.env.LEADERBOARD_NATIVE_BATCH_CONTAINER === '1' &&
          bin === '/usr/lib/postgresql/bin')
    );
    const stockClient = process.env.LEADERBOARD_NATIVE_BATCH_STOCK || join(bin, 'pg_dump');
    assert.ok(
      stockClient === join(bin, 'pg_dump') ||
        (process.env.LEADERBOARD_NATIVE_BATCH_CONTAINER === '1' &&
          stockClient === '/opt/lb-native/bin/pg_dump-stock')
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^PG|^DATABASE_URL$/.test(k))
    );
    const run = (path, args, input) =>
      spawnSync(path, args, {
        env,
        input,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 64 * 1024 * 1024,
      });
    const ok = (r) => {
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    const args = ['-h', socket, '-U', 'leaderboard_qualification_bootstrap', '-d', 'postgres'];
    const sql = (input, db = 'postgres') =>
      ok(
        run(
          join(bin, 'psql'),
          ['-XAtq', ...args.slice(0, 4), '-d', db, '-v', 'ON_ERROR_STOP=1'],
          input
        )
      );
    const catalog = readFileSync(
      new URL('./leaderboard-isolation-catalog.sql', import.meta.url),
      'utf8'
    );
    let started = false;
    const normalize = (s) =>
      s
        .replace(/^-- (Started|Completed|Dumped by|Dumped from).*\n/gm, '')
        .replace(/^\\(un)?restrict .+\n/gm, '');
    try {
      ok(
        run(join(bin, 'initdb'), [
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
      ok(
        run(join(bin, 'pg_ctl'), [
          '-D',
          data,
          '-l',
          log,
          '-w',
          '-o',
          `-k ${socket} -c listen_addresses= -c log_statement=all`,
          'start',
        ])
      );
      started = true;
      sql(`CREATE ROLE owner; CREATE ROLE reader; CREATE SCHEMA "semi;schema" AUTHORIZATION owner;
   CREATE TYPE public.state AS ENUM ('a','quote''label'); ALTER TYPE public.state OWNER TO owner;
   CREATE TYPE public.result AS (label text, state public.state); ALTER TYPE public.result OWNER TO owner;
   CREATE DOMAIN public.positive AS integer CHECK (VALUE>0); ALTER DOMAIN public.positive OWNER TO owner;
   CREATE TABLE public.entries(id integer PRIMARY KEY, state public.state, label text);
   ALTER TABLE public.entries OWNER TO owner;
   CREATE TABLE public.parts(id integer PRIMARY KEY, label text) PARTITION BY RANGE(id);
   CREATE TABLE public.parts_one PARTITION OF public.parts FOR VALUES FROM(0) TO(10);
   CREATE TABLE public.parts_two PARTITION OF public.parts FOR VALUES FROM(10) TO(20);
   CREATE FUNCTION public.decorate(value text) RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$ SELECT value || ';body' $body$;
   ALTER FUNCTION public.decorate(text) OWNER TO owner;
   SET ROLE owner; REVOKE ALL ON FUNCTION public.decorate(text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.decorate(text) TO reader; RESET ROLE;
   CREATE FUNCTION public.on_entry() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN NEW.label:=public.decorate(NEW.label); RETURN NEW; END $body$;
   ALTER FUNCTION public.on_entry() OWNER TO owner;
   CREATE TRIGGER on_entry BEFORE INSERT ON public.entries FOR EACH ROW EXECUTE FUNCTION public.on_entry();
   ALTER TABLE public.entries ALTER COLUMN label SET DEFAULT public.decorate('default');
   CREATE FUNCTION public.read_entries() RETURNS SETOF public.entries LANGUAGE sql AS $body$ SELECT * FROM public.entries $body$; ALTER FUNCTION public.read_entries() OWNER TO owner;
   CREATE VIEW public.labels AS SELECT public.decorate(label) AS label FROM public.entries; ALTER VIEW public.labels OWNER TO owner;
   CREATE FUNCTION public.view_rows() RETURNS SETOF public.labels LANGUAGE sql AS $body$ SELECT * FROM public.labels $body$;
   CREATE FUNCTION public.parsed(value integer DEFAULT 2) RETURNS integer LANGUAGE SQL IMMUTABLE BEGIN ATOMIC SELECT value+1; END;
   CREATE PROCEDURE public.annotate(value text) LANGUAGE plpgsql AS $body$ BEGIN NULL; END $body$;
   CREATE FUNCTION public.window_rank() RETURNS bigint LANGUAGE internal WINDOW AS 'window_row_number';
   CREATE AGGREGATE public.add_values(integer)(SFUNC=int4pl,STYPE=integer,INITCOND='0');
   ALTER TABLE public.entries ENABLE ROW LEVEL SECURITY; CREATE POLICY read_own ON public.entries FOR SELECT TO reader USING(id>0);
   GRANT SELECT ON public.entries,public.labels TO reader;
   COMMENT ON FUNCTION public.decorate(text) IS 'Native quoted metadata';
   ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA public GRANT SELECT ON TABLES TO reader;
   CREATE FUNCTION public.ddl_noop() RETURNS event_trigger LANGUAGE plpgsql AS $body$ BEGIN NULL; END $body$;
   CREATE EVENT TRIGGER fixture_ddl ON ddl_command_end EXECUTE FUNCTION public.ddl_noop();
   CREATE PUBLICATION fixture_pub FOR TABLE public.entries(id,state) WHERE(id>0) WITH(publish='insert,update');
   CREATE PUBLICATION fixture_schemas FOR TABLES IN SCHEMA "semi;schema";
   DO $body$ BEGIN FOR i IN 1..500 LOOP EXECUTE format('CREATE FUNCTION public.fn_%s(value integer) RETURNS integer LANGUAGE SQL IMMUTABLE AS %L',i,'SELECT value+'||i); END LOOP; END $body$;`);
      sql(`CREATE SEQUENCE public.seq_small AS smallint START 3 INCREMENT 2 MINVALUE 1 MAXVALUE 101 CACHE 4 CYCLE;
   CREATE SEQUENCE public.seq_integer AS integer START -5 INCREMENT -2;
   CREATE SEQUENCE public.seq_big AS bigint START 9223372036854775800;
   CREATE UNLOGGED SEQUENCE public.seq_down AS bigint START -10 INCREMENT -3 MINVALUE -100 MAXVALUE -1 CACHE 2 CYCLE;
   ALTER SEQUENCE public.seq_small OWNER TO owner;
   SET ROLE owner; GRANT USAGE,SELECT ON SEQUENCE public.seq_small TO reader; RESET ROLE;
   COMMENT ON SEQUENCE public.seq_small IS 'Quoted sequence metadata; preserved';
   CREATE TABLE public.serial_entry(id serial PRIMARY KEY);
   CREATE TABLE public.identity_always(id bigint GENERATED ALWAYS AS IDENTITY(START WITH 11 INCREMENT BY 2));
   CREATE TABLE public.identity_default(id smallint GENERATED BY DEFAULT AS IDENTITY(START WITH -7 INCREMENT BY -1));
   CREATE SCHEMA excluded_sequences;
   CREATE SEQUENCE excluded_sequences.hidden START 42;
   DO $body$ BEGIN FOR i IN 1..80 LOOP EXECUTE format('CREATE SEQUENCE public.seq_many_%s START %s',i,i); END LOOP; END $body$;`);
      const sequenceCount = Number(sql('SELECT count(*) FROM pg_catalog.pg_sequence;').trim());
      assert.equal(sequenceCount, 88);
      const before = JSON.parse(sql(catalog));
      const stock = ok(
        run(stockClient, [...args, '--schema-only', '--create', '--format=plain', '--no-password'])
      );
      const logBefore = readFileSync(log, 'utf8');
      const batch = ok(
        run(native, [...args, '--schema-only', '--create', '--format=plain', '--no-password'])
      );
      const logBatch = readFileSync(log, 'utf8').slice(logBefore.length);
      assert.equal((logBefore.match(/statement: EXECUTE dumpFunc\('/g) || []).length, 508);
      assert.equal((logBatch.match(/statement: EXECUTE dumpFunc\('/g) || []).length, 0);
      assert.equal((logBatch.match(/statement: SELECT p\.oid AS lb_oid,/g) || []).length, 1);
      assert.equal(
        (logBefore.match(/statement: SELECT format_type\(seqtypid, NULL\),/g) || []).length,
        sequenceCount
      );
      assert.equal(
        (logBatch.match(/statement: SELECT format_type\(seqtypid, NULL\),/g) || []).length,
        0
      );
      assert.equal(
        (logBatch.match(/statement: SELECT seqrelid AS lb_sequence_oid,/g) || []).length,
        1
      );
      const excludedArgs = [
        ...args,
        '--schema-only',
        '--create',
        '--format=plain',
        '--no-password',
        '--exclude-schema=excluded_sequences',
      ];
      const selectedStock = ok(run(stockClient, excludedArgs));
      const selectedBatch = ok(run(native, excludedArgs));
      assert.equal(normalize(selectedBatch), normalize(selectedStock));
      assert.doesNotMatch(selectedBatch, /CREATE SEQUENCE excluded_sequences\.hidden/);

      assert.equal(
        normalize(batch),
        normalize(stock),
        'Only metadata transport may change native dump output'
      );
      sql('DROP DATABASE postgres;', 'template1');
      sql(batch, 'template1');
      const after = JSON.parse(sql(catalog));
      assert.deepEqual(after, before, 'Entire existing security/schema catalog must match');
      sql(
        "INSERT INTO public.entries(id,state) VALUES(1,'a'); INSERT INTO public.parts(id,label) VALUES(12,'second');"
      );
      assert.equal(sql('SELECT label FROM public.entries;').trim(), 'default;body;body');
      assert.equal(
        sql(
          'SELECT public.parsed(),public.fn_500(2),(SELECT count(*) FROM public.view_rows());'
        ).trim(),
        '3|502|1'
      );
      assert.equal(sql('SELECT tableoid::regclass FROM public.parts;').trim(), 'parts_two');
      assert.equal(sql('SELECT public.add_values(id) FROM public.entries;').trim(), '1');
      assert.equal(
        sql(
          "SELECT nextval('public.seq_small'),nextval('public.seq_integer'),nextval('public.seq_big'),nextval('public.seq_down');"
        ).trim(),
        '3|-5|9223372036854775800|-10'
      );
      assert.equal(sql('INSERT INTO public.serial_entry DEFAULT VALUES RETURNING id;').trim(), '1');
      assert.equal(
        sql('INSERT INTO public.identity_always DEFAULT VALUES RETURNING id;').trim(),
        '11'
      );
      assert.equal(
        sql('INSERT INTO public.identity_default DEFAULT VALUES RETURNING id;').trim(),
        '-7'
      );
      assert.equal(sql("SELECT nextval('excluded_sequences.hidden');").trim(), '42');
      console.log(
        'Native output parity, full catalog, parsed SQL, view rowtype, partitions, aggregate, event trigger, publications, RLS and ACL: passed. 508 routine and 88 sequence metadata calls each reduced to one; filtered selection and restored sequence behavior passed.'
      );
    } finally {
      if (started) ok(run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']));
      rmSync(directory, { recursive: true, force: true });
      assert.ok(!existsSync(directory));
    }
  }
);

test('all qualification doors enforce the same real native fixture before source access', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const build = read('./leaderboard-native-function-batch-build.sh');
  assert.match(build, /sha256sum -c -/);
  assert.match(build, /docker run --rm --network none --user postgres/);
  assert.match(build, /LEADERBOARD_NATIVE_BATCH_TEST=1/);
  assert.ok(
    build.indexOf('--test /harness/leaderboard-native-function-batch.test.mjs') <
      build.indexOf('>> "$GITHUB_ENV"')
  );
  assert.doesNotMatch(
    build,
    /-e (?:DATABASE_URL|PGDATABASE|PGPASSWORD)|--publish|--network host|docker push/
  );
  for (const workflow of [
    'leaderboard-isolation-preflight',
    'leaderboard-isolated-auth-qualification',
    'leaderboard-isolated-financial-qualification',
    'leaderboard-isolated-financial-repair-qualification',
  ]) {
    const source = read(`../../.github/workflows/${workflow}.yml`);
    assert.ok(
      source.indexOf('leaderboard-native-function-batch-build.sh') < source.indexOf('DATABASE_URL:')
    );
    assert.match(source, /github\.ref == 'refs\/heads\/main'/);
    assert.match(source, /replica_descriptor:/);
    assert.doesNotMatch(source, /^\s*continue-on-error:/m);
  }
  const ci = read('../../.github/workflows/ci.yml');
  assert.match(
    ci,
    /Native Leaderboard Metadata Batching Retains Exact Export And Restore\n\s+if: matrix.shard == 4/
  );
  const preflight = read('./leaderboard-isolation-preflight.sh');
  assert.match(
    preflight,
    /LEADERBOARD_NATIVE_BATCH_IMAGE:\?Actual native batch client fixture must pass/
  );
  assert.match(preflight, /source_image="\$LEADERBOARD_NATIVE_BATCH_IMAGE"/);
  assert.match(preflight, /replica recovery, feedback, version or WAL fence refused/);
  assert.match(preflight, /cmp -s "\$scratch\/source-before.json" "\$scratch\/isolated.json"/);
});
