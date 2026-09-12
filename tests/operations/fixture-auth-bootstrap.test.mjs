import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCanonicalSignup,
  assertAttributionChipSeed,
} from '../../operations/release/fixture/auth-bootstrap-proof.mjs';

const ids = [1, 2, 3].map((i) => `10000000-0000-4000-8000-00000000000${i}`);
const ownership = {
  database: 'club_arena_qualification',
  local_socket: true,
  database_user: 'postgres',
};
const row = (id) => ({
  id,
  synthetic_auth: 1,
  canonical_profile: 1,
  legacy_profile: 1,
  wallets: 1,
  zero_player_wallet: 1,
  diamond_mirrors: 3,
  empty_streak: 1,
  mint_rows: 1,
  diamond_journal_rows: 1,
  linked_signup_mint: 1,
  finalized_mint: 1,
  signup_errors: 0,
  diamond_incidents: 0,
});
function database(rows, owner = ownership) {
  let calls = 0;
  return {
    query: async (_sql, parameters) => {
      calls++;
      if (calls === 1) return { rows: [owner] };
      assert.deepEqual(parameters, [rows.map((item) => item.id)]);
      return { rows };
    },
    calls: () => calls,
  };
}

test('three canonical signup outcomes return counts without account or journal data', async () => {
  const proof = await assertCanonicalSignup(database(ids.map(row)), ids);
  assert.deepEqual(proof, {
    users: 3,
    zero_player_wallets: 3,
    diamonds_per_user: 500,
    linked_signup_mints: 3,
    signup_errors: 0,
    diamond_incidents: 0,
  });
  assert.ok(!JSON.stringify(proof).includes(ids[0]));
});

for (const [field, bad] of [
  ['legacy_profile', 0],
  ['wallets', 2],
  ['zero_player_wallet', 0],
  ['canonical_profile', 0],
  ['diamond_mirrors', 2],
  ['empty_streak', 0],
  ['mint_rows', 2],
  ['diamond_journal_rows', 2],
  ['linked_signup_mint', 0],
  ['finalized_mint', 0],
  ['signup_errors', 1],
  ['diamond_incidents', 1],
]) {
  test(`Auth success cannot hide an incomplete signup: ${field}`, async () => {
    const rows = ids.map(row);
    rows[1][field] = bad;
    await assert.rejects(
      assertCanonicalSignup(database(rows), ids),
      /FIXTURE_CANONICAL_SIGNUP_INCOMPLETE/
    );
  });
}

test('the later banned attribution identity also requires canonical signup completion', async () => {
  const proof = await assertCanonicalSignup(database([row(ids[0])]), [ids[0]]);
  assert.equal(proof.users, 1);
});

test('signup reads refuse a remote, wrong or unowned database before application data', async () => {
  for (const owner of [
    { ...ownership, database: 'postgres' },
    { ...ownership, local_socket: false },
    { ...ownership, database_user: 'authenticated' },
  ]) {
    const db = database(ids.map(row), owner);
    await assert.rejects(assertCanonicalSignup(db, ids), /FIXTURE_SIGNUP_OWNED_DATABASE_REQUIRED/);
    assert.equal(db.calls(), 1);
  }
});

test('malformed or duplicated identities cannot start a signup read', async () => {
  const db = database([]);
  for (const invalid of [
    [],
    ids.slice(0, 2),
    [ids[0], ids[0], ids[1]],
    ["'", ids[1], ids[2]],
    null,
  ]) {
    await assert.rejects(assertCanonicalSignup(db, invalid));
  }
  assert.equal(db.calls(), 0);
});

const chipState = {
  profiles: 4,
  members: 3,
  seats: 2,
  chip_mints: 1,
  attribution_memberships: 0,
  attribution_seats: 0,
  treasury: '96000.00',
  wallets: '3600.00',
  stacks: '400.00',
};
test('attribution counts chip issuance separately from legitimate diamond signup mints', async () => {
  const db = {
    query: async (sql, params) => {
      assert.match(sql, /FROM public\.ca_mint_ledger WHERE asset='chips'/);
      assert.deepEqual(params, [ids[0]]);
      return { rows: [chipState] };
    },
  };
  await assertAttributionChipSeed(db, ids[0]);
});

for (const [field, bad] of [
  ['chip_mints', 2],
  ['attribution_memberships', 1],
  ['attribution_seats', 1],
  ['treasury', '96001.00'],
  ['wallets', '3601.00'],
  ['stacks', '401.00'],
]) {
  test(`the banned attribution identity cannot change the chip seed: ${field}`, async () => {
    await assert.rejects(
      assertAttributionChipSeed(
        { query: async () => ({ rows: [{ ...chipState, [field]: bad }] }) },
        ids[0]
      )
    );
  });
}
