import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
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
      'TRUNCATE tournaments,tables,table_seats,club_members,wallets,wallet_transactions,chip_transactions,wallet_credit_idempotency,session_closes'
    );
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
    ).toEqual({ anon: false, authenticated: true, service_role: true });
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
        let first = true;
        transport.rpc.mockImplementation(async (name: string, args: any) => {
          if (name === 'fn_offer_open_seat')
            return { data: { ok: false, reason: 'nobody_waiting' }, error: null };
          expect(name).toBe('atomic_seat_cashout_locked');
          expect(args.p_table_id).toBe(TABLE);
          expect(args.p_user_id).toBe(USER);
          expect(args.p_seat_number).toBe(2);
          const injected = first ? failure : 'normal';
          first = false;
          try {
            const data = sql(`BEGIN;
              SET LOCAL test.reject_exit = '${injected === 'rollback' ? 'on' : 'off'}';
              SELECT atomic_seat_cashout_locked('${USER}','${TABLE}',2,NULL);
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
        e.seatedPlayers = [{ user_id: USER, seat_number: 2, stack }];
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
