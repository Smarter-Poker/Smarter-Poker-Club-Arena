---
name: verify-before-done
description: 'MANDATORY verification protocol. Agents MUST verify all work is actually complete and functional before claiming success. No task is "done" without proof. Trigger on: every task completion, every claim of success, every "done" statement, every verification step.'
---

# Verify Before Done — Mandatory Proof-of-Work Protocol

## RULE (NON-NEGOTIABLE)

**You MUST verify that your changes actually work before claiming a task is complete.**

"It should work" is NOT verification. "I believe this fixes it" is NOT verification. Only confirmed, observable proof counts.

## WHAT COUNTS AS VERIFICATION

### For Code Changes:

1. **Build passes** — Run `npm run build` and confirm zero errors
2. **No new TypeScript errors** — Check build output for type errors
3. **Feature works on smarter.poker** — Visually confirm in browser (see `testing-protocol` skill)
4. **No regressions** — Check that existing functionality still works

### For Bug Fixes:

1. **Reproduce the bug first** — Confirm you understand what was broken
2. **Apply the fix**
3. **Build passes** — `npm run build` with zero errors
4. **Bug is gone** — Verify on smarter.poker that the issue is resolved
5. **No side effects** — Confirm nothing else broke

### For Deletions / Removals:

1. **No broken imports** — Build must pass with zero errors
2. **No dead references** — Grep for removed identifiers to ensure nothing references them
3. **Feature is actually gone** — Verify on smarter.poker the removed element is not visible

### For UI Changes:

1. **Screenshot the result** — Use browser tools to capture the actual rendered output
2. **Compare to expectations** — Does it look right? Is the layout correct?
3. **Check mobile** — Resize and verify responsive behavior if applicable

## VERIFICATION CHECKLIST (Run Before Claiming Done)

```
[ ] Code compiles — `npm run build` exits with 0 errors
[ ] No lint/type regressions — no NEW errors introduced
[ ] Pushed to GitHub — (see `auto-push` skill)
[ ] Deployed to smarter.poker — Vercel deployment completed
[ ] Tested on smarter.poker — (see `testing-protocol` skill)
[ ] Proof collected — Screenshots, terminal output, or browser observations
```

## PROHIBITED CLAIMS

- ❌ "This should work" — without build verification
- ❌ "The fix is in place" — without testing on smarter.poker
- ❌ "Done" — without running through the verification checklist
- ❌ "Successfully implemented" — without observable proof
- ❌ "Verified working" — based only on reading the code, not running it

## WHAT TO DO WHEN VERIFICATION FAILS

1. **Do NOT claim success** — Be honest that it's not working yet
2. **Diagnose the failure** — Read error messages, check logs
3. **Fix the issue** — Apply corrections
4. **Re-verify from scratch** — Run the full checklist again
5. **Only THEN claim completion** — With proof

## MINIMUM EVIDENCE FOR COMPLETION

At absolute minimum, every task must have:

1. A successful `npm run build` output (zero errors)
2. A `git push` confirmation
3. A statement of what was verified and how

For UI-visible changes, additionally require: 4. A browser-based check on `smarter.poker` confirming the change is live
