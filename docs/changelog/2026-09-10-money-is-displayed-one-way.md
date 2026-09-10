# 2026-09-10 - Money is displayed one way

Branch `fix/money-is-displayed-one-way`. Client only (`src/`, `tests/`, `docs/`).
Remediates audit findings CL-5..CL-14, CL-34..37, CL-39..42 from the 2026-09-08
Club Arena audit. Every finding was re-verified against `origin/main`
(`40886c94ab`) before it was touched; none had been fixed in the meantime.

## What was wrong

The audit counted 30+ distinct money formatters under `src/`: seven that
truncate, fourteen that round, four that abbreviate to K/M, and five with no
fraction options at all. Concretely:

- `src/lib/utils.ts` `formatChips` rounded half-up while `src/utils/format.ts`
  and `src/utils/clubDashboard.ts` truncated, so one balance read a cent apart
  on two screens (CL-7).
- `CommissionHistoryModal` called bare `toLocaleString()`, which is Intl's
  default of THREE fraction digits: 12.3456 read "12.346", 12.5 read "12.5"
  (CL-8). `AgentTree` set only `minimumFractionDigits: 0` and got the same
  three-decimal default (CL-9). `describeChipTransaction` set only a maximum,
  so 1,234.50 read "1,234.5" in the ledger sentence (CL-10).
- `PayoutStructure` abbreviated with `toFixed(1)` K/M, so a 1,250,000 first
  prize and a 1,349,000 second both read "1.3M" (CL-12). `TournamentClock`
  showed 10,400 and 10,600 as "10K" and "11K" (CL-40). `TournamentHUD` and
  `AgentScoreCard` carried their own ladders. `fmtChips` in `format.ts` was the
  exported one every lobby page reached for (CL-41).
- `SessionSummaryHost` rounded to whole chips before formatting, so a session
  net of -0.49 showed as "0": a loss shown as break-even (CL-13).
- `PotDisplay` returned "0" for a NaN pot, because `!(amount > 0)` is true for
  NaN (CL-14).
- `lib/utils.formatCurrency` accepted a `currency` argument it never read
  (CL-39). `table/CashierModal` and `table/BuyInModal` carried byte-identical
  `formatAmount` copies (CL-42). The tournament payout list formatted inline
  with `maximumFractionDigits: 2` and no minimum (CL-11).

And on the accessibility side: the money field `AmountInput` had no id, no
label binding, no `aria-invalid`, no `aria-describedby`, and its CSS set
`outline: none` on `:focus` with no `:focus-visible` replacement (CL-5, CL-35);
the club cashier's amount input had no id and its label no `htmlFor` (CL-6);
every tournament card was a bare `div` with `onClick` (CL-34); the VIP and
Report Player overlays had an unnamed "x" close, no `role="dialog"`, no
`aria-modal`, and no Escape handling (CL-36, CL-37).

## What changed

**One home.** `src/utils/format.ts` is the only place a chip amount becomes
text. Its family and the rule each one carries:

| helper              | for                                           | rule                                                       |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `formatChips`       | wallets, cashier, ledger, prizes, commissions | two places always, separators, truncated at the cent       |
| `formatSignedChips` | a P/L                                         | same, with a leading + or -, sign from the truncated cents |
| `formatTableChips`  | chips on the felt, tournament clocks          | integers clean, a real fraction kept (unchanged)           |
| `formatStackChips`  | a seat's stack                                | pennies under 100, whole above (unchanged, Dan 2026-09-04) |
| `formatChipAward`   | the "+N" arriving at a seat                   | unchanged                                                  |

`formatChips` now accepts a numeric string (ledger columns arrive as text),
returns "0.00" for anything non-finite, and never prints "-0.00".
`fmtChips` (K/M) is deleted. `src/lib/utils.ts` and `src/utils/clubDashboard.ts`
re-export the canonical functions; `formatCurrency` lost its unread parameter.

**Callers.** 17 files now import from `utils/format` instead of formatting on
their own: the seven lobby/admin/agent pages that used `fmtChips`, the two
money-entry modals, `PotDisplay`, `PayoutStructure`, `TournamentClock`,
`TournamentHUD`, `AgentScoreCard`, `AgentTree`, `CommissionHistoryModal`,
`SessionSummaryHost`, `describeChipTransaction`, `ClubProfileModal`,
`ClubActivityChart`, `TournamentPage`, `club/CashierModal`, `AmountInput`.

Visible consequences a player will notice: agent and admin figures that read
"1.5K" read "1,500.00"; the tournament clock reads "10,400" not "10K"; the
payout structure reads "1,250,000.00" and "1,349,000.00"; the session summary
reads "-0.49" for a 49-cent loss; a pot the client cannot compute reads "-"
instead of "0".

**Accessibility.** `AmountInput` binds label to field with `useId`, carries
`aria-invalid` and `aria-describedby` to a `role="alert"` error, presets are
`type="button"` with `aria-pressed`, and the focus ring sits on the container
via `:focus-within`. The club cashier input has an id and the label an
`htmlFor`. Tournament cards are `role="button"`, `tabIndex=0`, `aria-pressed`,
and open on Enter or Space. The VIP and Report Player modals are
`role="dialog"` / `aria-modal` / `aria-labelledby`, use the existing
`useDialogEscape` and `useFocusTrap` hooks, and their close buttons are named.

## The law

`tests/money-is-displayed-one-way.law.test.ts` (registered in
`docs/laws.d/money-is-displayed-one-way.md`):

1. the formatter behaves as Dan ruled (two places, truncated, never NaN, no
   K/M from any export);
2. `lib/utils` and `clubDashboard` are re-exports, not implementations, and
   `formatCurrency` has one parameter;
3. no file in `src/` has a K/M ladder, a `padStart` on a number (the clock's
   `padStart(2, '0')` is the one exception), or the identifier `fmtChips`;
4. **a ratchet**: the 71 files that still carry their own
   `minimum/maximumFractionDigits` and the 94 that still call a bare
   `.toLocaleString()` on a money identifier are listed by name. A file may
   leave the list; a file may not join it, and the list may not name a file
   that no longer offends. New ad-hoc money formatting fails with the name of
   the function to call instead;
5. source pins for each accessibility fix.

`tests/unit/chipsOnTheFeltAreNeverAbbreviated.test.ts` no longer pins
`fmtChips(1500) === '1.5K'` ("the lobby may still abbreviate" was an agent's
scoping note from 2026-08-28, superseded by Dan's 2026-09-04 "ABSOLUTELY ZERO
ROUNDING ANYWHERE EVER"); it now pins that the export is gone.
`tests/unit/describeChipTransaction.test.ts` expected the CL-10 output
("1,250.5"); it now expects "1,250.50".

## Not done here, deliberately

The 165 files on the ratchet still format money on their own. They are
correct in most cases (two places set explicitly) and wrong in some (bare
`toLocaleString()` on a money value). Sweeping them is mechanical but touches
every page in the app; the ratchet makes each one a one-line fix that cannot
regress, and refuses any new one. The felt formatters (`formatTableChips`,
`formatStackChips`, `formatChipAward`) keep the contracts Dan set on
2026-08-28 / 08-29 / 09-04; "two decimals everywhere" would have contradicted
the stack rule (whole chips from 100 up) and was not applied to them.
