# Preserve the actual lobby preference click verdict

Production runs 38994358828 and 38997226662 reported a missing preference request during restoration, without recording a completed click. The helper started the request timeout immediately before a click with the same timeout. When the click itself could not finish, the earlier request timer won and hid its actionable failure. Cleanup could then begin before the click settled.

Observe matching requests before the action, await the click's actual verdict, and then await the captured request and response within the original shared 30-second budget. Detach the request listener on every path. A fast request remains captured even when it precedes the click's completion; failed or missing saves, wrong owners, and unknown outcomes still fail. The 120-second journey limit is unchanged.

The regression fails before the correction with `Preference request timeout` and passes afterward with the actual click failure. All 21 preference-proof tests pass. Separate live checks completed cold-return and MTT restoration for both the dedicated service and a new reserved zero-balance staff account; the reserved account was hard-deleted and its absence verified. Those checks do not resolve or conceal the outstanding hosted click failure: the corrected full post-deploy run must supply its actual verdict.

On restoration failure, capture the actual returning document before closing it, with a bounded three-second screenshot. The old automatic failure screenshot captured the original fixture page after the returning page had closed. Preserve both the original failure and any diagnostic or close failure.
