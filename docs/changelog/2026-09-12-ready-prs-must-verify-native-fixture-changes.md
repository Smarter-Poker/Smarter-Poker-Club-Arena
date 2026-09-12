# Ready PRs must verify native fixture changes

PR automation could open a ready PR whose fixture native test ran only on drafts. Standard required checks could then pass and merge the source without exercising the actual services.

Ordinary CI now calls one reusable native workflow for affected or unknown diffs, on both ready and draft PRs. The existing required TypeScript Check waits for compilation and the applicable native outcome, rejecting missing or skipped proof. Compilation remains parallel; verified unrelated changes skip the expensive fixture build explicitly. The workflow retains repository read permission, exact source identity, isolated services and mandatory resource cleanup. No branch protection or production controls change.

Classification compares the event's immutable Git base and head, including both paths of renamed files and the complete previous native workflow coverage. Missing history, revision mismatch or incomplete enumeration runs every suite. The required result also demands an executed-proof output for the exact source SHA, emitted only after native assertions and cleanup pass; a green wrapper alone cannot satisfy it.
