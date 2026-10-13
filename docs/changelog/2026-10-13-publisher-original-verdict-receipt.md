# Preserve Original Publisher Verdict Evidence

GitHub returned successful publisher jobs with empty step arrays. The existing publisher now records its original GitHub step conclusions after the original validation, transaction, rollback and cleanup paths, in one immutable artifact per job and attempt. No transaction script, condition or admission assertion changes.

The receipt validator binds repository, protected workflow source, trigger, selected runtime, owning completed job and same-run artifact. It fills only an empty step array; nonempty missing, duplicate or conflicting evidence refuses. Earlier successful origin attempts survive optional job reruns without accepting foreign attempts. Missing historical receipts remain unknown. No logs, success badge or current origin snapshot invents step conclusions. Consumer integration and actual hosted receipt proof remain required.
