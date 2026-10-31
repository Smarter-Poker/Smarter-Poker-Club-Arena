# Retaining a bank-arm intent preserves the player's decision time

Pressing Time Bank before the primary clock expires records an arm intent and waits for its continuation checkpoint. During a slow checkpoint, player actions are withheld but the old primary timer continued, spending a bank or forcing an action before input became available.

The original arm request now holds the shared decision timers and countdown under its own owner until that checkpoint completes. Existing weekly owners remain independent; overlapping holds count once. The request restores the remaining time, immediately emits the existing timer_countdown event and republishes the corrected deadline, and does not resume a stopped, replaced, or unretained failed decision. Concurrent arm requests share one hold. No table maintenance, financial, insurance, or controller pause is introduced.

The real request, continuation lane and scheduler reproduce bank consumption before the fix. Focused cases cover a long retention delay, Fold/Call/Raise afterward, both weekly release orders, a newly armed replacement clock, changed decision, stop, uncertain retention, and concurrent arm requests. The existing recovery capsule retains the arm intent without an ephemeral hold owner; ordinary restart clock behavior and paid-bank restoration are unchanged. Live incident attribution and deployment remain separate evidence.
