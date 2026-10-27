import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  scoreboardSQL,
  runScoreboard,
  scoreboardWindows,
  mergeScoreboards,
  scoreboardConnectionEnvironment,
  scoreboardReportSQL,
} from '../horse-human-scoreboard.mjs';

test('report and native regression changes trigger their PostgreSQL check', () => {
  const workflow = readFileSync('.github/workflows/horse-human-scoreboard.yml', 'utf8');
  for (const path of [
    'scripts/horse-human-scoreboard.mjs',
    'scripts/ci/test-horse-human-scoreboard.mjs',
    '.github/workflows/horse-human-scoreboard.yml',
  ])
    assert.equal(workflow.split(path).length - 1 >= 2, true);
  assert.match(workflow, /node --test scripts\/ci\/test-horse-human-scoreboard.mjs/);
  assert.match(workflow, /default_transaction_read_only=on/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /runScoreboard\(\['--run'/);
});

const since = '2026-10-26T14:00:00Z',
  through = '2026-10-26T15:00:00Z';
test('report refuses invalid, injected, reversed and unbounded windows before connecting', () => {
  for (const [a, b] of [
    ["'; DELETE FROM profiles;--", through],
    [through, since],
    ['2026-09-01T00:00:00Z', through],
    [since, since],
    ['not-a-date', through],
    ['2026-02-30T00:00:00Z', '2026-03-03T00:00:00Z'],
    ['2026-04-31T00:00:00Z', '2026-05-03T00:00:00Z'],
  ]) {
    assert.throws(() => scoreboardSQL(a, b));
    const invalid = runScoreboard(['--run', a, b]);
    assert.equal(invalid.code, 3);
    assert.equal(JSON.parse(invalid.output).reason, 'invalid_input');
  }
  assert.equal(runScoreboard([]).code, 64);
  assert.throws(() => scoreboardSQL(since, through, "x'; SELECT 1;--"));
  assert.match(scoreboardSQL(since, through), /^BEGIN READ ONLY;/);
  assert.match(
    scoreboardSQL(since, through, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    /p.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'/
  );
});

test('daily reports merge complete windows using hand-weighted results and reject gaps or drift', () => {
  const from = '2026-10-24T00:00:00Z',
    until = '2026-10-24T12:00:00Z';
  const windows = scoreboardWindows(from, until);
  assert.equal(windows.length, 2);
  assert.equal(scoreboardWindows('2026-10-12T00:00:00Z', '2026-10-26T00:00:00Z').length, 56);
  const receipt = (w, hands, bb) => ({
    version: 1,
    status: 'observed',
    ...w,
    player_id: null,
    roster_digest: '1'.repeat(32),
    classification_basis: 'current_profiles_not_historical_identity',
    candidate_scope: 'currently_classified_humans_only_unknown_actors_excluded',
    candidate_facts: hands,
    coverage: [{ cohort: 'sole_human_against_horses', facts: hands }],
    scores: [
      {
        game_variant: 'plo5',
        big_blind: 2,
        tournament: false,
        user_id: 'player',
        hands,
        distinct_hands: hands,
        human_net_chips_after_rake: bb * 2,
        human_net_bb_after_rake: bb,
        human_bb_per_100: (100 * bb) / hands,
      },
    ],
  });
  const reports = [receipt(windows[0], 1, 2), receipt(windows[1], 3, -1)];
  const result = mergeScoreboards(reports, from, until);
  assert.equal(result.candidate_facts, 4);
  assert.equal(result.scores[0].hands, 4);
  assert.equal(result.scores[0].human_net_chips_after_rake, 2);
  assert.equal(result.scores[0].human_net_bb_after_rake, 1);
  assert.equal(result.scores[0].human_bb_per_100, 25);
  const scopedReports = reports.map((r) => ({
    ...r,
    player_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    scores: r.scores.map((row) => ({ ...row, user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
  }));
  assert.equal(
    mergeScoreboards(scopedReports, from, until, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA').player_id,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  assert.throws(() => mergeScoreboards(reports.slice(1), from, until));
  for (const patch of [
    { status: 'incomplete_row_limit' },
    { roster_digest: '2'.repeat(32) },
    { since: windows[0].since },
    { candidate_scope: 'all' },
    { candidate_facts: 99 },
    { scores: [] },
  ]) {
    assert.throws(() => mergeScoreboards([reports[0], { ...reports[1], ...patch }], from, until));
  }
  assert.throws(() =>
    mergeScoreboards(
      [reports[0], { ...reports[1], scores: [...reports[1].scores, ...reports[1].scores] }],
      from,
      until
    )
  );
  assert.throws(() =>
    mergeScoreboards(
      [reports[0], { ...reports[1], scores: [{ ...reports[1].scores[0], human_bb_per_100: 300 }] }],
      from,
      until
    )
  );
});

test('native PostgreSQL report isolates exact cohorts, rake, variants, stakes and tournament chips', async () => {
  // Never inherits remote PG settings or reads ~/.pgpass. TCP is disabled.
  const root = mkdtempSync(join(tmpdir(), 'horse-scoreboard-'));
  const data = join(root, 'pg'),
    socket = join(root, 'socket');
  mkdirSync(socket);
  const bin = process.env.PG_SCOREBOARD_BIN || '';
  const executable = (name) => (bin ? join(bin, name) : name);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    LC_ALL: 'C',
    PGHOST: socket,
    PGPORT: '5432',
    PGUSER: process.env.USER || 'postgres',
    PGDATABASE: 'postgres',
    PGPASSFILE: join(root, 'absent'),
  };
  const run = (name, args, input) => {
    const r = spawnSync(executable(name), args, {
      env,
      input,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '--no-locale', '-U', env.PGUSER]);
    run('pg_ctl', [
      '-D',
      data,
      '-l',
      join(root, 'postgres.log'),
      '-o',
      `-k ${socket} -h ''`,
      '-w',
      'start',
    ]);
    started = true;
    const psql = (sql) => run('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql);
    psql(`CREATE TABLE profiles(id text PRIMARY KEY,is_horse boolean);
      INSERT INTO profiles VALUES ('11111111-1111-4111-8111-111111111111',false),('h2',false),('a',true),('b',true),('unknown',null);
      CREATE TABLE ca_hand_facts(hand_id text,user_id text,game_variant text,big_blind numeric,
        tournament_id text,net numeric,opponent_ids text[],players_dealt int,played_at timestamptz);
      CREATE INDEX fact_user_time ON ca_hand_facts(user_id,played_at);
      INSERT INTO ca_hand_facts VALUES
      ('cash-win','11111111-1111-4111-8111-111111111111','plo5',2,null,18,ARRAY['a','b'],3,'2026-10-26T14:10Z'),
      ('cash-loss','11111111-1111-4111-8111-111111111111','plo5',2,null,-10,ARRAY['a','b'],3,'2026-10-26T14:11Z'),
      ('mixed','11111111-1111-4111-8111-111111111111','plo5',2,null,900,ARRAY['h2','a'],3,'2026-10-26T14:12Z'),
      ('mixed','h2','plo5',2,null,-900,ARRAY['11111111-1111-4111-8111-111111111111','a'],3,'2026-10-26T14:12Z'),
      ('unknown','11111111-1111-4111-8111-111111111111','plo5',2,null,500,ARRAY['unknown'],2,'2026-10-26T14:13Z'),
      ('missing','11111111-1111-4111-8111-111111111111','plo5',2,null,500,ARRAY['absent'],2,'2026-10-26T14:13Z'),
      ('duplicate','11111111-1111-4111-8111-111111111111','plo5',2,null,500,ARRAY['a','a'],3,'2026-10-26T14:13Z'),
      ('incomplete','11111111-1111-4111-8111-111111111111','plo5',2,null,500,ARRAY['a'],3,'2026-10-26T14:13Z'),
      ('null-count','11111111-1111-4111-8111-111111111111','plo5',2,null,500,ARRAY['a'],null,'2026-10-26T14:13Z'),
      ('invalid','11111111-1111-4111-8111-111111111111','plo5',0,null,500,ARRAY['a'],2,'2026-10-26T14:13Z'),
      ('not-finite','11111111-1111-4111-8111-111111111111','plo5','NaN',null,500,ARRAY['a'],2,'2026-10-26T14:13Z'),
      ('self','11111111-1111-4111-8111-111111111111','plo5',2,null,500,ARRAY['11111111-1111-4111-8111-111111111111'],2,'2026-10-26T14:13Z'),
      ('horse','a','plo5',2,null,500,ARRAY['11111111-1111-4111-8111-111111111111'],2,'2026-10-26T14:13Z'),
      ('tourney','11111111-1111-4111-8111-111111111111','plo5',2,'t',200,ARRAY['a'],2,'2026-10-26T14:14Z'),
      ('other-stakes','11111111-1111-4111-8111-111111111111','plo5',10,null,50,ARRAY['a'],2,'2026-10-26T14:14Z'),
      ('other-game','11111111-1111-4111-8111-111111111111','nlh',2,null,-2,ARRAY['a'],2,'2026-10-26T14:14Z'),
      ('end-excluded','11111111-1111-4111-8111-111111111111','plo5',2,null,500,ARRAY['a'],2,'2026-10-26T15:00Z');`);
    const report = JSON.parse(psql(scoreboardSQL(since, through)));
    assert.equal(report.status, 'observed');
    const cli = spawnSync(
      process.execPath,
      [resolve('scripts/horse-human-scoreboard.mjs'), '--run', since, through],
      {
        env: { ...env, PATH: bin ? bin + ':' + env.PATH : env.PATH },
        encoding: 'utf8',
        timeout: 10000,
      }
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), { ...report, windows: 1 });
    const uri = spawnSync(
      process.execPath,
      [resolve('scripts/horse-human-scoreboard.mjs'), '--run', since, through],
      {
        env: {
          ...env,
          PATH: bin ? bin + ':' + env.PATH : env.PATH,
          PGHOST: join(root, 'unreachable'),
          PGDATABASE: `postgresql://${encodeURIComponent(env.PGUSER)}@${encodeURIComponent(socket)}:5432/postgres`,
        },
        encoding: 'utf8',
        timeout: 10000,
      }
    );
    assert.equal(uri.status, 0, uri.stderr || uri.stdout);
    assert.deepEqual(JSON.parse(uri.stdout), { ...report, windows: 1 });

    const multi = spawnSync(
      process.execPath,
      [
        resolve('scripts/horse-human-scoreboard.mjs'),
        '--run',
        '2026-10-25T14:00:00Z',
        '2026-10-27T14:00:00Z',
      ],
      {
        env: { ...env, PATH: bin ? bin + ':' + env.PATH : env.PATH },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    assert.equal(multi.status, 0, multi.stderr);
    const merged = JSON.parse(multi.stdout);
    assert.equal(merged.windows, 8);
    const mergedCash = merged.scores.find(
      (r) => r.game_variant === 'plo5' && r.big_blind === 2 && !r.tournament
    );
    assert.equal(mergedCash.hands, 3);
    assert.equal(mergedCash.human_net_chips_after_rake, 508);
    assert.equal(report.scores.length, 4);
    const cash = report.scores.find(
      (r) => r.game_variant === 'plo5' && r.big_blind === 2 && !r.tournament
    );
    assert.equal(cash.hands, 2);
    assert.equal(cash.human_net_chips_after_rake, 8);
    assert.equal(cash.human_net_bb_after_rake, 4);
    assert.equal(cash.human_bb_per_100, 200);
    const coverage = Object.fromEntries(report.coverage.map((r) => [r.cohort, r.facts]));
    assert.equal(coverage.mixed_human, 2);
    assert.equal(coverage.unknown_opponent, 2);
    assert.equal(coverage.unknown_participants, 4);
    assert.equal(coverage.invalid_result, 2);
    assert.equal(coverage.horse_fact, undefined);
    assert.match(report.meaning, /not horse profit/);
    const scoped = JSON.parse(
      psql(scoreboardSQL(since, through, '11111111-1111-4111-8111-111111111111'))
    );
    assert.equal(scoped.player_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(scoped.coverage.find((r) => r.cohort === 'mixed_human').facts, 1);
    const empty = JSON.parse(psql(scoreboardSQL('2026-10-26T16:00:00Z', '2026-10-26T17:00:00Z')));
    assert.deepEqual(empty.scores, []);
    // A real second session changes the roster between two actual partition
    // SELECTs. READ COMMITTED reproduces the old refusal; the maintained batch
    // must retain one snapshot without weakening the digest consistency check.
    const snapshotEnd = '2026-10-27T02:00:00Z';
    const exerciseSnapshot = async (repeatable, fixtureId) => {
      const windows = scoreboardWindows(since, snapshotEnd);
      assert.equal(windows.length, 2);
      const second = scoreboardSQL(windows[1].since, windows[1].through)
        .replace(/^BEGIN READ ONLY;\n/, '')
        .replace(/\nCOMMIT;\n$/, '');
      let batch = scoreboardReportSQL(since, snapshotEnd);
      assert.ok(batch.includes(second));
      batch = batch.replace(second, `SELECT pg_sleep(0.5);\n${second}`);
      if (!repeatable)
        batch = batch.replace(
          'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
          'BEGIN READ ONLY;'
        );
      const updater = spawn(
        executable('psql'),
        [
          '-X',
          '-q',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `SELECT pg_sleep(0.15); INSERT INTO profiles VALUES ('${fixtureId}',false);`,
        ],
        { env }
      );
      let errorText = '';
      updater.stderr.on('data', (chunk) => {
        errorText += chunk;
      });
      const finished = new Promise((resolve, reject) => {
        updater.on('error', reject);
        updater.on('exit', (code) => (code === 0 ? resolve() : reject(Error(errorText))));
      });
      const raw = psql(batch);
      await finished;
      return raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };
    const drifting = await exerciseSnapshot(false, 'snapshot-old');
    assert.notEqual(drifting[0].roster_digest, drifting[1].roster_digest);
    assert.throws(
      () => mergeScoreboards(drifting, since, snapshotEnd),
      /Unqualified window receipt/
    );
    const stable = await exerciseSnapshot(true, 'snapshot-new');
    assert.equal(stable[0].roster_digest, stable[1].roster_digest);
    assert.equal(mergeScoreboards(stable, since, snapshotEnd).windows, 2);
    psql(
      `INSERT INTO ca_hand_facts SELECT 'bulk-'||g,'11111111-1111-4111-8111-111111111111','plo5',2,null,1,ARRAY['a'],2,'2026-10-26T14:20Z' FROM generate_series(1,50001) g;`
    );
    const capped = JSON.parse(psql(scoreboardSQL(since, through)));
    assert.equal(capped.status, 'incomplete_row_limit');
    assert.equal(capped.candidate_facts, 50001);
    assert.deepEqual(capped.coverage, []);
    assert.deepEqual(capped.scores, []);
    assert.equal(psql('SELECT count(*) FROM ca_hand_facts;').trim(), '50018');
    psql('ALTER TABLE ca_hand_facts RENAME TO unavailable_private_relation;');
    const unavailable = spawnSync(
      process.execPath,
      [resolve('scripts/horse-human-scoreboard.mjs'), '--run', since, through],
      { env: { ...env, PATH: bin ? bin + ':' + env.PATH : env.PATH }, encoding: 'utf8' }
    );
    assert.equal(unavailable.status, 3);
    assert.deepEqual(JSON.parse(unavailable.stdout), {
      status: 'unavailable',
      reason: 'query_failed',
      sqlstate: '42P01',
      partition: 1,
      completed_partitions: 0,
    });
    assert.doesNotMatch(unavailable.stdout, /unavailable_private_relation|SELECT|postgresql:\/\//);
  } finally {
    if (started || existsSync(join(data, 'postmaster.pid')))
      run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    assert.equal(
      existsSync(join(data, 'postmaster.pid')),
      false,
      'Unconfirmed cleanup retains its private allocation'
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider URL becomes private libpq environment without changing identity or logging it', () => {
  const base = {
    PGDATABASE:
      'postgresql://service%2Erole:fake%40password@db.example:6543/postgres?sslmode=require&channel_binding=require',
    PGHOST: 'wrong',
    PGSERVICE: 'wrong',
    PGSERVICEFILE: 'wrong',
  };
  const result = scoreboardConnectionEnvironment(base);
  assert.equal(result.PGHOST, 'db.example');
  assert.equal(result.PGPORT, '6543');
  assert.equal(result.PGUSER, 'service.role');
  assert.equal(result.PGPASSWORD, 'fake@password');
  assert.equal(result.PGDATABASE, 'postgres');
  assert.equal(result.PGSSLMODE, 'require');
  assert.equal(result.PGCHANNELBINDING, 'require');
  assert.equal(result.PGSERVICE, undefined);
  assert.equal(result.PGSERVICEFILE, undefined);
  assert.equal(base.PGHOST, 'wrong');
  assert.equal(scoreboardConnectionEnvironment({ PGDATABASE: 'postgres' }).PGDATABASE, 'postgres');
  assert.throws(() =>
    scoreboardConnectionEnvironment({
      PGDATABASE: 'postgresql://user@db.example/postgres?unknown=x',
    })
  );
});
