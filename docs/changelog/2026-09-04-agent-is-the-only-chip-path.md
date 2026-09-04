# The agent is the only chip path (2026-09-04)

Deleted the four direct payment rails from `DepositWithdrawModal` and everything
downstream of them. The agent path stays, because it is the only one that was
ever real.

## What was in the code

`src/components/wallet/DepositWithdrawModal.tsx` declared

```ts
type PaymentMethod = 'crypto' | 'venmo' | 'zelle' | 'cashapp' | 'agent';
```

and carried a five-entry catalog with Club Arena's own handles on four of them:

| Method   | Destination shown to the player          | Min / max    | Fee | Stated time |
| -------- | ---------------------------------------- | ------------ | --- | ----------- |
| Crypto   | a wallet address field, "BTC, ETH, USDT" | 20 / 100,000 | 0%  | 10-30 min   |
| Venmo    | `@ClubArena`                             | 10 / 5,000   | 3%  | 1-2 hours   |
| Zelle    | `Pay@Clubarena.Com`                      | 10 / 10,000  | 2%  | 1-2 hours   |
| Cash App | `$ClubArena`                             | 10 / 5,000   | 3%  | 1-2 hours   |
| Agent    | "Transfer Through Your Agent"            | 10 / 50,000  | 0%  | Instant     |

Each of the four had a branded SVG logo (Bitcoin orange, Venmo blue, Zelle
purple, Cash App green) under a banner calling them "high-trust payment method
icons", a per-rail destination label in a five-branch ternary, and a deposit
instruction list telling the player to send money and put a reference ID "in the
memo".

All of it was reachable: `PlayerWalletPage.tsx` mounts the sheet twice and
renders both hero buttons, and `App.tsx` routes the page at
`/hub/club-arena/wallet` behind `AuthGuard` alone.

## Why it is gone

Dan, 2026-09-04, verbatim:

> PLAYERS CAN CASH OUT THEIR CHIPS WITH AN AGENT FOR REAL WORLD PRIZES,
> SMARTER.POKER NEVER RECEIVES PAYOUTS OR TAKES PAYMENT DIRECTLY FOR ANY CLUB
> ARENA PLAY.

The four rails asserted the opposite, in the platform's own name, on a screen
any player or app reviewer could open. A Zelle address at `Clubarena.Com` is not
an ambiguous signal.

The product's disclaimer already says what is true, and the player accepts it
before entering — `ClubArenaWelcomeModal.tsx:83-89`:

> Club Arena Is Not Responsible For Any Interactions Or Arrangements Between
> Club Members.
>
> Club Owners And Operators Are Independent And Not Affiliated With Or Endorsed
> By Club Arena.

A player cashing out with their agent is exactly the arrangement that clause
describes, and it happens off this platform. The agent method is an in-platform
transfer of chips between two member accounts; no money crosses Club Arena in
either direction.

**Deleted, not disabled.** No feature flag and nothing commented out. A flag gets
flipped and a comment gets uncommented, and neither survives the next agent who
opens this file looking for "the payment methods".

## What changed

`src/components/wallet/DepositWithdrawModal.tsx`

- `PaymentMethod` is now the single literal `'agent'`, under a block comment
  recording Dan's ruling and saying plainly not to add a rail here.
- The four branded logos are deleted; `PaymentLogo` renders the one agent icon.
- `PAYMENT_METHODS` collapsed to a single exported-shape `AGENT_METHOD`.
- **The method-select step is gone.** One card is not a choice. `Step` is now
  `'amount' | 'confirm' | 'success'`, the sheet opens on the amount with the
  method already fixed, `StepProgress` shows three stages, and the Back button
  only appears on confirm. `selectedMethod` stopped being nullable state and
  became a const.
- The withdrawal destination is a single optional **Agent ID** field. The old
  guard required an address for every method _except_ agent, so it could never
  fire again; the field's optionality is unchanged from what agent always had.
- The deposit instruction list no longer says "Send 500 To Transfer Through Your
  Agent" followed by a bank memo line. It describes the agent transfer and
  repeats, at the point of action, that Club Arena is not a party to it and
  takes no payment.
- Copy that named money Club Arena does not handle: the sheet title
  "Deposit Funds" / "Withdraw Funds" is now "Add Chips" / "Cash Out Chips", and
  the confirm total "You Pay" / "You Receive" is now "Chips Requested" /
  "Chips Released".

`src/pages/PlayerWalletPage.tsx`

- The hero buttons read "+ Add Chips" and "Cash Out" so the entry point and the
  sheet it opens agree. Class names (`hero-btn deposit`, `hero-btn withdraw`)
  are untouched, so the existing CSS still lands.

## What did not change

`FUNDING_ENDPOINT` is still `null`, and the confirm button is still disabled with
"Ask Your Agent To Cash You Out". That is unrelated to this change and correct:
the audit of 2026-08-25 established there is no server route for a funding
request and that the old direct `wallet_transactions` insert was impossible four
ways over. The seam is unchanged for whenever a route exists.

No database change. `wallet_transactions` never had a `payment_method` column —
that was one of the four reasons the old insert failed. The only
`payment_method` in this schema is on `credit_payments`
(`'wallet' | 'diamonds' | 'external'`), which is unrelated and untouched.

Nothing outside these two files referenced the rails. Verified by grep across
the repo: every remaining `crypto` match is `crypto.randomUUID()` or
`globalThis.crypto`, the Web Crypto API.

## Open for Dan, not decided here

The welcome disclaimer says **"All Chips And Currencies Are Virtual With No
Real-World Monetary Value"**, and `TermsOfServicePage.tsx:49-54` says chips
"Cannot Be Exchanged For Real Money Or Prizes". Dan's ruling above says players
_can_ cash out with an agent for real-world prizes. Those two statements are in
tension, and the tension is in the legal copy rather than in the code.

Not touched here. Section 10.9 keeps legal and forward-looking terms with Dan,
and a code change is the wrong instrument for it. Flagging it because a reviewer
who reads both will ask, and because the honest version of the disclaimer is
probably closer to "Club Arena issues no cash value and settles nothing; any
arrangement between a player and an independent agent is between them" than to a
flat denial that prizes exist.
