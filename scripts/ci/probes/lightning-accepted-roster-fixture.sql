-- Native-only original Lightning formation/anchor fixture. No production DSN.
CREATE TABLE IF NOT EXISTS public.lightning_hand (
  hand_id               uuid PRIMARY KEY,
  cluster_id            uuid NOT NULL,
  cluster_epoch         integer NOT NULL,
  lightning_instance_id uuid NOT NULL,
  -- The formation barrier: once this is set the participant set is locked and
  -- no substitution, seat swap, blind reassignment or insertion is permitted.
  formed_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at            timestamptz,
  CONSTRAINT lightning_hand_epoch_nonneg CHECK (cluster_epoch >= 0),
  CONSTRAINT lightning_hand_settles_after_formation CHECK (
    settled_at IS NULL OR settled_at >= formed_at)
);

CREATE INDEX IF NOT EXISTS lightning_hand_by_cluster_epoch
  ON public.lightning_hand (cluster_id, cluster_epoch, formed_at DESC);

CREATE INDEX IF NOT EXISTS lightning_hand_by_instance
  ON public.lightning_hand (lightning_instance_id);

ALTER TABLE public.lightning_hand ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_hand FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lightning_hand TO service_role;

COMMENT ON TABLE public.lightning_hand IS
  'The Lightning dimensions of one hand: which Cluster, which epoch, which instance. A side table keyed by hand_id rather than columns on hand_history (2.9M rows, 14 GB) and hand_atomic_commits (2.85M rows, 11 GB), so non-Lightning hands carry no permanently NULL columns and the hot settlement path keeps its exact signature.';

CREATE TABLE IF NOT EXISTS public.lightning_hand_player (
  hand_id          uuid NOT NULL,
  player_id        uuid NOT NULL,
  -- WHICH TABLE this hand was played at, not merely which player. Two
  -- concurrent Lightning hands for one multi-tabling player would otherwise
  -- point at the same participation with nothing distinguishing them, and
  -- per-table statistics could never be reconstructed.
  pool_slot_id     uuid NOT NULL,
  seat             smallint NOT NULL,
  position         text,
  blind_role       text,
  stack_before     numeric(14,2),
  stack_after      numeric(14,2),
  -- The fold taxonomy. Nothing in this estate distinguished these before:
  -- ca_hand_player_stat.folded is a single boolean.
  fold_type        text NOT NULL DEFAULT 'none',
  CONSTRAINT lightning_hand_player_pkey PRIMARY KEY (hand_id, player_id),
  CONSTRAINT lightning_hand_player_fold_type_check CHECK (fold_type IN (
    'none', 'normal', 'fast', 'fold_watch')),
  CONSTRAINT lightning_hand_player_position_check CHECK (position IS NULL OR position IN (
    'utg', 'hj', 'co', 'btn', 'sb', 'bb')),
  CONSTRAINT lightning_hand_player_blind_role_check CHECK (blind_role IS NULL OR blind_role IN (
    'none', 'sb', 'bb', 'both', 'dead_sb', 'straddle')),
  CONSTRAINT lightning_hand_player_seat_range CHECK (seat >= 1 AND seat <= 9)
);

-- One seat per hand, held by one player. The other half of the formation
-- barrier: two players cannot occupy the same chair in a committed hand.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_hand_player_one_per_seat
  ON public.lightning_hand_player (hand_id, seat);

-- Keyed by the SLOT, so per-table statistics read only that table's hands.
CREATE INDEX IF NOT EXISTS lightning_hand_player_by_pool_slot
  ON public.lightning_hand_player (pool_slot_id);

ALTER TABLE public.lightning_hand_player ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_hand_player FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lightning_hand_player TO service_role;

COMMENT ON COLUMN public.lightning_hand_player.fold_type IS
  'none, normal, fast or fold_watch. New vocabulary: the existing per-hand analytics carry only a single folded boolean, which cannot distinguish a Fast Fold from an ordinary one.';


ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS hand_number bigint;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS host_table_id uuid;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS hand_history_id uuid;
-- Both physical tables have a chair 1. Those chairs are not hand positions.
SET LOCAL session_replication_role=replica;
INSERT INTO public.tables(id,name,tournament_id,game_type,game_variant,status,lifecycle,club_id,
 small_blind,big_blind,cluster_id,seat_game_scope,seat_admission_key,max_players)
 SELECT '88100000-0000-0000-0000-000000000002','Other Lightning Anchor',tournament_id,
 game_type,game_variant,status,lifecycle,club_id,small_blind,big_blind,cluster_id,
 seat_game_scope,seat_admission_key,max_players FROM public.tables
 WHERE id='88100000-0000-0000-0000-000000000001';
UPDATE public.table_seats SET table_id='88100000-0000-0000-0000-000000000002',seat_number=1
 WHERE id='88300000-0000-0000-0000-000000000002';
SET LOCAL session_replication_role=origin;
INSERT INTO public.lightning_hand(hand_id,cluster_id,cluster_epoch,lightning_instance_id,hand_number,host_table_id)
 VALUES ('88600000-0000-0000-0000-000000000001','88900000-0000-0000-0000-000000000001',1,
 '88700000-0000-0000-0000-000000000001',8800010,'88100000-0000-0000-0000-000000000001');
INSERT INTO public.lightning_hand_player(hand_id,player_id,pool_slot_id,seat)
 SELECT '88600000-0000-0000-0000-000000000001',user_id::uuid,
 '88700000-0000-0000-0000-000000000002',8-row_number() OVER(ORDER BY user_id)
 FROM pg_temp.roster_seats('exact');
INSERT INTO public.hand_history(id,table_id,hand_number,game_variant,players,actions)
 VALUES ('88400000-0000-0000-0000-000000000010','88100000-0000-0000-0000-000000000001',8800010,'plo6','[]','[]');
INSERT INTO public.lightning_settlement_marker(txid,seat_id,anchor_table_id,player_id,hand_id,host_table_id,hand_number)
 SELECT pg_current_xact_id(),t.id,t.table_id,t.user_id,'88600000-0000-0000-0000-000000000001',
 '88100000-0000-0000-0000-000000000001',8800010
 FROM public.table_seats t WHERE t.id IN(SELECT seat_id::uuid FROM pg_temp.roster_seats('exact'));
CREATE FUNCTION pg_temp.lightning_roster_result(p_map jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001',8800010,
 '88400000-0000-0000-0000-000000000010',pg_temp.roster_stacks('exact'),true,
 COALESCE(p_map,(SELECT jsonb_object_agg(t.user_id::text,t.table_id) FROM public.table_seats t
 WHERE t.id IN(SELECT seat_id::uuid FROM pg_temp.roster_seats('exact')))),transaction_timestamp());
$$;
