import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const cents = (x) => Math.round(Number(x) * 100);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, message, budget = 30000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await pause(20);
  }
  throw new Error(message);
}
const card = (text) => ({
  rank: text[0],
  suit: { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }[text[1]],
});

/** Native, authenticated EV actor. The caller owns real isolated services and
 * fresh funded seats. No financial function or authentication is replaced.
 * Card order is a deterministic input to the real deck, not a settlement row.
 */
export async function exerciseEvCashout({
  db,
  users,
  tableId,
  serverDirectory,
  river,
  reportStage,
}) {
  assert.equal(typeof reportStage, 'function');
  reportStage('ev-prepare');
  assert.equal(users.length, 2);
  assert.ok(['3c', '3d'].includes(river));
  assert.equal(new URL(process.env.SUPABASE_URL).hostname, '127.0.0.1');
  const load = (name) => import(pathToFileURL(`${serverDirectory}/dist/${name}.js`).href);
  const [
    { ServerTableEngine },
    { HandController },
    { Deck },
    { handleInsurance },
    { INSTANCE_ID },
    { getFullRakeConfig, getPlayerCountCaps },
    { TableStateHub },
  ] = await Promise.all([
    load('engine/ServerTableEngine'),
    load('engine/HandController'),
    load('engine/PokerEngine'),
    load('handlers/insurance'),
    load('services/tableLease'),
    load('config/RakeConfig'),
    load('transport/TableStateHub'),
  ]);
  const read = async (sql, values = []) => (await db.query(sql, values)).rows;
  const [table] = await read('SELECT * FROM public.tables WHERE id=$1', [tableId]);
  assert.ok(table && !table.tournament_id && table.club_id);
  const seats = await read(
    'SELECT *,joined_at::text AS original_joined_at FROM public.table_seats WHERE table_id=$1 AND left_at IS NULL ORDER BY seat_number',
    [tableId]
  );
  assert.equal(seats.length, 2);
  assert.deepEqual(
    seats.map((x) => x.user_id),
    users.map((x) => x.id)
  );
  assert.equal(cents(seats[0].stack), 15000);
  assert.equal(cents(seats[1].stack), 15000);
  const bankBefore = cents(
    (
      await read('SELECT insurance_balance FROM public.club_wallets WHERE club_id=$1', [
        table.club_id,
      ])
    )[0].insurance_balance
  );
  const opening = seats.reduce((n, s) => n + cents(s.stack), 0);
  const hand = river === '3c' ? 1000901 : 1000902;
  const generation = randomUUID();
  await db.query(
    'INSERT INTO public.engine_table_leases(table_id,instance_id,lease_generation,protocol_version,heartbeat_at) VALUES($1,$2,$3,2,clock_timestamp())',
    [tableId, INSTANCE_ID, generation]
  );
  const roster = seats.map((s) => ({
    user_id: s.user_id,
    seat_id: s.id,
    occupancy_id: s.occupancy_id,
    seat_joined_at: s.original_joined_at,
    stack_before: Number(s.stack),
    is_horse: false,
  }));
  await db.query('SELECT public.fn_cash_capture_hand_manifest($1,$2,$3::jsonb,$4,$5)', [
    tableId,
    hand,
    JSON.stringify(roster),
    INSTANCE_ID,
    generation,
  ]);
  const [manifest] = await read(
    'SELECT id FROM public.cash_hand_participant_manifests WHERE table_id=$1 AND hand_number=$2',
    [tableId, hand]
  );
  assert.ok(manifest);
  const players = seats.map((s, i) => ({
    ...s,
    username: `EV Actor ${i + 1}`,
    stack: Number(s.stack),
    is_horse: false,
    seat_id: s.id,
    seat_joined_at: s.original_joined_at,
  }));
  const engine = new ServerTableEngine(tableId, {
    scope: 'cash',
    verified: true,
    generation,
    proofDeadlineMonotonicMs: performance.now() + 60000,
  });
  assert.equal(
    engine.claimProcessOwnership(),
    true,
    'isolated dealer must acquire its actual process slot'
  );
  const events = [];
  const hub = new TableStateHub();
  const emit = hub.emitEvent.bind(hub);
  hub.emitEvent = (table, event) => {
    events.push(structuredClone(event));
    return emit(table, event);
  };
  Object.assign(engine, {
    running: true,
    handCount: hand,
    tableInfo: {
      ...table,
      game_variant: 'nlh',
      small_blind: 1,
      big_blind: 2,
      max_players: 2,
      insurance_enabled: true,
      arena: { asset: 'chips', is_platform: true, union_id: null },
    },
    seatedPlayers: players,
    currentHandStartedAt: new Date().toISOString(),
    currentHandVariant: 'nlh',
    currentHandDealerSeat: 1,
    currentHandDealtStacks: new Map(players.map((p) => [p.user_id, p.stack])),
    currentHandSeatGenerations: new Map(
      roster.map((s) => [
        s.user_id,
        { ...s, funding_manifest_id: manifest.id, funding_stack_before: s.stack_before },
      ])
    ),
    hub,
  });
  engine.insuranceEngine.configure(tableId, { enabled: true });
  for (const player of players) {
    engine.atomicStackService.initializeStack(tableId, player.user_id, player.stack);
    engine.timeBankEngine.initializePlayer(tableId, player.user_id);
  }
  const rc = getFullRakeConfig(1, 2, 'nlh');
  const holes = [
    ['As', 'Ah'],
    ['7c', '8c'],
  ].map((xs) => xs.map(card));
  const board = ['Ac', 'Kc', '2d', '9h', river].map(card);
  const known = new Set([...holes.flat(), ...board].map((c) => `${c.rank}:${c.suit}`));
  const remainder = [];
  for (const suit of ['spades', 'hearts', 'diamonds', 'clubs'])
    for (const rank of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'])
      if (!known.has(`${rank}:${suit}`)) remainder.push({ rank, suit });
  const order = [...holes.flat(), ...board, ...remainder];
  assert.equal(order.length, 52);
  const shuffle = Deck.prototype.shuffle;
  let controller;
  try {
    Deck.prototype.shuffle = function () {
      this.cards = structuredClone(order);
    };
    controller = new HandController(
      {
        tableId,
        handNumber: hand,
        gameVariant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        asset: 'chips',
        rakeConfig: {
          percent: rc.rakePercent,
          cap: rc.rakeCap,
          noFlopNoDrop: true,
          playerCountCaps: getPlayerCountCaps(rc.rakeCap, 2),
        },
        bbjConfig: {
          enabled: rc.bbjEnabled,
          feeBB: rc.bbjFeeBB,
          minPotBB: rc.rules.minPotBB,
          minPlayersDealt: rc.rules.minPlayersDealt,
        },
      },
      players.map((p, i) => ({
        user_id: p.user_id,
        seat: i + 1,
        username: p.username,
        stack: p.stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      })),
      1
    );
  } finally {
    Deck.prototype.shuffle = shuffle;
  }
  engine.handController = controller;
  const pending = [];
  let persistenceGeneration;
  let eventFailure;
  controller.onEvent((event) => {
    if (event.type === 'CARDS_DEALT') return; // private-card transport is outside this EV HTTP qualification
    if (event.type === 'TURN_CHANGE') return; // the finite actor supplies turns, never an autonomous dealer loop
    const work = engine.handleHandEvent(event, players, persistenceGeneration);
    pending.push(
      Promise.resolve(work).catch((error) => {
        eventFailure = error;
      })
    );
  });
  const http = createServer(
    (req, res) =>
      void handleInsurance(req, res, {
        gameServer: { getTableEngine: (id) => (id === tableId ? engine : null) },
      })
  );
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${http.address().port}/insurance`;
  const answer = async (user, body) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(user ? { authorization: `Bearer ${user.session.access_token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    persistenceGeneration = engine.beginTerminalBoundaryPersistence();
    controller.start();
    assert.deepEqual(
      controller.getState().players.map((p) => p.cards),
      holes
    );
    engine.currentHandHoleCards = new Map(
      players.map((p, i) => [p.user_id, { seat: i + 1, cards: holes[i] }])
    );
    while (controller.getState().stage !== 'turn') {
      const state = controller.getState();
      const p = state.players.find((x) => x.seat === state.currentPlayerSeat);
      assert.ok(p);
      assert.equal(
        controller.performAction(p.seat, state.current_bet > p.bet ? 'call' : 'check'),
        true
      );
    }
    for (let i = 0; i < 2; i++) {
      const state = controller.getState();
      assert.equal(controller.performAction(state.currentPlayerSeat, 'all_in'), true);
    }
    reportStage('ev-offer');
    const offered = await until(
      () => events.find((x) => x.type === 'insurance_offers'),
      'actual engine EV offer absent'
    );
    assert.equal(offered.offers.length, 1);
    assert.equal(offered.offers[0].playerId, users[0].id);
    const quote = cents(offered.offers[0].evCashoutAmount);
    assert.ok(quote > 0);
    const request = { tableId, response: 'cashout', userId: users[0].id };
    reportStage('ev-authentication');
    assert.equal((await answer(null, request)).status, 401);
    assert.equal(
      (await answer(users[1], request)).status,
      400,
      'another authenticated actor must not accept the leader quote'
    );
    reportStage('ev-acceptance');
    const accepted = await answer(users[0], request);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'cashed_out');
    assert.equal(cents(accepted.body.insuredAmount), quote);
    reportStage('ev-duplicate-refusal');
    assert.equal((await answer(users[0], request)).status, 400, 'duplicate acceptance must refuse');
    reportStage('ev-commit');
    await until(() => events.some((x) => x.type === 'hand_complete'), 'real hand never completed');
    await until(async () => {
      const [x] = await read(
        'SELECT post_commit_completed_at FROM public.hand_atomic_commits WHERE table_id=$1 AND hand_number=$2',
        [tableId, hand]
      );
      return x?.post_commit_completed_at;
    }, 'accepted EV hand did not durably complete');
    await Promise.all(pending);
    if (eventFailure) throw eventFailure;
    await engine.postHandTasksPromise;
    reportStage('ev-conservation');
    const [commit] = await read(
      'SELECT * FROM public.hand_atomic_commits WHERE table_id=$1 AND hand_number=$2',
      [tableId, hand]
    );
    const [payment] = await read(
      'SELECT * FROM public.insurance_transactions WHERE table_id=$1 AND hand_number=$2',
      [tableId, hand]
    );
    assert.equal(payment.kind, 'ev_cashout');
    assert.equal(payment.player_id, users[0].id);
    assert.equal(cents(payment.payout), quote);
    assert.equal(cents(payment.insured_amount), 0);
    const [history] = await read('SELECT * FROM public.hand_history WHERE id=$1', [commit.hand_id]);
    const ending = await read(
      'SELECT user_id,stack FROM public.table_seats WHERE table_id=$1 AND left_at IS NULL ORDER BY seat_number',
      [tableId]
    );
    assert.equal(cents(ending[0].stack), quote);
    assert.equal(
      ending.reduce((n, s) => n + cents(s.stack), 0) +
        cents(payment.premium) -
        quote +
        cents(history.rake_amount) +
        cents(history.bbj_amount),
      opening,
      'stacks plus signed insurance bank and fees conserve opening chips'
    );
    assert.equal(
      payment.player_won,
      river === '3d',
      'river must produce the independently expected winner'
    );
    assert.equal(
      cents(payment.premium),
      river === '3d' ? opening - cents(history.rake_amount) - cents(history.bbj_amount) : 0,
      'only actual winning pot is redirected to bank'
    );
    const bankAfter = cents(
      (
        await read('SELECT insurance_balance FROM public.club_wallets WHERE club_id=$1', [
          table.club_id,
        ])
      )[0].insurance_balance
    );
    assert.equal(
      Math.sign(bankAfter - bankBefore),
      river === '3d' ? 1 : -1,
      'bank sign must follow independent win/loss case'
    );
    assert.equal(
      bankAfter - bankBefore,
      cents(payment.premium) - quote,
      'actual insurance bank must match its unique payment'
    );
    const ledger = await read(
      'SELECT * FROM public.chip_ledger WHERE settlement_id=$1 ORDER BY id',
      [`insurance:${tableId}:${hand}:${users[0].id}`]
    );
    assert.equal(ledger.length, 1, 'EV bank movement must have one durable ledger row');
    assert.equal(cents(ledger[0].amount), Math.abs(bankAfter - bankBefore));
    assert.equal(
      ending.reduce((n, s) => n + cents(s.stack), 0) +
        bankAfter -
        bankBefore +
        cents(history.rake_amount) +
        cents(history.bbj_amount),
      opening
    );
    const frozen = JSON.stringify({ payment, ending, commit });
    reportStage('ev-replay');
    const retained = await read(
      'SELECT submission_id FROM smarter_private.hand_submissions WHERE table_id=$1 AND hand_number=$2',
      [tableId, hand]
    );
    assert.equal(retained.length, 1);
    const [resubmitted] = await read(
      'SELECT public.fn_ca_commit_hand_submission($1,$2,$3) AS result',
      [retained[0].submission_id, INSTANCE_ID, generation]
    );
    assert.equal(resubmitted.result.success, true);
    assert.equal(resubmitted.result.atomic_hand_commit, true);
    assert.equal(resubmitted.result.replay, true);
    const [replay] = await read(
      'SELECT public.fn_ca_process_hand_post_commit_obligations($1) AS result',
      [commit.hand_id]
    );
    assert.equal(replay.result.already_completed, true);
    const afterPayment = (
      await read(
        'SELECT * FROM public.insurance_transactions WHERE table_id=$1 AND hand_number=$2',
        [tableId, hand]
      )
    )[0];
    const afterEnding = await read(
      'SELECT user_id,stack FROM public.table_seats WHERE table_id=$1 AND left_at IS NULL ORDER BY seat_number',
      [tableId]
    );
    const afterCommit = (
      await read('SELECT * FROM public.hand_atomic_commits WHERE table_id=$1 AND hand_number=$2', [
        tableId,
        hand,
      ])
    )[0];
    assert.equal(
      cents(
        (
          await read('SELECT insurance_balance FROM public.club_wallets WHERE club_id=$1', [
            table.club_id,
          ])
        )[0].insurance_balance
      ),
      bankAfter
    );
    assert.equal(
      (
        await read('SELECT count(*)::int AS n FROM public.chip_ledger WHERE settlement_id=$1', [
          `insurance:${tableId}:${hand}:${users[0].id}`,
        ])
      )[0].n,
      1
    );
    assert.equal(
      JSON.stringify({ payment: afterPayment, ending: afterEnding, commit: afterCommit }),
      frozen,
      'postcommit replay changed original money or receipt'
    );
    return {
      scope: 'authenticated-ev-cashout-native-lifecycle',
      hand_number: hand,
      table_id: tableId,
      quote_cents: quote,
      outcome: river === '3c' ? 'loss' : 'win',
      product_certificate: false,
    };
  } finally {
    await new Promise((resolve) => http.close(resolve));
    engine.stop();
  }
}
