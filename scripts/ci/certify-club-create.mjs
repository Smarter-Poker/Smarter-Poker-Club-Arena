#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import { cleanupProductionE2EAccount } from './production-e2e-account.mjs';
import { retryTransient } from './transient-retry.mjs';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.VITE_SUPABASE_ANON_KEY;
const assetUrl = process.env.CLUB_CREATE_CERT_ASSET_URL;

if (!url || !serviceKey || !publishableKey || !assetUrl) {
  throw new Error('Club Create Certification Requires Supabase And Asset Environment Variables.');
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

async function cleanupLegacyDirectCertificates() {
  const legacy = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Legacy Certificate Inventory Failed: ${error.message}`);
    const users = data?.users || [];
    legacy.push(
      ...users.filter((user) =>
        /^club-create-cert-.+@smarter-poker\.invalid$/i.test(String(user.email || ''))
      )
    );
    if (users.length < 1000) break;
  }

  for (const fixture of legacy) {
    const { data: ownedClubs, error: clubError } = await admin
      .from('clubs')
      .select('id')
      .eq('owner_id', fixture.id)
      .limit(1);
    if (clubError) throw new Error(`Legacy Certificate Club Check Failed: ${clubError.message}`);
    if (ownedClubs?.length) {
      throw new Error(`Refusing To Remove Legacy Certificate ${fixture.id}: It Still Owns A Club.`);
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

    await cleanupProductionE2EAccount({
      record: { id: fixture.id, email: fixture.email },
      environment: process.env,
    });
  }

  if (legacy.length) {
    console.log(`Removed And Verified ${legacy.length} Legacy Create Club Certificate Account(s).`);
  }
}

await cleanupLegacyDirectCertificates();

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
  const { error: signInError } = await player.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

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

  const { data: club, error: createError } = await player.rpc('fn_create_club_atomic', {
    p_request_id: requestId,
    p_name: name,
    p_description: 'Production Club Creation Certification',
    p_color_theme: 'royal-blue',
    p_is_public: true,
    p_requires_approval: false,
    p_logo_url: publicLogo.publicUrl,
  });
  if (createError || !club?.id) {
    throw new Error(
      `Atomic Create Failed: ${createError?.code || 'NO_CODE'} ${createError?.message || 'No Club Returned'}`
    );
  }
  clubIds.push(club.id);

  const { data: welcome, error: welcomeError } = await player.rpc('fn_get_club_welcome_package', {
    p_club_id: club.id,
  });
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

  const { data: membership, error: membershipError } = await admin
    .from('club_members')
    .select('role,status,chip_balance')
    .eq('club_id', club.id)
    .eq('user_id', userId)
    .single();
  if (
    membershipError ||
    membership?.role !== 'owner' ||
    membership?.status !== 'active' ||
    Number(membership?.chip_balance) !== 0
  ) {
    throw membershipError || new Error('Owner Membership Was Not Created Correctly.');
  }

  const { data: storedClub, error: storedClubError } = await admin
    .from('clubs')
    .select('logo_url,avatar_url,chip_treasury,bbj_enabled,spins_enabled')
    .eq('id', club.id)
    .single();
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

  const { data: funding, error: fundingError } = await admin
    .from('club_welcome_package_funding')
    .select('destination,amount,balance_after')
    .eq('club_id', club.id)
    .order('destination');
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

  const { data: canonicalWallet, error: canonicalWalletError } = await admin
    .from('club_wallets')
    .select('club_id,chip_balance')
    .eq('club_id', club.id)
    .single();
  if (
    canonicalWalletError ||
    canonicalWallet?.club_id !== club.id ||
    Number(canonicalWallet?.chip_balance) !== 0
  ) {
    throw canonicalWalletError || new Error('Canonical Club Wallet Was Not Created.');
  }

  const cashIds = welcomeCash.map((item) => item.entity_id);
  const initialTableIds = welcomeCash.map((item) => item.initial_table_id);
  const { data: cashRows, error: cashRowsError } = await admin
    .from('cash_games')
    .select('id,template_name,variant,sb,bb,enabled,state')
    .in('id', cashIds);
  const { data: initialTables, error: initialTablesError } = await admin
    .from('tables')
    .select('id,cluster_id,status,lifecycle')
    .in('id', initialTableIds);
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

  const { data: schedule, error: scheduleError } = await admin
    .from('tournament_schedules')
    .select('id,name,active,days_of_week,start_times_utc,interval_minutes,config')
    .eq('id', welcomeSchedules[0].entity_id)
    .single();
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

  const { data: spinRecurrence, error: spinRecurrenceError } = await admin
    .from('spin_bonus_pools')
    .select('club_id,is_active,balance,seeded_amount,offered_max_stake')
    .eq('club_id', club.id)
    .single();
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

  const { data: diamondConfigs, error: diamondConfigsError } = await admin
    .from('diamond_game_configs')
    .select('game,enabled,min_bet_diamonds,max_bet_diamonds,purchased_only')
    .eq('host_id', club.id);
  const { data: wheelConfig, error: wheelConfigError } = await admin
    .from('wheel_configs')
    .select('enabled,purchased_only')
    .eq('host_id', club.id)
    .single();
  const { data: diamondConsent, error: diamondConsentError } = await admin
    .from('diamond_spins_owner_consents')
    .select('host_id')
    .eq('host_id', club.id);
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

  const { data: resetImpact, error: resetImpactError } = await player.rpc(
    'fn_get_club_welcome_package_reset_impact',
    { p_club_id: club.id }
  );
  if (resetImpactError || resetImpact?.can_reset !== true) {
    throw resetImpactError || new Error('Pristine Welcome Package Was Not Resettable.');
  }
  const resetOperationId = crypto.randomUUID();
  const { data: reset, error: resetError } = await player.rpc(
    'fn_remove_first_club_welcome_games',
    { p_club_id: club.id, p_operation_id: resetOperationId }
  );
  if (
    resetError ||
    reset?.ok !== true ||
    Number(reset?.returned_to_treasury?.bbj) !== 100 ||
    Number(reset?.returned_to_treasury?.spin) !== 200 ||
    reset?.owner_acceptance_receipts_preserved !== true
  ) {
    throw resetError || new Error('Welcome Package Did Not Reset To A Conserved Zero State.');
  }
  const [
    resetClubRead,
    resetSpinRead,
    resetBbjRead,
    resetCashRead,
    resetScheduleRead,
    resetDiamondRead,
    resetWheelRead,
    resetConsentRead,
  ] = await Promise.all([
    admin
      .from('clubs')
      .select('chip_treasury,bbj_enabled,bbj_rake_enabled,spins_enabled,spins_preseed_amount')
      .eq('id', club.id)
      .single(),
    admin
      .from('spin_bonus_pools')
      .select('balance,seeded_amount,is_active')
      .eq('club_id', club.id)
      .single(),
    admin
      .from('bbj_pools')
      .select('main_balance,backup_balance,promo_balance,status')
      .eq('club_id', club.id)
      .single(),
    admin.from('cash_games').select('id,enabled,state').in('id', cashIds),
    admin.from('tournament_schedules').select('id,active').eq('id', schedule.id).single(),
    admin.from('diamond_game_configs').select('game,enabled').eq('host_id', club.id),
    admin.from('wheel_configs').select('enabled').eq('host_id', club.id).single(),
    admin.from('diamond_spins_owner_consents').select('host_id').eq('host_id', club.id),
  ]);
  const resetReadError = [
    resetClubRead,
    resetSpinRead,
    resetBbjRead,
    resetCashRead,
    resetScheduleRead,
    resetDiamondRead,
    resetWheelRead,
    resetConsentRead,
  ]
    .map((read) => read.error)
    .find(Boolean);
  if (
    resetReadError ||
    Number(resetClubRead.data?.chip_treasury) !== 100000 ||
    resetClubRead.data?.bbj_enabled !== false ||
    resetClubRead.data?.bbj_rake_enabled !== false ||
    resetClubRead.data?.spins_enabled !== false ||
    Number(resetClubRead.data?.spins_preseed_amount) !== 0 ||
    Number(resetSpinRead.data?.balance) !== 0 ||
    Number(resetSpinRead.data?.seeded_amount) !== 0 ||
    resetSpinRead.data?.is_active !== false ||
    Number(resetBbjRead.data?.main_balance) !== 0 ||
    Number(resetBbjRead.data?.backup_balance) !== 0 ||
    Number(resetBbjRead.data?.promo_balance) !== 0 ||
    resetBbjRead.data?.status !== 'retired' ||
    resetCashRead.data?.some((row) => row.enabled || row.state !== 'dormant') ||
    resetScheduleRead.data?.active !== false ||
    resetDiamondRead.data?.some((row) => row.enabled) ||
    resetWheelRead.data?.enabled !== false ||
    resetConsentRead.data?.length !== 0
  ) {
    throw resetReadError || new Error('Welcome Reset Readback Was Not A True Zero State.');
  }

  const presetRequestId = crypto.randomUUID();
  const { data: presetClub, error: presetError } = await player.rpc('fn_create_club_atomic', {
    p_request_id: presetRequestId,
    p_name: `Preset ${name}`.slice(0, 30),
    p_description: 'Production Placeholder Crest Certification',
    p_color_theme: 'royal-blue',
    p_is_public: true,
    p_requires_approval: false,
    p_logo_url: assetUrl,
  });
  if (presetError || !presetClub?.id) {
    throw new Error(
      `Preset Create Failed: ${presetError?.code || 'NO_CODE'} ${presetError?.message || 'No Club Returned'}`
    );
  }
  clubIds.push(presetClub.id);

  const { data: secondWelcome, error: secondWelcomeError } = await player.rpc(
    'fn_get_club_welcome_package',
    { p_club_id: presetClub.id }
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

  const { data: storedPreset, error: storedPresetError } = await admin
    .from('clubs')
    .select('logo_url,avatar_url')
    .eq('id', presetClub.id)
    .single();
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
        console.error(`Fixture Cleanup Failed For ${clubId}: ${error.message}`);
      } else if (data && data.success === false) {
        console.error(`Fixture Cleanup Refused For ${clubId}: ${data.error}`);
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
