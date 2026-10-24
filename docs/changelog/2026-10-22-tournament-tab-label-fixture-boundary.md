# Tournament tab label fixture boundary

The exhaustive live event-name and buy-in label matrix mounted a closed account menu and personalized button-skin lookup on every render. The incomplete session fixture repeatedly invoked identity hydration, producing thousands of irrelevant errors and exhausting the hosted test budget.

Keep the real TableTabBar and every event/amount assertion, isolate only the unrelated TableMenu and button-skin boundaries, and assert that label tests never hydrate an account. The new boundary invariant fails against the original menu mount and passes with the isolated fixture. No runtime behavior or test timeout changed.
