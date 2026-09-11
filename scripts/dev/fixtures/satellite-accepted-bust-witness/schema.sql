-- Minimal statement fixture. Deliberately permissive witness columns allow
-- malformed/nonfinite evidence probes. No financial or manager authority is mocked.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA probe;
CREATE TABLE public.tournament_players (
 id uuid PRIMARY KEY, tournament_id uuid NOT NULL, user_id uuid NOT NULL,
 status text, position integer, elimination_sequence bigint, eliminated_at timestamptz,
 UNIQUE(tournament_id,position)
);
CREATE TABLE public.tournament_knockout_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid,
 eliminated_user_id uuid, table_id uuid, hand_number bigint, hand_id uuid,
 stack_before numeric, state text, created_at timestamptz
);
CREATE TABLE public.hand_atomic_commits (
 table_id uuid, hand_number bigint, hand_id uuid, committed_at timestamptz,
 PRIMARY KEY(table_id,hand_number), UNIQUE(hand_id)
);
-- These row types allow catalog compilation of the complete exact core.
-- Its financial body is never called by this focused statement probe.
CREATE TABLE public.tournament_escrow(id uuid);
CREATE TABLE public.tournament_satellite_settlements(id uuid);
CREATE TABLE public.tournament_obligations(id uuid);
CREATE FUNCTION probe.id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
CREATE FUNCTION probe.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS
$$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'PROBE FAILED: %',label; END IF; END $$;
CREATE FUNCTION probe.seed() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 TRUNCATE public.tournament_players,public.tournament_knockout_candidates,public.hand_atomic_commits;
 INSERT INTO public.tournament_players VALUES
  (probe.id(1),probe.id(100),probe.id(1),'winner',1,NULL,NULL),
  (probe.id(2),probe.id(100),probe.id(2),'eliminated',2,20,'2026-09-11 02:00Z'),
  (probe.id(3),probe.id(100),probe.id(3),'eliminated',3,10,'2026-09-11 01:00Z');
END $$;
CREATE FUNCTION probe.candidate(player integer,hand integer,stack numeric,captured timestamptz,
 committed timestamptz DEFAULT NULL,state_value text DEFAULT 'eliminated')
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO public.tournament_knockout_candidates
 (tournament_id,eliminated_user_id,table_id,hand_number,hand_id,stack_before,state,created_at)
 VALUES(probe.id(100),probe.id(player),probe.id(1000+hand),1000000+hand,
  probe.id(2000+hand),stack,state_value,captured);
 IF committed IS NOT NULL THEN
  INSERT INTO public.hand_atomic_commits VALUES
   (probe.id(1000+hand),1000000+hand,probe.id(2000+hand),committed)
  ON CONFLICT(table_id,hand_number) DO NOTHING;
 END IF;
END $$;
CREATE FUNCTION probe.second_is(player integer,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM probe.check((SELECT user_id FROM public.tournament_players
  WHERE tournament_id=probe.id(100) AND position=2)=probe.id(player),label);
END $$;
CREATE FUNCTION probe.refuses_unchanged(label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_rows jsonb; after_rows jsonb; refused boolean:=false;
BEGIN
 SELECT jsonb_agg(to_jsonb(p) ORDER BY id) INTO before_rows FROM public.tournament_players p;
 BEGIN PERFORM probe.rank_after(probe.id(100)); EXCEPTION WHEN SQLSTATE 'P0404' THEN refused:=true; END;
 SELECT jsonb_agg(to_jsonb(p) ORDER BY id) INTO after_rows FROM public.tournament_players p;
 PERFORM probe.check(refused AND before_rows=after_rows,label);
END $$;
