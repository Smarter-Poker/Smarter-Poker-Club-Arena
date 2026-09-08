# Maintenance resume waves preserve reconnect time

Reconnect protection stops consuming time for the complete server-owned maintenance interval, including the database thaw wait and that table's resume wave. The common cash, MTT, Spin, Sit & Go and heads-up protection policy remains unchanged. An active or lifetime VIP gets 45 seconds against the standard 30; expired VIP does not get an extension. Compensation preserves the unused portion, never revives a pre-expired grant and never repeats already-compensated time after a snapshot restore.

MaintenanceBreak records each actual resume before releasing the engine. DisconnectEngine applies that table's interval before either presenting an FSM deadline or arming an auto-action. ReconnectResumeWaves.test.ts executes those real owners across 200 tables and all eight waves. reconnectFreeze.test.ts pins incremental, expired and mid-wave grants; reconnectProtection.test.ts pins membership eligibility.
