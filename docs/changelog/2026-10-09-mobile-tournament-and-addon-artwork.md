# Mobile Tournament And Add-On Artwork

Mobile cash and MTT controls now use three columns across two rows, with complete labels and existing sort/menu handlers. Cash retains Stakes, Variant, Players, Buy-In and Status. MTT retains Starting Time, Game Type, Buy-In, Guarantee, Registered and Status. Desktop columns and other game categories retain their controls.

The tournament card uses a complete cash-style native-ratio chassis with independent live title, status, variant, rules, six metric bays and existing Details/Register actions. The add-on popup uses rendered chrome and green timer/action faces with live cost, fee, total, chips, wallet and deadline; existing acceptance, affordability, duplicate, expiry and unknown-result handling remain authoritative. Close and Escape use the same decline path. Keyboard focus stays inside the dialog.

Validation includes real-component mobile renders, focused monetary/component tests, TypeScript and the ordinary hooks. Publication and production behavior remain separate evidence in the owning task checkpoint. No engine or database change is required.
