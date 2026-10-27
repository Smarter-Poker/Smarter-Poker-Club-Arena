CREATE TABLE IF NOT EXISTS union_pnl_cash_outcome_resolutions("table_id" uuid,"hand_number" bigint,"hand_id" uuid,"outcome_payload_hash" text,"outcome_evidence_md5" text,"resolution_kind" text,"proof" jsonb,"reason" text,"resolved_by" text,"resolved_at" timestamp with time zone);
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "table_id" uuid;
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "hand_number" bigint;
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "hand_id" uuid;
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "outcome_payload_hash" text;
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "outcome_evidence_md5" text;
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "resolution_kind" text;
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "proof" jsonb;
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "resolved_by" text;
ALTER TABLE union_pnl_cash_outcome_resolutions ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS union_pnl_cash_outcome_link_resolutions("table_id" uuid,"hand_number" bigint,"hand_id" uuid,"outcome_payload_hash" text,"outcome_evidence_md5" text,"roster_source" text,"manifest_id" uuid,"game_scope" jsonb,"evidence" jsonb,"proof" jsonb,"proof_md5" text,"reason" text,"resolved_by" text,"resolved_at" timestamp with time zone);
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "table_id" uuid;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "hand_number" bigint;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "hand_id" uuid;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "outcome_payload_hash" text;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "outcome_evidence_md5" text;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "roster_source" text;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "manifest_id" uuid;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "game_scope" jsonb;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "evidence" jsonb;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "proof" jsonb;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "proof_md5" text;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "resolved_by" text;
ALTER TABLE union_pnl_cash_outcome_link_resolutions ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS union_pnl_cash_outcome_touches("table_id" uuid,"hand_number" bigint,"recognized_at" timestamp with time zone,"game_union_id" text,"shaped" boolean,"accepted_rake" text,"participants" jsonb);
ALTER TABLE union_pnl_cash_outcome_touches ADD COLUMN IF NOT EXISTS "table_id" uuid;
ALTER TABLE union_pnl_cash_outcome_touches ADD COLUMN IF NOT EXISTS "hand_number" bigint;
ALTER TABLE union_pnl_cash_outcome_touches ADD COLUMN IF NOT EXISTS "recognized_at" timestamp with time zone;
ALTER TABLE union_pnl_cash_outcome_touches ADD COLUMN IF NOT EXISTS "game_union_id" text;
ALTER TABLE union_pnl_cash_outcome_touches ADD COLUMN IF NOT EXISTS "shaped" boolean;
ALTER TABLE union_pnl_cash_outcome_touches ADD COLUMN IF NOT EXISTS "accepted_rake" text;
ALTER TABLE union_pnl_cash_outcome_touches ADD COLUMN IF NOT EXISTS "participants" jsonb;
CREATE TABLE IF NOT EXISTS union_pnl_projection_build("projection" text,"end_block" bigint,"next_block" bigint,"rows_written" bigint,"steps" bigint,"installed_at" timestamp with time zone,"updated_at" timestamp with time zone,"completed_at" timestamp with time zone);
ALTER TABLE union_pnl_projection_build ADD COLUMN IF NOT EXISTS "projection" text;
ALTER TABLE union_pnl_projection_build ADD COLUMN IF NOT EXISTS "end_block" bigint;
ALTER TABLE union_pnl_projection_build ADD COLUMN IF NOT EXISTS "next_block" bigint;
ALTER TABLE union_pnl_projection_build ADD COLUMN IF NOT EXISTS "rows_written" bigint;
ALTER TABLE union_pnl_projection_build ADD COLUMN IF NOT EXISTS "steps" bigint;
ALTER TABLE union_pnl_projection_build ADD COLUMN IF NOT EXISTS "installed_at" timestamp with time zone;
ALTER TABLE union_pnl_projection_build ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE union_pnl_projection_build ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS smarter_private.posthand_escrow_certificates("table_id" uuid,"hand_number" bigint,"hand_id" uuid,"original" jsonb,"original_sha256" text,"recorded_at" timestamp with time zone);
ALTER TABLE smarter_private.posthand_escrow_certificates ADD COLUMN IF NOT EXISTS "table_id" uuid;
ALTER TABLE smarter_private.posthand_escrow_certificates ADD COLUMN IF NOT EXISTS "hand_number" bigint;
ALTER TABLE smarter_private.posthand_escrow_certificates ADD COLUMN IF NOT EXISTS "hand_id" uuid;
ALTER TABLE smarter_private.posthand_escrow_certificates ADD COLUMN IF NOT EXISTS "original" jsonb;
ALTER TABLE smarter_private.posthand_escrow_certificates ADD COLUMN IF NOT EXISTS "original_sha256" text;
ALTER TABLE smarter_private.posthand_escrow_certificates ADD COLUMN IF NOT EXISTS "recorded_at" timestamp with time zone;
SET LOCAL check_function_bodies=off;
CREATE OR REPLACE FUNCTION smarter_private.posthand_escrow_certified_evidence(p_table uuid, p_number bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE o public.union_pnl_cash_outcomes;proof jsonb;projected jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM smarter_private.posthand_escrow_certificates WHERE table_id=p_table AND hand_number=p_number) THEN RETURN NULL;END IF;
 SELECT * INTO o FROM public.union_pnl_cash_outcomes WHERE table_id=p_table AND hand_number=p_number;
 IF NOT FOUND THEN RETURN NULL;END IF;
 proof:=public.fn_union_pnl_prove_posthand_escrow(p_table,p_number);
 IF proof->>'status' IS DISTINCT FROM 'proven' THEN RETURN NULL;END IF;
 projected:=smarter_private.posthand_escrow_project_evidence(o.evidence,proof);
 IF projected->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR projected->'game_scope' IS DISTINCT FROM o.game_scope THEN RETURN NULL;END IF;
 RETURN projected;
END $function$
;
SET LOCAL check_function_bodies=on;
