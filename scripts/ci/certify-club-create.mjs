#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import { cleanupProductionE2EAccount } from './production-e2e-account.mjs';
import { retryTransient } from './transient-retry.mjs';
import {
  awaitPlatformThaw,
  describeThaw,
  freezeBudgetMs,
} from './platform-freeze-window.mjs';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.VITE_SUPABASE_ANON_KEY;
const assetUrl = process.env.CLUB_CREATE_CERT_ASSET_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!url || !serviceKey || !publishableKey || !assetUrl || !databaseUrl) {
  throw new Error(
    'Club Create Certification Requires Supabase, Database, And Asset Environment Variables.'
  );
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false },
  global: {
    headers: {
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    },
  },
});
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Reuse the guarded, deletion-capable certification namespace. The older
// smarter-poker.invalid identity could retire its clubs but could not pass the
// reserved-account cleanup door, leaving auth/profile residue behind.
const email = `ca-customization-cert-postdeploy-direct-${stamp}@example.invalid`;
const password = `Cert-${crypto.randomUUID()}-9a!`;
const requestId = crypto.randomUUID();
const name = `Crest Cert ${stamp}`.slice(0, 30);
let userId;
const clubIds = [];
let logoPath;

const retryRead = (label, operation) =>
  retryTransient(operation, {
    failureOf: (result) => result?.error,
    label,
  });

/**
 * A SCHEDULED MAINTENANCE BREAK IS NOT A BROKEN CLUB DOOR (2026-10-02).
 *
 * fn_create_club_atomic inserts into chip_transactions, so zz_freeze_guard
 * refuses it for the five-plus minutes of every hourly break and of the extra
 * certified recovery window the September 17 owner update allows (CLAUDE.md
 * section 13). This certification used to report that refusal verbatim -
 * "Atomic Create Failed: 55006 PLATFORM_FROZEN" - which reads as "authenticated
 * club creation is broken" and is not what was measured. Run 37064989099 is
 * exactly that: the 21:05:05Z recovery break was still enforced at 21:08, the
 * create was refused, and the only thing wrong was the clock.
 *
 * CLAUDE.md 10.86 rule 1: a stop we scheduled is a third outcome and it gets
 * its own name. So wait on the freeze's own end condition - fn_platform_frozen,
 * with the budget read from engine_maintenance_break by
 * scripts/ci/platform-freeze-window.mjs - and ask again. Three distinct
 * endings, none of them silent:
 *
 *   thawed, then created        -> the certification continues, having said how
 *                                  long it waited;
 *   thawed, then refused again  -> a real defect, named as one;
 *   never thawed / unreadable   -> UNKNOWN, named as UNKNOWN, never a pass.
 *
 * This is not a retry hiding a path that should have worked (CLAUDE.md 10.12):
 * the live path is correct to refuse a write inside the freeze. What is being
 * corrected is this check's reading of it.
 *
 * Two freezes is every freeze one run can legitimately meet - the hourly break
 * plus one certified recovery window - which is the same bound and the same
 * reason as PLATFORM_FREEZE_MAX_WAITS in production-e2e-account.mjs.
 */
const PLATFORM_FREEZE_MAX_WAITS = 2;

const refusedForTheFreeze = (error) =>
  Boolean(error) &&
  (String(error.code || '') === '55006' ||
    /PLATFORM_FROZEN/.test(String(error.message || '')) ||
    /platform is on a scheduled maintenance break/i.test(String(error.message || '')));

async function readBreakRow() {
  const { data, error } = await admin
    .from('engine_maintenance_break')
    .select('phase,break_started_at,break_ends_at,enforce_freeze')
    .limit(1);
  // 10.86 rule 2: unreadable is not empty. A null row makes freezeBudgetMs fall
  // back to the 15 minute ceiling the database itself enforces, and the caller
  // says that is what happened.
  if (error) {
    console.log(
      `[club-create-cert] the maintenance break row could not be read (${error.message}); ` +
        "sizing the wait from the database's own 15 minute freeze ceiling."
    );
    return null;
  }
  return Array.isArray(data) ? data[0] || null : null;
}

async function waitOutPlatformFreeze() {
  const result = await awaitPlatformThaw({
    isFrozen: async () => {
      const { data, error } = await admin.rpc('fn_platform_frozen');
      if (error) throw new Error(error.message || 'fn_platform_frozen could not be read');
      return data === true;
    },
    budgetMs: freezeBudgetMs(await readBreakRow(), Date.now()),
  });
  console.log(`[club-create-cert] ${describeThaw(result)}`);
  return result;
}

/**
 * Create one certification club, waiting out a scheduled freeze instead of
 * reporting it as a club-creation failure.
 */
async function createClubThroughTheFreeze(player, label, args) {
  for (let freezesWaited = 0; ; ) {
    const { data: club, error } = await player.rpc('fn_create_club_atomic', args);
    if (!error && club?.id) return club;
    if (!refusedForTheFreeze(error)) {
      throw new Error(
        `${label}: ${error?.code || 'NO_CODE'} ${error?.message || 'No Club Returned'}`
      );
    }
    if (freezesWaited >= PLATFORM_FREEZE_MAX_WAITS) {
      throw new Error(
        `${label}: the platform freeze refused the create across ${freezesWaited} complete ` +
          'freezes, which is more than section 13 schedules.'
      );
    }
    freezesWaited += 1;
    console.log(
      '[club-create-cert] the platform freeze refused the fixture create; waiting for the thaw.'
    );
    const thaw = await waitOutPlatformFreeze();
    if (thaw.outcome !== 'thawed') {
      throw new Error(`${label}: the create was refused for the freeze; ${describeThaw(thaw)}`);
    }
  }
}

function jwtClaims(accessToken, expectedUserId) {
  const encoded = String(accessToken || '').split('.')[1];
  if (!encoded) throw new Error('Authenticated Session Did Not Return JWT Claims.');
  const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (claims?.sub !== expectedUserId || claims?.role !== 'authenticated') {
    throw new Error('Authenticated Session JWT Claims Did Not Match The Certification Player.');
  }
  return claims;
}

const sortedIds = (values) => [...(Array.isArray(values) ? values : [])].map(String).sort();
const sameIds = (left, right) =>
  JSON.stringify(sortedIds(left)) === JSON.stringify(sortedIds(right));

async function certifyWelcomeResetInsideRollback({
  claims,
  clubId,
  operationId,
  cashIds,
  tableIds,
  scheduleId,
}) {
  const { Client } = await import('pg');
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'club-create-certification-welcome-reset-rollback',
  });
  let began = false;
  let result;
  let operationError;
  let rollbackError;

  await client.connect();
  try {
    await client.query('BEGIN');
    began = true;
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query(
      "SELECT set_config('request.jwt.claims',$1::text,true), set_config('request.jwt.claim.sub',$2::text,true)",
      [JSON.stringify(claims), claims.sub]
    );

    await client.query('SET LOCAL ROLE service_role');
    // The opening board materializes incrementally through this same global
    // settlement lane. Acquire it before the independent preimage so the
    // graph cannot change between observation and the authenticated reset.
    // The transaction-scoped lock remains held through the existing ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock(530090,1)');
    const expectedResponse = await client.query(
      `SELECT
        COALESCE((SELECT jsonb_agg(g.id ORDER BY g.id)
          FROM public.cash_games g WHERE g.club_id=$1::uuid),'[]'::jsonb) AS cash_game_ids,
        COALESCE((SELECT jsonb_agg(t.id ORDER BY t.id)
          FROM public.tables t WHERE t.club_id=$1::uuid),'[]'::jsonb) AS table_ids,
        COALESCE((SELECT jsonb_agg(s.id ORDER BY s.id)
          FROM public.tournament_schedules s WHERE s.club_id=$1::uuid),'[]'::jsonb) AS schedule_ids,
        COALESCE((SELECT jsonb_agg(t.id ORDER BY t.id)
          FROM public.tournaments t WHERE t.club_id=$1::uuid),'[]'::jsonb) AS tournament_ids`,
      [clubId]
    );
    const expected = expectedResponse.rows?.[0];
    if (
      !sameIds(expected?.cash_game_ids, cashIds) ||
      !sortedIds(tableIds).every((id) => sortedIds(expected?.table_ids).includes(id)) ||
      !sortedIds(expected?.schedule_ids).includes(String(scheduleId))
    ) {
      throw new Error(
        'Welcome Reset Preimage Did Not Match The Independently Observed Package Graph.'
      );
    }

    await client.query('SET LOCAL ROLE authenticated');
    const resetResponse = await client.query(
      'SELECT public.fn_remove_first_club_welcome_games($1::uuid,$2::uuid) AS result',
      [clubId, operationId]
    );
    const resetResult = resetResponse.rows?.[0]?.result;
    if (
      !sameIds(resetResult?.removed?.cash_game_ids, expected?.cash_game_ids) ||
      !sameIds(resetResult?.removed?.table_ids, expected?.table_ids) ||
      !sameIds(resetResult?.removed?.schedule_ids, expected?.schedule_ids) ||
      !sameIds(resetResult?.removed?.tournament_ids, expected?.tournament_ids)
    ) {
      throw new Error('Welcome Reset Receipt Did Not Name The Complete Independent Package Graph.');
    }
    // The owner-authenticated mutation above is the behavior under test. Its
    // complete financial readback also needs the service role because reserve
    // balances are deliberately not visible to players. Both remain inside
    // this same never-committed transaction and the authenticated JWT claims
    // remain installed for the whole observation.
    await client.query('SET LOCAL ROLE service_role');
    const readbackResponse = await client.query(
      `SELECT
        (SELECT to_jsonb(c) FROM (
          SELECT chip_treasury,bbj_enabled,bbj_rake_enabled,spins_enabled,spins_preseed_amount
          FROM public.clubs WHERE id=$1::uuid
        ) c) AS club,
        (SELECT to_jsonb(s) FROM (
          SELECT balance,seeded_amount,is_active
          FROM public.spin_bonus_pools WHERE club_id=$1::uuid
        ) s) AS spin,
        (SELECT to_jsonb(b) FROM (
          SELECT main_balance,backup_balance,promo_balance,status
          FROM public.bbj_pools WHERE club_id=$1::uuid AND union_id IS NULL
        ) b) AS bbj,
        COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM (
          SELECT id,enabled,state FROM public.cash_games WHERE id=ANY($2::uuid[])
        ) g),'[]'::jsonb) AS cash_games,
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM (
          SELECT id,status,current_players FROM public.tables WHERE id=ANY($3::uuid[])
        ) t),'[]'::jsonb) AS tables,
        COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM (
          SELECT id,active FROM public.tournament_schedules WHERE id=ANY($4::uuid[])
        ) s),'[]'::jsonb) AS schedules,
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM (
          SELECT id,status FROM public.tournaments WHERE id=ANY($5::uuid[])
        ) t),'[]'::jsonb) AS tournaments,
        COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM (
          SELECT id,status FROM public.managed_game_schedules
          WHERE status IN ('scheduled','executing') AND
            ((game_kind='tournament' AND game_id=ANY($5::uuid[])) OR
             (game_kind='table' AND game_id=ANY($3::uuid[])))
        ) m),'[]'::jsonb) AS active_managed_commands,
        COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.game) FROM (
          SELECT game,enabled FROM public.diamond_game_configs WHERE host_id=$1::uuid
        ) d),'[]'::jsonb) AS diamond_configs,
        (SELECT to_jsonb(w) FROM (
          SELECT enabled FROM public.wheel_configs WHERE host_id=$1::uuid
        ) w) AS wheel_config,
        COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM (
          SELECT host_id FROM public.diamond_spins_owner_consents WHERE host_id=$1::uuid
        ) a),'[]'::jsonb) AS diamond_consents`,
      [
        clubId,
        expected.cash_game_ids,
        expected.table_ids,
        expected.schedule_ids,
        expected.tournament_ids,
      ]
    );
    result = {
      reset: resetResult,
      readback: readbackResponse.rows?.[0],
      expected,
    };
  } catch (error) {
    operationError = error;
  } finally {
    if (began) {
      try {
        // Observe the destructive path without leaving it behind. The pristine
        // welcome package remains in place for the guarded fixture cleanup.
        await client.query('ROLLBACK');
      } catch (error) {
        rollbackError = error;
      }
    }
    await client.end();
  }

  if (rollbackError) {
    throw new AggregateError(
      operationError ? [operationError, rollbackError] : [rollbackError],
      'Welcome Reset Certification Could Not Prove Its Transaction Rolled Back.'
    );
  }
  if (operationError) throw operationError;
  return result;
}

async function cleanupResidualDirectCertificates() {
  const residual = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Legacy Certificate Inventory Failed: ${error.message}`);
    const users = data?.users || [];
    residual.push(
      ...users.filter((user) =>
        /^(?:club-create-cert-.+@smarter-poker\.invalid|ca-customization-cert-postdeploy-direct-.+@example\.invalid)$/i.test(
          String(user.email || '')
        )
      )
    );
    if (users.length < 1000) break;
  }

  for (const fixture of residual) {
    const { data: ownedClubs, error: clubError } = await admin
      .from('clubs')
      .select('id')
      .eq('owner_id', fixture.id);
    if (clubError) throw new Error(`Residual Certificate Club Check Failed: ${clubError.message}`);

    for (const ownedClub of ownedClubs || []) {
      const { data: retired, error: retirementError } = await retryTransient(
        () =>
          admin.rpc('fn_ca_retire_welcome_certification_club', {
            p_club_id: ownedClub.id,
            p_reason: 'cert-residue-recovery',
          }),
        {
          failureOf: (result) => result?.error,
          label: `residual certification club retirement ${ownedClub.id}`,
        }
      );
      if (retirementError || retired?.success === false) {
        throw (
          retirementError ||
          new Error(`Residual Certification Club ${ownedClub.id} Refused Retirement.`)
        );
      }
      if (retired?.already_gone || Number(retired?.chips_retired) !== 100000) {
        throw new Error(
          `Residual Certification Club ${ownedClub.id} Retired ${retired?.chips_retired ?? 'Unknown'} Chips Instead Of 100000.`
        );
      }
    }

    const { data: remainingClubs, error: remainingClubError } = await admin
      .from('clubs')
      .select('id')
      .eq('owner_id', fixture.id);
    if (remainingClubError || remainingClubs?.length) {
      throw (
        remainingClubError ||
        new Error(`Residual Certificate ${fixture.id} Still Owns A Club After Recovery.`)
      );
    }

    const folder = `club-logos/${fixture.id}`;
    const { data: assets, error: listError } = await admin.storage
      .from('club-assets')
      .list(folder, { limit: 100 });
    if (listError) throw new Error(`Legacy Certificate Asset Check Failed: ${listError.message}`);
    if (assets?.length) {
      const { error: removeError } = await admin.storage
        .from('club-assets')
        .remove(assets.map((asset) => `${folder}/${asset.name}`));
      if (removeError) {
        throw new Error(`Legacy Certificate Asset Cleanup Failed: ${removeError.message}`);
      }
    }
    const { data: remainingAssets, error: remainingAssetError } = await admin.storage
      .from('club-assets')
      .list(folder, { limit: 100 });
    if (remainingAssetError || remainingAssets?.length) {
      throw (
        remainingAssetError ||
        new Error(`Residual Certificate ${fixture.id} Still Owns Club Logo Assets.`)
      );
    }

    await cleanupProductionE2EAccount({
      record: { id: fixture.id, email: fixture.email },
      environment: process.env,
    });
  }

  if (residual.length) {
    console.log(
      `Removed And Verified ${residual.length} Residual Create Club Certificate Account(s).`
    );
  }
}

await cleanupResidualDirectCertificates();

try {
  const { data: created, error: createUserError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username: `crest_cert_${stamp.replace(/[^a-z0-9]/g, '').slice(-12)}` },
  });
  if (createUserError || !created.user)
    throw createUserError || new Error('No Test User Returned.');
  userId = created.user.id;

  // The certification owns its fixture explicitly. Production signup normally
  // creates this row, but admin-created users can race or bypass that hook.
  const fixtureName = `crest_cert_${stamp.replace(/[^a-z0-9]/g, '').slice(-12)}`;
  const { error: profileError } = await admin.from('profiles').upsert(
    {
      id: userId,
      username: fixtureName,
      display_name: 'Club Create Certification',
    },
    { onConflict: 'id' }
  );
  if (profileError) throw new Error(`Profile Fixture Failed: ${profileError.message}`);

  const player = createClient(url, publishableKey, { auth: { persistSession: false } });
  const { data: signedIn, error: signInError } = await player.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw signInError;
  const authenticatedClaims = jwtClaims(signedIn.session?.access_token, userId);

  const assetResponse = await fetch(assetUrl);
  if (!assetResponse.ok) throw new Error(`Crest Asset Returned HTTP ${assetResponse.status}.`);
  const logo = await assetResponse.blob();
  logoPath = `club-logos/${userId}/${requestId}.webp`;
  const { error: uploadError } = await player.storage.from('club-assets').upload(logoPath, logo, {
    contentType: 'image/webp',
    upsert: true,
  });
  if (uploadError) throw new Error(`Logo Upload Failed: ${uploadError.message}`);
  const { data: publicLogo } = player.storage.from('club-assets').getPublicUrl(logoPath);

  const { data: eligibility, error: eligibilityError } = await player.rpc(
    'fn_get_club_creation_eligibility'
  );
  if (eligibilityError || eligibility?.can_create !== true) {
    throw eligibilityError || new Error('Disposable User Is Not Eligible To Create A Club.');
  }

  const club = await createClubThroughTheFreeze(player, 'Atomic Create Failed', {
    p_request_id: requestId,
    p_name: name,
    p_description: 'Production Club Creation Certification',
    p_color_theme: 'royal-blue',
    p_is_public: true,
    p_requires_approval: false,
    p_logo_url: publicLogo.publicUrl,
  });
  clubIds.push(club.id);

  // This is a read-only receipt over an already committed, idempotently
  // provisioned club. Production service_role/authenticated statements are
  // bounded, so a load-spike timeout must be retried here instead of turning a
  // successfully created and cleanly retired fixture into a false red.
  const { data: welcome, error: welcomeError } = await retryRead(
    `welcome package read for certification club ${club.id}`,
    () => player.rpc('fn_get_club_welcome_package', { p_club_id: club.id })
  );
  const welcomeItems = Array.isArray(welcome?.items) ? welcome.items : [];
  const welcomeCash = welcomeItems.filter((item) => item?.entity_kind === 'cash_game');
  const welcomeSchedules = welcomeItems.filter(
    (item) => item?.entity_kind === 'tournament_schedule'
  );
  const welcomeEconomics = welcome?.economics || {};
  if (
    welcomeError ||
    welcome?.ok !== true ||
    welcome?.eligible !== true ||
    welcome?.status !== 'provisioned' ||
    welcome?.package_version !== 'welcome-v1' ||
    welcomeCash.length !== 9 ||
    welcomeSchedules.length !== 1 ||
    welcomeSchedules[0]?.slot_key !== 'daily_25_freezeout_1900' ||
    welcomeEconomics.bbj_enabled !== true ||
    Number(welcomeEconomics.bbj_seed) !== 100 ||
    welcomeEconomics.spins_enabled !== true ||
    Number(welcomeEconomics.spin_max_stake) !== 1 ||
    Number(welcomeEconomics.spin_seed) !== 200 ||
    welcomeEconomics.diamond_spins_status !== 'owner_acceptance_required'
  ) {
    throw welcomeError || new Error('First Club Welcome Package Was Not Provisioned Exactly.');
  }

  const expectedWelcomeSlots = new Set([
    'classic_nlh_050_100',
    'classic_flh_050_100',
    'classic_plo4_050_100',
    'classic_plo5_050_100',
    'classic_plo6_050_100',
    'classic_plo8_050_100',
    'classic_flo8_050_100',
    'classic_short_deck_050_100',
    'classic_pineapple_050_100',
  ]);
  if (
    welcomeCash.some(
      (item) =>
        !expectedWelcomeSlots.delete(String(item?.slot_key || '')) ||
        typeof item?.entity_id !== 'string' ||
        typeof item?.initial_table_id !== 'string' ||
        item?.retired_at !== null
    ) ||
    expectedWelcomeSlots.size !== 0
  ) {
    throw new Error('First Club Welcome Cash-Game Matrix Did Not Match Welcome-v1.');
  }

  const { data: membership, error: membershipError } = await retryRead(
    `owner membership read for certification club ${club.id}`,
    () =>
      admin
        .from('club_members')
        .select('role,status,chip_balance')
        .eq('club_id', club.id)
        .eq('user_id', userId)
        .single()
  );
  if (
    membershipError ||
    membership?.role !== 'owner' ||
    membership?.status !== 'active' ||
    Number(membership?.chip_balance) !== 0
  ) {
    throw membershipError || new Error('Owner Membership Was Not Created Correctly.');
  }

  const { data: storedClub, error: storedClubError } = await retryRead(
    `club identity read for certification club ${club.id}`,
    () =>
      admin
        .from('clubs')
        .select('logo_url,avatar_url,chip_treasury,bbj_enabled,spins_enabled')
        .eq('id', club.id)
        .single()
  );
  if (
    storedClubError ||
    storedClub?.logo_url !== publicLogo.publicUrl ||
    storedClub?.avatar_url !== publicLogo.publicUrl ||
    Number(storedClub?.chip_treasury) !==
      100000 - Number(welcomeEconomics.bbj_seed) - Number(welcomeEconomics.spin_seed) ||
    storedClub?.bbj_enabled !== true ||
    storedClub?.spins_enabled !== true
  ) {
    throw (
      storedClubError ||
      new Error('The First Club Identity, Welcome Switches, Or Seeded Treasury Was Incorrect.')
    );
  }

  const { data: funding, error: fundingError } = await retryRead(
    `welcome funding read for certification club ${club.id}`,
    () =>
      admin
        .from('club_welcome_package_funding')
        .select('destination,amount,balance_after')
        .eq('club_id', club.id)
        .order('destination')
  );
  if (
    fundingError ||
    !Array.isArray(funding) ||
    funding.length !== 2 ||
    funding[0]?.destination !== 'bbj_main' ||
    Number(funding[0]?.amount) !== Number(welcomeEconomics.bbj_seed) ||
    Number(funding[0]?.balance_after) !== Number(welcomeEconomics.bbj_seed) ||
    funding[1]?.destination !== 'spin_reserve' ||
    Number(funding[1]?.amount) !== Number(welcomeEconomics.spin_seed) ||
    Number(funding[1]?.balance_after) !== Number(welcomeEconomics.spin_seed)
  ) {
    throw fundingError || new Error('Welcome BBJ And Spin Funding Receipts Were Not Exact.');
  }

  const { data: canonicalWallet, error: canonicalWalletError } = await retryRead(
    `canonical wallet read for certification club ${club.id}`,
    () => admin.from('club_wallets').select('club_id,chip_balance').eq('club_id', club.id).single()
  );
  if (
    canonicalWalletError ||
    canonicalWallet?.club_id !== club.id ||
    Number(canonicalWallet?.chip_balance) !== 0
  ) {
    throw canonicalWalletError || new Error('Canonical Club Wallet Was Not Created.');
  }

  const cashIds = welcomeCash.map((item) => item.entity_id);
  const initialTableIds = welcomeCash.map((item) => item.initial_table_id);
  const { data: cashRows, error: cashRowsError } = await retryRead(
    `welcome cash game read for certification club ${club.id}`,
    () =>
      admin
        .from('cash_games')
        .select('id,template_name,variant,sb,bb,enabled,state')
        .in('id', cashIds)
  );
  const { data: initialTables, error: initialTablesError } = await retryRead(
    `welcome table read for certification club ${club.id}`,
    () => admin.from('tables').select('id,cluster_id,status,lifecycle').in('id', initialTableIds)
  );
  if (
    cashRowsError ||
    initialTablesError ||
    cashRows?.length !== 9 ||
    initialTables?.length !== 9 ||
    cashRows.some(
      (row) =>
        row.template_name !== 'classic' ||
        Number(row.sb) !== 0.5 ||
        Number(row.bb) !== 1 ||
        row.enabled !== true ||
        row.state !== 'live'
    ) ||
    initialTables.some(
      (row) =>
        !initialTableIds.includes(row.id) ||
        !cashIds.includes(row.cluster_id) ||
        ['closed', 'cancelled', 'completed'].includes(String(row.status || '').toLowerCase()) ||
        row.lifecycle === 'closed'
    )
  ) {
    throw (
      cashRowsError ||
      initialTablesError ||
      new Error('Welcome Cash Tables Were Not Durable And Engine-Ready.')
    );
  }

  const { data: schedule, error: scheduleError } = await retryRead(
    `welcome schedule read for certification club ${club.id}`,
    () =>
      admin
        .from('tournament_schedules')
        .select('id,name,active,days_of_week,start_times_utc,interval_minutes,config')
        .eq('id', welcomeSchedules[0].entity_id)
        .single()
  );
  if (
    scheduleError ||
    schedule?.name !== 'Daily $25 Freezeout' ||
    schedule?.active !== true ||
    schedule?.interval_minutes !== null ||
    JSON.stringify(schedule?.days_of_week) !== JSON.stringify([0, 1, 2, 3, 4, 5, 6]) ||
    JSON.stringify(schedule?.start_times_utc) !== JSON.stringify(['19:00']) ||
    Number(schedule?.config?.buyIn) !== 25 ||
    Number(schedule?.config?.startingStack) !== 10000 ||
    schedule?.config?.recurrenceCadence !== 'daily'
  ) {
    throw (
      scheduleError || new Error('Daily 7 PM $25 Welcome Tournament Was Not Configured Exactly.')
    );
  }

  const { data: spinRecurrence, error: spinRecurrenceError } = await retryRead(
    `spin recurrence read for certification club ${club.id}`,
    () =>
      admin
        .from('spin_bonus_pools')
        .select('club_id,is_active,balance,seeded_amount,offered_max_stake')
        .eq('club_id', club.id)
        .single()
  );
  if (
    spinRecurrenceError ||
    spinRecurrence?.is_active !== true ||
    Number(spinRecurrence?.balance) !== 200 ||
    Number(spinRecurrence?.seeded_amount) !== 200 ||
    Number(spinRecurrence?.offered_max_stake) !== 1
  ) {
    throw (
      spinRecurrenceError || new Error('Authoritative Spin And Sit-N-Go Recurrence Was Not Active.')
    );
  }

  const { data: diamondConfigs, error: diamondConfigsError } = await retryRead(
    `diamond config read for certification club ${club.id}`,
    () =>
      admin
        .from('diamond_game_configs')
        .select('game,enabled,min_bet_diamonds,max_bet_diamonds,purchased_only')
        .eq('host_id', club.id)
  );
  const { data: wheelConfig, error: wheelConfigError } = await retryRead(
    `wheel config read for certification club ${club.id}`,
    () =>
      admin.from('wheel_configs').select('enabled,purchased_only').eq('host_id', club.id).single()
  );
  const { data: diamondConsent, error: diamondConsentError } = await retryRead(
    `diamond consent read for certification club ${club.id}`,
    () => admin.from('diamond_spins_owner_consents').select('host_id').eq('host_id', club.id)
  );
  if (
    diamondConfigsError ||
    wheelConfigError ||
    diamondConsentError ||
    diamondConfigs?.length !== 4 ||
    new Set(diamondConfigs.map((row) => row.game)).size !== 4 ||
    diamondConfigs.some(
      (row) =>
        row.enabled !== true ||
        Number(row.min_bet_diamonds) !== 25 ||
        Number(row.max_bet_diamonds) !== 5000 ||
        row.purchased_only !== false
    ) ||
    wheelConfig?.enabled !== true ||
    wheelConfig?.purchased_only !== false ||
    diamondConsent?.length !== 0
  ) {
    throw (
      diamondConfigsError ||
      wheelConfigError ||
      diamondConsentError ||
      new Error('Diamond Games Were Not Enabled-By-Default Behind The Unaccepted Consent Gate.')
    );
  }

  const { data: resetImpact, error: resetImpactError } = await retryRead(
    `welcome reset impact read for certification club ${club.id}`,
    () =>
      player.rpc('fn_get_club_welcome_package_reset_impact', {
        p_club_id: club.id,
      })
  );
  if (resetImpactError || resetImpact?.can_reset !== true) {
    throw resetImpactError || new Error('Pristine Welcome Package Was Not Resettable.');
  }
  const resetOperationId = crypto.randomUUID();
  const {
    reset,
    readback: resetReadback,
    expected: resetExpected,
  } = await certifyWelcomeResetInsideRollback({
    claims: authenticatedClaims,
    clubId: club.id,
    operationId: resetOperationId,
    cashIds,
    tableIds: initialTableIds,
    scheduleId: schedule.id,
  });
  if (
    reset?.ok !== true ||
    Number(reset?.returned_to_treasury?.bbj) !== 100 ||
    Number(reset?.returned_to_treasury?.spin) !== 200 ||
    reset?.owner_acceptance_receipts_preserved !== true
  ) {
    throw new Error('Welcome Package Did Not Reset To A Conserved Zero State.');
  }
  const resetClubRead = resetReadback?.club;
  const resetSpinRead = resetReadback?.spin;
  const resetBbjRead = resetReadback?.bbj;
  const resetCashRead = resetReadback?.cash_games;
  const resetTableRead = resetReadback?.tables;
  const resetScheduleRead = resetReadback?.schedules;
  const resetTournamentRead = resetReadback?.tournaments;
  const resetManagedCommandRead = resetReadback?.active_managed_commands;
  const resetDiamondRead = resetReadback?.diamond_configs;
  const resetWheelRead = resetReadback?.wheel_config;
  const resetConsentRead = resetReadback?.diamond_consents;
  if (
    Number(resetClubRead?.chip_treasury) !== 100000 ||
    resetClubRead?.bbj_enabled !== false ||
    resetClubRead?.bbj_rake_enabled !== false ||
    resetClubRead?.spins_enabled !== false ||
    Number(resetClubRead?.spins_preseed_amount) !== 0 ||
    Number(resetSpinRead?.balance) !== 0 ||
    Number(resetSpinRead?.seeded_amount) !== 0 ||
    resetSpinRead?.is_active !== false ||
    Number(resetBbjRead?.main_balance) !== 0 ||
    Number(resetBbjRead?.backup_balance) !== 0 ||
    Number(resetBbjRead?.promo_balance) !== 0 ||
    resetBbjRead?.status !== 'retired' ||
    resetCashRead?.length !== resetExpected?.cash_game_ids?.length ||
    resetCashRead?.some((row) => row.enabled || row.state !== 'dormant') ||
    resetTableRead?.length !== resetExpected?.table_ids?.length ||
    resetTableRead?.some((row) => row.status !== 'closed' || Number(row.current_players) !== 0) ||
    resetScheduleRead?.length !== resetExpected?.schedule_ids?.length ||
    resetScheduleRead?.some((row) => row.active !== false) ||
    resetTournamentRead?.length !== resetExpected?.tournament_ids?.length ||
    resetTournamentRead?.some(
      (row) => !['CANCELLED', 'CANCELED'].includes(String(row.status || '').toUpperCase())
    ) ||
    resetManagedCommandRead?.length !== 0 ||
    resetDiamondRead?.some((row) => row.enabled) ||
    resetWheelRead?.enabled !== false ||
    resetConsentRead?.length !== 0
  ) {
    throw new Error('Welcome Reset Readback Was Not A True Zero State.');
  }

  const presetRequestId = crypto.randomUUID();
  const presetClub = await createClubThroughTheFreeze(player, 'Preset Create Failed', {
    p_request_id: presetRequestId,
    p_name: `Preset ${name}`.slice(0, 30),
    p_description: 'Production Placeholder Crest Certification',
    p_color_theme: 'royal-blue',
    p_is_public: true,
    p_requires_approval: false,
    p_logo_url: assetUrl,
  });
  clubIds.push(presetClub.id);

  const { data: secondWelcome, error: secondWelcomeError } = await retryRead(
    `welcome package refusal read for certification club ${presetClub.id}`,
    () => player.rpc('fn_get_club_welcome_package', { p_club_id: presetClub.id })
  );
  if (
    secondWelcomeError ||
    secondWelcome?.ok !== true ||
    secondWelcome?.eligible !== false ||
    secondWelcome?.status !== 'not_eligible' ||
    !Array.isArray(secondWelcome?.items) ||
    secondWelcome.items.length !== 0
  ) {
    throw (
      secondWelcomeError ||
      new Error('A Lifetime-Second Club Incorrectly Received A Welcome Package.')
    );
  }

  const { data: storedPreset, error: storedPresetError } = await retryRead(
    `placeholder crest read for certification club ${presetClub.id}`,
    () => admin.from('clubs').select('logo_url,avatar_url').eq('id', presetClub.id).single()
  );
  if (
    storedPresetError ||
    storedPreset?.logo_url !== assetUrl ||
    storedPreset?.avatar_url !== assetUrl
  ) {
    throw storedPresetError || new Error('The Placeholder Crest URL Was Not Stored Directly.');
  }

  console.log(
    `PASS First-Club Welcome, Lifetime-Second Refusal, Custom And Placeholder Club Creation Certified For ${clubIds.join(', ')}.`
  );
} finally {
  const cleanupFailures = [];
  if (userId) {
    const { data: ownedClubs, error: ownedClubsError } = await admin
      .from('clubs')
      .select('id,name,is_union,union_id')
      .eq('owner_id', userId);
    if (ownedClubsError) {
      cleanupFailures.push(
        new Error(`Certification Could Not Inventory Its Owned Clubs: ${ownedClubsError.message}`)
      );
    } else {
      const unexpected = (ownedClubs || []).filter(
        (club) =>
          !/^(?:Preset )?Crest Cert /.test(String(club.name || '')) ||
          club.is_union === true ||
          club.union_id != null
      );
      if (unexpected.length) {
        cleanupFailures.push(
          new Error(
            `Certification Owner Has Unexpected Club State: ${unexpected.map((club) => club.id).join(', ')}`
          )
        );
      } else {
        for (const club of ownedClubs || []) {
          if (!clubIds.includes(club.id)) clubIds.push(club.id);
        }
      }
    }
  }
  // Append-only financial records intentionally prevent a plain hard delete:
  // clubs -> chip_transactions is ON DELETE SET NULL, which is an UPDATE on an
  // append-only journal (and chip_transactions.club_id is NOT NULL, so it could
  // never have worked), and removing the last member emits an append-only
  // management event. Every run between 2026-08-31 and 2026-09-03 therefore
  // warned "Fixture Hard Delete Skipped" and left a club behind holding its
  // 100,000-chip opening grant: 15 clubs, 1,300,000 chips.
  //
  // The welcome coordinator proves and removes only unused package-owned games,
  // then invokes fn_ca_retire_certification_club in the same transaction. The
  // long-standing retirement door still proves the club, retires its chips to
  // the Mint with a declared journal row, and archives every journal row it
  // touches. A failure here is loud: a leaked fixture is a real defect.
  if (clubIds.length) {
    const { error: retireError } = await admin
      .from('clubs')
      .update({ is_public: false, status: 'inactive' })
      .in('id', clubIds);
    if (retireError) console.error(`Fixture Retirement Failed: ${retireError.message}`);

    for (const clubId of clubIds) {
      // The door is one idempotent transaction (a repeat answers already_gone),
      // so a statement timeout during a database load spike is retried with
      // backoff instead of leaking the club: 2026-09-28 one such timeout left a
      // fixture owned by the reserved identity and wedged every post-deploy
      // certificate for ten hours. A `success: false` refusal is definitive and
      // is never retried.
      const { data, error } = await retryTransient(
        () =>
          admin.rpc('fn_ca_retire_welcome_certification_club', {
            p_club_id: clubId,
            p_reason: 'cert-cleanup',
          }),
        {
          failureOf: (result) => result?.error,
          label: `retirement of certification club ${clubId}`,
        }
      );
      if (error) {
        cleanupFailures.push(new Error(`Fixture Cleanup Failed For ${clubId}: ${error.message}`));
      } else if (data && data.success === false) {
        cleanupFailures.push(new Error(`Fixture Cleanup Refused For ${clubId}: ${data.error}`));
      } else if (data?.already_gone || Number(data?.chips_retired) !== 100000) {
        cleanupFailures.push(
          new Error(
            `Fixture ${clubId} Retired ${data?.chips_retired ?? 'Unknown'} Chips Instead Of 100000.`
          )
        );
      } else {
        console.log(
          `Fixture ${clubId} retired: ${data?.chips_retired ?? 0} chips returned to the Mint.`
        );
      }
    }

    const { data: leaked, error: leakedError } = await retryTransient(
      () => admin.from('clubs').select('id').in('id', clubIds),
      { failureOf: (result) => result?.error, label: 'fixture club verification read' }
    );
    if (leakedError) {
      // An unreadable answer is not an empty one.
      cleanupFailures.push(
        new Error(
          `Certification could not verify its fixture clubs are gone: ${leakedError.message}`
        )
      );
    } else if (leaked?.length) {
      cleanupFailures.push(
        new Error(
          `Certification leaked ${leaked.length} fixture club(s) into Club Arena: ${leaked
            .map((c) => c.id)
            .join(', ')}`
        )
      );
    }
  }
  if (logoPath) {
    const { error: storageError } = await admin.storage.from('club-assets').remove([logoPath]);
    if (storageError) {
      cleanupFailures.push(new Error(`Fixture Asset Cleanup Failed: ${storageError.message}`));
    }
    const folder = logoPath.slice(0, logoPath.lastIndexOf('/'));
    const fileName = logoPath.slice(logoPath.lastIndexOf('/') + 1);
    const { data: remainingAssets, error: remainingAssetError } = await admin.storage
      .from('club-assets')
      .list(folder, { limit: 100, search: fileName });
    if (remainingAssetError) {
      cleanupFailures.push(
        new Error(`Fixture Asset Verification Failed: ${remainingAssetError.message}`)
      );
    } else if (remainingAssets?.some((asset) => asset.name === fileName)) {
      cleanupFailures.push(new Error(`Fixture Asset ${logoPath} Still Exists After Cleanup.`));
    }
  }
  if (userId) {
    try {
      await cleanupProductionE2EAccount({
        record: { id: userId, email },
        environment: process.env,
      });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length) {
    throw new AggregateError(cleanupFailures, 'Club Create Certification Cleanup Was Incomplete.');
  }
}
