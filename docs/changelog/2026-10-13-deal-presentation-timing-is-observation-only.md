# Deal presentation timing is observation only

The retained MTT browser witness recorded dealer movement but the 16-card deal appeared 3,134 ms after the hand event, outside its existing three-second requirement. The trace confirmed normal animation speed but did not distinguish event handling, timer firing, geometry readiness and React commit delay.

A transient certificate observer can now capture those six presentation phases with the exact hand number, timestamps, configured speed/delay and counts. It records no cards, players, names, credentials or balances. Without that in-page observer the helper emits nothing; it adds no persistent preference, repair loop or gameplay authority. The journal retains at most eight hands with eight diagnostic records each. The original animation timers, cards, completion, three-second DOM assertion and all four format requirements remain unchanged.

Focused tests verify inactive/throwing observation cannot affect gameplay, exact emitted fields, the actual late-geometry-to-card commit transition and existing completion behavior. These diagnostics require publication of this client before a new source-bound live certificate can use them. This change gathers missing evidence; it is not a claim that the late animation is fixed.
