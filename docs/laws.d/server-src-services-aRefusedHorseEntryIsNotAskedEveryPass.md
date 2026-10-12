# server/src/services/aRefusedHorseEntryIsNotAskedEveryPass.law.test.ts

A horse whose entry into an event came back as an error is not offered that event again until a jittered backoff (10 minutes doubling to an hour) has passed, and an error that says the database did not answer (timeout, exhausted API pool, dropped connection) stops the registration pass. On 2026-10-11 the pass re-offered refused ticket holders every five minutes while each abandoned call kept running inside the API until the pool was gone.
