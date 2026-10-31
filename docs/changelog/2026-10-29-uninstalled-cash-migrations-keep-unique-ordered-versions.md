# Uninstalled cash migrations keep unique ordered versions

Before merge, protected main independently added `20261029212243_satellite_schedules_fund_economical_target_tickets.sql`, colliding with this branch's uninstalled cash statistics version. Auto-merge was disabled. The foreign file and all installed migration history remain unchanged.

The maintained `scripts/new-migration.mjs` allocator reserved this ordered replacement chain:

| Uninstalled owned version | Replacement    |
| ------------------------- | -------------- |
| 20261029212243            | 20261029230358 |
| 20261029212431            | 20261029230421 |
| 20261029212530            | 20261029230441 |
| 20261029212616            | 20261029230502 |

The index and corrected linked-union statistics versions remain unchanged. Exact history/source-hash bindings and install readbacks follow the new names. Inverse checks restore the previous four SQL bodies by reversing only version/hash references; function, economic, percentage, duplicate-protection and genuine-generation logic do not change.

Validation on integrated protected main: cash/statistics 16 native controls, TQ 8 controls, three-helper 9 controls, exact closure readiness positive and five negative controls, TypeScript and four affected source-test files (16 tests) pass. These remain source qualifications; actual installation, whole-book capacity and durable closure proof are separate required steps.
