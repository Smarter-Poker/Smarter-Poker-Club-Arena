import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPilotClub,
  assertPilotGame,
  PILOT,
  pilotServiceFetch,
  selectPilotGame,
} from './prepare-lightning-private-pilot.mjs';
const club = {
  id: 'private-club',
  owner_id: PILOT.ownerId,
  name: PILOT.name,
  is_public: false,
  requires_approval: true,
  union_id: null,
};
const game = {
  id: 'private-game',
  club_id: club.id,
  union_id: null,
  name: PILOT.gameName,
  handedness: 6,
  variant: 'nlh',
  must_move: true,
  ruleset_snapshot: { options: { is_private: true } },
  lightning_enabled: false,
  cluster_mode: 'must_move',
};
test('requires the existing service owner, private standalone club and admission approval', () => {
  assert.doesNotThrow(() => assertPilotClub(club));
  for (const patch of [
    { owner_id: 'personal' },
    { is_public: true },
    { requires_approval: false },
    { union_id: 'public-union' },
    { name: 'Other Club' },
  ]) {
    assert.throws(() => assertPilotClub({ ...club, ...patch }));
  }
});
test('refuses unrelated games, public games and activation during provisioning recovery', () => {
  assert.doesNotThrow(() => assertPilotGame(game, club.id));
  for (const patch of [
    { club_id: 'other' },
    { union_id: 'public-union' },
    { handedness: 9 },
    { must_move: false },
    { ruleset_snapshot: { options: { is_private: false } } },
    { lightning_enabled: true },
    { cluster_mode: 'lightning' },
  ]) {
    assert.throws(() => assertPilotGame({ ...game, ...patch }, club.id));
  }
});

test('service readback uses the configured key generation and drops caller authentication', async () => {
  for (const key of ['sb_secret_current', 'legacy.jwt.key']) {
    let seen;
    const run = pilotServiceFetch(key, async (_url, init) => {
      seen = init.headers;
      return { ok: true };
    });
    await run('https://configured-project/rest/v1/profiles', {
      headers: {
        Authorization: 'Bearer wrong-user',
        'Content-Type': 'application/json',
        'x-smarter-data-actor': 'wrong-actor',
      },
    });
    assert.equal(seen.apikey, key);
    assert.equal(seen.Authorization, key.startsWith('sb_secret_') ? undefined : `Bearer ${key}`);
    assert.equal(seen['x-smarter-data-actor'], 'service');
    assert.equal(seen['Content-Type'] || seen['content-type'], 'application/json');
  }
});

test('preserves normal seeded games and recovers only the specifically named private pilot', () => {
  const defaults = Array.from({ length: 9 }, (_, n) => ({
    ...game,
    id: `default-${n}`,
    name: `Default Game ${n}`,
    ruleset_snapshot: { options: { is_private: false } },
  }));
  assert.equal(selectPilotGame(defaults, club.id), null);
  assert.equal(selectPilotGame([...defaults, game], club.id), game);
  assert.throws(() => selectPilotGame([...defaults, game, { ...game, id: 'duplicate' }], club.id));
  assert.throws(() => selectPilotGame([...defaults, { ...game, club_id: 'other' }], club.id));
  assert.throws(() =>
    selectPilotGame(
      [...defaults, { ...game, ruleset_snapshot: { options: { is_private: false } } }],
      club.id
    )
  );
  assert.throws(() =>
    selectPilotGame([...defaults, { ...game, lightning_enabled: true }], club.id)
  );
});
