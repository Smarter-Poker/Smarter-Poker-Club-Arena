# Poker Arena Diamond Programme: Phase 1

Dan approved one Poker Arena entry, reusing Club Arena as the shell and gameplay engine. Diamond Arena is a diamond-only skin. Every platform user is automatically a Diamond member; Shark and all other chip clubs require explicit joining. Player diamond transfers remain allowed. No union/agent structure or chip financial backing belongs in Diamond Arena.

This change adds the 12-phase programme and amends DIAMOND-RULINGS 4/16 and corresponding current accounting specification sections. Historical migrations are unchanged. Existing public clean-accounting release prerequisites remain.

Documentation only: no runtime feature, schema, balance, credential, engine setting or public route is changed. The initial dependency map identifies the old member chip_balance funding and transfer prohibition as work to replace. Branch publication is recorded separately from runtime deployment.

Verification: git diff --check passed; npx tsc --noEmit exited 0; all 12 phase headings and 24 referenced source paths verified; all three amended specifications reference the programme. No runtime tests or production build were needed for this documentation-only change. No hooks were bypassed.

Latest user instruction: remove all old Diamond Arena code and legacy paths. The programme now requires physical runtime deletion, dependency verification, removal of old route aliases, and forward database retirement with preserved financial evidence.
