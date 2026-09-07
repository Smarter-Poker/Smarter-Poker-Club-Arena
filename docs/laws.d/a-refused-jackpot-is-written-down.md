# server/src/engine/aRefusedJackpotIsWrittenDown.law.test.ts

A hand that reached the Bad Beat Jackpot decision and was refused writes a row
naming the gate that refused it. Between 2026-08-21 and 2026-09-07 the jackpot
paid nothing on the highest contribution volume the platform has ever taken, and
no row anywhere could distinguish "no qualifying hand occurred" from "one
occurred and something refused it" - the detector existed and spoke only to a
console line and a hub event that expires in seconds (CLAUDE.md 10.86 rule 3, a
guard with no reader). The recorder moves no money and can never break
settlement.
