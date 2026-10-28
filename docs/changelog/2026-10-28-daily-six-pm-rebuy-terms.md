# Daily 6 PM rebuy contract

The owner requested a 25-chip daily 6 PM Central NLH tournament with 15,000 chips, eight-minute levels beginning at 25/50, one 25-chip rebuy and no add-on. The existing Midway generator forces non-freezeouts to offer an add-on and start at 25/25, overriding that authored schedule.

Normalize only new REGISTERING occurrences of this exact Midway schedule in the original insertion transaction, preserving the authored blind ladder and requested purchase terms before any entry is sold. Keep all unrelated series and existing registered contracts unchanged. The native PostgreSQL regression supplies the actual overridden generator output, reproduces the unwanted add-on before the patch, and verifies the exact future contract afterward, including unrelated and running-event boundaries.

The schedule is paused until the qualified migration is installed. Three already generated, unregistered occurrences were corrected after explicit zero-entry checks. Installation and recurrence readback remain separate from source delivery.
