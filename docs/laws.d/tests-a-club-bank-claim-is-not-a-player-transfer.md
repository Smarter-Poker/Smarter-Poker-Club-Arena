# tests/a-club-bank-claim-is-not-a-player-transfer.law.test.ts

A club bank claim is not a player-to-player transfer (2026-10-12): fn_union_integrity_sweep does not flag club_bank_claim rows as direct chip transfers, because their to_user_id is the club owner as the face of the club bank the chips went into.
