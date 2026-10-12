# tests/a-park-over-a-sealed-hand-is-withdrawn.law.test.ts

`public.fn_f06_withdraw_unplaceable_park` also accepts, as the witness that nothing is in flight, a table's latest hand permit that is `accepted` with its hand sealed (atomic commit, post-commit completed, hand_history) and no trace of any later hand, on any table including the event's last; every other proof of the door is unchanged and it still writes only its receipt and the park's `withdrawn_before_manifest` state, crediting nothing.
