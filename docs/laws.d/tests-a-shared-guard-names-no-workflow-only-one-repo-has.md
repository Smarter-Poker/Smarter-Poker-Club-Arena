# tests/a-shared-guard-names-no-workflow-only-one-repo-has.law.test.ts

agent-autopilot.yml is byte-identical in seven repos and only Club Arena has a ci.yml; it asked `gh run list --workflow ci.yml`, answered "none" for every World Hub pull request, and pushed an empty re-trigger commit onto each of them after every real push. It now decides "no CI at all" from any pull_request run on the head and "red" from the checks the base ruleset requires, and no shared guard may name a workflow by a name one repo owns
