---
name: mandatory-typecheck
description: 'ABSOLUTE LAW — Every agent MUST run `npx tsc --noEmit` BEFORE committing or pushing ANY code change. If it fails, you DO NOT commit. You DO NOT push. You fix the errors first. No exceptions. Trigger on: every git add, every git commit, every git push, every code change.'
---

# Mandatory TypeScript Check — ABSOLUTE LAW

## WHY THIS EXISTS

Claude agents have repeatedly pushed code with TypeScript errors to `main`, causing CI pipeline failures on every push. This creates cascading failure notifications and blocks deployments. **This is unacceptable.**

Common mistakes that caused production CI failures:
- Importing components that don't exist (not created, not exported)
- Emitting bus events with fields not declared in the type map
- Passing JSX props that aren't in the component's interface
- Adding properties to objects that don't match their type definition

## THE RULE (NON-NEGOTIABLE)

**Before EVERY `git commit`, you MUST run:**

```bash
npx tsc --noEmit 2>&1 | tail -20
```

**If it exits with ANY errors → STOP. Fix them ALL. Re-run until exit code 0.**

Only then may you `git commit` and `git push`.

## ENFORCEMENT PROTOCOL

### Step 1: Make your code changes

### Step 2: Run TypeScript check (MANDATORY)
```bash
npx tsc --noEmit
```

### Step 3: If errors exist → FIX THEM
- Read each error carefully
- Fix the root cause (don't suppress with `any` or `@ts-ignore`)
- Common fixes:
  - **TS2305** "has no exported member" → Create the component/export, or fix the import
  - **TS2353** "does not exist in type" → Add the property to the type definition
  - **TS2322** "not assignable to type" → Remove invalid props, or add them to the interface
  - **TS2304** "cannot find name" → Import the missing module/type

### Step 4: Re-run TypeScript check
```bash
npx tsc --noEmit
```
Must exit with code 0 and no error output.

### Step 5: NOW commit and push
```bash
git add -A
git commit -m "your message"
git push origin main
```

## PROHIBITED ACTIONS

- ❌ NEVER `git commit` without running `npx tsc --noEmit` first
- ❌ NEVER `git push` code that has TypeScript errors
- ❌ NEVER use `@ts-ignore` or `@ts-expect-error` to suppress real errors
- ❌ NEVER add `as any` to bypass type checking
- ❌ NEVER claim "it works locally" without proving `tsc --noEmit` passes
- ❌ NEVER import a component/function that doesn't exist yet — create it first
- ❌ NEVER emit bus events with properties not in the BusPayloadMap type
- ❌ NEVER pass JSX props that aren't declared in the component's Props interface

## COMMON PITFALLS (MEMORIZE THESE)

### 1. Creating a new component but forgetting the barrel export
If you create `src/components/table/NewComponent.tsx`, you MUST also add it to `src/components/table/index.ts`:
```typescript
export { NewComponent } from './NewComponent';
```

### 2. Adding fields to a MasterBus event emission
If you emit a bus event with new fields, you MUST update the type in `src/core/MasterBus.ts` → `BusPayloadMap`:
```typescript
SPIN_RESULT: {
  lobbyId: string;
  multiplier: number;
  // ADD new fields here, not just in the emit() call
  bonusFromPool?: number;
};
```

### 3. Passing extra props to a component
If a component's Props interface doesn't include `tableId`, you CANNOT pass `tableId={...}` to it. Either:
- Add `tableId` to the component's interface, OR
- Remove the prop from the JSX

### 4. Using types from one file in another without importing
Always verify imports resolve to actual exports.

## VERIFICATION EVIDENCE

When reporting completion, include this exact output:
```
✅ TypeScript: npx tsc --noEmit → exit code 0
✅ Committed: [commit hash]
✅ Pushed: [branch] → origin
```

If you cannot produce this evidence, the task is NOT complete.
