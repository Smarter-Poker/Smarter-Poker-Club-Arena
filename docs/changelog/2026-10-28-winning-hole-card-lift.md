# Winning hole cards rise above the hand

Hero and opponent winning hole cards now hold a vertical lift of one fifth of their own height while the winning combination is displayed. In a PLO5 AKJ56 hand won with KJ, only K and J rise; unused cards retain their dimming. The independent CSS translate survives flat-row transform overrides and existing reveal/deal animations, including reduced motion. Existing engine-provided dealt indexes, sort mapping, hidden-card protection and hand reset remain authoritative.

Regression coverage extends the real SeatSlot render for both hero and opponent, empty winner indexes, hidden cards and cleared winner state. The existing live showdown browser spec measures winning-versus-resting card rectangles at mobile/desktop widths and both motion preferences.

Client-only presentation using existing engine fields; no engine replacement or new contract required. Separate reported all-in Unknown percentages trace to the already merged exact-equity producer in PR #8463 awaiting the owner's explicitly chosen October 29 04:00 Chicago activation. This card lift does not alter equity values or claim that pending engine behavior is live.
