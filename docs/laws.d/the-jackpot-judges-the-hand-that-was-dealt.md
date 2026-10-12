# server/src/config/theJackpotJudgesTheHandThatWasDealt.law.test.ts

The Bad Beat Jackpot judges the hand that was actually dealt, on board one,
against every winner. Settlement reads the variant the hand was DEALT as (a
bomb-pot override or the Pineapple switch), not the table's game, so an NLH
bomb pot on a PLO table is never judged by the Omaha rule; on a run-it-multiple
-times hand only board one's winners count, so a board-one loser who won a later
run is still judged; the main near miss takes every winner, so a chop never
files a co-winner as a loser, and has the same double-board gate as the hit;
and a hold'em-family hand is judged on exactly two hole cards. Every case uses
hands from the real evaluator.
