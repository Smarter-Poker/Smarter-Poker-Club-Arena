# 2026-09-24: Visual acceptance of the product completion surfaces

Assignment CA-PRODUCT-COMPLETION-2026-09-22, Phase 5.6. Every surface the
assignment shipped (kill pots, multi-day, schedule zones, club membership,
tournament creation refusals) was rendered headless at 393px and 1440px with
synthetic fixtures. The checklist, method and screenshot names are in
`docs/handoffs/club-arena-product-completion/VISUAL-ACCEPTANCE.md`.

## Defects fixed

1. **Killer seat lost its blind badge** (`SeatSlot.tsx`, `SeatSlot.css`). "Kill
   Blind" was an absolutely placed twin of the position badge and, wider than
   half the avatar, painted over SB/BB (UTG+1 overlapped by 17px). On the
   killer's seat both now sit in one flex row (`.seat__corner-badges`); the
   marker breaks onto two lines. Every other seat renders exactly as before.
2. **Rules sheet value over its label** (`GameRulesModal.css`). The kill rule's
   long Trigger / Killer sentences took the whole row; the label column now
   keeps its longest word and the value wraps.
3. **Kill control flush on the rail** (`CashGameCreateFlow.css`). Chips and the
   rule sentence inside the promise panel take the 12px inset.
4. **Day Schedule editor in browser defaults** (`DayScheduleEditor.tsx/.css`).
   Fields use `config-datetime`, buttons the form's outline button, the picker
   icon is visible.
5. **Reschedule Day 2 in browser defaults, zone as an id**
   (`RescheduleStageControl.tsx/.css`). Board field ink; "America/New York".
6. **Tournament card "Day 1 Complete" overprinted** (`TournamentLobbyCard.tsx`,
   `.module.css`). The multi-day row stacks and its start time wraps.
7. **Schedule summary not Title Case, zone with an underscore**
   (`WeeklyScheduleEditor.tsx` `describeSchedule`, `scheduleTimeZone.ts`
   `scheduleZoneLabel`, display only). "Fri At 20:00 America/Argentina/Buenos
   Aires", "Every Day - Every 60 Min".
8. **Invisible union schedule button** (`UnionDetailPage.module.css`
   `.joinButton`): its gradient read `--accent`, which exists only in the
   unimported `globals.css`. Brand blue, white ink.
9. **Club allowance line off both edges of the phone**
   (`CreateClubModal.module.css`): the footer line wraps.
10. **Tournament form refusals printed grey** (`CreateTournamentModal.tsx`,
    `.module.css`): the lines take the summary block's red.

## Tests

- New `tests/unit/productCompletionVisualAcceptance.test.tsx` (13 cases).
- `tests/unit/scheduleKeepsItsTimeZone.test.tsx`: expectation moved to Title
  Case in the same change, plus a new every-word-capitalised case.
