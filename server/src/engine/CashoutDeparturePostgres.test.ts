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
      'TRUNCATE table_waitlist,cash_game_waitlist,cash_seat_move_receipts,cash_seat_moves,cash_player_session,cash_cluster_events,cash_games,seat_admin_departure_authorizations,anti_cheat_events,profiles,seat_departure_requests,seat_cashout_receipts,tournaments,tables,table_seats,club_members,wallets,wallet_transactions,chip_transactions,wallet_credit_idempotency,session_closes'
    );
  });

  const seedOccupancy = (stack = 25, tournament = false) => {
    if (tournament) sql(`INSERT INTO tournaments VALUES('${CLUB}')`);
    sql(`INSERT INTO profiles VALUES('${USER}');
      INSERT INTO tables(id,tournament_id,current_players) VALUES('${TABLE}',${tournament ? "'" + CLUB + "'" : 'NULL'},1);
      INSERT INTO club_members VALUES('${USER}','${CLUB}',100,NULL);
      INSERT INTO table_seats VALUES(gen_random_uuid(),'${TABLE}','${USER}',2,
      ${stack},now(),NULL,false,'${CLUB}')`);
    return sql('SELECT to_json(occupancy_id) FROM table_seats') as string;
  };

  const GAME = '11111111-1111-4111-8111-111111111111';
  const OTHER_TABLE = '22222222-2222-4222-8222-222222222222';
  const seedGame = () => {
    seedOccupancy();
    sql(`UPDATE tables SET cluster_id='${GAME}';
      INSERT INTO tables(id,cluster_id,current_players) VALUES('${OTHER_TABLE}','${GAME}',0)`);
  };

  const MOVE = '66666666-6666-4666-8666-666666666666';
  const PARTNER_MOVE = '77777777-7777-4777-8777-777777777777';
  const PARTNER_USER = '88888888-8888-4888-8888-888888888888';
  const planMove = (id = MOVE, user = USER, from = TABLE, to = OTHER_TABLE) =>
    sql(`INSERT INTO cash_seat_moves(id,game_id,player_id,from_table_id,to_table_id,reason,expires_at)
      VALUES('${id}','${GAME}','${user}','${from}','${to}','seat_change',now()+interval '5 minutes')`);
  const seedMove = () => {
    seedGame();
    sql(`INSERT INTO cash_games(id) VALUES('${GAME}');
      INSERT INTO cash_player_session VALUES('${USER}','table','${TABLE}','${TABLE}',NULL)`);
    planMove();
  };
  const seedSwap = () => {
    seedMove();
    sql(`INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,club_id,is_sitting_out,sit_out_at)
      VALUES(gen_random_uuid(),'${OTHER_TABLE}','${PARTNER_USER}',3,70,now(),'${CLUB}',true,'2026-09-01')`);
    planMove(PARTNER_MOVE, PARTNER_USER, OTHER_TABLE, TABLE);
    sql(
      `UPDATE cash_seat_moves SET swap_move_id=CASE WHEN id='${MOVE}' THEN '${PARTNER_MOVE}'::uuid ELSE '${MOVE}'::uuid END `
    );
  };
  const move = (id = MOVE) => sql(`SELECT fn_cash_seat_move_execute('${id}')`);
  const arrivals = (tableId: string, occupancyId: string) =>
    sql(`SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      FROM fn_cash_seat_move_arrivals('${tableId}', ARRAY['${occupancyId}'::uuid]) r`);

  it('reads exact arrival provenance without changing seats, receipts or chips', () => {
    seedMove();
    const result = move();
    const before = snapshot();
    expect(arrivals(OTHER_TABLE, result.destination_occupancy_id)).toEqual([
      {
        move_id: MOVE,
        player_id: USER,
        from_table_id: TABLE,
        to_table_id: OTHER_TABLE,
        source_occupancy_id: result.source_occupancy_id,
        destination_occupancy_id: result.destination_occupancy_id,
      },
    ]);
    expect(arrivals(TABLE, result.destination_occupancy_id)).toEqual([]);
    expect(arrivals(OTHER_TABLE, result.source_occupancy_id)).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(1);
  });

  it('cannot attach a prior transfer receipt to a later voluntary stay', () => {
    seedMove();
    const result = move();
    sql(`UPDATE table_seats SET left_at=now() WHERE table_id='${OTHER_TABLE}' AND user_id='${USER}';
      UPDATE table_seats SET left_at=NULL WHERE table_id='${OTHER_TABLE}' AND user_id='${USER}'`);
    const replacement = sql(`SELECT to_json(occupancy_id) FROM table_seats
      WHERE table_id='${OTHER_TABLE}' AND user_id='${USER}' AND left_at IS NULL`);
    expect(replacement).not.toBe(result.destination_occupancy_id);
    expect(arrivals(OTHER_TABLE, result.destination_occupancy_id)).toEqual([]);
    expect(arrivals(OTHER_TABLE, replacement)).toEqual([]);
  });

  it('has no arrival receipt for a cancelled plan', () => {
    seedMove();
    sql(`UPDATE cash_seat_moves SET state='cancelled' WHERE id='${MOVE}'`);
    const original = sql(`SELECT to_json(occupancy_id) FROM table_seats WHERE user_id='${USER}'`);
    expect(arrivals(OTHER_TABLE, original)).toEqual([]);
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
  });

  it('proves both swap arrivals only after the shared transfer commits', () => {
    seedSwap();
    const original = sql(`SELECT to_json(occupancy_id) FROM table_seats WHERE user_id='${USER}'`);
    expect(move()).toMatchObject({ held: true });
    expect(arrivals(OTHER_TABLE, original)).toEqual([]);
    const partner = move(PARTNER_MOVE);
    const first = move();
    expect(arrivals(OTHER_TABLE, first.destination_occupancy_id)[0].move_id).toBe(MOVE);
    expect(arrivals(TABLE, partner.destination_occupancy_id)[0].move_id).toBe(PARTNER_MOVE);
  });

  it('keeps arrival history engine-only and bounds its input', () => {
    expect(
      sql(`SELECT jsonb_build_array(
      has_function_privilege('anon','public.fn_cash_seat_move_arrivals(uuid,uuid[])','EXECUTE'),
      has_function_privilege('authenticated','public.fn_cash_seat_move_arrivals(uuid,uuid[])','EXECUTE'),
      has_function_privilege('service_role','public.fn_cash_seat_move_arrivals(uuid,uuid[])','EXECUTE'))`)
    ).toEqual([false, false, true]);
    expect(() =>
      sql(`SET test.is_engine='false';
      SELECT count(*) FROM fn_cash_seat_move_arrivals('${TABLE}',ARRAY[]::uuid[])`)
    ).toThrow(/ENGINE_ONLY/);
    expect(() => sql(`SELECT count(*) FROM fn_cash_seat_move_arrivals('${TABLE}',NULL)`)).toThrow(
      /INVALID_SEAT_MOVE_ARRIVAL_SCOPE/
    );
    expect(() =>
      sql(`SELECT count(*) FROM fn_cash_seat_move_arrivals('${TABLE}',ARRAY[NULL]::uuid[])`)
    ).toThrow(/INVALID_SEAT_MOVE_ARRIVAL_SCOPE/);
    expect(() =>
      sql(
        `SELECT count(*) FROM fn_cash_seat_move_arrivals('${TABLE}',array_fill('${USER}'::uuid,ARRAY[65]))`
      )
    ).toThrow(/INVALID_SEAT_MOVE_ARRIVAL_SCOPE/);
  });
  it('binds a move to its original stay and rejects identity changes', () => {
    seedMove();
    expect(sql('SELECT to_json(source_occupancy_id) FROM cash_seat_moves')).toEqual(
      sql('SELECT to_json(occupancy_id) FROM table_seats')
    );
    expect(() => sql(`UPDATE cash_seat_moves SET source_occupancy_id='${PARTNER_MOVE}'`)).toThrow(
      /SEAT_MOVE_IDENTITY_IMMUTABLE/
    );
    expect(() => sql(`UPDATE cash_seat_moves SET to_table_id='${CLUB}'`)).toThrow(
      /SEAT_MOVE_IDENTITY_IMMUTABLE/
    );
  });
  it('moves exact chips and session scope with an intrinsically balanced retained journal', () => {
    seedMove();
    const result = move();
    expect(result).toMatchObject({
      ok: true,
      stack: 25,
      move_id: MOVE,
      player_id: USER,
      from_table_id: TABLE,
      to_table_id: OTHER_TABLE,
      idempotency_key: 'seatmove:' + MOVE,
    });
    expect(result.source_occupancy_id).not.toBe(result.destination_occupancy_id);
    expect(sql('SELECT sum(amount) FROM cash_seat_move_ledger')).toBe(0);
    expect(sql('SELECT count(*) FROM cash_seat_move_ledger')).toBe(2);
    expect(sql('SELECT sum(stack) FROM table_seats WHERE left_at IS NULL')).toBe(25);
    expect(sql('SELECT chip_balance FROM club_members')).toBe(100);
    expect(sql('SELECT count(*) FROM wallet_transactions')).toBe(0);
    expect(sql('SELECT to_json(table_id) FROM cash_player_session')).toBe(OTHER_TABLE);
    expect(move()).toEqual(result);
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(1);
  });
  it.each(['waiting', 'closed'])(
    'handles a legacy empty %s destination without inventing its admission key',
    (status) => {
      seedMove();
      // Fixture only: represent an empty parent created before the additive keys.
      sql(`BEGIN;
      ALTER TABLE tables DISABLE TRIGGER zzzz_stamp_table_seat_admission;
      UPDATE tables SET status='${status}',seat_admission_key=NULL WHERE id='${OTHER_TABLE}';
      ALTER TABLE tables ENABLE TRIGGER zzzz_stamp_table_seat_admission;
      COMMIT;`);
      if (status === 'closed') {
        expect(move()).toMatchObject({ ok: false });
        expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
        expect(
          sql(`SELECT sum(stack) FROM table_seats WHERE table_id='${TABLE}' AND left_at IS NULL`)
        ).toBe(25);
      } else {
        expect(move()).toMatchObject({ ok: true, stack: 25, to_table_id: OTHER_TABLE });
        expect(sql('SELECT sum(amount) FROM cash_seat_move_ledger')).toBe(0);
        expect(
          sql(`SELECT to_json(seat_admission_key) FROM tables WHERE id='${OTHER_TABLE}'`)
        ).toBe('cash');
      }
    }
  );

  it('retains the original move outcome after seat and table deletion', () => {
    seedMove();
    const result = move();
    sql('DELETE FROM table_seats; DELETE FROM tables; DELETE FROM cash_seat_moves');
    expect(move()).toEqual(result);
    expect(sql('SELECT sum(amount) FROM cash_seat_move_ledger')).toBe(0);
  });
  it('refuses an old plan after the same player rejoins the source chair', () => {
    seedMove();
    const original = sql('SELECT to_json(occupancy_id) FROM table_seats') as string;
    sql(`SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${original}',NULL)`);
    sql('UPDATE table_seats SET left_at=NULL,stack=40');
    expect(move()).toMatchObject({ ok: false, reason: 'original_occupancy_gone' });
    expect(sql('SELECT sum(stack) FROM table_seats WHERE left_at IS NULL')).toBe(40);
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
  });
  it('keeps an expired move from transferring chips', () => {
    seedMove();
    sql("UPDATE cash_seat_moves SET expires_at=now()-interval '1 second'");
    expect(move()).toMatchObject({ ok: false, reason: 'expired' });
    expect(sql('SELECT sum(stack) FROM table_seats WHERE left_at IS NULL')).toBe(25);
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
  });
  it('refuses cross-game destination changes before any movement', () => {
    seedMove();
    sql(`UPDATE tables SET cluster_id='${CLUB}' WHERE id='${OTHER_TABLE}'`);
    expect(() => move()).toThrow(/SEAT_MOVE_GAME_SCOPE_MISMATCH/);
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
    expect(sql('SELECT to_json(state) FROM cash_seat_moves')).toBe('pending');
  });
  it('swaps only after both original sides are ready and journals both outcomes', () => {
    seedSwap();
    expect(move()).toMatchObject({ ok: false, reason: 'waiting_partner', held: true });
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
    const second = move(PARTNER_MOVE);
    expect(second).toMatchObject({ ok: true, swap: true, stack: 70 });
    const first = move();
    expect(first).toMatchObject({ ok: true, swap: true, stack: 25, player_id: USER });
    expect(move(PARTNER_MOVE)).toEqual(second);
    expect(first.partner.source_occupancy_id).toBe(second.source_occupancy_id);
    expect(sql('SELECT count(*) FROM cash_seat_move_ledger')).toBe(4);
    expect(sql('SELECT sum(amount) FROM cash_seat_move_ledger')).toBe(0);
    expect(sql('SELECT sum(stack) FROM table_seats WHERE left_at IS NULL')).toBe(95);
    expect(
      sql(`SELECT to_json(is_sitting_out) FROM table_seats WHERE user_id='${PARTNER_USER}'`)
    ).toBe(true);
    expect(sql('SELECT count(*) FROM wallet_transactions')).toBe(0);
  });
  it('cancels a swap if the waiting partner is now a different occupancy', () => {
    seedSwap();
    move();
    sql(`UPDATE table_seats SET left_at=now() WHERE user_id='${USER}';
      UPDATE table_seats SET left_at=NULL,stack=45 WHERE user_id='${USER}'`);
    expect(move(PARTNER_MOVE)).toMatchObject({ ok: false, reason: 'original_occupancy_gone' });
    expect(sql("SELECT count(*) FROM cash_seat_moves WHERE state='cancelled'")).toBe(2);
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
  });
  it('rolls back chips, session and plan if the retained outcome cannot be written', () => {
    seedMove();
    sql(`CREATE FUNCTION reject_move_receipt() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'injected move receipt failure'; END $fn$;
      CREATE TRIGGER reject_move_receipt BEFORE INSERT ON cash_seat_move_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_move_receipt()`);
    try {
      expect(() => move()).toThrow(/injected move receipt failure/);
      expect(
        sql(`SELECT sum(stack) FROM table_seats WHERE table_id='${TABLE}' AND left_at IS NULL`)
      ).toBe(25);
      expect(sql('SELECT to_json(table_id) FROM cash_player_session')).toBe(TABLE);
      expect(sql('SELECT to_json(state) FROM cash_seat_moves')).toBe('pending');
      expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
    } finally {
      sql(
        'DROP TRIGGER reject_move_receipt ON cash_seat_move_receipts; DROP FUNCTION reject_move_receipt()'
      );
    }
  });
  it('rolls back an unexpected destination stack mutation instead of recording a false transfer', () => {
    seedMove();
    sql(`CREATE FUNCTION corrupt_move_destination() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN IF NEW.table_id='${OTHER_TABLE}' THEN NEW.stack:=NEW.stack+1; END IF; RETURN NEW; END $fn$;
      CREATE TRIGGER corrupt_move_destination BEFORE INSERT OR UPDATE ON table_seats
      FOR EACH ROW EXECUTE FUNCTION corrupt_move_destination()`);
    try {
      expect(() => move()).toThrow(/SEAT_MOVE_CONSERVATION_FAILED/);
      expect(sql('SELECT sum(stack) FROM table_seats WHERE left_at IS NULL')).toBe(25);
      expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
      expect(sql('SELECT to_json(state) FROM cash_seat_moves')).toBe('pending');
    } finally {
      sql(
        'DROP TRIGGER corrupt_move_destination ON table_seats; DROP FUNCTION corrupt_move_destination()'
      );
    }
  });
  it.each(['anon', 'authenticated'])('denies %s execution of moves and swaps', (role) => {
    seedMove();
    expect(() =>
      sql(`BEGIN; SET LOCAL ROLE ${role}; SELECT fn_cash_seat_move_execute('${MOVE}'); COMMIT;`)
    ).toThrow(/permission denied/);
    expect(() =>
      sql(`BEGIN; SET LOCAL ROLE ${role}; SELECT fn_cash_seat_swap_execute('${MOVE}'); COMMIT;`)
    ).toThrow(/permission denied/);
  });
  it('denies service-role direct mutation of retained transfer evidence', () => {
    seedMove();
    move();
    expect(() =>
      sql('BEGIN; SET LOCAL ROLE service_role; DELETE FROM cash_seat_move_receipts; COMMIT;')
    ).toThrow(/permission denied/);
    expect(() =>
      sql(`BEGIN; SET LOCAL ROLE service_role;
      SELECT fn_cash_seat_move_execute_before_maintenance_gate('${MOVE}'); COMMIT;`)
    ).toThrow(/permission denied/);
  });
  it('requires engine authority before reading a completed move', () => {
    seedMove();
    move();
    expect(() =>
      sql(
        `BEGIN; SET LOCAL test.is_engine='false'; SELECT fn_cash_seat_move_execute('${MOVE}'); COMMIT;`
      )
    ).toThrow(/Engine authority required/);
  });

  it.each(['NaN', 'Infinity', '25.001'])('does not journal invalid source amount %s', (amount) => {
    seedMove();
    sql(`UPDATE table_seats SET stack='${amount}'::numeric`);
    expect(() => move()).toThrow();
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(0);
    expect(sql('SELECT to_json(state) FROM cash_seat_moves')).toBe('pending');
  });
  it('returns the same retained result to concurrent duplicate move requests', async () => {
    seedMove();
    const results = await Promise.all(
      [1, 2].map(() =>
        concurrentSql(
          `BEGIN; SET LOCAL statement_timeout='5s'; SELECT fn_cash_seat_move_execute('${MOVE}'); COMMIT;`
        )
      )
    );
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(JSON.parse(results[0].output.trim())).toEqual(JSON.parse(results[1].output.trim()));
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(1);
    expect(sql('SELECT sum(amount) FROM cash_seat_move_ledger')).toBe(0);
  });
  it('does not deadlock when both swap sides reach the boundary concurrently', async () => {
    seedSwap();
    const results = await Promise.all(
      [MOVE, PARTNER_MOVE].map((id) =>
        concurrentSql(
          `BEGIN; SET LOCAL statement_timeout='5s'; SELECT fn_cash_seat_move_execute('${id}'); COMMIT;`
        )
      )
    );
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(2);
    expect(sql('SELECT sum(stack) FROM table_seats WHERE left_at IS NULL')).toBe(95);
    expect(move()).toMatchObject({ ok: true, stack: 25 });
    expect(move(PARTNER_MOVE)).toMatchObject({ ok: true, stack: 70 });
  });
  it.each(['cashout', 'move'] as const)(
    '%s commits first: original move and cashout cannot both spend a stay',
    async (first) => {
      seedMove();
      const original = sql('SELECT to_json(occupancy_id) FROM table_seats') as string;
      const departure = `SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${original}',NULL)`;
      const transfer = `SELECT fn_cash_seat_move_execute('${MOVE}')`;
      const holder = await holdingSql(first === 'cashout' ? departure : transfer);
      const contender = concurrentSql(`SET application_name='move_cashout_contender'; BEGIN;
      SET LOCAL statement_timeout='5s'; ${first === 'cashout' ? transfer : departure}; COMMIT;`);
      try {
        await waitForDatabaseLock('move_cashout_contender');
        expect((await holder.finish(true)).code).toBe(0);
        const result = await contender;
        if (first === 'cashout') {
          expect(result.code).toBe(0);
          expect(JSON.parse(result.output.trim())).toMatchObject({
            ok: false,
            reason: 'original_occupancy_gone',
          });
        } else {
          expect(result.code).not.toBe(0);
          expect(result.error).toMatch(/CASHOUT_STALE_OCCUPANCY/);
        }
        expect(
          sql(
            'SELECT coalesce(sum(stack),0)+(SELECT chip_balance FROM club_members) FROM table_seats WHERE left_at IS NULL'
          )
        ).toBe(125);
        expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(first === 'move' ? 1 : 0);
        expect(sql('SELECT count(*) FROM wallet_transactions')).toBe(first === 'cashout' ? 1 : 0);
      } finally {
        await holder.finish(false);
        await contender;
      }
    }
  );
  it('the actual service recovers a lost committed response using only the original move', async () => {
    seedMove();
    const original = sql(
      `SELECT to_json(source_occupancy_id) FROM cash_seat_moves WHERE id='${MOVE}'`
    ) as string;
    const service = await import('../services/supabase/seatMoves.js');
    let calls = 0;
    transport.rpc.mockImplementation(async (name: string, args: { p_move_id: string }) => {
      expect(name).toBe('fn_cash_seat_move_execute');
      const data = move(args.p_move_id);
      calls++;
      return calls === 1
        ? { data: null, error: { message: 'response lost after commit' } }
        : { data, error: null };
    });
    const result = await service.executePendingSeatMoves(TABLE, { announcedOnly: false }, [
      {
        move_id: MOVE,
        player_id: USER,
        source_occupancy_id: original,
        to_table_id: OTHER_TABLE,
        to_table_name: null,
        to_role: null,
        to_main_index: null,
        reason: 'seat_change',
        announced_at: null,
        swap_move_id: null,
        ready_at: null,
      },
    ]);
    expect(result.done).toHaveLength(1);
    expect(result.done[0]).toMatchObject({
      move_id: MOVE,
      stack: 25,
      source_occupancy_id: expect.any(String),
    });
    expect(calls).toBe(2);
    expect(sql('SELECT count(*) FROM cash_seat_move_receipts')).toBe(1);
  });

  it('the pending RPC retains original occupancy and durable swap readiness', () => {
    seedSwap();
    const original = sql(
      `SELECT to_json(source_occupancy_id) FROM cash_seat_moves WHERE id='${MOVE}'`
    );
    expect(move()).toMatchObject({ ok: false, held: true, reason: 'waiting_partner' });
    const rows = sql(`SELECT json_agg(m) FROM fn_cash_seat_moves_pending('${TABLE}') m`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      move_id: MOVE,
      player_id: USER,
      source_occupancy_id: original,
    });
    expect(rows[0].ready_at).toBeTruthy();
    expect(
      sql(
        "SELECT to_json(has_function_privilege('authenticated','fn_cash_seat_moves_pending(uuid)','EXECUTE'))"
      )
    ).toBe(false);
    expect(
      sql(
        "SELECT to_json(has_function_privilege('anon','fn_cash_seat_moves_pending(uuid)','EXECUTE'))"
      )
    ).toBe(false);
    expect(
      sql(
        "SELECT to_json(has_function_privilege('service_role','fn_cash_seat_moves_pending(uuid)','EXECUTE'))"
      )
    ).toBe(true);
    sql(`UPDATE cash_seat_moves SET expires_at=now()-interval '1 second' WHERE id='${MOVE}'`);
    expect(sql(`SELECT count(*) FROM fn_cash_seat_moves_pending('${TABLE}')`)).toBe(0);
  });

  it('does not tear down a replacement engine occupancy after an old move reply', async () => {
    seedMove();
    const originalOutcome = move();
    const replacement = '99999999-9999-4999-8999-999999999999';
    transport.rpc.mockResolvedValue({ data: originalOutcome, error: null });
    const engine = new ServerTableEngine(TABLE) as any;
    engine.tableInfo = { id: TABLE, cluster_id: GAME, tournament_id: null };
    engine.lifecycleCanMutate = () => true;
    engine.seatedPlayers = [
      { user_id: USER, seat_number: 2, occupancy_id: replacement, stack: 40 },
    ];
    const unregister = vi.spyOn(engine.disconnectEngine, 'unregisterPlayer');
    const notice = vi.fn();
    engine.hub = { emitEvent: notice };
    expect(
      await engine.executePendingSeatMoves({ announcedOnly: false }, [
        {
          move_id: MOVE,
          player_id: USER,
          source_occupancy_id: originalOutcome.source_occupancy_id,
          to_table_id: OTHER_TABLE,
          to_table_name: null,
          to_role: null,
          to_main_index: null,
          reason: 'seat_change',
          announced_at: null,
          swap_move_id: null,
          ready_at: null,
        },
      ])
    ).toEqual([]);
    expect(engine.seatedPlayers).toEqual([
      { user_id: USER, seat_number: 2, occupancy_id: replacement, stack: 40 },
    ]);
    expect(unregister).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  const insertGameSeat = (table = OTHER_TABLE) =>
    `INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,club_id)
      VALUES(gen_random_uuid(),'${table}','${USER}',3,40,now(),'${CLUB}')`;
  it('rejects a committed duplicate even with the cash move bypass and rolls back its debit', () => {
    seedGame();
    expect(() =>
      sql(`BEGIN; SET LOCAL app.cash_seat_move='on';
      UPDATE club_members SET chip_balance=chip_balance-40;
      ${insertGameSeat()}; COMMIT;`)
    ).toThrow(/one_committed_seat_per_game_player/);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  it('permits destination-first movement in one transaction while retaining the exact stack', () => {
    seedGame();
    sql(`BEGIN; SET LOCAL app.cash_seat_move='on';
      INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,club_id)
        SELECT gen_random_uuid(),'${OTHER_TABLE}',user_id,3,stack,joined_at,club_id FROM table_seats;
      UPDATE table_seats SET left_at=now(),stack=0 WHERE table_id='${TABLE}'; COMMIT;`);
    expect(sql('SELECT sum(stack) FROM table_seats')).toBe(25);
    expect(sql('SELECT count(*) FROM table_seats WHERE active_game_scope IS NOT NULL')).toBe(1);
    expect(sql('SELECT chip_balance FROM club_members')).toBe(100);
  });
  it('rejects revival of the old chair after a completed move', () => {
    seedGame();
    sql(
      `BEGIN; ${insertGameSeat()}; UPDATE table_seats SET left_at=now() WHERE table_id='${TABLE}'; COMMIT;`
    );
    expect(() => sql(`UPDATE table_seats SET left_at=NULL WHERE table_id='${TABLE}'`)).toThrow(
      /one_committed_seat_per_game_player/
    );
    expect(sql('SELECT count(*) FROM table_seats WHERE left_at IS NULL')).toBe(1);
  });
  it('derives forged or cleared scopes from their parent without permitting a bypass', () => {
    seedGame();
    sql(
      "UPDATE table_seats SET active_game_scope=NULL; UPDATE tables SET seat_game_scope='forged'"
    );
    expect(sql('SELECT to_json(active_game_scope) FROM table_seats')).toBe('cluster:' + GAME);
    expect(() =>
      sql(`INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,active_game_scope)
      VALUES(gen_random_uuid(),'${OTHER_TABLE}','${USER}',3,40,'forged')`)
    ).toThrow(/one_committed_seat_per_game_player/);
  });
  it('cascades standalone-to-cluster membership and rolls back a conflicting reassignment', () => {
    seedGame();
    sql(`UPDATE tables SET cluster_id=NULL WHERE id='${OTHER_TABLE}'; ${insertGameSeat()}`);
    expect(() => sql(`UPDATE tables SET cluster_id='${GAME}' WHERE id='${OTHER_TABLE}'`)).toThrow(
      /one_committed_seat_per_game_player/
    );
    expect(
      sql(`SELECT to_json(active_game_scope) FROM table_seats WHERE table_id='${OTHER_TABLE}'`)
    ).toBe('table:' + OTHER_TABLE);
    sql(`UPDATE table_seats SET left_at=now() WHERE table_id='${TABLE}';
      UPDATE tables SET cluster_id='${GAME}' WHERE id='${OTHER_TABLE}'`);
    expect(
      sql(`SELECT to_json(active_game_scope) FROM table_seats WHERE table_id='${OTHER_TABLE}'`)
    ).toBe('cluster:' + GAME);
  });
  it('keeps table and cluster UUID namespaces independent', () => {
    seedGame();
    sql(`INSERT INTO tables(id,current_players) VALUES('${GAME}',0); ${insertGameSeat(GAME)}`);
    expect(sql('SELECT count(*) FROM table_seats WHERE left_at IS NULL')).toBe(2);
  });
  it('rejects a table change into an already occupied game', () => {
    seedGame();
    sql(`INSERT INTO tables(id,current_players) VALUES('${GAME}',0); ${insertGameSeat(GAME)}`);
    expect(() =>
      sql(`UPDATE table_seats SET table_id='${OTHER_TABLE}' WHERE table_id='${GAME}'`)
    ).toThrow(/one_committed_seat_per_game_player/);
  });

  const concurrentSql = (query: string) =>
    new Promise<{ code: number | null; error: string; output: string }>((resolve, reject) => {
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
        query,
      ]);
      let error = '';
      let output = '';
      child.stdout.on('data', (data) => {
        output += String(data);
      });
      child.stderr.on('data', (data) => {
        error += String(data);
      });
      child.once('error', reject);
      // `exit` can fire before the child stdio streams finish flushing. Resolve
      // on `close` so concurrent psql results are complete before JSON parsing.
      child.once('close', (code) => resolve({ code, error, output }));
    });

  it('allows only one concurrent committed admission and rolls back the losing wallet debit', async () => {
    seedGame();
    sql('DELETE FROM table_seats');
    // Different debit rows avoid accidentally serializing the competing seat insertions.
    sql(`INSERT INTO club_members VALUES('${USER}','${GAME}',100,NULL)`);
    const results = await Promise.all(
      [TABLE, OTHER_TABLE].map((table, index) =>
        concurrentSql(
          `BEGIN; SET LOCAL statement_timeout='3s'; SET LOCAL app.cash_seat_move='on';
       UPDATE club_members SET chip_balance=chip_balance-40 WHERE club_id='${index ? GAME : CLUB}';
       ${insertGameSeat(table)}; SELECT pg_sleep(0.15); COMMIT;`
        )
      )
    );
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code !== 0)[0].error).toMatch(
      /one_committed_seat_per_game_player/
    );
    expect(sql('SELECT sum(chip_balance) FROM club_members')).toBe(160);
    expect(sql('SELECT count(*) FROM table_seats WHERE left_at IS NULL')).toBe(1);
  });

  it('serializes cluster reassignment against a concurrent standalone admission', async () => {
    seedGame();
    sql(`UPDATE tables SET cluster_id=NULL WHERE id='${OTHER_TABLE}'`);
    const results = await Promise.all([
      concurrentSql(`BEGIN; SET LOCAL statement_timeout='3s'; ${insertGameSeat()};
        SELECT pg_sleep(0.15); COMMIT;`),
      concurrentSql(`BEGIN; SET LOCAL statement_timeout='3s';
        UPDATE tables SET cluster_id='${GAME}' WHERE id='${OTHER_TABLE}';
        SELECT pg_sleep(0.15); COMMIT;`),
    ]);
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code !== 0)[0].error).toMatch(
      /one_committed_seat_per_game_player|active_seat_game_scope_parent/
    );
    expect(
      sql(`SELECT count(*) FROM table_seats s JOIN tables t ON t.id=s.table_id
      WHERE s.left_at IS NULL AND s.active_game_scope IS DISTINCT FROM
        CASE WHEN t.cluster_id IS NULL THEN 'table:'||t.id::text ELSE 'cluster:'||t.cluster_id::text END`)
    ).toBe(0);
    expect(
      sql(`SELECT count(*) FROM (SELECT s.user_id,t.cluster_id FROM table_seats s
      JOIN tables t ON t.id=s.table_id WHERE s.left_at IS NULL AND t.cluster_id IS NOT NULL
      GROUP BY 1,2 HAVING count(*)>1) d`)
    ).toBe(0);
  });

  const clusterRetirementMigration = () =>
    readFileSync(
      resolve(
        process.cwd(),
        '../supabase/migrations/20260909054702_retire_cluster_duplicate_chair_cashouts_after_native_ownership.sql'
      ),
      'utf8'
    );
  it('refuses planner retirement if native committed ownership is missing', () => {
    expect(() =>
      sql(
        'BEGIN; ALTER TABLE table_seats DROP CONSTRAINT one_committed_seat_per_game_player;' +
          clusterRetirementMigration()
      )
    ).toThrow(/Native committed seat ownership must be installed/);
    expect(
      sql("SELECT count(*) FROM pg_constraint WHERE conname='one_committed_seat_per_game_player'")
    ).toBe(1);
  });
  it('refuses an unreviewed planner body without overwriting it or committing the transaction', () => {
    expect(() =>
      sql(
        `BEGIN; CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(uuid,integer)
      RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;` + clusterRetirementMigration()
      )
    ).toThrow(/Unreviewed cluster planner body/);
    expect(
      sql(
        "SELECT to_json(md5(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)))"
      )
    ).toBe('ae91ea39aef3746371029528cb8e343d');
  });
  it('preserves frozen, missing-game and manual-game planner responses after retirement', () => {
    expect(
      sql(`BEGIN; SET LOCAL test.platform_frozen='true';
      SELECT fn_cash_cluster_tick('${GAME}',0); COMMIT;`)
    ).toEqual({ ok: false, skipped: 'frozen' });
    expect(sql(`SELECT fn_cash_cluster_tick('${GAME}',0)`)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    sql(`INSERT INTO cash_games VALUES('${GAME}',false)`);
    expect(sql(`SELECT fn_cash_cluster_tick('${GAME}',0)`)).toEqual({
      ok: false,
      reason: 'manual_game',
    });
  });
  it('preserves planner execution privileges and removes both direct repair payments', () => {
    expect(
      sql(`SELECT json_build_object(
      'anon',has_function_privilege('anon','public.fn_cash_cluster_tick(uuid,integer)','EXECUTE'),
      'authenticated',has_function_privilege('authenticated','public.fn_cash_cluster_tick(uuid,integer)','EXECUTE'),
      'engine',has_function_privilege('service_role','public.fn_cash_cluster_tick(uuid,integer)','EXECUTE'),
      'repair',position('atomic_seat_cashout_locked' in pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure))>0)`)
    ).toEqual({ anon: false, authenticated: false, engine: true, repair: false });
  });

  it('does not accept a same-named replacement ownership constraint on migration replay', () => {
    seedGame();
    const migration = readFileSync(
      resolve(
        process.cwd(),
        '../supabase/migrations/20260909052547_one_committed_cash_game_seat_per_player.sql'
      ),
      'utf8'
    );
    expect(() =>
      sql(
        `BEGIN;
      ALTER TABLE table_seats DROP CONSTRAINT one_committed_seat_per_game_player;
      ALTER TABLE table_seats ADD CONSTRAINT one_committed_seat_per_game_player
        UNIQUE(user_id,seat_number) DEFERRABLE INITIALLY DEFERRED;` + migration
      )
    ).toThrow(/Unreviewed ownership constraint one_committed_seat_per_game_player/);
    expect(() => sql(insertGameSeat())).toThrow(/one_committed_seat_per_game_player/);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });

  it('keeps derived ownership metadata out of the operator contract while preserving real rules', () => {
    const result = sql(`SELECT json_build_object(
      'before',fn_managed_game_contract_document('table','{"name":"test","big_blind":2}'::jsonb),
      'after',fn_managed_game_contract_document('table','{"name":"test","big_blind":2,"seat_game_scope":"cluster:derived","seat_admission_key":"cash"}'::jsonb),
      'changed',fn_managed_game_contract_document('table','{"name":"test","big_blind":4,"seat_game_scope":"cluster:derived","seat_admission_key":"cash"}'::jsonb))`);
    expect(result.before).toEqual({ name: 'test', big_blind: 2 });
    expect(result.after).toEqual(result.before);
    expect(result.changed).toEqual({ name: 'test', big_blind: 4 });
  });

  const holdingSql = async (query: string) => {
    sql('SELECT to_json(true)'); // Validate the disposable socket before opening another connection.
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
    ]);
    let error = '';
    let output = '';
    let releaseSent = false;
    const done = new Promise<{ code: number | null; error: string }>((resolve) => {
      child.stderr.on('data', (data) => {
        error += String(data);
      });
      child.once('error', (e) => resolve({ code: null, error: String(e) }));
      child.once('exit', (code) => resolve({ code, error }));
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (data) => {
        output += String(data);
        if (output.includes('SQL_LOCK_READY')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!output.includes('SQL_LOCK_READY'))
          reject(new Error('Lock holder exited ' + code + ': ' + error));
      });
    });
    child.stdin.write(
      "BEGIN;\nSET LOCAL statement_timeout='5s';\n" + query + ';\n\\echo SQL_LOCK_READY\n'
    );
    await ready;
    return {
      finish: (commit: boolean, finalQuery = '') => {
        if (!releaseSent) {
          releaseSent = true;
          child.stdin.end(
            (finalQuery ? finalQuery + ';\n' : '') + (commit ? 'COMMIT;\n' : 'ROLLBACK;\n')
          );
        }
        return done;
      },
    };
  };
  const waitForDatabaseLock = async (application: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        sql(`SELECT count(*) FROM pg_stat_activity
        WHERE application_name='${application}' AND wait_event_type='Lock'`) > 0
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Contender did not reach the expected PostgreSQL lock');
  };

  describe('game waitlist cancellation', () => {
    const seedQueue = () => {
      seedGame();
      sql(`INSERT INTO cash_games(id) VALUES('${GAME}'),('${PARTNER_MOVE}');
        INSERT INTO tables(id,cluster_id) VALUES('${CLUB}',NULL),('${PARTNER_MOVE}','${PARTNER_MOVE}');
        INSERT INTO cash_game_waitlist(game_id,user_id,status) VALUES
          ('${GAME}','${USER}','waiting'),('${GAME}','${PARTNER_USER}','notified'),
          ('${PARTNER_MOVE}','${USER}','waiting');
        INSERT INTO table_waitlist(table_id,user_id,status,hold_expires_at) VALUES
          ('${TABLE}','${USER}','notified',now()+interval '1 minute'),
          ('${OTHER_TABLE}','${USER}','waiting',NULL),
          ('${TABLE}','${PARTNER_USER}','notified',now()+interval '1 minute'),
          ('${CLUB}','${USER}','waiting',NULL),
          ('${PARTNER_MOVE}','${USER}','notified',now()+interval '1 minute'),
          ('${OTHER_TABLE}','${USER}','seated',NULL)`);
    };
    const cancelQueue = (table?: string) =>
      sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL test.auth_uid='${USER}';
        SELECT ${table ? `fn_table_waitlist_leave('${table}')` : `fn_cash_game_leave_waitlist('${GAME}')`}; COMMIT;`);
    const remainingOwnOffers = () =>
      sql(`SELECT count(*) FROM table_waitlist w JOIN tables t ON t.id=w.table_id
        WHERE t.cluster_id='${GAME}' AND w.user_id='${USER}' AND w.status IN ('waiting','notified')`);

    it('retires both records, preserves other players/games/history and never changes money or a seated stay', () => {
      seedQueue();
      const before = snapshot();
      const stay = sql('SELECT to_jsonb(s) FROM table_seats s');
      expect(cancelQueue()).toEqual({ ok: true, cancelled: 1, released_offers: 2 });
      expect(remainingOwnOffers()).toBe(0);
      expect(
        sql("SELECT count(*) FROM table_waitlist WHERE status='left' AND hold_expires_at IS NULL")
      ).toBe(2);
      expect(
        sql("SELECT count(*) FROM table_waitlist WHERE status IN ('waiting','notified')")
      ).toBe(3);
      expect(sql("SELECT count(*) FROM table_waitlist WHERE status='seated'")).toBe(1);
      expect(
        sql("SELECT count(*) FROM cash_game_waitlist WHERE status IN ('waiting','notified')")
      ).toBe(2);
      expect(sql('SELECT to_jsonb(s) FROM table_seats s')).toEqual(stay);
      expect(snapshot()).toEqual(before);
      expect(cancelQueue()).toEqual({ ok: true, cancelled: 0, released_offers: 0 });
      expect(snapshot()).toEqual(before);
    });

    it('the physical-table exit cancels the same whole-game admission', () => {
      seedQueue();
      expect(cancelQueue(TABLE)).toEqual({ ok: true, cancelled: 2 });
      expect(remainingOwnOffers()).toBe(0);
      expect(
        sql(
          `SELECT to_json(status) FROM cash_game_waitlist WHERE game_id='${GAME}' AND user_id='${USER}'`
        )
      ).toBe('cancelled');
      expect(cancelQueue(TABLE)).toEqual({ ok: true, cancelled: 0 });
    });

    it('keeps an ordinary table exit scoped to that table', () => {
      seedQueue();
      expect(cancelQueue(CLUB)).toEqual({ ok: true, cancelled: 1 });
      expect(remainingOwnOffers()).toBe(2);
      expect(sql("SELECT count(*) FROM cash_game_waitlist WHERE status='cancelled'")).toBe(0);
    });

    it.each(['fn_cash_game_leave_waitlist', 'fn_table_waitlist_leave'])(
      '%s requires identity and is not executable anonymously',
      (name) => {
        seedQueue();
        expect(() =>
          sql(
            `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL test.auth_uid=''; SELECT ${name}('${GAME}'); COMMIT;`
          )
        ).toThrow(/NOT_AUTHENTICATED/);
        expect(() => sql(`BEGIN; SET LOCAL ROLE anon; SELECT ${name}('${GAME}'); COMMIT;`)).toThrow(
          /permission denied/
        );
        expect(remainingOwnOffers()).toBe(2);
      }
    );

    it('preserves authenticated doors without granting direct queue writes', () => {
      expect(
        sql(`SELECT json_build_object(
        'game',has_function_privilege('authenticated','fn_cash_game_leave_waitlist(uuid)','EXECUTE'),
        'table',has_function_privilege('authenticated','fn_table_waitlist_leave(uuid)','EXECUTE'),
        'engine',has_function_privilege('service_role','fn_cash_game_leave_waitlist(uuid)','EXECUTE'),
        'game_write',has_table_privilege('authenticated','cash_game_waitlist','UPDATE'),
        'table_write',has_table_privilege('authenticated','table_waitlist','UPDATE'))`)
      ).toEqual({ game: true, table: true, engine: true, game_write: false, table_write: false });
    });

    it('rolls back the game cancellation if releasing its offer fails', () => {
      seedQueue();
      expect(() =>
        sql(`BEGIN;
        CREATE FUNCTION pg_temp.reject_release() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'TEST_RELEASE_FAILURE'; END$$;
        CREATE TRIGGER reject_release BEFORE UPDATE ON table_waitlist FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_release();
        SET LOCAL test.auth_uid='${USER}'; SELECT fn_cash_game_leave_waitlist('${GAME}'); COMMIT;`)
      ).toThrow(/TEST_RELEASE_FAILURE/);
      expect(sql("SELECT count(*) FROM cash_game_waitlist WHERE status='cancelled'")).toBe(0);
      expect(remainingOwnOffers()).toBe(2);
      expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    });

    it('waits for a concurrent game join and releases its newly committed admission', async () => {
      seedQueue();
      sql(`DELETE FROM cash_game_waitlist WHERE game_id='${GAME}' AND user_id='${USER}';
        DELETE FROM table_waitlist WHERE user_id='${USER}' AND table_id IN ('${TABLE}','${OTHER_TABLE}')`);
      const holder = await holdingSql(`SELECT id FROM cash_games WHERE id='${GAME}' FOR UPDATE`);
      const contender = concurrentSql(`SET application_name='native_queue_join_cancel';
        BEGIN; SET LOCAL statement_timeout='5s'; SET LOCAL test.auth_uid='${USER}';
        SELECT fn_cash_game_leave_waitlist('${GAME}'); COMMIT;`);
      try {
        await waitForDatabaseLock('native_queue_join_cancel');
        expect(
          (
            await holder.finish(
              true,
              `INSERT INTO cash_game_waitlist(game_id,user_id,status) VALUES('${GAME}','${USER}','notified');
          INSERT INTO table_waitlist(table_id,user_id,status,hold_expires_at) VALUES('${TABLE}','${USER}','notified',now()+interval '1 minute')`
            )
          ).code
        ).toBe(0);
        const result = await contender;
        expect(result.code).toBe(0);
        expect(JSON.parse(result.output)).toEqual({ ok: true, cancelled: 1, released_offers: 1 });
        expect(remainingOwnOffers()).toBe(0);
      } finally {
        await holder.finish(false);
        await contender;
      }
    });

    it.each(['offer', 'cancel'] as const)(
      '%s commits first: a racing offer cannot survive cancellation',
      async (first) => {
        seedQueue();
        sql(
          `UPDATE table_waitlist SET status='waiting',hold_expires_at=NULL WHERE table_id='${TABLE}' AND user_id='${USER}'`
        );
        const offer = `UPDATE table_waitlist SET status='notified',hold_expires_at=now()+interval '1 minute'
        WHERE table_id='${TABLE}' AND user_id='${USER}' AND status='waiting'`;
        const cancel = `SET LOCAL test.auth_uid='${USER}'; SELECT fn_cash_game_leave_waitlist('${GAME}')`;
        const holder = await holdingSql(first === 'offer' ? offer : cancel);
        const contender = concurrentSql(`SET application_name='native_queue_offer_cancel';
        BEGIN; SET LOCAL statement_timeout='5s'; ${first === 'offer' ? cancel : offer}; COMMIT;`);
        try {
          await waitForDatabaseLock('native_queue_offer_cancel');
          expect((await holder.finish(true)).code).toBe(0);
          expect((await contender).code).toBe(0);
          expect(remainingOwnOffers()).toBe(0);
        } finally {
          await holder.finish(false);
          await contender;
        }
      }
    );

    it('refuses cancellation definition drift and rolls the rejected migration back', () => {
      const migration = readFileSync(
        resolve(
          process.cwd(),
          '../supabase/migrations/20260914110751_cash_game_waitlist_cancellation_releases_its_offers.sql'
        ),
        'utf8'
      );
      expect(() =>
        sql(
          `BEGIN; CREATE OR REPLACE FUNCTION public.fn_cash_game_leave_waitlist(uuid)
        RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;` + migration
        )
      ).toThrow(/Unreviewed waitlist cancellation baseline/);
      seedQueue();
      expect(cancelQueue()).toEqual({ ok: true, cancelled: 1, released_offers: 2 });
    });
  });

  it.each(['admission', 'close'] as const)(
    '%s commits first: the opposite transaction cannot create a closed-table occupancy',
    async (first) => {
      const original = seedOccupancy();
      boundCashout(original);
      const admit = `UPDATE club_members SET chip_balance=chip_balance-40; ${insertGameSeat(TABLE)}`;
      const close = "UPDATE tables SET status='closed'";
      const holder = await holdingSql(first === 'admission' ? admit : close);
      const contender = concurrentSql(`SET application_name='native_close_contender';
        BEGIN; SET LOCAL statement_timeout='5s'; ${first === 'admission' ? close : admit}; COMMIT;`);
      try {
        await waitForDatabaseLock('native_close_contender');
        expect((await holder.finish(true)).code).toBe(0);
        const result = await contender;
        expect(result.code).not.toBe(0);
        expect(result.error).toMatch(/live_seat_parent_cannot_close/);
        expect(sql('SELECT to_json(status) FROM tables')).toBe(
          first === 'admission' ? 'waiting' : 'closed'
        );
        expect(snapshot()).toEqual({
          balance: first === 'admission' ? 85 : 125,
          active: first === 'admission' ? 1 : 0,
          credits: 1,
          keys: 1,
          closes: 1,
        });
        expect(
          sql(`SELECT count(*) FROM table_seats s JOIN tables t ON t.id=s.table_id
          WHERE s.left_at IS NULL AND t.seat_admission_key='closed'`)
        ).toBe(0);
      } finally {
        await holder.finish(false);
        await contender;
      }
    }
  );

  it('cannot reclassify a committed cash occupancy as tournament chips', () => {
    const original = seedOccupancy();
    sql(`INSERT INTO tournaments VALUES('${GAME}')`);
    expect(() => sql(`UPDATE tables SET tournament_id='${GAME}'`)).toThrow(
      /live_seat_parent_cannot_close/
    );
    expect(sql('SELECT to_json(seat_admission_key) FROM tables')).toBe('cash');
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    boundCashout(original);
    sql(`UPDATE tables SET tournament_id='${GAME}'`);
    expect(sql('SELECT to_json(seat_admission_key) FROM tables')).toBe('tournament:' + GAME);
  });
  it('rolls back a cash debit when reclassification commits after the purchase precheck', async () => {
    const original = seedOccupancy();
    boundCashout(original);
    sql(`INSERT INTO tournaments VALUES('${GAME}')`);
    const holder = await holdingSql(`SELECT fn_assert_cash_chip_purchase_table('${TABLE}');
      SET LOCAL app.money_path='atomic_table_buyin';
      UPDATE club_members SET chip_balance=chip_balance-40`);
    try {
      sql(`UPDATE tables SET tournament_id='${GAME}'`);
      const result = await holder.finish(true, insertGameSeat(TABLE));
      expect(result.code).not.toBe(0);
      expect(result.error).toMatch(/CASH_PURCHASE_ONLY/);
      expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
    } finally {
      await holder.finish(false);
    }
  });

  it.each(['anon', 'authenticated'])(
    'RLS prevents %s from changing chips or releasing a seat directly',
    (role) => {
      seedOccupancy();
      sql(`BEGIN; SET LOCAL ROLE ${role};
      UPDATE table_seats SET stack=999999,left_at=now();
      DELETE FROM table_seats; COMMIT;`);
      expect(() =>
        sql(`BEGIN; SET LOCAL ROLE ${role};
      INSERT INTO table_seats(id,table_id,user_id,seat_number,stack)
      VALUES(gen_random_uuid(),'${TABLE}','${ACTOR}',3,10); COMMIT;`)
      ).toThrow(/row-level security/);
      expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    }
  );
  it('treasury cash funding cannot create tournament chips even for an engine caller', () => {
    seedOccupancy(25, true);
    expect(() =>
      sql(`BEGIN; SET LOCAL app.money_path='fn_horse_seat_from_treasury';
      INSERT INTO table_seats(id,table_id,user_id,seat_number,stack)
      VALUES(gen_random_uuid(),'${TABLE}','${ACTOR}',3,40); COMMIT;`)
    ).toThrow(/CASH_PURCHASE_ONLY/);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  it('keeps tournament cleanup restricted to the service role', () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(
        sql(`SELECT to_json(has_function_privilege('${role}',
        'public.fn_clear_table_seats(uuid,boolean)','EXECUTE'))`)
      ).toBe(role === 'service_role');
    }
  });

  it('refuses a replay that would cascade an asset change into an active seat', () => {
    seedOccupancy();
    const migration = readFileSync(
      resolve(
        process.cwd(),
        '../supabase/migrations/20260909062236_terminal_tables_cannot_commit_live_occupancies.sql'
      ),
      'utf8'
    );
    expect(() =>
      sql(
        `BEGIN;
      ALTER TABLE table_seats DROP CONSTRAINT live_seat_parent_cannot_close;
      ALTER TABLE table_seats ADD CONSTRAINT live_seat_parent_cannot_close
        FOREIGN KEY(table_id,active_parent_key) REFERENCES tables(id,seat_admission_key)
        ON UPDATE CASCADE;` + migration
      )
    ).toThrow(/Unreviewed admission constraint live_seat_parent_cannot_close/);
    expect(() => sql("UPDATE tables SET status='closed'")).toThrow(/live_seat_parent_cannot_close/);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });

  it('the authorized close RPC refuses an occupied table without waiting on its cashout seat lock', async () => {
    seedOccupancy();
    const holder = await holdingSql('SELECT id FROM table_seats FOR UPDATE');
    try {
      const result = await concurrentSql(`BEGIN; SET LOCAL test.auth_uid='${USER}';
        SET LOCAL statement_timeout='2s'; SELECT fn_close_managed_game('table','${TABLE}'); COMMIT;`);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output.trim())).toEqual({ ok: false, reason: 'players_seated' });
      expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    } finally {
      await holder.finish(false);
    }
  });
  it('the authorized close RPC waits for the cash game before locking its empty table', async () => {
    const original = seedOccupancy();
    boundCashout(original);
    sql(`INSERT INTO cash_games(id,must_move) VALUES('${GAME}',true);
      UPDATE tables SET cluster_id='${GAME}',role='main'`);
    const holder = await holdingSql(`SELECT id FROM cash_games WHERE id='${GAME}' FOR UPDATE`);
    const close = concurrentSql(`SET application_name='managed_close_game_contender';
      BEGIN; SET LOCAL test.auth_uid='${USER}'; SET LOCAL statement_timeout='5s';
      SELECT fn_close_managed_game('table','${TABLE}'); COMMIT;`);
    try {
      await waitForDatabaseLock('managed_close_game_contender');
      // This would block if close had already taken the table before the game.
      sql(
        "BEGIN; SET LOCAL statement_timeout='1s'; UPDATE tables SET current_players=current_players; COMMIT;"
      );
      expect((await holder.finish(true)).code).toBe(0);
      const result = await close;
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output.trim())).toEqual({ ok: true });
      expect(sql('SELECT to_json(status) FROM tables')).toBe('closed');
      expect(sql('SELECT to_json(enabled) FROM cash_games')).toBe(false);
      expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
    } finally {
      await holder.finish(false);
      await close;
    }
  });
  it('the close RPC preserves authentication and club authorization refusals', () => {
    seedOccupancy();
    expect(() => sql(`SELECT fn_close_managed_game('table','${TABLE}')`)).toThrow(
      /Authentication required/
    );
    expect(
      sql(`BEGIN; SET LOCAL test.auth_uid='${USER}'; SET LOCAL test.can_create_games='false';
      SELECT fn_close_managed_game('table','${TABLE}'); COMMIT;`)
    ).toEqual({ ok: false, reason: 'not_authorized' });
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });

  it('does not close a different cash-game context after waiting for the original game lock', async () => {
    const original = seedOccupancy();
    boundCashout(original);
    sql(`INSERT INTO cash_games(id,must_move) VALUES('${GAME}',true),('${OTHER_TABLE}',true);
      UPDATE tables SET cluster_id='${GAME}',role='main'`);
    const holder = await holdingSql(`SELECT id FROM cash_games WHERE id='${GAME}' FOR UPDATE`);
    const close = concurrentSql(`SET application_name='managed_close_stale_context';
      BEGIN; SET LOCAL test.auth_uid='${USER}'; SET LOCAL statement_timeout='5s';
      SELECT fn_close_managed_game('table','${TABLE}'); COMMIT;`);
    try {
      await waitForDatabaseLock('managed_close_stale_context');
      sql(`UPDATE tables SET cluster_id='${OTHER_TABLE}'`);
      await holder.finish(true);
      const result = await close;
      expect(result.code).not.toBe(0);
      expect(result.error).toMatch(/STALE_GAME_CONTEXT/);
      expect(sql('SELECT to_json(status) FROM tables')).toBe('waiting');
      expect(sql('SELECT count(*) FROM cash_games WHERE enabled')).toBe(2);
      expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
    } finally {
      await holder.finish(false);
      await close;
    }
  });

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

  const adminReceipt = (occupancy: string, actor = ACTOR, table = TABLE, seat = 2) =>
    sql(
      `SELECT coalesce(fn_get_admin_seat_cashout_receipt('${actor}','${USER}','${table}',${seat},'${occupancy}'),'null'::jsonb)`
    );
  it('replays only the original admin outcome after table and profile deletion', () => {
    const occupancy = seedOccupancy();
    requestAdmin(occupancy);
    expect(adminReceipt(occupancy)).toBe(null);
    const paid = boundCashout(occupancy);
    sql('DELETE FROM profiles; DELETE FROM table_seats; DELETE FROM tables');
    expect(adminReceipt(occupancy)).toEqual(paid);
    expect(adminReceipt(occupancy, USER)).toBe(null);
    expect(adminReceipt(occupancy, ACTOR, CLUB)).toBe(null);
    expect(adminReceipt(occupancy, ACTOR, TABLE, 3)).toBe(null);
    expect(sql('SELECT count(*) FROM wallet_transactions')).toBe(1);
  });
  it('does not expose a voluntary cashout as an admin receipt', () => {
    const occupancy = seedOccupancy();
    boundCashout(occupancy);
    expect(adminReceipt(occupancy)).toBe(null);
  });
  it.each(['anon', 'authenticated'])('refuses %s direct admin outcome lookup', (role) => {
    const occupancy = seedOccupancy();
    requestAdmin(occupancy);
    boundCashout(occupancy);
    expect(() =>
      sql(`BEGIN; SET LOCAL ROLE ${role};
      SELECT fn_get_admin_seat_cashout_receipt('${ACTOR}','${USER}','${TABLE}',2,'${occupancy}'); COMMIT;`)
    ).toThrow(/permission denied/);
  });
  it('requires engine authority even for the read-only retained outcome', () => {
    const occupancy = seedOccupancy();
    expect(() =>
      sql(`BEGIN; SET LOCAL test.is_engine='false';
      SELECT fn_get_admin_seat_cashout_receipt('${ACTOR}','${USER}','${TABLE}',2,'${occupancy}'); COMMIT;`)
    ).toThrow(/Engine authority required/);
  });
  it('classifies admin departure from durable authority and restores the prior marker', () => {
    const occupancy = seedOccupancy();
    requestAdmin(occupancy);
    sql(`BEGIN; SET LOCAL app.cash_exit_authority='prior';
      SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${occupancy}',NULL);
      DO $proof$ BEGIN
        IF current_setting('app.cash_exit_authority')<>'prior' THEN
          RAISE EXCEPTION 'prior authority was not restored';
        END IF;
      END $proof$;
      COMMIT;`);
    // The next occupancy must not inherit the restored caller's admin marker.
    sql(`BEGIN;
      UPDATE table_seats SET left_at=NULL,stack=40;
      SET LOCAL app.cash_exit_authority='club_admin';
      DO $proof$ DECLARE result jsonb; BEGIN
        SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,occupancy_id,'forced')
          INTO result FROM table_seats;
        IF current_setting('app.cash_exit_authority')<>'club_admin' THEN
          RAISE EXCEPTION 'prior authority was not restored';
        END IF;
      END $proof$;
      COMMIT;`);
    expect(sql('SELECT jsonb_agg(reason ORDER BY stack) FROM session_closes')).toEqual([
      'kicked',
      'system',
    ]);
  });
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
    const occupancy = seedOccupancy(25, true);
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
    if (column === 'table_id')
      sql("INSERT INTO tables(id) VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')");
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

  it.each([0, 25])('table close waits for the engine receipt for a %s stack', (stack) => {
    const original = seedOccupancy(stack);
    expect(() => sql(`SELECT fn_cashout_seats_for_closing_table('${TABLE}','test close')`)).toThrow(
      /CASH_TABLE_CLOSE_REQUIRES_ENGINE_DEPARTURES/
    );
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    const receipt = boundCashout(original);
    expect(receipt).toMatchObject({ stack, occupancy_id: original });
    expect(sql(`SELECT fn_cashout_seats_for_closing_table('${TABLE}','repeat')`)).toMatchObject({
      ok: true,
      players_paid: 0,
      chips_returned: 0,
    });
    expect(snapshot()).toEqual({
      balance: 100 + stack,
      active: 0,
      credits: stack > 0 ? 1 : 0,
      keys: stack > 0 ? 1 : 0,
      closes: 1,
    });
  });
  it('table close cannot skip a positive stack whose home club is missing', () => {
    seedOccupancy();
    sql('UPDATE table_seats SET club_id=NULL');
    const before = snapshot();
    expect(() => sql(`SELECT fn_cashout_seats_for_closing_table('${TABLE}','test close')`)).toThrow(
      /CASH_TABLE_CLOSE_REQUIRES_ENGINE_DEPARTURES/
    );
    expect(snapshot()).toEqual(before);
    expect(sql('SELECT count(*) FROM seat_cashout_receipts')).toBe(0);
  });
  it('table close refuses all occupancies without starting a partial payout', () => {
    seedOccupancy();
    sql(`INSERT INTO club_members VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${CLUB}',100,NULL);
      INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,club_id)
      VALUES(gen_random_uuid(),'${TABLE}','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',3,-1,now(),'${CLUB}')`);
    expect(() => sql(`SELECT fn_cashout_seats_for_closing_table('${TABLE}','test close')`)).toThrow(
      /CASH_TABLE_CLOSE_REQUIRES_ENGINE_DEPARTURES/
    );
    expect(
      sql(`SELECT json_build_object('balance',(SELECT sum(chip_balance) FROM club_members),
      'active',(SELECT count(*) FROM table_seats WHERE left_at IS NULL),
      'credits',(SELECT count(*) FROM wallet_transactions),
      'receipts',(SELECT count(*) FROM seat_cashout_receipts))`)
    ).toEqual({ balance: 200, active: 2, credits: 0, receipts: 0 });
  });
  it('the close trigger permits an empty authorized close without an engine identity', () => {
    const original = seedOccupancy();
    sql(`CREATE TRIGGER test_table_close AFTER UPDATE OF status ON tables
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status='closed')
      EXECUTE FUNCTION trg_auto_cashout_on_table_close()`);
    try {
      expect(() => sql("UPDATE tables SET status='closed'")).toThrow(
        /CASH_TABLE_CLOSE_REQUIRES_ENGINE_DEPARTURES|live_seat_parent_cannot_close/
      );
      expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
      boundCashout(original);
      // The authorized close RPC is SECURITY DEFINER; its caller's JWT can
      // belong to an administrator rather than an engine.
      expect(
        sql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL test.auth_uid='${USER}';
        SET LOCAL test.is_engine='false'; SELECT fn_close_managed_game('table','${TABLE}'); COMMIT;`)
      ).toEqual({ ok: true });
      expect(sql('SELECT to_json(status) FROM tables')).toBe('closed');
      expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
    } finally {
      sql('DROP TRIGGER test_table_close ON tables');
    }
  });
  it.each([
    "status='closed'",
    "status='completed'",
    "status='cancelled'",
    "status='finished'",
    "lifecycle='closed'",
    'is_deleted=true',
    'is_template=true',
  ])('native ownership refuses %s while a seat is active', (change) => {
    const original = seedOccupancy();
    expect(() => sql('UPDATE tables SET ' + change)).toThrow(/live_seat_parent_cannot_close/);
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
    boundCashout(original);
    sql('UPDATE tables SET ' + change);
    expect(sql('SELECT to_json(seat_admission_key) FROM tables')).toBe('closed');
    expect(() =>
      sql(`BEGIN; SET LOCAL app.cash_seat_move='on';
      UPDATE club_members SET chip_balance=chip_balance-40;
      ${insertGameSeat(TABLE)}; COMMIT;`)
    ).toThrow(/CLOSED_TABLE_REJECTS_ACTIVE_SEAT/);
    expect(snapshot()).toEqual({ balance: 125, active: 0, credits: 1, keys: 1, closes: 1 });
  });
  it('does not let a caller forge parent openness or child admission proof', () => {
    seedOccupancy();
    sql(
      "UPDATE tables SET seat_admission_key='forged'; UPDATE table_seats SET active_parent_key=NULL"
    );
    expect(sql('SELECT to_json(seat_admission_key) FROM tables')).toBe('cash');
    expect(sql('SELECT to_json(active_parent_key) FROM table_seats')).toBe('cash');
  });
  it('retired cash seat clearing never marks an unpaid occupancy as left', () => {
    seedOccupancy();
    expect(() => sql(`SELECT fn_clear_table_seats('${TABLE}',false)`)).toThrow(
      /CASH_SEAT_CLEAR_REQUIRES_ENGINE_DEPARTURES/
    );
    expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
  });
  it('preserves tournament seat cleanup without a cash-wallet payout', () => {
    seedOccupancy(25, true);
    expect(sql(`SELECT fn_clear_table_seats('${TABLE}',false)`)).toBe(1);
    expect(snapshot()).toEqual({ balance: 100, active: 0, credits: 0, keys: 0, closes: 0 });
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

  it.each(['anon', 'authenticated', 'service_role'])(
    'denies every unbound cashout door to %s after adoption',
    (role) => {
      const occupancy = seedOccupancy();
      const calls = [
        `atomic_seat_cashout_locked('${USER}','${TABLE}',2,'forced')`,
        `atomic_table_cashout('${USER}','${TABLE}',2)`,
        `player_leave_table('${TABLE}','${USER}')`,
        `fn_admin_kick_player('${TABLE}','${USER}','reason')`,
      ];
      for (const call of calls) {
        expect(() => sql(`BEGIN; SET LOCAL ROLE ${role}; SELECT ${call}; COMMIT;`)).toThrow(
          /permission denied/
        );
        expect(snapshot()).toEqual({ balance: 100, active: 1, credits: 0, keys: 0, closes: 0 });
      }
      if (role === 'service_role') {
        expect(
          sql(`BEGIN; SET LOCAL ROLE service_role;
        SELECT fn_cashout_seat_occupancy('${USER}','${TABLE}',2,'${occupancy}',NULL); COMMIT;`)
        ).toMatchObject({ ok: true, stack: 25 });
      }
    }
  );

  it('retires the unbound seat-expiry alias for every application role', () => {
    expect(
      sql(`SELECT json_build_object(
      'anon',has_function_privilege('anon','public.player_leave_table(uuid,uuid)','EXECUTE'),
      'authenticated',has_function_privilege('authenticated','public.player_leave_table(uuid,uuid)','EXECUTE'),
      'service_role',has_function_privilege('service_role','public.player_leave_table(uuid,uuid)','EXECUTE'))`)
    ).toEqual({ anon: false, authenticated: false, service_role: false });
  });
  it('keeps the unbound cashout primitive private after engine adoption', () => {
    expect(
      sql(`SELECT json_build_object(
      'anon',has_function_privilege('anon','public.atomic_seat_cashout_locked(uuid,uuid,integer,text)','EXECUTE'),
      'authenticated',has_function_privilege('authenticated','public.atomic_seat_cashout_locked(uuid,uuid,integer,text)','EXECUTE'),
      'service_role',has_function_privilege('service_role','public.atomic_seat_cashout_locked(uuid,uuid,integer,text)','EXECUTE'))`)
    ).toEqual({ anon: false, authenticated: false, service_role: false });
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
  it('refuses missing table cashout and prevents an orphan admission from committing a debit', () => {
    sql(`INSERT INTO club_members VALUES('${USER}','${CLUB}',100,NULL)`);
    expect(() =>
      sql(`BEGIN; UPDATE club_members SET chip_balance=chip_balance-25;
      INSERT INTO table_seats VALUES(gen_random_uuid(),'${TABLE}','${USER}',2,
      25,now(),NULL,false,'${CLUB}'); COMMIT;`)
    ).toThrow(/Active seat requires an existing table/);
    expect(() => sql(`SELECT atomic_seat_cashout_locked('${USER}','${TABLE}',2,NULL)`)).toThrow(
      /CASHOUT_TABLE_NOT_FOUND/
    );
    expect(snapshot()).toEqual({ balance: 100, active: 0, credits: 0, keys: 0, closes: 0 });
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
