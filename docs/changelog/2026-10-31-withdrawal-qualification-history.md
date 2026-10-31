# Withdrawal qualification retains the pinned original generation

The protected withdrawal job checked out only one commit. Its native qualification reads the exact original bd11 source from Git history, so the shallow checkout failed before any host operation. The existing checkout now fetches full history, matching engine preflight. Regression coverage verifies the protected ref, full-depth setting, credential non-persistence and the pinned original source blob. No fixture source is copied or substituted, and no engine or production operation is changed.
