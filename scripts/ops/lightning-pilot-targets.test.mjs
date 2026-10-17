import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePilotTarget,
  assertCurrentPilotTarget,
  PILOT_CLUB_ID,
} from './lightning-pilot-targets.mjs';
import { PILOT, PILOT_TARGETS } from './prepare-lightning-private-pilot.mjs';
const IDS = ['01234567-1111-4111-8111-111111111111', '01234567-2222-4222-8222-222222222222'];
function game(index = 0) {
  const t = PILOT_TARGETS[index],
    a = index === 0;
  return {
    id: IDS[index],
    club_id: PILOT_CLUB_ID,
    name: t.gameName,
    template_name: t.templateName,
    handedness: t.handedness,
    sb: t.sb,
    bb: t.bb,
    variant: 'nlh',
    enabled: true,
    must_move: true,
    cluster_mode: 'lightning',
    lightning_enabled: true,
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
  };
}
function adminFor(candidate, { unique = candidate.id, readError = false } = {}) {
  const reads = [];
  return {
    reads,
    from: (table) => {
      const filters = {};
      let columns;
      const q = {
        select: (s) => {
          columns = s;
          return q;
        },
        eq: (k, v) => {
          filters[k] = v;
          return q;
        },
        maybeSingle: async () => {
          reads.push({ table, columns, filters });
          return {
            error: readError ? { message: 'untrusted' } : null,
            data:
              table === 'clubs'
                ? {
                    id: PILOT_CLUB_ID,
                    owner_id: PILOT.ownerId,
                    name: PILOT.name,
                    is_public: false,
                    requires_approval: true,
                  }
                : columns === 'id'
                  ? { id: unique }
                  : candidate,
          };
        },
      };
      return q;
    },
  };
}
test('normal-created UUIDs bind by actual target names and immutable Action/Madness rules', async () => {
  for (let i = 0; i < 2; i++) {
    const g = game(i),
      admin = adminFor(g);
    const r = await resolvePilotTarget(admin, g.id);
    assert.equal(r.target.templateName, i ? 'madness' : 'action');
    assert.deepEqual(admin.reads.at(-1).filters, {
      club_id: PILOT_CLUB_ID,
      name: PILOT_TARGETS[i].gameName,
    });
    assert.equal(admin.reads[1].filters.id, g.id);
  }
});
test('Classic, arbitrary UUID identities, altered rules and ambiguous names never bind', async () => {
  const g = game();
  for (const patch of [
    { name: 'Lightning Pilot NLH 6', template_name: 'classic' },
    { name: 'Other Action' },
    { club_id: IDS[1] },
    { variant: 'plo4' },
    { handedness: 9 },
    { sb: 0.02 },
    { ruleset_snapshot: { ...g.ruleset_snapshot, vpip_floor: 0 } },
    { ruleset_snapshot: { ...g.ruleset_snapshot, options: { is_private: false } } },
  ])
    await assert.rejects(resolvePilotTarget(adminFor({ ...g, ...patch }), g.id));
  await assert.rejects(resolvePilotTarget(adminFor(g, { unique: IDS[1] }), g.id));
  await assert.rejects(resolvePilotTarget(adminFor({ ...g, id: IDS[1] }), g.id));
  await assert.rejects(resolvePilotTarget(adminFor(g, { readError: true }), g.id));
});
test('replay can read a dark exact target, while all action paths require active Lightning', () => {
  const g = { ...game(), cluster_mode: 'must_move', lightning_enabled: false };
  assert.throws(() => assertCurrentPilotTarget(g));
  assert.equal(
    assertCurrentPilotTarget(g, PILOT_CLUB_ID, { active: false }).templateName,
    'action'
  );
  assert.throws(() =>
    assertCurrentPilotTarget({ ...g, template_name: 'classic' }, PILOT_CLUB_ID, { active: false })
  );
});

test('disabled and closed exact targets remain available for forensic replay but never admission or play', async () => {
  for (const patch of [
    { enabled: false },
    { closed_at: '2026-10-17T00:00:00Z' },
    { enabled: false, closed_at: '2026-10-17T00:00:00Z' },
  ]) {
    const g = { ...game(), ...patch };
    const replay = await resolvePilotTarget(adminFor(g), g.id, { active: false });
    assert.equal(replay.target.templateName, 'action');
    await assert.rejects(resolvePilotTarget(adminFor(g), g.id, { active: true }));
  }
});
