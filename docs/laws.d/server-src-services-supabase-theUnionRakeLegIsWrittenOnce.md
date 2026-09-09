# server/src/services/supabase/theUnionRakeLegIsWrittenOnce.law.test.ts

The union rake leg is written once: logRakeCollection credits a union's rake wallet through increment_union_wallet with club and notes context, so the balance change and its union_wallet_transactions row are one statement in one transaction with balance_after from the UPSERT's own RETURNING; the engine writes no journal row of its own, reads no balance back to describe one, and reports the one write it makes when it fails
