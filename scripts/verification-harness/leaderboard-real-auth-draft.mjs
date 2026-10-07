// UNQUALIFIED DRAFT. Run only inside the owned, isolated internal Docker network.
// Input is ephemeral synthetic credentials and prerequisite evidence on stdin.
// No production URL/key/source connection is accepted; responses are never printed.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Pinned PostgREST v14.5: JWTExpired is JwtClaimsErr, not JwtDecodeErr.
export function assertExpiredCredential(response) {
  assert.equal(response.status, 401);
  assert.equal(response.data?.code, 'PGRST303');
  assert.equal(response.data?.message, 'JWT expired');
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const cfg = JSON.parse(input);
  assert.equal(cfg.kind, 'synthetic-leaderboard-real-auth-v1');
  assert.equal(cfg.preflight.catalogEquivalent, true);
  assert.equal(cfg.preflight.noProductionData, true);
  assert.equal(cfg.preflight.internalNetwork, true);
  assert.equal(cfg.preflight.authCatalogUnchangedAfterStartup, true);
  assert.equal(cfg.preflight.authVersionsFingerprint, 'a39a6625824a961c445673001a211a1d');
  assert.equal(cfg.preflight.authVersions.length, 82);
  assert.ok(
    cfg.preflight.authVersions.every(
      (version) => typeof version === 'string' && version.length > 0 && !version.includes(',')
    )
  );
  assert.equal(new Set(cfg.preflight.authVersions).size, 82);
  assert.deepEqual(cfg.preflight.authVersions, [...cfg.preflight.authVersions].sort());
  // Matches the verified metadata query md5(string_agg(version, ',' ORDER BY version)).
  // Legacy '00' and date-looking historical values are opaque ledger strings.
  assert.equal(
    createHash('md5').update(cfg.preflight.authVersions.join(',')).digest('hex'),
    'a39a6625824a961c445673001a211a1d'
  );
  assert.equal([...cfg.preflight.authVersions].sort().at(-1), '20260831180000');
  assert.deepEqual(cfg.preflight.authVersions, cfg.preflight.candidateAuthVersions);
  // candidateAuthVersions is observed RESTORED DATABASE history, not image files.
  // Retained historical ledger rows need not exist in a newer binary file list.
  assert.equal(cfg.preflight.authServeOnlyVerified, true);
  assert.equal(cfg.preflight.imageMigrationVersions.length, 75);
  assert.equal(new Set(cfg.preflight.imageMigrationVersions).size, 75);
  assert.deepEqual(
    cfg.preflight.imageMigrationVersions,
    [...cfg.preflight.imageMigrationVersions].sort()
  );
  assert.ok(
    cfg.preflight.imageMigrationVersions.every((version) =>
      cfg.preflight.candidateAuthVersions.includes(version)
    ),
    'Selected image has an unapplied migration; refuse without running migrations'
  );
  assert.match(cfg.preflight.authImage, /^supabase\/gotrue@sha256:[a-f0-9]{64}$/);
  assert.match(cfg.preflight.restImage, /^postgrest\/postgrest@sha256:[a-f0-9]{64}$/);
  assert.equal(cfg.accounts.length, 5);
  for (const [index, account] of cfg.accounts.entries()) {
    assert.equal(account.email, `lb-real-auth-${index + 1}@example.invalid`);
    assert.ok(account.password.length >= 20);
  }
  const auth = 'http://leaderboard-auth:9999';
  const rest = 'http://leaderboard-rest:3000';
  async function request(base, path, body, token) {
    const response = await fetch(base + path, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data };
  }
  function claims(jwt) {
    assert.equal(jwt.split('.').length, 3);
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
  }
  const sessions = [];
  for (const account of cfg.accounts) {
    if (cfg.mode === 'signup') {
      const signed = await request(auth, '/signup', {
        email: account.email,
        password: account.password,
        data: { poker_alias: 'IsolatedAuth' + account.email.match(/[1-5]/)[0] },
      });
      assert.ok(signed.ok, 'Actual isolated signup refused');
      assert.ok(signed.data?.user?.id, 'Signup did not create an actual user');
    }
    const logged = await request(auth, '/token?grant_type=password', {
      email: account.email,
      password: account.password,
    });
    assert.ok(
      logged.ok && logged.data?.access_token && logged.data?.refresh_token,
      'Actual password login did not issue a session'
    );
    const original = claims(logged.data.access_token);
    assert.equal(original.role, 'authenticated');
    assert.equal(original.sub, logged.data.user.id);
    assert.ok(original.exp > Date.now() / 1000);
    const refreshed = await request(auth, '/token?grant_type=refresh_token', {
      refresh_token: logged.data.refresh_token,
    });
    assert.ok(refreshed.ok && refreshed.data?.access_token, 'Actual refresh refused');
    assert.equal(claims(refreshed.data.access_token).sub, original.sub);
    sessions.push({ user: original.sub, token: refreshed.data.access_token });
  }
  if (cfg.mode === 'signup') {
    // IDs are synthetic fixture inputs only. No password, access/refresh token,
    // secret, response payload or production identity is emitted.
    console.log(JSON.stringify({ kind: 'synthetic-signup-ids', ids: sessions.map((s) => s.user) }));
  } else {
    assert.equal(cfg.mode, 'matrix');
    assert.deepEqual(
      sessions.map((s) => s.user),
      cfg.fixtureUserIds
    );
    const clubs = ['92000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000002'];
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
    const saveArgs = (club) => ({
      p_club_id: club,
      p_rewards_enabled: false,
      p_metric: 'profit',
      p_weekly_prizes: [],
      p_monthly_prizes: [],
      p_suggestion_key: 'custom',
      p_expected_version: 0,
      p_operation_id: randomUUID(),
      p_overlay_enabled: false,
    });
    for (let actor = 0; actor < 5; actor++)
      for (let scope = 0; scope < 2; scope++) {
        const manages = (actor === 0 && scope === 0) || (actor === 1 && scope === 1);
        const reads = manages || actor === 3 || (actor === 2 && scope === 0);
        const got = await request(
          rest,
          '/rpc/fn_get_leaderboard_reward_setup',
          { p_club_id: clubs[scope] },
          sessions[actor].token
        );
        if (!reads)
          assert.equal(got.status, 403, 'Authenticated read must be refused for authority');
        else {
          assert.ok(got.ok, 'Authorized setup read failed');
          assert.equal(got.data.can_manage, manages);
          for (const field of privateFields) {
            assert.ok(Object.hasOwn(got.data, field));
            if (!manages) assert.equal(got.data[field], null);
          }
        }
        const saved = await request(
          rest,
          '/rpc/fn_save_leaderboard_reward_setup',
          saveArgs(clubs[scope]),
          sessions[actor].token
        );
        if (!manages)
          assert.equal(saved.status, 403, 'Authenticated save must be refused for authority');
        else {
          assert.ok(saved.ok, 'Funding-owner setup save failed');
          assert.equal(saved.data.program_version, 1);
          const readback = await request(
            rest,
            '/rpc/fn_get_leaderboard_reward_setup',
            { p_club_id: clubs[scope] },
            sessions[actor].token
          );
          assert.ok(readback.ok);
          assert.equal(readback.data.program_version, 1, 'Saved program must persist through REST');
        }
      }
    const token = sessions[0].token;
    const parts = token.split('.');
    const signature = Buffer.from(parts[2], 'base64url');
    signature[0] ^= 1;
    const tampered = parts.slice(0, 2).join('.') + '.' + signature.toString('base64url');
    // Expiry proof must use an actually GoTrue-issued signed token whose exp is
    // now past. Changing an unsigned payload tests tampering, not expiry.
    assert.ok(cfg.expiredIssuedToken);
    assert.equal(claims(cfg.expiredIssuedToken).sub, sessions[0].user);
    assert.ok(claims(cfg.expiredIssuedToken).exp < Date.now() / 1000 - 60);
    for (const [label, badToken] of [
      ['anonymous', undefined],
      ['tampered', tampered],
      ['expired', cfg.expiredIssuedToken],
    ]) {
      for (const [rpc, args] of [
        ['fn_get_leaderboard_reward_setup', { p_club_id: clubs[0] }],
        ['fn_save_leaderboard_reward_setup', saveArgs(clubs[0])],
      ]) {
        const denied = await request(rest, '/rpc/' + rpc, args, badToken);
        assert.equal(denied.status, 401, label + ' credential must be rejected');
        if (label === 'expired') {
          assertExpiredCredential(denied);
        }
      }
    }
    console.log(
      JSON.stringify({
        kind: 'isolated-real-auth-draft-result',
        matrix: 'passed',
        productionVersionParity: 'unknown',
        finalDatabaseReadback: 'required',
      })
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    // Never print raw input, Auth responses, assertions or errors containing tokens.
    console.error('Isolated Real Authorization Draft Failed; No Qualification Claimed');
    process.exitCode = 1;
  });
