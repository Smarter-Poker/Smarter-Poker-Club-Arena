export { PresenceIndicator } from './PresenceIndicator';
// OnlinePlayersList DELETED 2026-08-24. It was never rendered anywhere: the
// only JSX reference to it was its own declaration, and this barrel - its sole
// export path - is imported by nothing. Meanwhile it carried an UNFILTERED
// `profiles` realtime listener (every profile row change on the platform, to
// every client that mounted it), a serial N+1 loop over 150-id chunks of the
// club roster, and a 30s poll. Dead code with a firehose in it is worse than
// dead code, so it is gone rather than optimised. PresenceIndicator below is
// live - it has 9 call sites - so this folder stays.
