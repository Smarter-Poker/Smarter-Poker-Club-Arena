# 2026-08-28 — A feature you own is permission, not a failed purchase

## Two paid features broke permanently the moment you bought them

`fn_purchase_feature` answers an ALREADY-OWNED feature with
`{ success: false, error: 'already_owned' }` — a refusal, not a failure —
and `VIPService.purchaseFeature` already surfaces that as `alreadyOwned`.
Two call sites checked only `success`:

- **EmojiPicker** — `emoji_pack` is priced `permanent`. After the first
  successful purchase, EVERY premium emoji tap showed "Insufficient
  diamonds" and sent nothing. The player had paid for the pack and could
  never use it again.
- **PlayerNotesPanel** — `tag_pack` likewise. A non-VIP could add exactly
  ONE player tag, ever, and was then repeatedly shown the buy-more-diamonds
  sheet for something they owned; `setSelectedTags` was never reached.

Both now treat ownership as permission. EmojiPicker also stops claiming a
charge that did not happen (`result.charged > 0`), and its toasts are Title
Cased through the Toast layer as the house rule requires.

## Four paid taps had no in-flight latch

- **ThrowableSelector** — the panel stayed open and tappable for the whole
  round trip (onClose is two awaits away), the grid was never disabled, and
  `fn_use_throwable` has no idempotency key: its advisory lock stops a
  concurrent double-spend of the last FREE throw but cannot deduplicate two
  legitimate sequential charges. A double tap spent two diamonds and fired
  two animations.
- **EmojiPicker** — buttons never disabled; the declared `loading` state
  gated nothing.
- **PlayerNotesPanel** — two taps on one tag both passed the
  `selectedTags.includes` test (state had not committed) and both charged.
- **CardBackSelector** — `handleSelect` checked `busy`,
  `handleConfirmPurchase` did not, and `setConfirmPurchase(null)` is a state
  write rather than a synchronous latch. Reachable from inside the
  persistent table layer.

Each now latches on a REF (state does not commit fast enough to stop a
double tap inside one commit) and disables its control while in flight.

Also fixed: EmojiPicker's VIP check set state after `await` with no mounted
guard.

## Pinned by

`tests/unit/ownedIsPermissionNotFailure.test.ts` — the ownership branch at
both sites, the charge-only-when-charged announcement, and all four latches.
