import assert from 'node:assert/strict';
import test from 'node:test';
import { seedFixture } from '../../operations/release/fixture/seed-fixture.mjs';

test('missing, invalid or shared session identities cannot reach the fixture database', async () => {
  let calls = 0;
  const ids = [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
  ];
  const input = {
    db: {
      query: () => {
        calls++;
        throw new Error('unexpected database access');
      },
    },
    actorIds: ids.slice(0, 2),
    spectatorId: ids[2],
  };
  for (const sessionIds of [
    undefined,
    [],
    ids.slice(0, 2),
    [ids[0], ids[0], ids[2]],
    ['private', ids[1], ids[2]],
  ])
    await assert.rejects(
      seedFixture({ ...input, sessionIds }),
      /FIXTURE_(REAL_SESSION_IDS|DISTINCT_SESSIONS)_REQUIRED/
    );
  assert.equal(calls, 0);
  for (const financialScenario of ['true', 1, null, {}])
    await assert.rejects(
      seedFixture({ ...input, sessionIds: ids, financialScenario }),
      /FIXTURE_FINANCIAL_MODE_REQUIRED/
    );
  assert.equal(calls, 0, 'malformed financial modes cannot reach any seed operation');
});
