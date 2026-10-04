# tests/the-heavy-hourly-watches-do-not-start-together.law.test.ts

The heavy hourly watches do not start together. Job 161
(`rake-law-adherence-hourly`) had no statement timeout of its own and was
cancelled at the postgres role's 2 minutes in 7 of 23 runs, always inside the
:35-:42 pile-up of the union sweep, the escrow shadow and the ratchet watch. It
now carries the same `SET statement_timeout = '300s'` prefix as the other heavy
watches, and the ratchet watch (job 214) runs at :29 instead of :35. The law
pins that exactly jobs 161 and 214 are touched, each against its preimage; that
161 only gains the prefix and 214 only moves; that no job is created; and that
the escrow shadow keeps the :35 its brief fixed.
