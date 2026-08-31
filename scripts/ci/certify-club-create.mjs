#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.VITE_SUPABASE_ANON_KEY;
const assetUrl = process.env.CLUB_CREATE_CERT_ASSET_URL;

if (!url || !serviceKey || !publishableKey || !assetUrl) {
  throw new Error('Club Create Certification Requires Supabase And Asset Environment Variables.');
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const email = `club-create-cert-${stamp}@smarter-poker.invalid`;
const password = `Cert-${crypto.randomUUID()}-9a!`;
const requestId = crypto.randomUUID();
const name = `Crest Cert ${stamp}`.slice(0, 30);
let userId;
const clubIds = [];
let logoPath;

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

  const { data: membership, error: membershipError } = await admin
    .from('club_members')
    .select('role,status,chip_balance')
    .eq('club_id', club.id)
    .eq('user_id', userId)
    .single();
  if (membershipError || membership?.role !== 'owner' || membership?.status !== 'active') {
    throw membershipError || new Error('Owner Membership Was Not Created Correctly.');
  }

  const { data: storedClub, error: storedClubError } = await admin
    .from('clubs')
    .select('logo_url,avatar_url')
    .eq('id', club.id)
    .single();
  if (
    storedClubError ||
    storedClub?.logo_url !== publicLogo.publicUrl ||
    storedClub?.avatar_url !== publicLogo.publicUrl
  ) {
    throw storedClubError || new Error('The Selected Logo Was Not Stored On Both Identity Fields.');
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

  console.log(`PASS Custom And Placeholder Club Creation Certified For ${clubIds.join(', ')}.`);
} finally {
  if (clubIds.length) await admin.from('clubs').delete().in('id', clubIds);
  if (logoPath) await admin.storage.from('club-assets').remove([logoPath]);
  if (userId) await admin.auth.admin.deleteUser(userId);
}
