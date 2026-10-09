# Mobile Tournament And Add-On Artwork

Mobile cash and MTT controls now use three columns across two rows, with complete labels and existing sort/menu handlers. Cash retains Stakes, Variant, Players, Buy-In and Status. MTT retains Starting Time, Game Type, Buy-In, Guarantee, Registered and Status. Desktop columns and other game categories retain their controls.

The tournament card uses a complete cash-style native-ratio chassis with independent live title, status, variant, rules, six metric bays and existing Details/Register actions. The add-on popup uses rendered chrome and green timer/action faces with one centered fee-inclusive cost, chips, wallet and deadline; existing acceptance, affordability, duplicate, expiry and unknown-result handling remain authoritative. Close and Escape use the same decline path. Keyboard focus stays inside the dialog.

Validation includes real-component mobile renders, focused monetary/component tests, TypeScript and the ordinary hooks. Publication and production behavior remain separate evidence in the owning task checkpoint. No engine or database change is required.

## All Rebuy And Add-On Entry Points

The October 9 owner extension applies the same chrome/green artwork to tournament rebuys, tournament add-ons, cash bust rebuys and cash top-ups, including Diamond cash seats. Tournament prices show one fee-inclusive cost row without a separate house fee or duplicated charge breakdown. Cash prompts retain exact cents and whole Diamond selection, with live editable amounts and presets printed inside an additional native-ratio bay derived from the supplied artwork. Existing handlers, affordability, unknown balance, receipt recovery and idempotency remain in place. Cash bust rebuys now consume the existing parent processing flag so neither confirm nor dismissal stays active during that purchase.

Real-component purchase tests and mobile/desktop renders cover the four entry points and their pending, insufficient, unknown-balance and retry states. Seat transaction notices and automatic top-up business behavior keep their existing function. No engine or database change is required.
