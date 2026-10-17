# Banner Displays: Club Banner And Platform Ad Visibility

Club owners, including union club owners, manage their own top club banner separately from Smarter.Poker rotating advertisements. Banner Displays now offers only a persisted show/hide switch for those advertisements. Owners cannot upload, replace, reorder or remove platform ad creatives. Existing owner creative configuration is ignored by the ad renderer.

The visibility setting defaults to shown, uses an owner-constrained full-settings compare-and-swap, and preserves unrelated settings. Hiding the lobby strip stops its resolver, rotation, popup and ad events. Other ad placements retain their existing behavior and platform image/billing safeguards. The existing settings-specific event preserves in-progress banner saves and membership guards.

Focused regression coverage verifies union access, owner denial, independent top-banner/visibility saves, reload persistence, stale-write refusal, and hidden-ad suppression. The maintained production club certificate checks both OFF/ON transitions and top-banner independence, then restores its disposable fixture. Protected checks, publication and live verification are recorded in the task evidence checkpoint.
