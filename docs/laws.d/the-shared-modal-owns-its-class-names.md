# tests/the-shared-modal-owns-its-class-names.law.test.ts

Every class `components/common/Modal` defines and emits is namespaced `ca-modal`, no other stylesheet in `src/` may write a rule for one of them (the popup chassis may paint them, never position or z-index them), and the card is explicitly above its own backdrop. Added 2026-09-04 after nine other `.modal-overlay` rules put the shared backdrop OVER the club greeting card and the "small" popup blocked the whole page.
