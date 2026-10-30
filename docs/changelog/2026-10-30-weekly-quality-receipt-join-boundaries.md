# Weekly quality receipt join boundaries

The original DSS close exceeded its180second business budget. The current TQ first-row query separately exceeded90seconds. Its dense-source branch could flatten into wide random lookups, and receipt checks bypassed the existing materialized source-ID receipt bag.

The current TQ owner now preserves the stream subquery boundary with OFFSET0 and joins that exact source-ID receipt bag. Survivor membership, duplicate clocks, wrong-event and missing receipts, orphan checks, validation order, amounts and financial rules are unchanged. No planner mode is forced. The slow per-event fee path is unchanged.

Only TQ is replaced by reserved migration20261030205404. All9 authority guards, immutable paid records, current source65/GEN72, existing index definitions, freeze refusal, history refusal and short DDL budgets are retained. The installed64511 migration and its historical installer evidence remain immutable. Its native business cases execute the current owner; its historical installer check explicitly extracts the old protected body. A separate successor manifest and6installer controls qualify the new single-owner transition.

Verification: current33 full-function receipt cases and52 current floor/fee cases pass; historical6 and successor6 native installer controls pass. The successor has canonical MD553ffa57118e0d605dc65c5cbc4043dda. Read-only source-fenced custom query completed60.377seconds; combined generic query completed74.947seconds. These timings do not certify a whole close. Actual changed whole180 rollback proof remains required before public installation, followed by strict installed readback and the original PUBLIC close proof. No books or payment completion is claimed.

TypeScript: explicit local Node20.20.2 tsc passed. Source bindings:1814pins across54sections passed. Final required hooks and hosted checks remain pending.
