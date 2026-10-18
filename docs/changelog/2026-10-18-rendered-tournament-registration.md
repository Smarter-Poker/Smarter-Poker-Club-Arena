# Rendered Tournament Registration

Dan rejected the flat Register control on October18 and explicitly requested the Smarter.Poker rendered standard. This later instruction changes the registration button family only; the October4 tournament page layout remains intact.

The existing register, late-register and re-entry handlers, eligibility, busy states remain unchanged. A dedicated compact chrome/blue-glass plate is derived from the approved console primary plate. Live accessible text is fitted inside its face; no price or label is baked into artwork. The button retains native ratio, minimum48px hit area, keyboard focus, disabled semantics and long-label wrapping.

Dan subsequently requested a second Register beside Share, matching Share exactly. Both placements render from one action state machine and call the same guarded handler. The footer uses the existing Share class unchanged; it does not duplicate unrelated status or Watch controls.

Real-time law: existing tournament discrete events retained, with no snapshot diff or polling.

Validation:42 focused component/integration cases and20 UI contracts pass, root TypeScript and all four copy gates pass, and the final production build succeeds. The new two-entry-point regression fails twice on the previous source. Isolated real-component/font renders cover375/393/430px portrait,812px short landscape and1280px desktop; late/unavailable labels fit inside the face, pending controls remain disabled, keyboard focus is visible and the final action row clears the footer. Protected publication and actual live proof are recorded separately in the existing audit checkpoint.
