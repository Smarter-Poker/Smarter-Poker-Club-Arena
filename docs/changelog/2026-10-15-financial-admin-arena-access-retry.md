# An Arena Check That Did Not Answer Is Not A Broken Console

## What Was Wrong

Post-Deploy run 38707543879, job 116332102567, 2026-10-15 09:23 UTC. The
Financial Admin console certificate failed on the CSV Exports route:

```
renders every directly linked club console at exactly 393px without unsafe copy or controls
  Error: expect(locator).toBeVisible() failed
  Locator: getByRole('heading', { name: 'Financials', exact: true }).first()
  Timeout: 60000ms
  Error: element(s) not found
```

Read as written, that says the CSV Exports console is broken. It was not. In the
same job 458 of 458 sweep cases passed, and the recorded page snapshot for the
failing step is not a console at all:

```yaml
- main [active]:
    - alert:
        - generic: Poker Arena
        - heading "Could Not Verify Arena Access" [level=2]
        - generic: Offline
        - paragraph: The Arena Did Not Answer. Nothing Is Wrong With Your Account;
            The Check Simply Did Not Come Back. Try Again In A Moment.
        - button "Retry"
```

That is `ArenaAccessBoundary`'s own recovery surface, rendered when the access
read does not come back. The page says in its own copy that nothing is wrong
with the account, and it offers a Retry plate that re-runs the check. The
certificate never clicked it: it waited sixty seconds for a heading that cannot
appear until the boundary settles, then failed, and the console behind it was
never reached.

## The Change

`openConsole` now takes the recovery the page already offers, bounded at two
retries, before it asserts the console. Three endings, none of them silent:

| Ending                                      | Outcome                                               |
| ------------------------------------------- | ----------------------------------------------------- |
| The check answers, the console is right     | certified, exactly as before                          |
| The check answers, the console is wrong     | a real defect, named as one                           |
| The check never answers across both retries | named as the arena access check, never as the console |

This relaxes nothing. The exact heading assertion, the terminal-surface wait and
every per-console outcome in `expectLinkedConsoleOutcome` are unchanged, and the
retry fires only for `ArenaAccessBoundary`'s exact alert surface. The same
correction already exists one test down in "renders a bounded hub error and
recovers through the read-only retry"; this gives the linked consoles the same
honesty.
