# Uncalled returns preserve aggression evidence

Burls live verification found that valid hands ending in an uncalled-bet return lost AF measurement. Both the original fact-insertion helper and the public HUD summary rejected the engine's legitimate `return` action as unknown. They now accept that settlement action without counting it as a bet, raise, or call. Unknown and incomplete action histories remain unmeasured.

The migration changes only the maintained counting helper, preserving its grants and the original insert transaction. It does not rewrite historical facts or money. The engine summary uses the same rule. Native PostgreSQL and public-summary regressions fail before the repair and pass afterward, including a folded player whose opponent receives returned chips. Existing retry and privacy assertions remain intact.

The database helper installs from protected main through Apply Merged Migration; the HUD producer requires the normal certified engine release. Source, installation, publication and live proof are recorded in CHECKPOINT-burls-stats.md.
