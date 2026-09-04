# tests/the-stats-a-player-reads-survive-the-hand-prune.law.test.ts

The stats a player reads survive the hand prune: sp_prune_hand_history (newest definition in the migrations) never names ca_hand_player_stat, ca_hand_facts or ca_hand_transfers (it may prune the ca_hand_player_idx pointer table); ca_prune_hand_player_stat keeps at least the page's 750-hand analysis window per player; the forward roll prunes the stat table by per-player count, never by hand age. Added 2026-09-04 (Stats Page Programme phase 1)
