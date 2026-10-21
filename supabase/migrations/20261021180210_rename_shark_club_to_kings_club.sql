-- @live-proof: (SELECT name = 'KINGS CLUB' AND slug = 'kings-club' AND logo_url = '/hub/club-arena/images/kings-club-logo.png' AND card_image_url = '/hub/club-arena/images/kings-club-logo.png' FROM public.clubs WHERE id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4') AND (SELECT name = 'KINGS CLUB' AND avatar_url = '/hub/club-arena/images/kings-club-logo.png' FROM public.social_pages WHERE id = 'eba7d82a-94dd-43b8-840d-1d547961174a')
-- Owner 2026-10-21: replace Shark Club name/logo everywhere with supplied Kings Club logo.
-- Version reserved by scripts/new-migration.mjs. Branding only; immutable club/page
-- identities, memberships, permissions, balances and historical records stay intact.
-- Publish the new asset and legacy URL compatibility BEFORE installing this change.
-- Each authoritative row asserts the exact branding read live; a replay refuses.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $kings_brand$
DECLARE v_count integer;
BEGIN
  UPDATE public.clubs
  SET name = 'KINGS CLUB', slug = 'kings-club',
      logo_url = '/hub/club-arena/images/kings-club-logo.png',
      avatar_url = '/hub/club-arena/images/kings-club-logo.png',
      card_image_url = '/hub/club-arena/images/kings-club-logo.png',
      description = replace(description, 'SHARK CLUB', 'KINGS CLUB'),
      tagline = replace(tagline, 'SHARK CLUB', 'KINGS CLUB'),
      lobby_message = replace(lobby_message, 'SHARK CLUB', 'KINGS CLUB'),
      message_revision = message_revision + 1,
      lobby_message_updated_at = now(), updated_at = now()
  WHERE id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4' AND club_id = 25450
    AND name = 'SHARK CLUB' AND slug = 'shark-club'
    AND logo_url = '/hub/club-arena/images/shark-club-logo-v2.png'
    AND card_image_url = 'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/club-assets/club-cards/25450-card-v2.webp';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'kings_club_branding_preimage_changed: %', v_count; END IF;

  UPDATE public.social_pages
  SET name = 'KINGS CLUB',
      description = replace(description, 'SHARK CLUB', 'KINGS CLUB'),
      avatar_url = '/hub/club-arena/images/kings-club-logo.png', updated_at = now()
  WHERE id = 'eba7d82a-94dd-43b8-840d-1d547961174a'
    AND name = 'SHARK CLUB' AND slug IS NULL
    AND avatar_url = '/hub/club-arena/images/shark-club-logo-v2.png';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'kings_social_branding_preimage_changed: %', v_count; END IF;
END
$kings_brand$;
-- Only the user-visible refusal changes; preserve the exact installed body,
-- signature, security configuration, owner and ACLs. Never run the money RPC.
DO $opening_copy$
DECLARE
  v_signature regprocedure := 'public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure;
  v_definition text;
BEGIN
  v_definition := pg_get_functiondef(v_signature);
  IF md5(v_definition) <> 'af3dc9e20983b85167bd126451a57e1c' THEN
    RAISE EXCEPTION 'kings_opening_copy_predecessor_drift';
  END IF;
  EXECUTE replace(v_definition, 'That Tag Line Belongs To Shark Club', 'That Tag Line Belongs To Kings Club');
END
$opening_copy$;
COMMIT;
