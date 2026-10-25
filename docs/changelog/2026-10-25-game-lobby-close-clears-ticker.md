# Game Lobby Close Clears The Live Ticker

The selected cash-game dialog was body-portaled at layer 2100, beneath the
fixed announcement ticker at 9400. When the ticker below the global header
overlapped the close control, native WebKit clicks reached the ticker instead.
The production compact-row journey timed out despite a visible close button.

Raise the existing dialog backdrop to 9600, above the ticker and below the
toast layer at 10000. Preserve the dialog artwork, geometry, focus/Escape,
backdrop/return link, body scroll restoration and all ticker behavior.

Extend the existing enforced game-lobby browser fixture with the real
TickerRail outside the shell stacking context, at the header's 44px offset.
The phone WebKit close test fails before this layer correction with repeated
mtt-ticker\_\_track interception. The retained cases use ordinary clicks and
also verify ticker registration entry after close; no force click or longer
wait hides the defect. Run all existing cash/MTT/Spin/SNG phone/landscape cases
in Chromium and WebKit, plus the directly affected component/source contracts.

Publication and exact production certification are separate evidence gates.
The unrelated TableManagement page.goto ERR_ABORTED is not changed here.
