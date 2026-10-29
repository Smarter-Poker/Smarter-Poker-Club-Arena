# Private record hosting qualification input and remote script coverage

The isolated Linux bootstrap fixture now pipes stdin whenever its maintained child-process helper receives input. Commands without input still ignore stdin, and explicit stdio overrides remain authoritative. A real child-process regression verifies bootstrap JSON, no-input EOF and explicit ignored-input behavior. The existing Caddy stdin regression remains enforced.

The remote shell parser inventory now includes the existing Club Arena publisher's reviewed gateway heredoc. Every discovered remote heredoc still runs through bash syntax validation, including the original apostrophe regression.

These changes repair PR #8455 CI qualification. They do not install or activate the gateway, change paid Realtime, or certify the four Linux scenarios before their actual hosted execution.
