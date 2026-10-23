# Lightning Cycle Witness Retries A Control Refused Because Its Hand Ended

Madness deals a new hand every 10 to 20 seconds, so a pre-action offered on one hand can reach the engine after that hand ends. The engine refuses it with no effect (STALE_HAND, "That hand is over"). The cycle witness treated any refusal as fatal (run 39933070582 stopped at preaction refused).

An ended-hand refusal is now tried once more on the next hand, after the clock shows a new hand id. Any other refusal, or a second one, stops the witness as before. Stale refusals are retained in staleRefusals, and qualification still requires exactly one accepted request per control.

Tooling only.
