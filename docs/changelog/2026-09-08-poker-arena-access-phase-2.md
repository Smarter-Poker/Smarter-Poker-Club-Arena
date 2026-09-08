# Poker Arena Access, Phase 2 Work In Progress

Status: local implementation under verification, not applied, pushed, merged or published. Phase 2 is not complete.

The Diamond identity is a player-only platform entitlement, independent of club membership rows. Chip clubs retain their join/approval requirement. The new migration adds caller-bound access RPCs, restrictive game-read policies, immutable asset identity, and rejection of Diamond chip wallets, hierarchy, and generic chip seats. It preserves the zero-balance historical membership row as player/automatic. Existing chip engine loading explicitly rejects Diamond funding until dedicated custody exists.

Callers: ClubJoinService calls ArenaContextService before joining; Diamond returns navigation metadata without a join/referral mutation or CLUB_JOINED event. Public previews retain the existing unauthenticated RPC. ClubsService excludes Diamond records from the chip membership directory. TableViewerAccess supplies the common HTTP/WebSocket observer boundary; loadTable validates the authoritative embedded arena before chip settlement can start. SQL triggers and RLS invoke the new guards directly.

Local verification: the isolated PostgreSQL 17 fixture uses a Unix socket only, a dedicated database, and an environment guard before fixture DDL. It executes the actual migration and tests entitlement, chip join gating, anonymous denial, management, financial/hierarchy rejection and chip seating. It is a representative fixture, not a copy of every production trigger or proof of production behavior. The first live rollback rehearsal exposed pending trigger events from data-before-DDL ordering. The migration now performs its data transition after all DDL. That rehearsal rolled back.

Automatic approval review rejected a second live rehearsal because broad policy, trigger and membership changes could lock production despite intended rollback. No alternative live mutation or publication was attempted. Production migration application and live verification require explicit approval of those operations. Do not publish frontend callers before the RPC exists.

Remaining phase exit work: finish direct lobby/staff authorization and legacy dependency inventory; test against the complete production trigger chain in an approved environment; apply migration; pass repository gates; push, merge, publish and verify the served commit. No existing Diamond runtime earns completion credit. No funded games are enabled by this phase. Custody remains Phase 3, transfers Phase 4, shared skin/artwork and World Hub card/legacy route removal Phase 5.

The original Diamond Arena card image remains required for the Diamond club selector. Nothing in this patch changes or removes the shared platform wallet or authorizes chip-backed Diamond play.
