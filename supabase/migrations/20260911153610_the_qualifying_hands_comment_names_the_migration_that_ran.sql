-- The COMMENT installed by 20260911153422 named migration 20260911153245 - the
-- version `reserve-migration-version.sh` handed me. The management API stamps
-- its OWN timestamp at apply time, so what actually landed was 20260911153422,
-- and the comment was pointing a future reader at a migration that does not
-- exist. One statement, one reload, so the table's own description names the
-- migration that really maintains it.
COMMENT ON TABLE public.bbj_qualifying_hands IS
  'DESCRIPTIVE MIRROR, NOT THE RULE. The Bad Beat Jackpot qualifying rule is '
  'enforced by BBJ_QUALIFYING_HANDS in server/src/config/RakeConfig.ts and is '
  'mirrored for player-facing surfaces in src/config/RakeConfig.ts; those two '
  'are held identical by tests/one-qualifying-rule-for-one-jackpot.law.test.ts. '
  'Nothing reads this table. It is kept in step with the engine by migration '
  '20260911153422 because a stale copy that LOOKS authoritative is worse than '
  'no copy - before that migration it marked PLO6 eligible (the engine refuses '
  'PLO6), carried an ofc row the engine has never had, and omitted six '
  'variants including the live pineapple. If you change the rule, change the '
  'engine; then update this table in the same pull request or delete it.';
