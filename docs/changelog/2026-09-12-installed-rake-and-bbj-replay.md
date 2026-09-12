# Record the installed rake access and BBJ replay repairs

Production now scopes an overseer's rake downline to clubs they oversee and
refuses a BBJ bank-move replay whose payload differs from the original move.
The sanctioned migration runner assigned versions 20260912070307 and 20260912070357. These replace the reserved source filenames.

Both files contain the exact recorded migration statements, including short
transaction-local lock and statement limits. The runner owns each transaction;
the rake probe now supplies that same transaction boundary locally. The original
function preimages, candidate bodies, ownership and complete permissions are
unchanged. Native input hashes and paths follow the installed statements.

Readback verified the complete recorded statements, both function fingerprints
and unchanged permissions. The generated schema fragment covers only these two
observed functions. The catalog and migration-history transaction IDs differ;
the receipt records that fact without claiming atomic history/catalog identity.

This closes installation and source recording for these two repairs. It does
not certify live funded user flows, standalone rake burning, or the whole
engine release program.
