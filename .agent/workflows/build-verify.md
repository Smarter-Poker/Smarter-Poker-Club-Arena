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

**Recommended workflow:**

```bash
# 1. Build locally
npm run build

# 2. If successful, deploy
git add -A
git commit -m "your message"
git push origin main
vercel --prod --yes
```

---

**Remember**: A successful local build doesn't guarantee production success, but it catches 90% of issues!
