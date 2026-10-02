# The janitor keeps a tree that holds its own env file

`scripts/agent-tree-janitor.sh` archives a tree's work before removing it: the
branch commits as a bundle, the uncommitted diff as a patch, the untracked
files as a tar. An ignored file is in none of those, and a local `.env` is
ignored, so a tree carrying configuration of its own would have lost it.

Copying the file into the shared archive is not the answer; leaving the tree
alone is. The janitor now compares each `.env*` in a tree with the canonical
clone's copy. Byte-for-byte the same means regenerable and the tree may go. Any
difference means somebody's own configuration: the tree is reported and stays.
On the first sweep of this machine that kept 210 of 442 candidate trees.
