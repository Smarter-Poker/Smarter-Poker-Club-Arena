import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PILOT, PILOT_TARGETS } from './prepare-lightning-private-pilot.mjs';
import {
  latencyAttemptPlan,
  attemptLatencyFold,
  readWorkloadLatency,
  witnessLatencyWorkload,
} from './lightning-pilot-latency-workload.mjs';
const SECRET = 'PRIVATE_TEST_PAYLOAD';
const PLAYER = '0097309f-2864-4d09-b02b-56bca012a9c3';
const ROOM = '11111111-1111-4111-8111-111111111111';
const HAND = '22222222-2222-4222-8222-222222222222';
const pin = {
  playerId: PLAYER,
  poolSessionId: ROOM,
  clubId: 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',
  clusterId: '44444444-4444-4444-8444-444444444444',
};
function targetReader(index = 0, patch = {}) {
  const t = PILOT_TARGETS[index],
    a = t.templateName === 'action';
  const game = {
    id: pin.clusterId,
    club_id: pin.clubId,
    name: t.gameName,
    template_name: t.templateName,
    handedness: t.handedness,
    sb: t.sb,
    bb: t.bb,
    variant: 'nlh',
    enabled: false,
    closed_at: '2026-01-01',
    must_move: true,
    cluster_mode: 'must_move',
    lightning_enabled: false,
    ruleset_snapshot: {
      template: t.templateName,
      variant: 'nlh',
      regular_ante: a ? 'sb' : 'bb',
      vpip_floor: a ? 30 : 50,
      vpip_window: 10,
      bombs: {
        enabled: true,
        trigger: a ? 'timed_20m' : 'timed_10m',
        ante_bb: a ? 2 : 3,
        boards: 2,
      },
      options: { is_private: true },
    },
    ...patch,
  };
  return (table) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({
        data:
          table === 'clubs'
            ? {
                id: pin.clubId,
                owner_id: PILOT.ownerId,
                name: PILOT.name,
                is_public: false,
                requires_approval: true,
              }
            : game,
      }),
    };
    return q;
  };
}
test('finite alternating plan cannot exceed the three-window sample workload bound', () => {
  const plan = latencyAttemptPlan();
  assert.equal(plan.length, 120);
  assert.equal(plan.filter((k) => k === 'fast_fold').length, 60);
  assert.equal(plan.filter((k) => k === 'fold_watch').length, 60);
  for (let i = 1; i < plan.length; i++) assert.notEqual(plan[i], plan[i - 1]);
  for (const count of [0, 121, NaN, 2.1]) assert.throws(() => latencyAttemptPlan(count));
});
test('one ordinary click records actual accepted/refused response and never retries a hand', async () => {
  for (const kind of ['fast_fold', 'fold_watch'])
    for (const accepted of [true, false]) {
      const calls = [],
        seen = new Set();
      const response = {
        request: () => ({
          method: () => 'POST',
          postDataJSON: () => ({ tableId: ROOM, action: kind }),
        }),
        url: () => 'https://engine.smarter.poker/action',
        ok: () => accepted,
        json: async () => ({ success: accepted, secret: SECRET }),
      };
      const page = {
        locator: () => ({
          count: async () => 1,
          isVisible: async () => true,
          getAttribute: async () => 'true',
        }),
        getByTestId: (selector) => {
          calls.push(selector);
          return {
            waitFor: async () => {},
            click: async (opts) => {
              calls.push(opts.trial ? 'trial' : 'click');
            },
          };
        },
        waitForResponse: async (predicate) => {
          assert.equal(predicate(response), true);
          return response;
        },
      };
      const args = {
        page,
        pin,
        kind,
        handId: HAND,
        seen,
        currentHand: () => HAND,
        remaining: () => 1000,
      };
      const result = await attemptLatencyFold(args);
      assert.equal(result.outcome, accepted ? 'accepted' : 'refused');
      assert.equal(result.renderedIntentHandId, HAND);
      assert.equal(Object.hasOwn(result, 'handId'), false);
      assert.equal(calls.filter((v) => v === 'click').length, 1);
      assert.equal((await attemptLatencyFold(args)).cause, 'hand_already_attempted');
      assert.equal(calls.filter((v) => v === 'click').length, 1);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
    }
});
test('stale hand and missing action never send a normal click', async () => {
  let clicks = 0;
  const page = {
    getByTestId: () => ({
      waitFor: async () => {},
      click: async (opts) => {
        if (!opts.trial) clicks++;
      },
    }),
  };
  const stale = await attemptLatencyFold({
    page,
    pin,
    kind: 'fast_fold',
    handId: HAND,
    seen: new Set(),
    currentHand: () => ROOM,
    remaining: () => 1000,
  });
  assert.equal(stale.cause, 'fresh_hand_changed');
  assert.equal(clicks, 0);
  page.getByTestId = () => ({
    waitFor: async () => {
      throw new Error(SECRET);
    },
  });
  const unavailable = await attemptLatencyFold({
    page,
    pin,
    kind: 'fold_watch',
    handId: HAND,
    seen: new Set(),
    currentHand: () => HAND,
    remaining: () => 1000,
  });
  assert.equal(unavailable.outcome, 'unknown');
  assert.doesNotMatch(JSON.stringify(unavailable), new RegExp(SECRET));
});
test('latency readback keeps only actual ordered aggregates and unknown stays unknown', async () => {
  const admin = {
    from: targetReader(),
    rpc: async (name, args) => {
      assert.equal(name, 'fn_lightning_operator_cluster');
      assert.equal(args.p_cluster_id, pin.clusterId);
      return {
        data: {
          ok: true,
          cluster_id: pin.clusterId,
          cards: SECRET,
          latency_windows: [
            {
              window_from: '2026-01-01T00:00:00Z',
              window_to: '2026-01-01T00:01:00Z',
              legs: { fold_ack: { n: 2, p50: 1, p95: 2, p99: 3, secret: SECRET }, private: SECRET },
            },
          ],
        },
      };
    },
  };
  const result = await readWorkloadLatency(admin, pin.clusterId, '2026-01-01', '2026-01-02');
  assert.equal(result.status, 'known');
  assert.equal(result.windows[0].legs.fold_ack.n, 2);
  assert.deepEqual(Object.keys(result.windows[0].legs), ['fold_ack']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  admin.rpc = async () => ({ error: SECRET });
  assert.equal((await readWorkloadLatency(admin, pin.clusterId, '', '')).status, 'unknown');
});
test('forensic aggregates accept maintained Action and Madness after closure; Classic and malformed pins never call operator RPC', async () => {
  for (const index of [0, 1]) {
    let calls = 0;
    const admin = {
      from: targetReader(index),
      rpc: async () => {
        calls++;
        return { data: { ok: true, cluster_id: pin.clusterId, latency_windows: [] } };
      },
    };
    assert.equal(
      (await readWorkloadLatency(admin, pin.clusterId, '2026-01-01', '2026-01-02')).status,
      'known'
    );
    assert.equal(calls, 1);
    admin.from = targetReader(index, { template_name: 'classic' });
    calls = 0;
    assert.equal(
      (await readWorkloadLatency(admin, pin.clusterId, '2026-01-01', '2026-01-02')).status,
      'unknown'
    );
    assert.equal(calls, 0);
  }
  let malformedReads = 0;
  const noReads = {
    from() {
      malformedReads++;
      throw Error('must not read malformed pin');
    },
    rpc() {
      malformedReads++;
      throw Error('must not call malformed pin');
    },
  };
  assert.equal((await readWorkloadLatency(noReads, 'malformed', '', '')).status, 'unknown');
  assert.equal(malformedReads, 0);
});
test('prior consent is mandatory and partial auth owns only its created local session', async () => {
  const signouts = [];
  const admin = {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: { id: PLAYER, club_arena_tos_accepted_at: '2026-01-01' },
        }),
      };
      return q;
    },
    rpc: async () => ({ data: { ok: true, cluster_id: pin.clusterId, latency_windows: [] } }),
  };
  const report = await witnessLatencyWorkload({
    admin,
    pin,
    validate: async () => {},
    createClient: () => ({
      auth: {
        signOut: async (opts) => {
          signouts.push(opts);
          return {};
        },
      },
    }),
    openSession: async (_admin, factory) => {
      factory('https://example.invalid', 'public');
      throw new Error(SECRET);
    },
  });
  assert.equal(report.status, 'unknown');
  assert.deepEqual(signouts, [{ scope: 'local' }]);
  assert.equal(report.cleanup, 'local_session_and_browser_closed');
  assert.equal(report.actionHandBinding, 'not_captured_by_this_sample');
  assert.equal(report.staleActionCertificate, 'not_asserted');
  assert.equal(report.attempts.length, 0);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(SECRET));
});
test('selectors and action transport remain bound to maintained product owners', () => {
  const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
  const controls = read('src/components/table/LightningFoldBar.tsx');
  assert.match(controls, /data-testid="lightning-fold"/);
  assert.match(controls, /data-testid="lightning-fold-watch"/);
  const api = read('src/services/GameServerAPI.ts');
  assert.match(
    api,
    /JSON.stringify\(\{ tableId, action, amount, idempotencyKey, actionContext \}\)/
  );
  assert.match(
    read('src/services/EngineStateClient.ts'),
    /type: 'RENDER_ACK', tableId: this.opts.tableId, hand_id: handId/
  );
});

test('unaccepted terms and another player cannot start authentication or browser activity', async () => {
  let opened = false;
  const admin = {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { id: PLAYER, club_arena_tos_accepted_at: null } }),
      };
      return q;
    },
    rpc: async () => ({ error: true }),
  };
  for (const candidate of [pin, { ...pin, playerId: HAND }]) {
    const report = await witnessLatencyWorkload({
      admin,
      pin: candidate,
      validate: async () => {},
      openSession: async () => {
        opened = true;
      },
    });
    assert.equal(report.status, 'unknown');
    assert.equal(opened, false);
    assert.equal(report.attempts.length, 0);
  }
});

test('Samantha uses her own prior-consent profile; no new consent is written', async () => {
  const samantha = 'a23ca5c9-b748-482f-9b59-9db35f7aa996';
  for (const accepted of [false, true]) {
    let opened = false;
    const admin = {
      from: (table) => {
        assert.equal(table, 'profiles');
        const q = {
          select: () => q,
          eq: (key, value) => {
            assert.equal(key, 'id');
            assert.equal(value, samantha);
            return q;
          },
          maybeSingle: async () => ({
            data: { id: samantha, club_arena_tos_accepted_at: accepted ? '2026-01-01' : null },
          }),
        };
        return q;
      },
      rpc: async () => ({ error: true }),
    };
    const report = await witnessLatencyWorkload({
      admin,
      pin: { ...pin, playerId: samantha },
      validate: async () => {},
      openSession: async () => {
        opened = true;
        throw new Error('fixture');
      },
    });
    assert.equal(opened, accepted);
    assert.equal(report.status, 'unknown');
  }
});

function anchorReader(stack, patch = {}) {
  return {
    from: (table) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data:
            table === 'lightning_pool_session'
              ? { id: ROOM, anchor_seat_id: HAND }
              : {
                  id: HAND,
                  user_id: PLAYER,
                  stack,
                  left_at: null,
                  is_sitting_out: false,
                  leave_pending: false,
                  ...patch,
                },
        }),
      };
      return q;
    },
  };
}
test('latency eligibility requires a positive live anchor without changing wallet/top-up eligibility', async () => {
  const { validateLatencyPlayer } = await import('./lightning-pilot-latency-workload.mjs');
  let baseChecks = 0;
  await validateLatencyPlayer(anchorReader('0.01'), pin, async () => {
    baseChecks++;
  });
  assert.equal(baseChecks, 1);
  for (const [stack, patch] of [
    ['0.00', {}],
    ['-1', {}],
    ['NaN', {}],
    ['Infinity', {}],
    ['1.00', { left_at: '2026-10-18' }],
    ['1.00', { is_sitting_out: true }],
    ['1.00', { leave_pending: true }],
    ['1.00', { user_id: ROOM }],
  ])
    await assert.rejects(
      validateLatencyPlayer(anchorReader(stack, patch), pin, async () => {}),
      /Playable Pilot Anchor Unavailable/
    );
});
test('zero-stack latency stops before opening a browser or creating a session', async () => {
  const { validateLatencyPlayer } = await import('./lightning-pilot-latency-workload.mjs');
  let sessions = 0;
  const admin = anchorReader('0.00');
  const result = await witnessLatencyWorkload({
    admin,
    pin,
    url: 'https://supabase.invalid',
    timeoutMs: 30000,
    validate: (a, p) => validateLatencyPlayer(a, p, async () => {}),
    openSession: async () => {
      sessions++;
      throw Error('must not authenticate');
    },
  });
  assert.equal(sessions, 0);
  assert.equal(result.phase, 'preflight');
  assert.equal(result.cause, 'player_anchor_not_playable');
  assert.equal(result.cleanup, 'no_local_session_created');
  assert.deepEqual(result.attempts, []);
});

test('latency refuses a fold gesture after selection changes despite an own-pool render', async () => {
  let clicks = 0;
  const r = await attemptLatencyFold({
    page: {
      locator: () => ({
        count: async () => 1,
        isVisible: async () => true,
        getAttribute: async () => 'false',
      }),
      getByTestId: () => ({
        waitFor: async () => {},
        click: async (o) => {
          if (!o.trial) clicks++;
        },
      }),
      waitForResponse: async () => ({ ok: () => true, json: async () => ({ success: true }) }),
    },
    pin,
    kind: 'fast_fold',
    handId: HAND,
    currentHand: () => HAND,
    seen: new Set(),
    remaining: () => 1000,
  });
  assert.equal(clicks, 0);
  assert.equal(r.outcome, 'unknown');
});

test('a failed run names its own refusal and redacts anything else (2026-10-24)', async () => {
  const { witnessReason } = await import('./lightning-pilot-latency-workload.mjs');
  assert.equal(
    witnessReason(new Error('Existing Funded Active Pilot Player Unavailable')),
    'Existing Funded Active Pilot Player Unavailable'
  );
  assert.equal(
    witnessReason(new Error('Playable Pilot Anchor Unavailable')),
    'Playable Pilot Anchor Unavailable'
  );
  for (const leaky of [
    'fetch failed: https://example.supabase.co/rest/v1/x?apikey=eyJhbGciOi',
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'TypeError: Cannot read properties of undefined (reading id)',
    'token=abc123',
    '',
  ]) {
    assert.equal(witnessReason(new Error(leaky)), 'redacted', leaky);
  }
  assert.equal(witnessReason(undefined), 'redacted');
  assert.equal(witnessReason('Plain String Not An Error'), 'redacted');
});
