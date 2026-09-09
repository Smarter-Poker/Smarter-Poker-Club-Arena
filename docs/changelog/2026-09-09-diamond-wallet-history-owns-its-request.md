# Diamond Wallet History Owns Its Request

The Phase 4 wallet audit found that history requests checked only whether the component was mounted. A request from a previous account or a previous modal opening could therefore overwrite the current history. Each read now has a generation, invalidated on identity change, close and cleanup. Rows are rendered only for their recorded owner. Late results and late failures cannot replace a newer result.

Behavior tests exercise an old-account response arriving after the new account history and an old failure arriving after close/reopen. The existing custody balance component retains its independent authenticated balance and retry behavior. No monetary operation changes.
