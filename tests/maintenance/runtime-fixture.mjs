// Native-only fixture setup reused by real runtime composition. No production DSN.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../operations/release/package.json', import.meta.url));
const { Client } = require('pg');
export const actor = 'native-maintenance-proof',
  sha = 'a'.repeat(40);
export const digest = '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda';
export const call = async (c, name, args = []) =>
  (await c.query(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) v`, args)).rows[0]
    .v;
export const as = async (c, role, body) => {
  await c.query('SET ROLE ' + role);
  try {
    return await body();
  } finally {
    await c.query('RESET ROLE');
  }
};
export const one = async (c, q, args = []) => (await c.query(q, args)).rows[0];
export let base;
export async function connect(state, database) {
  const c = new Client({
    host: state.socket,
    port: state.port,
    database: database ?? state.database,
    user: 'postgres',
  });
  await c.connect();
  return c;
}
export async function readBase(c) {
  const q = await one(c, 'SELECT * FROM release_ops.queue');
  const plan = await one(c, 'SELECT * FROM release_ops.provider_plans');
  const compatibility = await one(c, 'SELECT id FROM release_ops.maintenance_compatibility');
  const installation = await one(c, 'SELECT id FROM release_ops.provider_installations');
  const tables = (
    await c.query(
      "SELECT id,tournament_id FROM public.tables WHERE name LIKE 'Native maintenance %' ORDER BY name"
    )
  ).rows;
  assert.equal(tables.length, 3);
  base = {
    release: q.release_id,
    manifest_digest: q.resolution_manifest_digest,
    ready: q.selected_receipts.READINESS,
    build: q.selected_receipts.BUILD,
    plan: plan.id,
    request: plan.request,
    installation: installation.id,
    compatibility: compatibility.id,
    tables: tables.map((t) => t.id),
    event: tables[0].tournament_id,
  };
  return base;
}
async function owner(c) {
  const o = await call(c, 'release_ops.acquire_owner', [randomUUID(), actor]);
  await c.query('UPDATE release_ops.controller SET reconciliation_required=false');
  return o;
}
async function activation(c, o) {
  return as(c, 'release_journal_controller', () =>
    call(c, 'release_ops.activate_operation_maintenance', [
      o.owner_id,
      o.epoch,
      base.compatibility,
      actor,
    ])
  );
}
async function need(c) {
  return as(c, 'release_journal_verifier', () =>
    call(c, 'release_ops.register_engine_maintenance_need', [
      base.release,
      base.ready,
      base.plan,
      {
        purpose: 'engine_replacement',
        policy_digest: digest,
        scope: { type: 'platform' },
        receipt_refs: ['native-qualified-need'],
        actual_recovery_ms: 150000,
        recovery_margin_ms: 10000,
      },
      actor,
    ])
  );
}
async function admission(c, o, n) {
  return as(c, 'release_journal_controller', () =>
    call(c, 'release_ops.admit_engine_maintenance', [
      o.owner_id,
      o.epoch,
      base.release,
      n,
      150000,
      150000,
      10000,
      actor,
    ])
  );
}
const engine = (c, name, args) => as(c, 'service_role', () => call(c, 'public.' + name, args));
async function ready(c, s, groups) {
  const ids = groups.flat();
  return engine(c, 'fn_engine_maintenance_ready', [
    s.interval_id,
    s.ownership_token,
    ids,
    {
      policy_version: 2,
      policy_digest: digest,
      runtime_version: sha,
      between_hands: true,
      parked: true,
      pending_mutations: 0,
      resume_wave_table_ids: groups,
    },
  ]);
}
async function current(c, s) {
  return (await engine(c, 'fn_engine_maintenance_operation', [s.interval_id])).operation;
}
async function fixtureHold(
  c,
  {
    seconds = 0,
    phase = 'last_hand',
    plan = true,
    historicalReady = false,
    admittedTables = base.tables,
  } = {}
) {
  const o = await owner(c);
  await activation(c, o);
  const n = await need(c);
  // Fixture administrator constructs a previously admitted historical hold. The
  // tested RPCs never accept a caller freeze time; normal admission is tested separately.
  await c.query('BEGIN');
  const { rows } = await c.query(
    `INSERT INTO release_ops.maintenance_operations(release_id,need_receipt,activation_receipt,controller_owner,controller_epoch,phase,scope,freeze_started_at,target_at,forward_deadline_at,deadline_at,reason,declared_by)
 SELECT $1,$2,$3,$4,$5,$6,'{"type":"platform"}',t,t+interval '300seconds',t+interval '1200seconds',t+interval '1800seconds','Engine maintenance',$7 FROM (SELECT date_trunc('milliseconds',clock_timestamp())-make_interval(secs=>$8) t) x RETURNING *`,
    [base.release, n, base.compatibility, o.owner_id, o.epoch, phase, actor, seconds]
  );
  let s = rows[0];
  await c.query(
    'INSERT INTO release_ops.maintenance_tables SELECT $1,id,tournament_id FROM public.tables WHERE id=ANY($2::uuid[])',
    [s.interval_id, admittedTables]
  );
  await call(c, 'release_ops.maintenance_permit', [s.interval_id, true]);
  await c.query(
    `INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,enforce_freeze,ownership_token) VALUES(true,'counting_down',$1,$1,$2,'Engine maintenance',$3,true,$4)`,
    [s.freeze_started_at, s.target_at, actor, s.ownership_token]
  );
  await call(c, 'release_ops.maintenance_permit', [s.interval_id, false]);
  if (historicalReady) {
    await c.query(
      "UPDATE release_ops.maintenance_operations SET ready_at=freeze_started_at+interval '120seconds' WHERE interval_id=$1",
      [s.interval_id]
    );
    for (let i = 0; i < 2; i++)
      await c.query(
        'INSERT INTO release_ops.maintenance_waves(interval_id,wave_index,table_ids,ownership_token) VALUES($1,$2,$3,$4)',
        [
          s.interval_id,
          i,
          (i === 0 ? base.tables.slice(0, 2) : base.tables.slice(2)).sort(),
          s.ownership_token,
        ]
      );
  }
  await c.query('COMMIT');
  if (plan) {
    s = (await ready(c, s, [base.tables.slice(0, 2), base.tables.slice(2)])).operation;
  }
  return { o, n, s: JSON.parse(JSON.stringify(s)) };
}
async function publication(c, s) {
  const e = randomUUID(),
    ev = await call(c, 'release_ops.event', [base.release, 'NATIVE_PUBLISH_PROOF', actor, {}]);
  const intent = {
    target: 'club-arena-engine',
    manifest_digest: base.manifest_digest,
    provider_request: base.request,
    plan_id: base.plan,
    installation_id: base.installation,
  };
  const result = {
    terminal: true,
    outcome: 'SUCCEEDED',
    provider: 'hetzner-engine',
    operation_id: e,
    manifest_digest: base.manifest_digest,
    run_key: base.request.run_key,
    source_sha: sha,
    control_sha: sha,
    image_id: base.request.artifact_image_id,
    result: 'sealed',
    receipt_refs: ['native:' + ev],
  };
  await c.query(
    `INSERT INTO release_ops.external_operations(id,release_id,operation_key,owner_id,epoch,kind,intent,intent_event,resume_state,status,result,terminal_event)
 SELECT $1,$2,$3,owner_id,epoch,'PUBLISH',$4,$5,'APPLYING','SUCCEEDED',$6,$5 FROM release_ops.controller WHERE singleton`,
    [e, base.release, 'publish:' + e, intent, ev, result]
  );
  const proof = {
    policy_digest: digest,
    source_sha: sha,
    image_id: base.request.artifact_image_id,
    readiness_event: base.ready,
    schema_compatible: true,
    retained_recovery_compatible: true,
    checks: Object.fromEntries(
      [
        'native_seal',
        'local_runtime',
        'public_runtime',
        'database_leader',
        'retired_writers',
        'schema',
        'retained_recovery',
      ].map((k) => [k, ['native:' + k]])
    ),
  };
  const receipt = await as(c, 'release_journal_verifier', () =>
    call(c, 'release_ops.register_maintenance_safe_resume', [s.operation_id, e, proof, actor])
  );
  return { e, receipt, proof };
}
async function release(c, o, s) {
  const p = await publication(c, s);
  return {
    p,
    s: (
      await as(c, 'release_journal_controller', () =>
        call(c, 'release_ops.authorize_maintenance_release', [
          o.owner_id,
          o.epoch,
          s.operation_id,
          p.receipt,
          actor,
        ])
      )
    ).operation,
  };
}
async function thaw(c, s) {
  let result;
  for (let i = 0; i < 20; i++) {
    result = await engine(c, 'fn_thaw_platform', [
      s.freeze_started_at,
      s.freeze_started_at,
      1,
      s.ownership_token,
      actor,
    ]);
    if (result.complete) return result;
  }
  throw new Error('Thaw did not complete: ' + JSON.stringify(result));
}
async function seedClocks(c, s) {
  const seat = (
    await one(c, 'SELECT to_jsonb(x) v FROM public.table_seats x WHERE user_id IS NOT NULL LIMIT 1')
  ).v;
  const user = seat.user_id;
  const club = (await one(c, 'SELECT club_id FROM public.tournaments WHERE id=$1', [base.event]))
    .club_id;
  const game = randomUUID(),
    chest = randomUUID(),
    award = randomUUID(),
    tx = randomUUID(),
    stay = randomUUID(),
    rejoin = randomUUID(),
    move = randomUUID(),
    snapshot = randomUUID(),
    wait = randomUUID();
  const start = Date.parse(s.freeze_started_at),
    live = new Date(start + 20000).toISOString(),
    before = new Date(start - 10000).toISOString();
  const reconnect = {
    live: {
      state: 'MISSING',
      reconnectDeadlineMs: start + 20000,
      reconnectGrantedAtMs: start - 1000,
      graceDeadlineMs: start + 10000,
    },
    expired: {
      state: 'MISSING',
      reconnectDeadlineMs: start - 1,
      reconnectGrantedAtMs: start - 100000,
    },
  };
  await c.query('BEGIN;SET LOCAL session_replication_role=replica');
  await c.query(
    `INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot) VALUES($1,$2,'Native clock fixture','classic','nlh',1,2,6,'{}')`,
    [game, club]
  );
  await c.query(
    `UPDATE public.tables SET cluster_id=$1,club_id=$2,seat_game_scope=NULL,seat_admission_key=NULL,break_eligible_since=$3,bomb_pot_next_due_at=$4 WHERE id=$5`,
    [game, club, before, live, base.tables[2]]
  );
  await c.query(
    `UPDATE public.table_seats SET table_id=$1,sit_out_at=$2,is_sitting_out=true,left_at=NULL,active_game_scope='cluster:'||$3::text WHERE id=$4`,
    [base.tables[2], before, game, seat.id]
  );
  await c.query(
    `INSERT INTO public.table_waitlist(id,table_id,user_id,hold_expires_at) VALUES($1,$2,$3,$4)`,
    [wait, base.tables[2], user, live]
  );
  await c.query(
    `UPDATE public.tournaments SET status='RUNNING',on_break=false,level_started_at=$1,addon_period_ends_at=$2 WHERE id=$3`,
    [before, live, base.event]
  );
  await c.query(
    `UPDATE public.tournament_players SET rebuy_prompt_until=$1 WHERE id=(SELECT id FROM public.tournament_players WHERE tournament_id=$2 LIMIT 1)`,
    [live, base.event]
  );
  await c.query(
    `INSERT INTO public.chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,reversible_until) VALUES($1,$2,$3,$3,1,'peer_transfer',$4)`,
    [tx, club, user, live]
  );
  await c.query(
    `INSERT INTO public.tournament_bounty_chests(id,tournament_id,seq,tier,amount_cents) VALUES($1,$2,99999,'base',100)`,
    [chest, base.event]
  );
  await c.query(
    `INSERT INTO public.tournament_bounty_awards(id,tournament_id,chest_id,eliminated_user_id,amount_cents,tier,op_id,reveal_deadline_at) VALUES($1,$2,$3,$4,100,'base',$5,$6)`,
    [award, base.event, chest, user, randomUUID(), live]
  );
  await c.query(
    `INSERT INTO public.cash_player_session(id,player_id,scope_type,scope_id,table_id,stay_running,stay_last_tick_at) VALUES($1,$2,'table',$3,$3,true,$4)`,
    [stay, user, base.tables[2], before]
  );
  await c.query(
    `INSERT INTO public.cash_rejoin_constraints(id,player_id,club_id,variant,sb,bb,required_stack,expires_at) VALUES($1,$2,$3,'nlh',1,2,100,$4)`,
    [rejoin, user, club, live]
  );
  await c.query(
    `INSERT INTO public.cash_seat_moves(id,game_id,player_id,from_table_id,to_table_id,reason,expires_at,source_occupancy_id,source_seat_number) VALUES($1,$2,$3,$4,$5,'balance',$6,$7,1)`,
    [move, game, user, base.tables[2], base.tables[0], live, seat.occupancy_id]
  );
  await c.query(
    `INSERT INTO public.engine_presence_parked(table_id,parked_at,disconnect_states) VALUES($1,$2,$3)`,
    [base.tables[0], s.freeze_started_at, reconnect]
  );
  await c.query(
    `INSERT INTO public.hand_state_snapshots(id,table_id,hand_number,state_json,config_json,dealer_seat,players_json,updated_at,disconnect_states,is_complete) VALUES($1,$2,42,'{}','{}',1,'[]',$3,$4,false)`,
    [snapshot, base.tables[2], s.freeze_started_at, reconnect]
  );
  await c.query('COMMIT');
  return {
    seat: seat.id,
    user,
    game,
    chest,
    award,
    tx,
    stay,
    rejoin,
    move,
    snapshot,
    wait,
    live,
    before,
    reconnect,
  };
}
async function clockReceipt(c, s, fixture) {
  const r = await one(
    c,
    `SELECT
 (SELECT sit_out_at FROM public.table_seats WHERE id=$1) seat,
 (SELECT level_started_at FROM public.tournaments WHERE id=$2) level,
 (SELECT reversible_until FROM public.chip_transactions WHERE id=$3) reversible,
 (SELECT disconnect_states FROM public.engine_presence_parked WHERE table_id=$4) reconnect,
 (SELECT jsonb_agg(to_jsonb(x) ORDER BY step,target_id) FROM public.engine_maintenance_thaw_targets x WHERE freeze_started_at=$5) targets`,
    [fixture.seat, base.event, fixture.tx, base.tables[0], s.freeze_started_at]
  );
  return JSON.parse(JSON.stringify(r));
}

export {
  owner,
  activation,
  need,
  admission,
  engine,
  ready,
  current,
  fixtureHold,
  publication,
  release,
  thaw,
  seedClocks,
  clockReceipt,
};
