# tests/workflow-run-names-a-live-workflow.law.test.ts

A `workflow_run` listener names a workflow that exists. `workflows:` matches the other workflow's `name:`, not its filename; rename or delete it and the listener silently never fires again. #2676 renamed the publisher and missed the post-deploy E2E listener for six hours.
