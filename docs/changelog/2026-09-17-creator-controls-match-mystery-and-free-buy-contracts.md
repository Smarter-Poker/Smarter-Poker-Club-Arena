# Creator controls match Mystery Bounty and Free Buy contracts

The manual tournament creator offered minimum and maximum mystery multipliers that the engine's funded chest inventory does not consume. It also showed Free Buy rebuys and re-entry as disabled, and offered editable add-on prices and an off switch that the creation serializer overrides.

The modal now offers the supported mystery profile, activation condition and pool share without multiplier controls or obsolete registration-time chest promises. Both one-off and recurring creation omit those obsolete multiplier fields. The disclosure describes the funded inventory built when the selected phase opens after registration and purchases close. Existing event fields, inventory generation and settlement are unchanged.

Free Buy purchase controls display the existing `freeBuyConfig` result: rebuys, re-entry and add-ons enabled, with the current one-chip purchase prices locked. The add-on period starts at seating. Draft economic inputs and the serializer remain unchanged; omitted rebuy chips still follow the selected starting stack, and add-on chips remain editable. Paid-event prices and controls remain editable. This does not reprice existing events or change the database's support for explicitly priced Free Buy tiers.

Regression evidence uses the existing rendered creator suite and the real serializer/schedule service. The added cases fail against the old modal on the two misleading control states and pass after the repair, while verifying the actual one-off and recurring payloads and paid-event terms. No production tournament was submitted.
