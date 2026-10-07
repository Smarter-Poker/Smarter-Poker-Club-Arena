import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { delegationFixture, delegatedProof } from './leaderboard-delegated-role-matrix.mjs';
const ids = Array.from(
  { length: 5 },
  (_, i) => `90000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
);
test('synthetic role-record fixtures are exact-identity local-only and preserve triggers', () => {
  for (const phase of ['join', 'appoint', 'revoke']) {
    const sql = delegationFixture(phase, ids);
    assert.match(sql, /session_user<>'leaderboard_qualification_bootstrap'/);
    assert.match(sql, /inet_server_addr\(\) IS NOT NULL/);
    assert.match(sql, /leaderboard_payout_batches/);
    assert.match(sql, /array_agg\(id::text ORDER BY id::text\)/);
    assert.doesNotMatch(sql, /DISABLE TRIGGER|UPDATE.*balance|auth\.users\s*\(/i);
  }
  assert.match(delegationFixture('join', ids), /public\.fn_join_club/);
  assert.match(delegationFixture('appoint', ids), /'union_admin'/);
  assert.throws(() => delegationFixture('unknown', ids));
  assert.throws(() => delegationFixture('appoint', [...ids.slice(1), ids[1]]));
  assert.throws(() =>
    delegationFixture(
      'appoint',
      ids.map((id, i) => (i ? id : "x';DROP TABLE x;--"))
    )
  );
});
test('owner phases retain the exact actor token across legal grant and revocation calls', async () => {
  const sessions = ids.map((user, i) => ({ user, token: `synthetic-token-${i}` }));
  const standalone = '92000000-0000-4000-8000-000000000002';
  const affiliate = '92000000-0000-4000-8000-000000000001';
  const house = '91000000-0000-4000-8000-000000000001';
  const versions = new Map([
    [standalone, 1],
    [affiliate, 1],
  ]);
  const roles = new Map([
    [standalone, 'player'],
    [house, 'player'],
  ]);
  let active = true,
    grants = 0,
    refusals = 0;
  const request = async (path, args, token) => {
    const actor = sessions.findIndex((s) => s.token === token);
    assert.ok(actor >= 0);
    const club = args.p_club_id;
    if (path.endsWith('fn_club_set_member_role') || path.endsWith('fn_club_set_member_status')) {
      assert.equal(actor, club === standalone ? 1 : 0);
      assert.equal(args.p_user_id, ids[3]);
      if (args.p_role) roles.set(club, args.p_role);
      else active = args.p_status === 'active';
      return { ok: true, data: { success: true } };
    }
    const allowed = (c) =>
      actor === (c === standalone ? 1 : 0) ||
      (actor === 3 &&
        (c === standalone
          ? active && roles.get(c) === 'co_owner'
          : ['co_owner', 'admin'].includes(roles.get(house))));
    if (path.endsWith('fn_leaderboard_reward_contexts'))
      return {
        ok: true,
        data: [standalone, affiliate].filter(allowed).map((club_id) => ({ club_id })),
      };
    if (path.endsWith('fn_save_leaderboard_reward_setup')) {
      assert.equal(token, sessions[3].token);
      if (!allowed(club)) {
        refusals++;
        return { status: 403 };
      }
      grants++;
      assert.equal(args.p_expected_version, versions.get(club));
      versions.set(club, versions.get(club) + 1);
      return { ok: true, data: { program_version: versions.get(club) } };
    }
    assert.ok(path.endsWith('fn_get_leaderboard_reward_setup'));
    if (actor === 3 && club === standalone && !active) return { status: 403 };
    const data = {
      can_manage: allowed(club),
      program_version: versions.get(club),
      rewards_enabled: false,
      overlay_enabled: false,
      weekly_prizes: [],
      monthly_prizes: [],
      payout_metric: 'profit',
      payout_currency: 'chips',
      funding_owner_type: club === affiliate ? 'union' : 'club',
      union_id: club === affiliate ? house : null,
    };
    for (const field of [
      'available_balance',
      'wallet_balance',
      'committed_balance',
      'current_program_commitment',
      'other_program_commitments',
      'available_uncommitted_balance',
      'publication_capacity',
      'committed_club_count',
    ])
      data[field] = allowed(club) ? 0 : null;
    return { ok: true, data };
  };
  await delegatedProof(request, sessions);
  assert.equal(grants, 3);
  assert.equal(refusals, 4);
  assert.deepEqual([...versions.values()], [2, 3]);
});
test('same-session customer phases use legal owner RPCs and contain no literal manager role', () => {
  const helper = readFileSync(
    new URL('./leaderboard-delegated-role-matrix.mjs', import.meta.url),
    'utf8'
  );
  assert.match(helper, /fn_club_set_member_role/);
  assert.match(helper, /fn_club_set_member_status/);
  assert.match(helper, /'suspended'/);
  assert.match(helper, /assert\.deepEqual\(after\.data,\s*before\.data\)/);
  assert.doesNotMatch(helper, /p_role:'manager'/);
  const launcher = readFileSync(
    new URL('./leaderboard-real-auth-launcher-draft.mjs', import.meta.url),
    'utf8'
  );
  assert.match(launcher, /publicationBeforeRefusal/);
  assert.ok(
    launcher.indexOf("delegationFixture('revoke'") < launcher.indexOf("mode: 'overseer-revoked'")
  );
});
