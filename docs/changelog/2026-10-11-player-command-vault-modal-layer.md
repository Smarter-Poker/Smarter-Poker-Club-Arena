# Player Command Vault Modal Layer

## Change 1: Escape The Isolated Page Stage

**Files:** `src/pages/PromoVaultPage.tsx` (before lines 1223–1237), `src/pages/PromoVaultPage.css` (before lines 32–51).

**What Existed:** The shared Help, Buy and Grant Overlay rendered beneath the Promo Vault page. AppLayout isolates its main stage; the persistent ClubBottomNav occupies a separate stacking context. Despite the overlay's existing z-index 1200, the footer covered the lower 11.6 pixels of Cancel on the published 375×812 viewport. A centre-point click passed while bottom-centre hit testing reached Players.

**What Changed:** The shared Overlay uses the established `createPortal(content, document.body)` pattern from `components/common/Modal.tsx`. Its existing z-index and dialog styling remain unchanged. The exact existing Vault `--ca-*` alias declarations apply to both the page and overlay, so portalled controls retain their original inks and face. Page sizing, padding and background remain page-only.

**Why:** A larger child z-index cannot escape its isolated ancestor. Body ownership makes the entire dialog and backdrop cover persistent navigation using the current modal layer, without changing global footer/main behavior or art.

**Verified:** YES. Re-read the actual source and diff. The new real-component Help/Buy/Grant portal regressions failed 3/3 against the prior source, then the entire accessibility file passed 13/13. Each new case verifies the overlay is a direct body child outside the page, closing removes it, the exact opener regains focus and no Buy/Grant RPC executes. Existing immediate recipient focus, trap, Escape, busy, permission and tab coverage remains intact.

**Evidence:** `phase2-vault-portal-before.log` and `phase2-vault-portal-after.log` in the task's external evidence archive.

**TypeScript:** PASS. Root final compiler and all 32 connected accessibility, request ownership and focus-trap cases pass; copy guards and 821 source-binding pins pass.

**Browser/Release:** Root owns the existing production browser regression for full nine-point action hit areas at 375/393, required checks, publication and cold live proof. The component test proves portal ownership and lifecycle; it does not itself establish rendered hit testing or production delivery.
