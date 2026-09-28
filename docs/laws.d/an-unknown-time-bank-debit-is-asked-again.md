# server/src/engine/anUnknownTimeBankDebitIsAskedAgain.law.test.ts

Every engine time bank debit is sent with its own request id to `fn_consume_time_bank` (receipted by 20260928144831); a debit whose answer was lost keeps that id and is asked again, by the same id, from the restart gate census and from the manager's stop, so one timeout can no longer freeze a table's time bank custody for ever (87a68e55, 2026-09-28). A flag with no kept debit is never cleared (fail closed), and the engine never sends a debit without its request id.
