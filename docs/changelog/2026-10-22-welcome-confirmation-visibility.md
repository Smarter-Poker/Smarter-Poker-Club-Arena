# Confirmation And Selection Control Visibility

The welcome agreement and other console checkboxes used an almost-black well with an 8% inset highlight. The shared sc-check control now has a solid 2px brand-blue edge and a 26px minimum size. The selected state has a green edge/core, and keyboard focus has a white edge and a visible outline. Native inputs paint their selected core directly rather than relying on pseudo-elements. The welcome-only override was removed in favor of the shared fix. This reaches welcome and club-creation agreements, club-opening confirmations, terms acceptance, cash/tournament configuration switches, ticker controls and club-message settings.

The broader control inventory also found and corrected:

- Create Union hid its native controls with display:none, removing keyboard access. They remain in the tab order and mirror focus onto the visible box/track. The unchecked control edge is blue and the page now defines its missing accent, background and muted-text tokens, which previously made its checked black tick and other black-on-accent states unreadable.
- Cashier Trade hid both filter checkboxes and indicated selection only through text color. Assigned To Me and Group By Role now show the shared native checkbox.
- Cashier recipient-wallet radio choices had no selected styling. The selected destination now uses white text and a blue underline. Its malformed button focus-offset declaration is corrected.
- Hero Hub and Table Settings Off labels used dark gunmetal on black. They now use readable muted silver while retaining the existing On treatment.

The audit covered checkbox, radio, switch and menu-checkbox markup and its owning styles. Standard visible native controls and switches with clear tracks/statuses were retained. The intentionally invisible TapHaptic input is an input overlay on an already visible control, and is not a missing confirmation box. Unused common Input controls, the unused legacy ReportPlayerModal and the unrouted ClubDetailPage were excluded from live-surface edits.

Consent handlers, legal copy, selected values, disabled guards, transaction handlers, table-setting behavior, portal layers and persistence are unchanged. This is client presentation and keyboard accessibility only; no engine API or engine replacement is required. Browser previews use the actual owning styles and shared controls with local-only state; production delivery and live verification are recorded separately in the task checkpoint.
