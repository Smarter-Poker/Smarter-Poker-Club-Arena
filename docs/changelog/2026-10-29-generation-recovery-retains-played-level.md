# Generation Recovery Retains A Genuinely Played Level

The existing F06 generation-abort clock selection uses the most recently ended
hand. An older original hand resumed after a restart can end after hands that
genuinely played a higher level. If another reserved hand never reached its
first private checkpoint, its normal generation-abort admission could then
rewind the tournament below that already played level.

The migration changes only that existing backwards correction: completed blind
pairs are mapped through the tournament's authoritative resolver and provide a
floor, capped at its current level. A genuine current level keeps its original
anchor; an unplayed higher level can still rewind. Scheduled breaks, financial
guards, receipts, lease authority and the exact incident exception are retained.
The guarded predecessor is the production function captured after installation
20261029003622, with full-definition MD5 8fb3869ea1cac37357e482a0bb0f661c.

The maintained native helper invokes the real F06 abort owner. Its predecessor
reproduces the wrong rewind to index 14; the candidate retains played index 15.
It also covers an unchanged index-15 anchor, a legitimate rewind when index 15
was never played, genuinely played current index 16, and scheduled-break
preservation. Repeated or capped identical blind pairs use the earliest
matching index, so an unplayed later identical level is never inferred. Every case proves duplicate receipts cannot shift the anchor and
complete public/private rollback. Changed owner configuration or ACL refuses
installation without changing data or catalog state. The helper is intended
for the existing required original-continuation native lane; source preparation
and isolated qualification are distinct from production installation.
