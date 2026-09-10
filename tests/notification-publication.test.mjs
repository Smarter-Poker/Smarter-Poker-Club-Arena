import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('notification publication restores delivery without changing other tables or account privacy', () => {
  const bin = process.env.PGBIN || '/opt/homebrew/opt/postgresql@17/bin';
  assert.match(
    execFileSync(join(bin, 'postgres'), ['--version'], { encoding: 'utf8' }),
    /PostgreSQL\) 17\./
  );
  const root = mkdtempSync(join(tmpdir(), 'ca-notification-publication-'));
  const data = join(root, 'data'),
    socket = join(root, 'socket');
  mkdirSync(socket);
  let share = execFileSync(join(bin, 'pg_config'), ['--sharedir'], { encoding: 'utf8' }).trim();
  if (!existsSync(join(share, 'postgres.bki'))) share = resolve(bin, '../share/postgresql');
  const sql = (query, failure = false) => {
    const result = spawnSync(
      join(bin, 'psql'),
      [
        '-h',
        socket,
        '-p',
        '55448',
        '-U',
        'notification_test',
        '-d',
        'postgres',
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { input: query, encoding: 'utf8' }
    );
    if (failure) {
      assert.notEqual(result.status, 0);
      return result;
    }
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    execFileSync(
      join(bin, 'initdb'),
      [
        '-L',
        share,
        '-D',
        data,
        '-U',
        'notification_test',
        '-A',
        'trust',
        '--no-locale',
        '-E',
        'UTF8',
      ],
      { stdio: 'pipe' }
    );
    execFileSync(
      join(bin, 'pg_ctl'),
      [
        '-D',
        data,
        '-l',
        join(root, 'postgres.log'),
        '-o',
        "-h '' -k '" + socket + "' -p 55448 -c wal_level=logical",
        '-w',
        'start',
      ],
      { stdio: 'pipe' }
    );
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      GRANT USAGE ON SCHEMA auth TO anon, authenticated;
      CREATE TABLE notifications(id uuid PRIMARY KEY, user_id uuid, read boolean, is_read boolean, message text);
      ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
      ALTER TABLE notifications REPLICA IDENTITY FULL;
      CREATE POLICY "Users can view own notifications" ON notifications FOR SELECT
        USING ((SELECT auth.uid()) = user_id);
      GRANT SELECT ON notifications TO anon, authenticated;
      CREATE TABLE club_members(id uuid PRIMARY KEY, user_id uuid, is_bot boolean);
      CREATE TABLE hand_projection_outbox(id uuid PRIMARY KEY);
      CREATE PUBLICATION supabase_realtime FOR TABLE club_members(id,user_id), hand_projection_outbox;
      INSERT INTO notifications VALUES
        ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',false,false,'Account A'),
        ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002',false,false,'Account B');
    `);
    const inventory =
      "SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename) FROM pg_publication_tables p WHERE pubname='supabase_realtime' AND tablename<>'notifications'";
    const before = sql(inventory);
    assert.equal(
      sql("SELECT count(*) FROM pg_publication_tables WHERE tablename='notifications'"),
      '0'
    );
    const migration = readFileSync(
      new URL(
        '../supabase/migrations/20260910003525_restore_owned_notification_realtime_after_publication_replacement.sql',
        import.meta.url
      ),
      'utf8'
    );
    sql(migration);
    assert.equal(
      sql("SELECT count(*) FROM pg_publication_tables WHERE tablename='notifications'"),
      '1'
    );
    assert.equal(sql(inventory), before);
    sql(migration);
    assert.equal(sql(inventory), before);
    assert.equal(sql('SET ROLE anon; SELECT count(*) FROM notifications;').split('\n').at(-1), '0');
    for (const [id, expected] of [
      ['20000000-0000-0000-0000-000000000001', 'Account A'],
      ['20000000-0000-0000-0000-000000000002', 'Account B'],
    ]) {
      const result = sql(
        "SET ROLE authenticated; SET request.jwt.claim.sub='" +
          id +
          "'; SELECT string_agg(message, ',') FROM notifications;"
      )
        .split('\n')
        .at(-1);
      assert.equal(result, expected);
    }
    sql(
      'ALTER PUBLICATION supabase_realtime DROP TABLE notifications; ALTER POLICY "Users can view own notifications" ON notifications USING (true);'
    );
    assert.match(sql(migration, true).stderr, /not the verified owner-only policy/);
    assert.equal(
      sql("SELECT count(*) FROM pg_publication_tables WHERE tablename='notifications'"),
      '0'
    );
    assert.equal(sql(inventory), before);
  } finally {
    spawnSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], {
      stdio: 'pipe',
    });
    rmSync(root, { recursive: true, force: true });
  }
});
