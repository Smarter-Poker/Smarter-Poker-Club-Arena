# Phase 3 Release Certification: Every-Word Title Case

## Previous Behavior

The existing page-copy gate inspected literal JSX text but missed accessible names, placeholders, tooltips, conditional strings, template segments, component copy registries, and the English translation registry. As a result, rendered pages and subpages could still contain sentence-case words even while CI was green.

## Changes

- Applied the binding every-word capitalization rule across all static player-facing copy in the Club Arena source tree.
- Removed every player-facing em dash confirmed by the UI-text gate.
- Expanded the TypeScript-aware Title Case gate to cover JSX text, copy attributes, conditional and logical expressions, template literals, known copy properties, and the English translation registry.
- Preserved routes, identifiers, emails, translation placeholders, numeric suffixes, plural suffixes, and other machine values.
- Corrected dynamic bet and raise accessibility labels that deliberately lowercased a visible word at runtime.
- Updated copy-contract tests to assert the exact rendered Title Case labels.
- Added regression coverage proving autofix behavior and its machine-value safeguards.

## Scope And Safety

This phase changes presentation copy only. It does not change database writes, authorization, money movement, game rules, real-time event ownership, or server protocols. Dynamic data remains unchanged.

## Verification

- Client TypeScript: passed.
- Client tests: 753 files passed; 10,559 passed and 1 skipped.
- Focused affected tests: 41 files and 712 tests passed.
- Server tests: 287 files and 3,258 tests passed.
- Server TypeScript build: passed.
- ESLint: zero errors; existing warnings remain.
- Production client build: passed before the final mainline rebase and is rerun after integration.
- Root production dependency audit: zero vulnerabilities.
- Copy gates: Title Case, navigation Title Case, em dash, and emoji checks passed.
