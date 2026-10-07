import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
if (!process.env.OPERATOR_HOLD_PG_HOST && !process.env.OPERATOR_HOLD_PG_PORT) {
  test('the maintained native operator-hold fixture creates and closes its own PostgreSQL server', (t) => {
    const nativeEnv = { ...process.env };
    delete nativeEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(
      'bash',
      [new URL('../../../scripts/dev/test-operator-pause-postgres.sh', import.meta.url).pathname],
      {
        encoding: 'utf8',
        timeout: 120000,
        env: nativeEnv,
      }
    );
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 21/);
    assert.match(result.stdout, /# pass 21/);
    assert.match(result.stdout, /# fail 0/);
    t.diagnostic(result.stdout);
  });
} else {
  const require = createRequire(new URL('../../../server/package.json', import.meta.url));
  const { Client } = require('pg');
  const db = new Client({
    host: process.env.OPERATOR_HOLD_PG_HOST,
    port: Number(process.env.OPERATOR_HOLD_PG_PORT),
    user: 'fixture_admin',
    database: 'postgres',
  });
  await db.connect();
  const migrationSource = readFileSync(
    new URL(
      '../../../supabase/migrations/20261007154739_an_operator_pause_survives_its_engine.sql',
      import.meta.url
    ),
    'utf8'
  );
  await db.query('INSERT INTO supabase_migrations.schema_migrations VALUES($1,$2,$3)', [
    '20261007154739',
    'an_operator_pause_survives_its_engine',
    [migrationSource],
  ]);
  after(async () => {
    await db.end();
  });
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'isolated-operator-hold-fixture';
  const { supabase } = await import('../../../server/dist/services/supabase/client.js');
  const { ServerTableEngine } = await import('../../../server/dist/engine/ServerTableEngine.js');
  const { INSTANCE_ID } = await import('../../../server/dist/services/tableLease.js');
  const leaseGeneration = '77777777-7777-4777-8777-777777777777';
  await db.query(
    'INSERT INTO public.engine_table_leases SELECT id,$1,$2,2,clock_timestamp() FROM public.tables',
    [INSTANCE_ID, leaseGeneration]
  );
  const { deadlineScheduler } = await import('../../../server/dist/engine/DeadlineScheduler.js');
  const { channelHub } = await import('../../../server/dist/hub/ChannelHub.js');
  after(() => {
    deadlineScheduler.stop();
    channelHub.close();
  });
  const originalRpc = supabase.rpc;
  let failRead = false,
    failWrite = false;
  // Only the HTTP transport is replaced. All store state/permissions/transactions
  // execute the committed PostgreSQL functions on this disposable native server.
  supabase.rpc = async (name, args) => {
    if (
      (failRead && name === 'fn_ca_get_table_operator_hold') ||
      (failWrite && name === 'fn_ca_set_table_operator_hold')
    )
      return { data: null, error: { code: 'unknown' } };
    try {
      const read = name === 'fn_ca_get_table_operator_hold';
      assert.ok(read || name === 'fn_ca_set_table_operator_hold');
      const result = await db.query(
        read
          ? 'SELECT public.fn_ca_get_table_operator_hold($1) AS value'
          : 'SELECT public.fn_ca_set_table_operator_hold($1,$2,$3,$4,$5,$6,$7) AS value',
        read
          ? [args.p_table_id]
          : [
              args.p_table_id,
              args.p_paused,
              args.p_actor_id,
              args.p_command_id,
              args.p_lease_generation,
              args.p_instance_id,
              args.p_expected_version,
            ]
      );
      return { data: result.rows[0].value, error: null };
    } catch (error) {
      return { data: null, error: { code: error.code } };
    }
  };
  after(() => {
    supabase.rpc = originalRpc;
  });
  const table = '33333333-3333-4333-8333-333333333333';
  const diamond = '44444444-4444-4444-8444-444444444444';
  const owner = '55555555-5555-4555-8555-555555555555';
  const staff = '66666666-6666-4666-8666-666666666666';
  function live() {
    const e = new ServerTableEngine(table, {
      scope: 'cash',
      verified: true,
      generation: leaseGeneration,
      proofDeadlineMonotonicMs: performance.now() + 60000,
    });
    e.running = true;
    assert.equal(e.claimProcessOwnership(), true);
    e.hub = { emitEvent() {} };
    return e;
  }
  async function retire(e) {
    await e.stop();
  }
  async function write(t, paused, actor, key = randomUUID(), expectedVersion = null) {
    if (expectedVersion === null)
      expectedVersion = Number(
        (await db.query('SELECT public.fn_ca_get_table_operator_hold($1) AS value', [t])).rows[0]
          .value.version
      );
    return (
      await db.query('SELECT public.fn_ca_set_table_operator_hold($1,$2,$3,$4,$5,$6,$7) AS value', [
        t,
        paused,
        actor,
        key,
        leaseGeneration,
        INSTANCE_ID,
        expectedVersion,
      ])
    ).rows[0].value;
  }

  const inheritedHandoff = randomUUID();
  const inheritedFleet = [
    { table_id: table, paused: true, lease_generation: leaseGeneration },
    { table_id: diamond, paused: false, lease_generation: leaseGeneration },
  ];
  const oldSource = '53743bc8853dbb42936cf08f5422d2ef1bffdc5b';
  test('original release admission contract names exact installed fixture migration and private native authority', async () => {
    const contract = (await db.query('SELECT public.fn_ca_operator_hold_contract() AS value'))
      .rows[0].value;
    assert.equal(contract.kind, 'operator_hold_contract_v1');
    assert.equal(contract.migration.statements_count, 1);
    assert.equal(
      contract.migration.sql_md5,
      createHash('md5').update(migrationSource).digest('hex')
    );
    assert.equal(contract.tables.length, 3);
    assert.ok(contract.tables.every((row) => row.rls === true));
    assert.ok(
      contract.tables.every(
        (row) =>
          row.columns.length >= 4 &&
          row.constraints.some((q) => q.type === 'p' && q.validated === true)
      )
    );
    assert.equal(contract.functions.length, 6);
    assert.ok(contract.functions.every((row) => row.security_definer === true));
    console.log('OPERATOR_HOLD_NATIVE_CONTRACT ' + JSON.stringify(contract));
  });
  test('legacy hold import retains typed original provenance without claiming a human actor', async () => {
    const result = (
      await db.query('SELECT public.fn_ca_import_operator_holds($1,$2,$3,$4::jsonb) AS value', [
        inheritedHandoff,
        INSTANCE_ID,
        oldSource,
        JSON.stringify(inheritedFleet),
      ])
    ).rows[0].value;
    assert.equal(result.imported, 2);
    assert.equal(result.replayed, false);
    const receipt = (
      await db.query('SELECT public.fn_ca_get_operator_hold_handoff($1) AS value', [
        inheritedHandoff,
      ])
    ).rows[0].value;
    assert.deepEqual(receipt, {
      handoff_id: inheritedHandoff,
      source_instance: INSTANCE_ID,
      source_release_sha: oldSource,
      fleet: inheritedFleet,
    });
    assert.equal(
      (await db.query('SELECT public.fn_ca_get_operator_hold_handoff($1) AS value', [randomUUID()]))
        .rows[0].value,
      null
    );
    const row = (
      await db.query(
        'SELECT paused,actor_id,command_id,inherited_handoff_id FROM public.ca_table_operator_holds WHERE table_id=$1',
        [table]
      )
    ).rows[0];
    assert.equal(row.paused, true);
    assert.equal(row.actor_id, null);
    assert.equal(row.command_id, null);
    assert.equal(row.inherited_handoff_id, inheritedHandoff);
  });

  test('an acknowledged operator hold survives a new actual engine and maintenance thaw', async () => {
    const first = live();
    const key = randomUUID();
    const result = await first.requestOperatorHold(true, owner, key, 'native test');
    assert.equal(result.success, true);
    assert.equal(result.admin_paused, true);
    await retire(first);
    const replacement = live();
    try {
      await replacement.restoreOperatorHold();
      replacement.pauseForMaintenance(300000);
      replacement.resumeFromMaintenance();
      assert.equal(replacement.adminPauseLock, true);
      assert.equal(replacement.isNextHandPaused(), true);
      assert.equal(
        (await db.query('SELECT status FROM public.tables WHERE id=$1', [table])).rows[0].status,
        'running'
      );
    } finally {
      await retire(replacement);
    }
  });

  test('scoped list and single-game refresh expose operator authority without changing raw status or cursor counts', async () => {
    await write(table, true, owner);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
    const list = (
      await db.query("SELECT public.fn_list_managed_games('club',$1) AS value", [
        '11111111-1111-4111-8111-111111111111',
      ])
    ).rows[0].value;
    assert.equal(list.ok, true);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].status, 'running');
    assert.equal(list.items[0].operator_paused, true);
    assert.equal(list.counts.live, 1);
    assert.equal(list.counts.closed, 0);
    const single = (
      await db.query(
        "SELECT public.fn_list_managed_games('club',$1,p_game_kind=>'table',p_game_id=>$2) AS value",
        ['11111111-1111-4111-8111-111111111111', table]
      )
    ).rows[0].value;
    assert.equal(single.items[0].operator_paused, true);
    assert.equal(single.counts, null);
    assert.equal(single.next_cursor, null);
    const foreign = (
      await db.query("SELECT public.fn_list_managed_games('club',$1) AS value", [
        '22222222-2222-4222-8222-222222222222',
      ])
    ).rows[0].value;
    assert.equal(foreign.ok, false);
    assert.equal(foreign.reason, 'not_authorized');
    await write(table, false, owner);
    const resumed = (
      await db.query(
        "SELECT public.fn_list_managed_games('club',$1,p_game_kind=>'table',p_game_id=>$2) AS value",
        ['11111111-1111-4111-8111-111111111111', table]
      )
    ).rows[0].value;
    assert.equal(resumed.items[0].operator_paused, false);
    assert.equal(resumed.items[0].status, 'running');
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
  });

  test('original committed operator command emits exactly one scoped refresh event, replay emits none', async () => {
    const command = randomUUID();
    await write(table, true, owner, command);
    await write(table, true, owner, command);
    const events = (
      await db.query('SELECT * FROM public.game_management_events WHERE command_id=$1', [command])
    ).rows;
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.event_type, 'game_changed');
    assert.equal(event.scope_kind, 'club');
    assert.equal(event.scope_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(event.entity_type, 'table');
    assert.equal(event.entity_id, table);
    assert.equal(event.actor_id, null);
    assert.equal(event.payload.operator_actor_id, owner);
    assert.equal(event.payload.operator_paused, true);
    assert.equal(
      event.payload.operator_hold_version,
      Number(
        (
          await db.query(
            'SELECT version FROM public.ca_table_operator_hold_commands WHERE command_id=$1',
            [command]
          )
        ).rows[0].version
      )
    );
  });

  test('resume releases only operator authority, keeping each independent hold', async () => {
    for (const flag of [
      'maintenancePaused',
      'handForHandPaused',
      'maintenanceLock',
      'finalTableDealPaused',
      'terminalCloseoutPaused',
      'dealingHaltLock',
    ]) {
      const e = live();
      try {
        await e.requestOperatorHold(true, owner, randomUUID());
        e[flag] = true;
        const r = await e.requestOperatorHold(false, owner, randomUUID());
        assert.equal(r.admin_paused, false);
        assert.equal(r.paused, true);
        assert.equal(e[flag], true);
      } finally {
        await retire(e);
      }
    }
  });

  test('native permission loss refuses pause without leaving a phantom hold', async () => {
    await write(table, false, owner);
    const e = live();
    try {
      await assert.rejects(
        e.requestOperatorHold(true, staff, randomUUID()),
        (error) => error.code === '42501'
      );
      assert.equal(e.adminPauseLock, false);
      assert.equal(e.pendingOperatorPauses, 0);
      assert.equal(e.isNextHandPaused(), false);
      assert.equal(
        (
          await db.query('SELECT paused FROM public.ca_table_operator_holds WHERE table_id=$1', [
            table,
          ])
        ).rows[0].paused,
        false
      );
    } finally {
      await retire(e);
    }
  });

  test('resume preserves another tournament move owner', async () => {
    const e = live();
    try {
      await e.requestOperatorHold(true, owner, randomUUID());
      e.tournamentMovePauseOwners.add('independent-owner');
      const r = await e.requestOperatorHold(false, owner, randomUUID());
      assert.equal(r.admin_paused, false);
      assert.equal(r.paused, true);
      assert.equal(e.tournamentMovePauseOwners.has('independent-owner'), true);
    } finally {
      await retire(e);
    }
  });

  test('unknown original pause retains its identity and next-hand fence until a newer native command', async () => {
    await write(table, false, owner);
    const e = live(),
      original = randomUUID();
    try {
      failWrite = true;
      await assert.rejects(e.requestOperatorHold(true, owner, original), /unconfirmed/);
      assert.equal(e.unconfirmedOperatorCommands.has(original), true);
      assert.equal(e.adminPauseLock, true);
      assert.equal(e.isNextHandPaused(), true);
      failWrite = false;
      const r = await e.requestOperatorHold(false, owner, randomUUID());
      assert.equal(r.admin_paused, false);
      assert.equal(e.unconfirmedOperatorCommands.size, 0);
      assert.equal(e.isNextHandPaused(), false);
    } finally {
      failWrite = false;
      await retire(e);
    }
  });

  test('unknown resume cannot clear a hold or report success', async () => {
    const e = live();
    try {
      await e.requestOperatorHold(true, owner, randomUUID());
      failWrite = true;
      await assert.rejects(e.requestOperatorHold(false, owner, randomUUID()), /unconfirmed/);
      assert.equal(e.adminPauseLock, true);
      assert.equal(
        (
          await db.query('SELECT paused FROM public.ca_table_operator_holds WHERE table_id=$1', [
            table,
          ])
        ).rows[0].paused,
        true
      );
    } finally {
      failWrite = false;
      await retire(e);
    }
  });

  test('unreadable boot hold refuses restoration, never treating it as absent', async () => {
    const e = live();
    try {
      failRead = true;
      await assert.rejects(e.restoreOperatorHold(), /unconfirmed/);
    } finally {
      failRead = false;
      await retire(e);
    }
  });

  test('actual start refuses unreadable operator authority before readiness or first dealing', async () => {
    const e = new ServerTableEngine(table, {
      scope: 'cash',
      verified: true,
      generation: leaseGeneration,
      proofDeadlineMonotonicMs: performance.now() + 60000,
    });
    const originalFrom = supabase.from;
    let dealt = 0;
    e.hub = { emitEvent() {} };
    e.dealingLoop = async () => {
      dealt++;
    };
    supabase.from = (relation) => {
      assert.equal(relation, 'tables');
      const builder = {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            data: {
              id: table,
              club_id: '11111111-1111-4111-8111-111111111111',
              union_id: null,
              status: 'running',
              arena: {
                id: '11111111-1111-4111-8111-111111111111',
                asset: 'chips',
                is_platform: false,
                union_id: null,
              },
              kill_mode: 'off',
              kill_threshold_bb: null,
            },
            error: null,
          };
        },
      };
      return builder;
    };
    failRead = true;
    try {
      await assert.rejects(e.start(), /Operator hold read is unconfirmed/);
      assert.equal(await e.ready, false);
      assert.equal(dealt, 0);
    } finally {
      failRead = false;
      supabase.from = originalFrom;
      await retire(e);
    }
  });

  test('original command replay cannot reapply a pause after a later resume', async () => {
    const key = randomUUID();
    const first = await write(table, true, owner, key);
    const resumed = await write(table, false, owner);
    assert.equal((await write(table, true, owner, key)).paused, false);
    const row = (
      await db.query(
        'SELECT count(*)::int AS n FROM public.ca_table_operator_hold_commands WHERE command_id=$1',
        [key]
      )
    ).rows[0];
    assert.equal(row.n, 1);
    assert.ok(resumed.version > first.version);
    await assert.rejects(write(table, false, owner, key), /operator_hold_command_mismatch/);
  });

  test('native authority matches ordinary club co-owner, Diamond staff and player refusal', async () => {
    await assert.rejects(write(table, true, staff), /operator_hold_forbidden/);
    await assert.rejects(write(diamond, true, owner), /operator_hold_forbidden/);
    assert.equal((await write(diamond, true, staff)).paused, true);
    assert.equal((await write(table, true, owner)).paused, true);
  });

  test('store and receipts have RLS and no direct client/service DML grants', async () => {
    const rows = (
      await db.query(
        "SELECT relrowsecurity FROM pg_class WHERE oid IN ('public.ca_table_operator_holds'::regclass,'public.ca_table_operator_hold_commands'::regclass)"
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.relrowsecurity));
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const q = await db.query(
        "SELECT has_table_privilege($1,'public.ca_table_operator_holds','INSERT,UPDATE,DELETE') AS allowed",
        [role]
      );
      assert.equal(q.rows[0].allowed, false);
    }
    for (const role of ['anon', 'authenticated']) {
      const q = await db.query(
        "SELECT has_function_privilege($1,'public.fn_ca_set_table_operator_hold(uuid,boolean,uuid,uuid,uuid,text,bigint)','EXECUTE') AS allowed",
        [role]
      );
      assert.equal(q.rows[0].allowed, false);
    }
  });

  test('union-only tables preserve native union operator authority without requiring a club row', async () => {
    const union = randomUUID(),
      board = randomUUID(),
      member = randomUUID();
    await db.query('INSERT INTO public.unions(id,owner_id) VALUES($1,$2)', [union, owner]);
    await db.query(
      "INSERT INTO public.tables(id,club_id,union_id,status) VALUES($1,NULL,$2,'running')",
      [board, union]
    );
    await db.query('INSERT INTO public.engine_table_leases VALUES($1,$2,$3,2,clock_timestamp())', [
      board,
      INSTANCE_ID,
      leaseGeneration,
    ]);
    assert.equal((await write(board, true, owner)).paused, true);
    await db.query('INSERT INTO public.union_admins VALUES($1,$2)', [union, member]);
    assert.equal((await write(board, false, member)).paused, false);
    await assert.rejects(write(board, true, staff), (error) => error.code === '42501');
    const event = (
      await db.query(
        "SELECT scope_kind,scope_id FROM public.game_management_events WHERE entity_id=$1 ORDER BY (payload->>'operator_hold_version')::integer LIMIT 1",
        [board]
      )
    ).rows[0];
    assert.equal(event.scope_kind, 'union');
    assert.equal(event.scope_id, union);
  });

  test('duplicate concurrent original commands produce one native version and receipt', async () => {
    const clients = await Promise.all(
      [0, 1].map(async () => {
        const c = new Client(db.connectionParameters);
        await c.connect();
        return c;
      })
    );
    try {
      const key = randomUUID();
      const before = (
        await db.query('SELECT version FROM public.ca_table_operator_holds WHERE table_id=$1', [
          table,
        ])
      ).rows[0].version;
      const replies = await Promise.all(
        clients.map((c) =>
          c.query('SELECT public.fn_ca_set_table_operator_hold($1,true,$2,$3,$4,$5,$6) AS value', [
            table,
            owner,
            key,
            leaseGeneration,
            INSTANCE_ID,
            Number(before),
          ])
        )
      );
      assert.equal(replies[0].rows[0].value.version, replies[1].rows[0].value.version);
      assert.equal(Number(replies[0].rows[0].value.version), Number(before) + 1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  test('late unknown original pause cannot overwrite a newer original resume', async () => {
    const before = Number(
      (
        await db.query('SELECT version FROM public.ca_table_operator_holds WHERE table_id=$1', [
          table,
        ])
      ).rows[0].version
    );
    const originalPause = randomUUID();
    const resume = await write(table, false, owner, randomUUID(), before);
    await assert.rejects(
      write(table, true, owner, originalPause, before),
      /operator_hold_version_changed/
    );
    assert.equal(
      (
        await db.query('SELECT paused FROM public.ca_table_operator_holds WHERE table_id=$1', [
          table,
        ])
      ).rows[0].paused,
      false
    );
    assert.equal(
      Number(
        (
          await db.query('SELECT version FROM public.ca_table_operator_holds WHERE table_id=$1', [
            table,
          ])
        ).rows[0].version
      ),
      resume.version
    );
  });

  test('original resume refuses when an earlier unknown pause commits after its read', async () => {
    await write(table, false, owner);
    const version = Number(
      (await db.query('SELECT public.fn_ca_get_table_operator_hold($1) AS value', [table])).rows[0]
        .value.version
    );
    await write(table, true, owner, randomUUID(), version);
    await assert.rejects(
      write(table, false, owner, randomUUID(), version),
      /operator_hold_version_changed/
    );
    assert.equal(
      (
        await db.query('SELECT paused FROM public.ca_table_operator_holds WHERE table_id=$1', [
          table,
        ])
      ).rows[0].paused,
      true
    );
  });

  test('legacy import replay cannot resurrect an old hold after an acknowledged resume', async () => {
    const latest = await write(table, false, owner);
    const replay = (
      await db.query('SELECT public.fn_ca_import_operator_holds($1,$2,$3,$4::jsonb) AS value', [
        inheritedHandoff,
        INSTANCE_ID,
        oldSource,
        JSON.stringify(inheritedFleet),
      ])
    ).rows[0].value;
    assert.equal(replay.replayed, true);
    const current = (
      await db.query('SELECT public.fn_ca_get_table_operator_hold($1) AS value', [table])
    ).rows[0].value;
    assert.equal(current.paused, false);
    assert.equal(current.version, latest.version);
    await assert.rejects(
      db.query('SELECT public.fn_ca_import_operator_holds($1,$2,$3,$4::jsonb)', [
        randomUUID(),
        INSTANCE_ID,
        oldSource,
        JSON.stringify(inheritedFleet),
      ]),
      /conflicts_with_current_authority/
    );
    await assert.rejects(
      db.query('SELECT public.fn_ca_import_operator_holds($1,$2,$3,$4::jsonb)', [
        randomUUID(),
        'different-instance',
        oldSource,
        JSON.stringify(inheritedFleet),
      ]),
      /engine_fenced/
    );
  });

  test('the previous native generation cannot commit after replacement admission', async () => {
    const successor = randomUUID();
    await db.query('UPDATE public.engine_table_leases SET lease_generation=$2 WHERE table_id=$1', [
      table,
      successor,
    ]);
    const prior = (
      await db.query('SELECT version FROM public.ca_table_operator_holds WHERE table_id=$1', [
        table,
      ])
    ).rows[0].version;
    await assert.rejects(write(table, true, owner), /operator_hold_engine_fenced/);
    assert.equal(
      (
        await db.query('SELECT version FROM public.ca_table_operator_holds WHERE table_id=$1', [
          table,
        ])
      ).rows[0].version,
      prior
    );
  });
}
