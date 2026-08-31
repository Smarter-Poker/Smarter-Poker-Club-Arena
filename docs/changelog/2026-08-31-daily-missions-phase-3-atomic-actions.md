# Daily Missions Phase 3: Atomic Action Receipts

## Audit Findings

- **Claim All was a client loop.** A vault page of 100 rewards issued up to 100 RPCs and wallet writes, then fetched the entire dashboard again. A dropped response could leave the player paid while the UI reported a partial failure.
- **Reroll replaced only `challenge_id`.** Phase 2 made assigned payouts immutable, but the old reroll function left the previous name, description, requirement, tier, chip reward, and diamond reward snapshots on the row. The replacement id and displayed/paid contract could therefore disagree.
- **Reroll authentication accepted a caller-supplied user id when `auth.uid()` was absent.** The replacement now allows unattributed calls only from the engine context.
- **A later privileged-profile trigger regressed challenge diamond claims.** The live rollback probe caught the 42501 before any player state was committed. Both server-authoritative challenge claim functions are now explicit, ledgered grant paths in that guard.
- Successful single claims and rerolls performed a second dashboard fetch even though the mutation already knew the changed state.

## Replacement

- `claim_daily_challenges` locks up to 100 owned rows, validates every immutable requirement, claims all eligible rows, credits aggregate chips and diamonds, writes exact ledgers, and returns career totals plus the next Reward Vault page in one transaction.
- `daily_challenge_claim_batches` persists the response under `(user_id, request_id)`, so a retry after a lost response returns the original payout receipt instead of a zero-value duplicate.
- The contract snapshot trigger now treats reroll as a guarded replacement contract. Only the reroll RPC can set the transaction-local capability, and it regenerates every snapshot from the same-tier catalog row.
- Reroll returns the complete replacement row and current diamond balance. The page swaps it into place without a reload.
- Single Claim and Claim All now use the same batch service. The page applies exact vault, lifetime, and balance fields from the receipt immediately.

## Production Database Verification

- Migration `20260831030000_daily_challenge_atomic_action_receipts` is recorded and live.
- Transactional compile passed before apply.
- Rollback-only batch claim probe confirmed one claimed id, exact stats/vault receipt, chip credit, diamond credit, and no production residue.
- Rollback-only reroll probe confirmed a changed challenge id, complete replacement receipt, and snapshots matching the replacement catalog contract.
- Focused client/SQL contract suite, lint, formatting, and TypeScript are green.

Merge, production bundle verification, and live browser certification remain required before Phase 3 is declared complete.
