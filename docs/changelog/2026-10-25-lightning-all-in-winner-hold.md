# Lightning All-In Winners Keep Their Cards And Award

The earlier shared all-in showdown change was wired through physical tables and the client, but LightningHandHost owned a separate completion path. It emitted the winner and immediately settled, atomically releasing the pool reservations before the client could finish showing the winner.

Lightning now records the all-in showdown fact from the live controller at SHOWDOWN. After the winner frames, it waits the remaining shared handCompletionHoldMs budget before calling settlement. That includes the existing award animation beats, side-pot group staggering and the owner's additional two seconds; the pre-award read already elapsed and is subtracted once. Non-all-in completion is unchanged. No money moves outside the existing atomic/idempotent settlement, and the reservation remains protected during the hold.

Connected host tests reproduce the missing hold against the original source, then verify heads-up and multiway side-pot hands retain their cards and reservations until the hold resolves, shutdown drains the existing hand, and settlement occurs once. A fold win does not inherit the all-in hold. The existing owner law now includes Lightning wiring.

Engine activation and natural-hand proof remain separate from local checks and protected merge. Routine activation uses the existing daily 04:00 America/Chicago route.
