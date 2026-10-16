# Phase 7 keeps the installed lease watchdog

The remaining Phase 7 migration expected the older watchdog, but the installed owner-lease revision already ignores deleted table closes and also preserves lease and paging behavior. Installing the old replacement would refuse its preimage guard.

The still-uninstalled Phase 7 migration now accepts that one exact installed definition with its exact owner, grants, volatility, security and settings, and leaves every byte untouched. The original guarded replacement remains for the original source. Unknown definitions still refuse. Launch-health changes and incident qualification, row locks, prior-resolution preservation and rollback are unchanged.

The existing required native driver proves the old guard refuses the actual installed definition, the new path preserves the entire definition, and a changed definition refuses. The existing incident overwrite, duplicate, rollback and concurrent-resolution regressions remain required. No watchdog is executed against production as a probe.
