# tests/the-jackpot-epoch-counts-each-pool-from-its-own-opening.law.test.ts

fn_bbj_conservation_check measures a BBJ pool opened after the 2026-09-04 epoch from its own opening baseline (not the global epoch), and counts its journalled welcome seeds and burns in the lifetime identity, so an opening is never counted twice as a shortfall (incident f3e82f59, 2026-10-02)
