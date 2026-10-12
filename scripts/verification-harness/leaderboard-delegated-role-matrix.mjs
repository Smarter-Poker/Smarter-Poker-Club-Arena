import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const affiliate = '92000000-0000-4000-8000-000000000001';
const standalone = '92000000-0000-4000-8000-000000000002';
const house = '91000000-0000-4000-8000-000000000001';
export function delegationFixture(action, ids) {
  assert.ok(['join', 'appoint', 'revoke'].includes(action));
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  for (const id of ids)
    assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const actor = action === 'join' ? ids[3] : ids[4];
  const identityGuard = `IF (SELECT array_agg(id::text ORDER BY id::text) FROM auth.users) IS DISTINCT FROM ARRAY[${[
    ...ids,
  ]
    .sort()
    .map((id) => `'${id}'`)
    .join(
      ','
    )}]::text[] OR (SELECT array_agg(id::text ORDER BY id::text) FROM public.clubs) IS DISTINCT FROM ARRAY['${house}','${affiliate}','${standalone}']::text[] THEN RAISE EXCEPTION 'Disposable identity set mismatch'; END IF;`;
  const mutation =
    action === 'join'
      ? `PERFORM set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','role','authenticated')::text,true); PERFORM set_config('request.jwt.claim.sub','${actor}',true); PERFORM set_config('request.jwt.claim.role','authenticated',true); SET LOCAL ROLE authenticated; result:=public.fn_join_club('${house}'); IF result->>'role' IS DISTINCT FROM 'player' OR COALESCE(result->>'status','') NOT IN ('active','approved') OR (result->>'chip_balance')::numeric IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Delegated member join failed'; END IF; RESET ROLE;`
      : action === 'appoint'
        ? `IF EXISTS(SELECT 1 FROM public.union_admins) THEN RAISE EXCEPTION 'Unexpected delegation preimage'; END IF; INSERT INTO public.union_admins(union_id,user_id,role) VALUES('${house}','${actor}','union_admin');`
        : `IF (SELECT count(*) FROM public.union_admins WHERE union_id='${house}' AND user_id='${actor}' AND role='union_admin')<>1 OR (SELECT count(*) FROM public.union_admins)<>1 THEN RAISE EXCEPTION 'Unexpected delegation revocation preimage'; END IF; DELETE FROM public.union_admins WHERE union_id='${house}' AND user_id='${actor}';`;
  return `BEGIN; SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'; DO $delegation$ DECLARE result jsonb; BEGIN IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>'leaderboard_qualification_bootstrap' OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres' OR (SELECT count(*) FROM auth.users)<>5 OR (SELECT count(*) FROM public.clubs)<>3 OR NOT EXISTS(SELECT 1 FROM public.clubs WHERE id='${house}' AND is_union AND owner_id='${ids[0]}') OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches) OR EXISTS(SELECT 1 FROM public.club_members WHERE chip_balance IS DISTINCT FROM 0 OR promo_balance IS DISTINCT FROM 0) THEN RAISE EXCEPTION 'Disposable delegation fixture guard failed'; END IF; ${identityGuard} ${mutation} END $delegation$; COMMIT;`;
}

export async function delegatedProof(request, sessions, mode = 'owner-phases') {
  const privateFields = [
    'available_balance',
    'wallet_balance',
    'committed_balance',
    'current_program_commitment',
    'other_program_commitments',
    'available_uncommitted_balance',
    'publication_capacity',
    'committed_club_count',
  ];
  const call = (rpc, args, actor) => request('/rpc/' + rpc, args, sessions[actor].token);
  const setup = (club, actor) =>
    call('fn_get_leaderboard_reward_setup', { p_club_id: club }, actor);
  async function check(club, actor, owner, manages, reads, nextVersion) {
    const before = await setup(club, owner);
    assert.ok(before.ok);
    const got = await setup(club, actor);
    if (!reads) assert.equal(got.status, 403);
    else {
      assert.ok(got.ok);
      assert.equal(got.data.can_manage, manages);
      for (const field of privateFields) {
        assert.ok(Object.hasOwn(got.data, field));
        if (!manages) assert.equal(got.data[field], null);
        else
          assert.ok(
            typeof got.data[field] === 'number' &&
              Number.isFinite(got.data[field]) &&
              got.data[field] >= 0
          );
      }
    }
    const contexts = await call('fn_leaderboard_reward_contexts', {}, actor);
    assert.ok(contexts.ok);
    assert.ok(Array.isArray(contexts.data));
    assert.equal(
      contexts.data.some((row) => row.club_id === club),
      manages
    );
    const saved = await call(
      'fn_save_leaderboard_reward_setup',
      {
        p_club_id: club,
        p_rewards_enabled: false,
        p_metric: 'profit',
        p_weekly_prizes: [],
        p_monthly_prizes: [],
        p_suggestion_key: 'custom',
        p_expected_version: before.data.program_version,
        p_operation_id: randomUUID(),
        p_overlay_enabled: false,
      },
      actor
    );
    const after = await setup(club, owner);
    assert.ok(after.ok);
    if (!manages) {
      assert.equal(saved.status, 403);
      assert.deepEqual(after.data, before.data);
    } else {
      assert.ok(saved.ok);
      assert.equal(saved.data.program_version, nextVersion);
      assert.equal(after.data.program_version, nextVersion);
      assert.equal(after.data.rewards_enabled, false);
      assert.equal(after.data.overlay_enabled, false);
      assert.deepEqual(after.data.weekly_prizes, []);
      assert.deepEqual(after.data.monthly_prizes, []);
      assert.equal(after.data.payout_metric, 'profit');
      assert.equal(after.data.payout_currency, 'chips');
      assert.equal(after.data.funding_owner_type, club === affiliate ? 'union' : 'club');
      assert.equal(after.data.union_id, club === affiliate ? house : null);
    }
  }
  async function transition(rpc, club, owner, value) {
    const args = {
      p_club_id: club,
      p_user_id: sessions[3].user,
      ...(rpc === 'fn_club_set_member_role'
        ? { p_role: value }
        : { p_status: value, p_reason: 'Isolated delegated authorization proof' }),
    };
    const result = await call(rpc, args, owner);
    assert.ok(result.ok);
    assert.equal(result.data.success, true);
  }
  if (mode === 'owner-phases') {
    await transition('fn_club_set_member_role', standalone, 1, 'co_owner');
    await check(standalone, 3, 1, true, true, 2);
    await transition('fn_club_set_member_status', standalone, 1, 'suspended');
    await check(standalone, 3, 1, false, false);
    await transition('fn_club_set_member_status', standalone, 1, 'active');
    await transition('fn_club_set_member_role', standalone, 1, 'admin');
    await check(standalone, 3, 1, false, true);
    await transition('fn_club_set_member_role', standalone, 1, 'player');
    await check(standalone, 3, 1, false, true);
    await transition('fn_club_set_member_role', house, 0, 'co_owner');
    await check(affiliate, 3, 0, true, true, 2);
    await transition('fn_club_set_member_role', house, 0, 'admin');
    await check(affiliate, 3, 0, true, true, 3);
    await transition('fn_club_set_member_role', house, 0, 'player');
    await check(affiliate, 3, 0, false, true);
  } else if (mode === 'overseer-admitted') await check(affiliate, 4, 0, true, true, 4);
  else {
    assert.equal(mode, 'overseer-revoked');
    await check(affiliate, 4, 0, false, false);
  }
}
