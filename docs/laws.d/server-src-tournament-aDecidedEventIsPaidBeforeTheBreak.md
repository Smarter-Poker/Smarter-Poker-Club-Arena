# server/src/tournament/aDecidedEventIsPaidBeforeTheBreak.law.test.ts

A tournament already down to its last player is finished and paid during the announced last-hand window until TERMINAL_SETTLEMENT_LEAD_MS before the :55 break (every other gate still freezes at :53); one deferred past that is declared decided and asked for at the thaw edge, so the scheduler's decided lane serves it before live work queued ahead of it.
