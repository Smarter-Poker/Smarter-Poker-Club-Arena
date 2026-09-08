# Reconnect time survives the full maintenance pause

The previous thaw recorded its end before waiting for the database. Maintenance then resumed up to eight table waves 1.5 seconds apart. A player lost the database wait plus up to 10.5 seconds of reconnect protection. Reading a snapshot in that interval set a marker that prevented any later compensation.

The real MaintenanceBreak and DisconnectEngine reproduce it in an isolated 200-table test: the first table lost an injected eight-second database wait, and subsequent waves lost their own delay. The fix records the global interval through the completed database wait and each table's actual resume boundary before a turn can start. The snapshot marker now means compensated through this instant. A later wave adds only the uncredited overlap. Expired pre-break grants stay expired; a new grant receives only its own overlap; repeated reads and restores cannot refill it.

Both the FSM projection and the action countdown use the same table-aware adjustment. Maintenance owns the timestamps; the disconnect engine owns each player's allowance. No new database write, interval, financial operation or game-format override is introduced. Entries for table wave ends are cleared with the next maintenance interval.

Validation: 83 tests passed across reconnect protection, incremental thaw, the 200-table resume integration and existing maintenance behavior. Server tsc --noEmit exited 0. The integration covers successful, failed and absent database thaw hooks; standard, active VIP, lifetime VIP, expired VIP and inactive membership; all eight waves; a snapshot read before the last wave; and restoring that snapshot before and after compensation. The common policy remains 30 seconds, with 45 seconds only for active or lifetime VIP membership.

The first test fixture was missing the required in-memory store; that fixture was corrected before the red reproduction. The three real deadline assertions then failed before the production change and passed afterward. Type checking also required the fake table to implement the real isBetweenHands and isRunning contract; both were supplied before verification.

Deployment is not yet verified. This engine change follows the normal branch, autopilot and announced Hetzner maintenance path. Physical iPad home-screen, internet-outage and network-swap testing remains outstanding. Snapshot tests retain the completed freeze registry in the restoring process; they do not prove a second process crash after the maintenance row was cleared but before a newly compensated snapshot was persisted.

# Published operator rules reviewed on 2026-09-08

[PokerStars cash reconnection](https://www.pokerstars.com/help/articles/ring-time-ma/220412/) distinguishes reconnect protection from the ordinary time bank, with pot-dependent protection around 30 to 240 seconds. Its [tournament disconnect policy](https://www.pokerstars.com/help/articles/disconnect-extra-time/) describes additional protection near the money and pausing the tournament clock during those disconnects.

[GGPoker house rules](https://ggpoker.com/house-rules/), updated March 27, 2026, describe extra reconnect time in late tournament stages, checking when no action is faced and folding when facing action after timeout. Disconnected tournament entrants continue to receive cards and pay forced bets. Its public rules do not specify a universal reconnect duration across formats.

These sources do not establish one universal industry duration. Daniel's explicit uniform protection requirement is therefore the product authority: the same allowance across cash, MTT, Spin, Sit & Go and heads-up; active/lifetime VIP gets 50 percent longer; expired VIP does not. The audit must prove those rules and recovery behavior, rather than claim an unmeasured one-to-one industry clone. A server maintenance pause must not consume player-controlled reconnect time.

CI follow-up: the full server run passed 7,628 tests and failed one old source assertion naming the zero-argument resume call. It now pins the call carrying the freeze identity and retains the idle-before-resume ordering check. The client law registry correctly refused the prose-only registry heading; the behavior test is now named ReconnectResumeWaves.law.test.ts and the registry points to that exact existing file. Neither gate is weakened or bypassed.
