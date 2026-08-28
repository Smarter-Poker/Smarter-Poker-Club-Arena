# Six components needed one boolean and mounted a settings engine each

Dan: "GO AHEAD AND FULLY BUILD ALL OF THESE."

## What `useButtonImage` actually did

It picks between two words in a URL — `blue` or `black` — from one flag,
`blue_buttons_enabled`. To read it, it mounted the whole of
`useUserTableSettings`. Per call site that is:

- a full row of React state plus five mutation refs (`writeTailsRef`,
  `durableValueRef`, `pendingEchoRef`, `mutationRevisionRef`,
  `pendingWriteCountRef`) — none of which a read-only consumer can use;
- **two** MasterBus subscriptions (`SETTINGS_CHANGED` and
  `CUSTOMIZATION_MUTATION_STATE`);
- and a re-render on **every** settings change, not just this one flag.

TableMenu, PreviousHandCard, MiniStatsCard, RabbitHunt, TableChat and
TimebankCounter all call it, plus two more calls inside TablePage — eight per
table. MultiTablePage keeps four tables mounted: **32 settings engines, 64 bus
subscriptions, and 32 components re-rendering whenever any unrelated setting
changed**, to choose an icon colour.

## The fix, and why it is a separate store

`useBlueButtonsEnabled` is a read-only shared selector: **one store per user,
one boolean, no write path**, bound with `useSyncExternalStore` so React
re-renders a consumer only when the value actually changes.

**It is not a refactor of `useUserTableSettings`, deliberately.** That hook
synchronises its instances through MasterBus, using an `origin` identity to skip
its own echo and `pendingEchoRef` to suppress a postgres echo while a local write
is in flight. Collapsing those instances onto shared state would delete the
meaning of "my own echo" and rewrite the synchronisation model of a hook whose
own notes describe a latch that _"swallows the next genuine cross-component
change"_ — an intermittent, cross-component failure, which is exactly the kind
unit tests do not catch. A read-only consumer needs none of that machinery.

How it stays correct:

- seeds from the same `readCachedSettings` cache the real hook uses, so the icon
  is right on first paint;
- then awaits `fetchUserTableSettingsRow`, which is **de-duplicated per user**
  (shipped in #1601), so this adds **no query** — it rides the read the real hook
  already issues;
- and listens to the same `SETTINGS_CHANGED` broadcast the real hook emits on
  every toggle _and_ on rollback, so flipping the setting still repaints every
  icon immediately.

The settings panel's write path is untouched. This store simply hears the same
broadcast it already made.

## Two things the tests taught me

**MasterBus is mocked globally in `tests/setup.ts`** — `emit` is a `vi.fn()`
no-op. My first "repaints every consumer" test called `emit` and asserted a
repaint; it failed, and would have failed for reasons unrelated to this store. A
throwaway probe confirmed a subscriber receives nothing in this harness.
`subscribe` _is_ a `vi.fn`, so the test now pulls the handler the store
registered out of its mock calls and invokes it directly — testing what this file
is responsible for, and leaving delivery to MasterBus's own tests.

**One of my mutations was not caught, and the test was the reason.** Removing the
`setting !== 'blue_buttons_enabled'` filter left the suite green, because the
"ignores other settings" test delivered `show_avatars: false` while the store
already held `false` — the value never changed, so nothing could detect the
missing filter. It now drives the store to `true` first, then delivers an
unrelated `false`. Third instance of this exact vacuous-pass shape in this
session, after `/\bdvh\b/` and the exported-seam guard.

## Guards

`tests/unit/buttonSkinIsASharedSelector.test.tsx` (7 tests): eight consumers
share one store; no extra query is issued; a toggle repaints every consumer _and_
its siblings; a broadcast for a different user is ignored; an unrelated setting
does **not** change the skin; a signed-out viewer creates no store and gets the
canonical default; and `useButtonImage` no longer imports `useUserTableSettings`.

All three mutations caught:

```
MUTATION: store per consumer instead of per user   -> 1 failed | 6 passed
MUTATION: drop the setting-name filter             -> 1 failed | 6 passed
          "an unrelated setting changed the button skin — the selector is not filtering"
MUTATION: useButtonImage back to the settings hook -> 1 failed | 6 passed
restored                                           -> 7 passed
```

## Results

```
npx tsc --noEmit        TSC=0
npx vitest run tests/   524 files, 8145 tests, 0 failed
```
