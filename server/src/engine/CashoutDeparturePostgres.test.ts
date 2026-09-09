import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: transport,
  maintenanceSupabase: transport,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { ServerTableEngine } = await import('./ServerTableEngine.js');
const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLUB = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const host = process.env.CA_DEPARTURE_PG_HOST;
// Opt-in: scripts/dev/probe-departure-postgres.sh owns a disposable socket-only DB.
// These are actual cashout/credit SQL transactions, not PostgREST/browser tests.
function sql(query: string): any {
  if (
    !host ||
    basename(host) !== 'socket' ||
    !basename(dirname(host)).startsWith('ca-departure.') ||
    realpathSync(dirname(dirname(host))) !== realpathSync(tmpdir())
  )
    throw new Error('A disposable departure database is required');
  const result = execFileSync(
    process.env.CA_DEPARTURE_PSQL!,
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      host,
      '-p',
      '55443',
      '-U',
      'departure_test',
      '-d',
      'postgres',
      '-c',
      query,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  return result ? JSON.parse(result) : undefined;
}
function snapshot() {
  return sql(`SELECT json_build_object(
    'balance',(SELECT chip_balance FROM club_members),
    'active',(SELECT count(*) FROM table_seats WHERE left_at IS NULL),
    'credits',(SELECT count(*) FROM wallet_transactions),
    'keys',(SELECT count(*) FROM wallet_credit_idempotency),
    'closes',(SELECT count(*) FROM session_closes))`);
}
describe.skipIf(!host)('engine/service/PostgreSQL departure recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql(
      'TRUNCATE seat_admin_departure_authorizations,anti_cheat_events,profiles,seat_departure_requests,seat_cashout_receipts,tournaments,tables,table_seats,club_members,wallets,wallet_transactions,chip_transactions,wallet_credit_idempotency,session_closes'
    );
  });
  const seedOccupancy = (stack = 25) => {
    sql(`INSERT INTO profiles VALUES('${USER}'); INSERT INTO tables VALUES('${TABLE}',NULL,1);
      INSERT INTO club_members VALUES('${USER}','${CLUB}',100,NULL);
      INSERT INTO table_seats VALUES(gen_random_uuid(),'${TABLE}','${USER}',2,
      ${stack},now(),NULL,false,'${CLUB}')`);
    return sql('SELECT to_json(occupancy_id) FROM table_seats') as string;
  };
  const boundCashout = (occupancy: string) =>
    sql(`SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${occupancy}',NULL)`);

  const requestDeparture = (occupancy: string, mode = 'voluntary') =>
    sql(
      "SELECT fn_request_seat_departure('" +
        USER +
        "','" +
        TABLE +
        "',2,'" +
        occupancy +
        "','" +
        mode +
        "')"
    );
  const ACTOR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const requestAdmin = (occupancy: string, actor = ACTOR, reason = 'house decision') =>
    sql(`SELECT fn_request_admin_seat_departure('${USER}','${TABLE}',2,
      '${occupancy}','${actor}','${CLUB}','${reason}')`);
  it('retains original administrative authority and moderation history with the departure', () => {
    const occupancy = seedOccupancy();
    expect(requestAdmin(occupancy)).toMatchObject({
      accepted: true,
      leave_mode: 'forced',
      admin_authorization: {
        occupancy_id: occupancy,
        actor_id: ACTOR,
        club_id: CLUB,
        reason: 'house decision',
      },
    });
    expect(sql('SELECT count(*) FROM seat_admin_departure_authorizations')).toBe(1);
    expect(sql("SELECT to_json(details->>'state') FROM anti_cheat_events")).toBe(
      'departure_requested'
    );
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    expect(requestAdmin(occupancy, USER, 'different reason').admin_authorization).toMatchObject({
      actor_id: ACTOR,
      reason: 'house decision',
    });
    expect(sql('SELECT count(*) FROM anti_cheat_events')).toBe(1);
    boundCashout(occupancy);
    expect(
      sql(`SELECT count(*) FROM seat_admin_departure_authorizations a
      JOIN seat_cashout_receipts r USING(occupancy_id)
      WHERE a.actor_id='${ACTOR}' AND (r.receipt->>'stack')::numeric=25`)
    ).toBe(1);
    expect(boundCashout(occupancy).stack).toBe(25);
    expect(sql('SELECT count(*) FROM wallet_transactions')).toBe(1);
  });
  it('rolls back departure flags and authority when moderation insertion fails', () => {
    const occupancy = seedOccupancy();
    // Actual production FK: the player profile must exist for moderation history.
    sql('DELETE FROM profiles');
    expect(() => requestAdmin(occupancy)).toThrow(/foreign key/);
    expect(sql('SELECT count(*) FROM seat_admin_departure_authorizations')).toBe(0);
    expect(sql('SELECT count(*) FROM seat_departure_requests')).toBe(0);
    expect(sql('SELECT to_json(leave_pending) FROM table_seats')).toBe(false);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  it('retains administrative proof after profile and physical seat deletion', () => {
    const occupancy = seedOccupancy();
    requestAdmin(occupancy);
    boundCashout(occupancy);
    sql('DELETE FROM profiles; DELETE FROM table_seats');
    expect(sql('SELECT count(*) FROM anti_cheat_events')).toBe(0);
    expect(sql('SELECT count(*) FROM seat_admin_departure_authorizations')).toBe(1);
    expect(boundCashout(occupancy).stack).toBe(25);
  });
  it('refuses direct owner manufacture or mutation of administrative authority', () => {
    const occupancy = seedOccupancy();
    expect(() =>
      sql(`BEGIN; SET LOCAL test.is_engine='false';
      SELECT fn_request_admin_seat_departure('${USER}','${TABLE}',2,'${occupancy}',
        '${ACTOR}','${CLUB}','house decision'); COMMIT;`)
    ).toThrow(/Engine authority required/);
    expect(() =>
      sql(`BEGIN; SET LOCAL ROLE authenticated;
      SELECT fn_request_admin_seat_departure('${USER}','${TABLE}',2,'${occupancy}',
        '${ACTOR}','${CLUB}','house decision'); COMMIT;`)
    ).toThrow(/permission denied/);
    requestAdmin(occupancy);
    expect(() =>
      sql(
        "BEGIN; SET LOCAL ROLE service_role; UPDATE seat_admin_departure_authorizations SET reason='changed'; COMMIT;"
      )
    ).toThrow(/permission denied/);
    expect(sql('SELECT to_json(reason) FROM seat_admin_departure_authorizations')).toBe(
      'house decision'
    );
  });
  it('rejects stale administrative identity without recording a kick', () => {
    seedOccupancy();
    expect(() => requestAdmin('ffffffff-ffff-4fff-8fff-ffffffffffff')).toThrow(
      /CASHOUT_STALE_OCCUPANCY/
    );
    expect(sql('SELECT count(*) FROM anti_cheat_events')).toBe(0);
    expect(sql('SELECT count(*) FROM seat_admin_departure_authorizations')).toBe(0);
  });
  it('persists forced authority and the pending flag atomically without moving chips', () => {
    const occupancy = seedOccupancy();
    expect(requestDeparture(occupancy, 'forced')).toMatchObject({
      accepted: true,
      occupancy_id: occupancy,
      leave_mode: 'forced',
      tournament_table: false,
    });
    expect(sql('SELECT to_json(leave_pending) FROM table_seats')).toBe(true);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    // A fresh connection has no engine-memory forced set. The ordinary
    // voluntary pending processor must still honor the stored forced request.
    sql(
      "SELECT fn_cashout_seat_occupancy('" +
        USER +
        "','" +
        TABLE +
        "',2,'" +
        occupancy +
        "','voluntary')"
    );
    expect(sql('SELECT to_json(reason) FROM session_closes')).toBe('system');
  });

  it('a forced request does not leak onto a later occupancy for the same player', () => {
    const original = seedOccupancy();
    requestDeparture(original, 'forced');
    boundCashout(original);
    sql('UPDATE table_seats SET left_at=NULL,stack=40; UPDATE tables SET current_players=1');
    const next = sql('SELECT to_json(occupancy_id) FROM table_seats') as string;
    expect(next).not.toBe(original);
    requestDeparture(next);
    sql(
      "SELECT fn_cashout_seat_occupancy('" +
        USER +
        "','" +
        TABLE +
        "',2,'" +
        next +
        "','voluntary')"
    );
    expect(sql("SELECT count(*) FROM session_closes WHERE reason='voluntary'")).toBe(1);
  });
  it('a voluntary retry cannot downgrade durable forced authority', () => {
    const occupancy = seedOccupancy();
    requestDeparture(occupancy);
    requestDeparture(occupancy, 'forced');
    expect(requestDeparture(occupancy).leave_mode).toBe('forced');
    expect(sql('SELECT count(*) FROM seat_departure_requests')).toBe(1);
  });
  it('rolls back departure authority if its seat flag cannot be written', () => {
    const occupancy = seedOccupancy();
    expect(() =>
      sql(
        "BEGIN; SET LOCAL test.reject_exit='on'; SELECT fn_request_seat_departure('" +
          USER +
          "','" +
          TABLE +
          "',2,'" +
          occupancy +
          "','forced'); COMMIT;"
      )
    ).toThrow(/injected seat exit failure/);
    expect(sql('SELECT count(*) FROM seat_departure_requests')).toBe(0);
    expect(sql('SELECT to_json(leave_pending) FROM table_seats')).toBe(false);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  it('cannot attach departure authority to a stale occupancy', () => {
    seedOccupancy();
    expect(() => requestDeparture('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'forced')).toThrow(
      /CASHOUT_STALE_OCCUPANCY/
    );
    expect(sql('SELECT count(*) FROM seat_departure_requests')).toBe(0);
  });
  it('does not let an authenticated owner manufacture forced authority', () => {
    const occupancy = seedOccupancy();
    expect(() =>
      sql(
        "BEGIN; SET LOCAL test.is_engine='false'; SET LOCAL test.auth_uid='" +
          USER +
          "'; SELECT fn_request_seat_departure('" +
          USER +
          "','" +
          TABLE +
          "',2,'" +
          occupancy +
          "','forced'); COMMIT;"
      )
    ).toThrow(/Engine authority required/);
    expect(sql('SELECT count(*) FROM seat_departure_requests')).toBe(0);
  });
  it('retains tournament chips and avoids cash leave_pending while persisting sit-out', () => {
    const occupancy = seedOccupancy();
    sql(
      "INSERT INTO tournaments VALUES('" +
        CLUB +
        "'); UPDATE tables SET tournament_id='" +
        CLUB +
        "'"
    );
    expect(requestDeparture(occupancy)).toMatchObject({ accepted: true, tournament_table: true });
    expect(sql('SELECT to_json(leave_pending) FROM table_seats')).toBe(false);
    expect(sql('SELECT to_json(is_sitting_out) FROM table_seats')).toBe(true);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  it.each([0, 25])('replays the original %s cashout after deletion and a new buy-in', (stack) => {
    const original = seedOccupancy(stack);
    const receipt = boundCashout(original);
    expect(receipt).toMatchObject({
      ok: true,
      stack,
      occupancy_id: original,
      user_id: USER,
      table_id: TABLE,
    });
    sql(`DELETE FROM table_seats;
      UPDATE club_members SET chip_balance=chip_balance-40;
      INSERT INTO table_seats VALUES(gen_random_uuid(),'${TABLE}','${USER}',2,
      40,now(),NULL,false,'${CLUB}');
      UPDATE tables SET current_players=1`);
    const replacement = sql('SELECT to_json(occupancy_id) FROM table_seats');
    expect(replacement).not.toBe(original);
    expect(boundCashout(original)).toEqual(receipt);
    expect(snapshot()).toEqual({
      balance: 60 + stack,
      active: 1,
      credits: stack ? 1 : 0,
      keys: stack ? 1 : 0,
      closes: 1,
    });
    expect(boundCashout(replacement).stack).toBe(40);
    expect(snapshot()).toEqual({
      balance: 100 + stack,
      active: 0,
      credits: stack ? 2 : 1,
      keys: stack ? 2 : 1,
      closes: 2,
    });
  });
  it('creates a new credit identity when a physical seat row and joined_at are reused', () => {
    const original = seedOccupancy();
    boundCashout(original);
    sql(`UPDATE club_members SET chip_balance=chip_balance-40;
      UPDATE table_seats SET left_at=NULL,stack=40;
      UPDATE tables SET current_players=1`);
    const replacement = sql('SELECT to_json(occupancy_id) FROM table_seats');
    expect(replacement).not.toBe(original);
    expect(boundCashout(replacement).stack).toBe(40);
    expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 2, keys: 2, closes: 2 });
  });
  it('rejects an unknown occupancy without touching the current seat', () => {
    seedOccupancy();
    expect(() => boundCashout('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).toThrow(
      /CASHOUT_STALE_OCCUPANCY/
    );
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  it('rejects a replay with changed business scope', () => {
    const original = seedOccupancy();
    boundCashout(original);
    expect(() =>
      sql(`SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',3,'${original}',NULL)`)
    ).toThrow(/CASHOUT_OCCUPANCY_SCOPE_MISMATCH/);
    expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
  });
  it('keeps a committed receipt replayable even after its table is deleted', () => {
    const original = seedOccupancy();
    const receipt = boundCashout(original);
    sql('DELETE FROM table_seats; DELETE FROM tables');
    expect(boundCashout(original)).toEqual(receipt);
    expect(sql('SELECT count(*)::integer FROM wallet_transactions')).toBe(1);
  });
  it('rolls back the credit, seat exit and receipt on a failed seat write', () => {
    const original = seedOccupancy();
    expect(() =>
      sql(`BEGIN; SET LOCAL test.reject_exit='on';
      SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${original}',NULL); COMMIT;`)
    ).toThrow(/injected seat exit failure/);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    expect(sql('SELECT count(*)::integer FROM seat_cashout_receipts')).toBe(0);
    expect(boundCashout(original).stack).toBe(25);
  });
  it('rolls back every financial write if storing the final receipt fails', () => {
    const original = seedOccupancy();
    sql(`CREATE FUNCTION reject_test_receipt() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$;
      CREATE TRIGGER reject_test_receipt BEFORE INSERT ON seat_cashout_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_test_receipt()`);
    try {
      expect(() => boundCashout(original)).toThrow(/injected receipt failure/);
      expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
      expect(sql('SELECT count(*)::integer FROM seat_cashout_receipts')).toBe(0);
    } finally {
      sql(
        'DROP TRIGGER reject_test_receipt ON seat_cashout_receipts; DROP FUNCTION reject_test_receipt()'
      );
    }
    expect(boundCashout(original).stack).toBe(25);
    expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
  });
  it('does not expose stored financial receipts through table privileges', () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(
          sql(`SELECT to_json(has_table_privilege('${role}',
          'public.seat_cashout_receipts','${privilege}'))`)
        ).toBe(false);
      }
    }
    expect(
      sql(`SELECT to_json(relrowsecurity) FROM pg_class
      WHERE oid='public.seat_cashout_receipts'::regclass`)
    ).toBe(true);
  });
  it.each([false, true])(
    'refuses another user before active or cached outcome access: committed=%s',
    (committed) => {
      const original = seedOccupancy();
      if (committed) boundCashout(original);
      const before = snapshot();
      expect(() =>
        sql(`BEGIN; SET LOCAL test.is_engine='false';
      SET LOCAL test.auth_uid='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${original}',NULL);
      COMMIT;`)
      ).toThrow(/Engine authority required/);
      expect(snapshot()).toEqual(before);
    }
  );
  it("requires engine authority even to replay the owner's committed receipt", () => {
    const original = seedOccupancy();
    const ownRequest = () =>
      sql(`BEGIN; SET LOCAL test.is_engine='false';
      SET LOCAL test.auth_uid='${USER}';
      SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${original}','voluntary');
      COMMIT;`);
    const receipt = boundCashout(original);
    expect(receipt.stack).toBe(25);
    expect(ownRequest).toThrow(/Engine authority required/);
    expect(boundCashout(original)).toEqual(receipt);
    expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
  });
  it.each(['user_id', 'table_id', 'seat_number'])('renews occupancy when %s changes', (column) => {
    const original = seedOccupancy();
    sql(
      `UPDATE table_seats SET ${column}=${column === 'seat_number' ? '3' : "'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'"}`
    );
    expect(sql('SELECT to_json(occupancy_id) FROM table_seats')).not.toBe(original);
  });
  it('ignores a caller-selected occupancy on insert', () => {
    seedOccupancy();
    sql(`DELETE FROM table_seats;
      INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,club_id,occupancy_id)
      VALUES(gen_random_uuid(),'${TABLE}','${USER}',2,25,now(),'${CLUB}',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')`);
    expect(sql('SELECT to_json(occupancy_id) FROM table_seats')).not.toBe(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    );
  });
  it.each([0, 25])(
    'concurrent identical requests return one durable outcome for stack %s',
    async (stack) => {
      const original = seedOccupancy(stack);
      const request = () =>
        new Promise<any>((resolve, reject) => {
          const child = spawn(process.env.CA_DEPARTURE_PSQL!, [
            '-X',
            '-qAt',
            '-v',
            'ON_ERROR_STOP=1',
            '-h',
            host!,
            '-p',
            '55443',
            '-U',
            'departure_test',
            '-d',
            'postgres',
            '-c',
            `SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${original}',NULL)`,
          ]);
          let output = '';
          let error = '';
          child.stdout.on('data', (data) => {
            output += String(data);
          });
          child.stderr.on('data', (data) => {
            error += String(data);
          });
          child.once('error', reject);
          child.once('exit', (code) => {
            if (code !== 0) reject(new Error(error));
            else {
              try {
                resolve(JSON.parse(output.trim()));
              } catch (error) {
                reject(error);
              }
            }
          });
        });
      const outcomes = await Promise.all([request(), request()]);
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(outcomes[0]).toMatchObject({ occupancy_id: original, stack });
      expect(snapshot()).toEqual({
        balance: 100 + stack,
        active: 0,
        credits: stack ? 1 : 0,
        keys: stack ? 1 : 0,
        closes: 1,
      });
      expect(sql('SELECT count(*)::integer FROM seat_cashout_receipts')).toBe(1);
    }
  );
  const occupancyMigration = () =>
    readFileSync(
      resolve(
        process.cwd(),
        '../supabase/migrations/20260908220604_bind_cashout_requests_to_seat_occupancy.sql'
      ),
      'utf8'
    );
  it.each(['legacy', 'same_timestamp', 'malformed'])(
    'refuses migration across active prior credit evidence: %s',
    (kind) => {
      seedOccupancy();
      const suffix =
        kind === 'legacy'
          ? "''"
          : kind === 'same_timestamp'
            ? "':'||joined_at::text"
            : "':invalid-time'";
      sql(`INSERT INTO wallet_credit_idempotency(key,user_id,amount)
      SELECT 'cashout:'||id::text||${suffix},user_id,25 FROM table_seats`);
      expect(() => sql(occupancyMigration())).toThrow(/Active occupancy has legacy cashout credit/);
      expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 1, closes: 0 });
    }
  );
  it('replays the complete migration with committed receipts and unrelated key formats', () => {
    const original = seedOccupancy();
    const receipt = boundCashout(original);
    sql(`INSERT INTO wallet_credit_idempotency VALUES('not:a:timestamp','${USER}',1)`);
    sql(occupancyMigration());
    expect(boundCashout(original)).toEqual(receipt);
    expect(sql('SELECT count(*)::integer FROM wallet_transactions')).toBe(1);
  });
  it('looks up an original receipt without touching the live seat', () => {
    const original = seedOccupancy();
    const lookup = () =>
      sql(`SELECT fn_get_seat_cashout_receipt('${USER}','${TABLE}',2,'${original}')`);
    // psql renders SQL NULL as empty output; the transport represents it as data:null.
    expect(lookup()).toBeUndefined();
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    const receipt = boundCashout(original);
    expect(lookup()).toEqual(receipt);
    expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
  });
  it('refuses receipt lookup with a different owner or seat', () => {
    const original = seedOccupancy();
    boundCashout(original);
    expect(() =>
      sql(`SELECT fn_get_seat_cashout_receipt(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${TABLE}',2,'${original}')`)
    ).toThrow(/CASHOUT_OCCUPANCY_SCOPE_MISMATCH/);
    expect(() =>
      sql(`SELECT fn_get_seat_cashout_receipt('${USER}','${TABLE}',3,'${original}')`)
    ).toThrow(/CASHOUT_OCCUPANCY_SCOPE_MISMATCH/);
  });
  it('requires engine authority for the HTTP receipt lookup even when the owner is known', () => {
    const original = seedOccupancy();
    boundCashout(original);
    expect(() =>
      sql(`BEGIN; SET LOCAL test.is_engine='false';
      SET LOCAL test.auth_uid='${USER}';
      SELECT fn_get_seat_cashout_receipt('${USER}','${TABLE}',2,'${original}'); COMMIT;`)
    ).toThrow(/Engine authority required/);
  });
  it.each([0, 25])(
    'an older engine cashout creates a replayable occupancy receipt for %s',
    (stack) => {
      const original = seedOccupancy(stack);
      const first = sql(`SELECT atomic_seat_cashout_locked('${USER}','${TABLE}',2,'forced')`);
      expect(first).toMatchObject({
        ok: true,
        stack,
        occupancy_id: original,
        user_id: USER,
        table_id: TABLE,
      });
      // The next client/engine version may only know the durable occupancy.
      expect(boundCashout(original)).toEqual(first);
      expect(snapshot()).toEqual({
        balance: 100 + stack,
        active: 0,
        credits: stack > 0 ? 1 : 0,
        keys: stack > 0 ? 1 : 0,
        closes: 1,
      });
      expect(sql('SELECT to_json(count(*)) FROM seat_cashout_receipts')).toBe(1);
    }
  );
  it.each([0, 25])('table close records the original receipt for a %s stack', (stack) => {
    const original = seedOccupancy(stack);
    const result = sql(`SELECT fn_cashout_seats_for_closing_table('${TABLE}','test close')`);
    expect(result).toMatchObject({
      ok: true,
      players_paid: stack > 0 ? 1 : 0,
      chips_returned: stack,
    });
    expect(snapshot()).toEqual({
      balance: 100 + stack,
      active: 0,
      credits: stack > 0 ? 1 : 0,
      keys: stack > 0 ? 1 : 0,
      closes: 1,
    });
    expect(boundCashout(original)).toMatchObject({ stack, occupancy_id: original });
    expect(sql(`SELECT fn_cashout_seats_for_closing_table('${TABLE}','repeat')`)).toMatchObject({
      ok: true,
      players_paid: 0,
      chips_returned: 0,
    });
  });
  it('table close cannot skip a positive stack whose home club is missing', () => {
    seedOccupancy();
    sql('UPDATE table_seats SET club_id=NULL');
    const before = snapshot();
    expect(() =>
      sql(`SELECT fn_cashout_seats_for_closing_table('${TABLE}','test close')`)
    ).toThrow();
    expect(snapshot()).toEqual(before);
    expect(sql('SELECT to_json(count(*)) FROM seat_cashout_receipts')).toBe(0);
  });
  it('a later invalid occupancy rolls back every earlier payout in the same close', () => {
    seedOccupancy();
    sql(`INSERT INTO club_members VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${CLUB}',100,NULL);
      INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,club_id)
      VALUES(gen_random_uuid(),'${TABLE}','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',3,-1,now(),'${CLUB}')`);
    expect(() =>
      sql(`SELECT fn_cashout_seats_for_closing_table('${TABLE}','test close')`)
    ).toThrow();
    expect(
      sql(`SELECT json_build_object('balance',(SELECT sum(chip_balance) FROM club_members),
      'active',(SELECT count(*) FROM table_seats WHERE left_at IS NULL),
      'credits',(SELECT count(*) FROM wallet_transactions),
      'receipts',(SELECT count(*) FROM seat_cashout_receipts),
      'closes',(SELECT count(*) FROM session_closes))`)
    ).toEqual({ balance: 200, active: 2, credits: 0, receipts: 0, closes: 0 });
  });
  it('the actual close trigger propagates payout failure and rolls back the status change', () => {
    seedOccupancy();
    sql(`CREATE TRIGGER test_table_close AFTER UPDATE OF status ON tables
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status='closed')
      EXECUTE FUNCTION trg_auto_cashout_on_table_close()`);
    try {
      expect(() =>
        sql(`BEGIN; SET LOCAL test.reject_exit='on';
        UPDATE tables SET status='closed'; COMMIT;`)
      ).toThrow(/injected seat exit failure/);
      expect(sql('SELECT to_json(status) FROM tables')).toBe('waiting');
      expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
      sql("UPDATE tables SET status='closed'");
      expect(sql('SELECT to_json(status) FROM tables')).toBe('closed');
      expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
    } finally {
      sql('DROP TRIGGER test_table_close ON tables');
    }
  });
  it.each(['voluntary', 'forced'])('rejects direct owner %s cashout before any write', (mode) => {
    const original = seedOccupancy();
    expect(() =>
      sql(`BEGIN; SET LOCAL test.is_engine='false';
      SET LOCAL test.auth_uid='${USER}';
      SET LOCAL app.cash_exit_authority='club_admin';
      SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${original}','${mode}'); COMMIT;`)
    ).toThrow(/Engine authority required/);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    expect(sql('SELECT to_json(count(*)) FROM seat_cashout_receipts')).toBe(0);
  });
  it('grants the bound financial cashout only to the service role', () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(
        sql(`SELECT to_json(has_function_privilege('${role}',
        'public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)','EXECUTE'))`)
      ).toBe(role === 'service_role');
    }
  });
  it('cannot confirm cashout when the destination club wallet no longer exists', () => {
    const original = seedOccupancy();
    sql('DELETE FROM club_members');
    expect(() => boundCashout(original)).toThrow(/CLUB_CREDIT_DESTINATION_MISSING/);
    expect(
      sql(`SELECT json_build_object(
      'active',(SELECT count(*) FROM table_seats WHERE left_at IS NULL),
      'credits',(SELECT count(*) FROM wallet_transactions),
      'keys',(SELECT count(*) FROM wallet_credit_idempotency),
      'receipts',(SELECT count(*) FROM seat_cashout_receipts),
      'closes',(SELECT count(*) FROM session_closes))`)
    ).toEqual({ active: 1, credits: 0, keys: 0, receipts: 0, closes: 0 });
  });
  it.each(['rakeback', 'tournament_prize', 'refund'])(
    'a missing club destination also refuses %s credits atomically',
    (category) => {
      seedOccupancy();
      sql('DELETE FROM club_members');
      expect(() =>
        sql(`SELECT atomic_credit_wallet_and_log('${USER}',25,'${category}','test',
      '${TABLE}',NULL,NULL,'missing-destination-test')`)
      ).toThrow(/CLUB_CREDIT_DESTINATION_MISSING/);
      expect(
        sql(`SELECT json_build_object(
      'stack',(SELECT stack FROM table_seats),
      'keys',(SELECT count(*) FROM wallet_credit_idempotency),
      'wallet_entries',(SELECT count(*) FROM wallet_transactions),
      'chip_entries',(SELECT count(*) FROM chip_transactions))`)
      ).toEqual({ stack: 25, keys: 0, wallet_entries: 0, chip_entries: 0 });
    }
  );
  it('no application role can invoke the retired SQL admin kick', () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(
        sql(`SELECT to_json(has_function_privilege('${role}',
        'public.fn_admin_kick_player(uuid,uuid,text)','EXECUTE'))`)
      ).toBe(false);
    }
  });
  it('a real authenticated role cannot enter canonical cashout after retirement', () => {
    seedOccupancy();
    expect(() =>
      sql(`BEGIN; SET LOCAL ROLE authenticated;
      SELECT public.atomic_seat_cashout_locked('${USER}','${TABLE}',2,'voluntary'); COMMIT;`)
    ).toThrow(/permission denied for function atomic_seat_cashout_locked/);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  it('grants the receipt lookup only to the service role', () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(
        sql(`SELECT to_json(has_function_privilege('${role}',
        'public.fn_get_seat_cashout_receipt(uuid,uuid,integer,uuid)','EXECUTE'))`)
      ).toBe(role === 'service_role');
    }
  });
  it('keeps occupancy stable for stack updates and refuses caller-chosen replacements', () => {
    const original = seedOccupancy();
    sql('UPDATE table_seats SET stack=30');
    expect(sql('SELECT to_json(occupancy_id) FROM table_seats')).toBe(original);
    expect(() => sql('UPDATE table_seats SET occupancy_id=gen_random_uuid()')).toThrow(
      /SEAT_OCCUPANCY_IMMUTABLE/
    );
    expect(sql('SELECT to_json(occupancy_id) FROM table_seats')).toBe(original);
  });
  it.each(['user', 'tournament'] as const)(
    'seat expiry waits for the %s lock without already owning the seat lock',
    async (scope) => {
      sql(`INSERT INTO tournaments VALUES('${TABLE}');
      INSERT INTO tables VALUES('${TABLE}',${scope === 'tournament' ? `'${TABLE}'` : 'NULL'},1);
      INSERT INTO club_members VALUES('${USER}','${CLUB}',100,NULL);
      INSERT INTO table_seats VALUES(gen_random_uuid(),'${TABLE}','${USER}',2,
      25,now(),NULL,false,'${CLUB}')`);
      // sql() above validates the disposable database before any child connection.
      const args = [
        '-X',
        '-qAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        host!,
        '-p',
        '55443',
        '-U',
        'departure_test',
        '-d',
        'postgres',
      ];
      const holder = spawn(process.env.CA_DEPARTURE_PSQL!, args);
      let holderOutput = '';
      holder.stdout.on('data', (data) => {
        holderOutput += String(data);
      });
      let expiry: ReturnType<typeof spawn> | undefined;
      let expiryError = '';
      let expiryDone: Promise<number | null> | undefined;
      const holderDone = new Promise<number | null>((resolve) => holder.once('exit', resolve));
      const until = async (ready: () => boolean) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (ready()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('Concurrent PostgreSQL connection did not reach its barrier');
      };
      try {
        holder.stdin.write(`BEGIN;
        ${
          scope === 'user'
            ? `SELECT pg_advisory_xact_lock(hashtextextended('table_cap:${USER}',0));`
            : `SELECT id FROM tournaments WHERE id='${TABLE}' FOR NO KEY UPDATE;`
        }
        SELECT 'scope_locked';
`);
        await until(() => holderOutput.includes('scope_locked'));
        expiry = spawn(process.env.CA_DEPARTURE_PSQL!, args);
        expiry.stderr!.on('data', (data) => {
          expiryError += String(data);
        });
        expiryDone = new Promise<number | null>((resolve) => expiry!.once('exit', resolve));
        expiry.stdin!.end(`SET application_name='ca-departure-expiry';
        SELECT player_leave_table('${TABLE}','${USER}');
`);
        await until(
          () =>
            sql(`SELECT to_json(EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE application_name='ca-departure-expiry'
          AND wait_event='${scope === 'user' ? 'advisory' : 'transactionid'}'))`) === true
        );
        // A third transaction must still be able to lock the seat NOWAIT.
        // Before correction this throws: expiry already holds the seat while
        // waiting for the user lock, the inverse of a concurrent buy-in.
        expect(() =>
          sql(`BEGIN;
        SELECT to_json(id) FROM table_seats WHERE table_id='${TABLE}' FOR UPDATE NOWAIT;
        ROLLBACK;`)
        ).not.toThrow();
      } finally {
        holder.stdin.end(`ROLLBACK;
`);
        await holderDone;
        if (expiryDone) {
          const result = await expiryDone;
          expect(result, expiryError).toBe(0);
        }
      }
      expect(snapshot()).toEqual(
        scope === 'user'
          ? { balance: 125, active: 0, credits: 1, keys: 1, closes: 1 }
          : { balance: 100, active: 0, credits: 0, keys: 0, closes: 0 }
      );
    }
  );
  it('keeps seat expiry available only to the service role', () => {
    expect(
      sql(`SELECT json_build_object(
      'anon',has_function_privilege('anon','public.player_leave_table(uuid,uuid)','EXECUTE'),
      'authenticated',has_function_privilege('authenticated','public.player_leave_table(uuid,uuid)','EXECUTE'),
      'service_role',has_function_privilege('service_role','public.player_leave_table(uuid,uuid)','EXECUTE'))`)
    ).toEqual({ anon: false, authenticated: false, service_role: true });
  });
  it('keeps anonymous cashout forbidden and authorized roles executable', () => {
    expect(
      sql(`SELECT json_build_object(
      'anon',has_function_privilege('anon','public.atomic_seat_cashout_locked(uuid,uuid,integer,text)','EXECUTE'),
      'authenticated',has_function_privilege('authenticated','public.atomic_seat_cashout_locked(uuid,uuid,integer,text)','EXECUTE'),
      'service_role',has_function_privilege('service_role','public.atomic_seat_cashout_locked(uuid,uuid,integer,text)','EXECUTE'))`)
    ).toEqual({ anon: false, authenticated: false, service_role: true });
  });
  it.each([
    'NULL',
    '-1',
    '0.001',
    '25.001',
    "'NaN'::numeric",
    "'Infinity'::numeric",
    "'-Infinity'::numeric",
  ])('rejects invalid cash stack %s before credit, seat exit or session close', (invalidStack) => {
    sql(`INSERT INTO tables VALUES('${TABLE}',NULL,1);
        INSERT INTO club_members VALUES('${USER}','${CLUB}',100,NULL);
        INSERT INTO table_seats VALUES(gen_random_uuid(),'${TABLE}','${USER}',2,
        ${invalidStack},now(),NULL,false,'${CLUB}')`);
    expect(() => sql(`SELECT atomic_seat_cashout_locked('${USER}','${TABLE}',2,NULL)`)).toThrow(
      /CASHOUT_INVALID_STACK/
    );
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  it('refuses a missing table context without consuming an orphaned seat', () => {
    sql(`INSERT INTO club_members VALUES('${USER}','${CLUB}',100,NULL);
      INSERT INTO table_seats VALUES(gen_random_uuid(),'${TABLE}','${USER}',2,
      25,now(),NULL,false,'${CLUB}')`);
    expect(() => sql(`SELECT atomic_seat_cashout_locked('${USER}','${TABLE}',2,NULL)`)).toThrow(
      /CASHOUT_TABLE_NOT_FOUND/
    );
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  for (const path of ['eviction', 'busted'] as const) {
    it.each(['normal', 'lost_after_commit', 'rollback'] as const)(
      `${path}: %s retains or releases the seat according to the database outcome`,
      async (failure) => {
        const stack = path === 'busted' ? 0 : 25;
        sql(`INSERT INTO tables VALUES('${TABLE}',NULL,1);
          INSERT INTO club_members VALUES('${USER}','${CLUB}',100,NULL);
          INSERT INTO table_seats VALUES(gen_random_uuid(),'${TABLE}','${USER}',2,
          ${stack},now(),NULL,false,'${CLUB}')`);
        const occupancyId = sql(
          `SELECT to_json(occupancy_id) FROM table_seats WHERE table_id='${TABLE}'`
        );
        let first = true;
        transport.rpc.mockImplementation(async (name: string, args: any) => {
          if (name === 'fn_offer_open_seat')
            return { data: { ok: false, reason: 'nobody_waiting' }, error: null };
          expect(name).toBe('fn_cashout_seat_occupancy');
          expect(args.p_occupancy_id).toBe(occupancyId);
          expect(args.p_table_id).toBe(TABLE);
          expect(args.p_user_id).toBe(USER);
          expect(args.p_seat_number).toBe(2);
          const injected = first ? failure : 'normal';
          first = false;
          try {
            const data = sql(`BEGIN;
              SET LOCAL test.reject_exit = '${injected === 'rollback' ? 'on' : 'off'}';
              SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${occupancyId}',NULL);
              COMMIT;`);
            if (injected === 'lost_after_commit')
              return { data: null, error: { message: 'response lost after actual commit' } };
            return { data, error: null };
          } catch (error: any) {
            return { data: null, error: { message: error.message } };
          }
        });
        const e = new ServerTableEngine(TABLE) as any;
        e.tableInfo = { tournament_id: null, nit_game: false };
        e.seatedPlayers = [{ user_id: USER, seat_number: 2, stack, occupancy_id: occupancyId }];
        e.handController = null;
        e.disconnectEngine = {
          tickSitOutsAndCollectEvictions: () => [USER],
          collectAwayBlindEvictions: () => [],
          collectAbandonedSeatEvictions: () => [],
          unregisterPlayer: vi.fn(),
        };
        for (const name of ['timeBankEngine', 'straddleEngine', 'preActionEngine'])
          e[name] = { removePlayer: vi.fn() };
        e.chipContinuity = { forget: vi.fn() };
        e.hub = { emitEvent: vi.fn() };
        e.bustedSince = new Map([[USER, Date.now() - 3600000]]);
        e.rebuyPromptOpenAt = new Map();
        e.pendingAddOns = new Map();
        e.usersWithPendingLedgerChips = vi.fn().mockResolvedValue(new Set());
        const sweep = () =>
          path === 'busted'
            ? e.standUpBustedCashPlayers()
            : e.evictExpiredSitOuts({ countOrbit: false });
        try {
          await sweep();
          if (failure !== 'normal') {
            expect(e.seatedPlayers).toHaveLength(1);
            expect(e.hub.emitEvent).not.toHaveBeenCalled();
            expect(e.chipContinuity.forget).not.toHaveBeenCalled();
            if (failure === 'rollback')
              expect(snapshot()).toEqual({
                balance: 100,
                active: 1,
                credits: 0,
                keys: 0,
                closes: 0,
              });
            else
              expect(snapshot()).toEqual({
                balance: 100 + stack,
                active: 0,
                credits: stack ? 1 : 0,
                keys: stack ? 1 : 0,
                closes: 1,
              });
            await sweep();
          }
          expect(e.seatedPlayers).toHaveLength(0);
          expect(e.hub.emitEvent).toHaveBeenCalledOnce();
          expect(e.disconnectEngine.unregisterPlayer).toHaveBeenCalledOnce();
          expect(e.chipContinuity.forget).toHaveBeenCalledOnce();
          expect(snapshot()).toEqual({
            balance: 100 + stack,
            active: 0,
            credits: stack ? 1 : 0,
            keys: stack ? 1 : 0,
            closes: 1,
          });
          await sweep();
          expect(e.hub.emitEvent).toHaveBeenCalledOnce();
        } finally {
          e.preciseTimer.dispose();
        }
      }
    );
  }
});
