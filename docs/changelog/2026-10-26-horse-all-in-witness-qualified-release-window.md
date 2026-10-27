# Install the accepted all-in witness through its original release

PR #8244 protected merge d4a9397f74b76508fa3830f93a0f88b6885e9c05 preserves the original all-in runout obligation through accepted stats and distinguishes owner-forced authority from independent qualification. The currently serving 814862e363946b90f103b71246dc69dec24c31d5 does not contain that repair; the earlier cash window is already consumed.

Record the directly verified owner instruction to reset now rather than wait for 4 AM as one finite, expiring entry anchored to the actual protected merge. The entry uses the existing certified release transaction and adds no publisher or migration operation. Keep this PR a draft until migration 20261026181909 has exact installed history, projector postimage and unchanged ACL readback. Staging, activation, original accepted behavior and canonical fleet proof remain separate evidence.
