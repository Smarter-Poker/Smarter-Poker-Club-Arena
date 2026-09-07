# server/src/services/TournamentRakeIsAttributedOnce.law.test.ts

Tournament rake (entry fees, rebuys, satellite seats, spin books) is attributed once, at settlement, by `fn_attribute_tournament_rake`; the per-row agent-commission and player_stats paths in `RakebackSettlerService` are cash-only and never pay a tournament row a second time (spins were paid twice, 90,396.99 in one week, 2026-09-07). The rakeback basis is deliberately not gated: which rake earns player rakeback is Dan's.
