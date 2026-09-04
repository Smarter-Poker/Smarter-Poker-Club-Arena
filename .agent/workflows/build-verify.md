---
description: Build verification and code quality checks for Club Arena
---

# Club Arena Build Verification

**CRITICAL**: Always run build verification before deploying to production.

## Quick Build Check

// turbo

```bash
cd /Users/smarter.poker/Documents/club-arena
npm run build
```

## Full Verification Workflow

```bash
cd /Users/smarter.poker/Documents/club-arena

# 1. Type check
npm run type-check

# 2. Build for production
npm run build

# 3. (Optional) Run E2E tests
npm run test:e2e
```

## When to Verify

**ALWAYS verify before deploying if:**

- ✅ Making significant code changes (new features, refactors)
- ✅ Modifying TypeScript types or interfaces
- ✅ Changing service layer or API integrations
- ✅ Updating dependencies

**Can skip verification for:**

- ❌ Minor CSS/styling tweaks
- ❌ Text content updates
- ❌ Documentation changes

## Build Success Criteria

✅ **Successful build output:**

```
✓ built in X.XXs
✓ XX modules transformed
```

❌ **Failed build indicators:**

```
✗ TypeScript errors
✗ Module not found
✗ Build failed
```

## Common Build Issues

### TypeScript Errors

```bash
# Check specific file
npx tsc --noEmit src/path/to/file.tsx
```

### Missing Dependencies

```bash
npm install
```

### Cache Issues

```bash
rm -rf node_modules/.vite
npm run build
```

## Integration with Deployment

REWRITTEN 2026-09-04. What used to be here was `git push origin main` followed
by `vercel --prod --yes` - three things that are each independently wrong now,
in a file with no supersession banner on it, unlike the other three deploy
workflows in this directory. `main` is a protected mirror and refuses a direct
push; Club Arena's Vercel project has `deploymentEnabled: false`; and CLAUDE.md
1.3 forbids the Vercel CLI in this directory outright.

**The whole workflow:**

```bash
# 1. Work on a branch in your own worktree, never in the shared clone
git worktree add -b fix/<slug> ~/Documents/.agent-trees/club-arena/<name> origin/main

# 2. Build locally if you touched src/ - the pre-push hook typechecks anyway
npm run build

# 3. Push the branch. THIS IS THE END OF YOUR JOB.
git push origin HEAD:refs/heads/fix/<slug>
```

`agent-open-pr.yml` opens the pull request within seconds, `agent-autopilot.yml`
squash-merges it when the six required checks are green, and
`publish-club-arena.yml` rsyncs `dist/` to `ca-static.smarter.poker`. Do not
open the PR yourself, do not merge, and do not sit watching CI (CLAUDE.md
10.8.3).

**The only claim of "deployed" that counts:**

```bash
curl -s https://smarter.poker/hub/club-arena/build-info.json   # ca_sha == main
```

---

**Remember**: a successful local build doesn't guarantee production success, but
it catches most issues before they cost the whole estate a red pipeline.
