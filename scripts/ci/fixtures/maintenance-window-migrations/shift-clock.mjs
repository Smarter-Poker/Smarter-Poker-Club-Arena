// Test preload: moves this process's wall clock to FAKE_NOW_MS while letting
// it advance in real time, so the installer can be qualified at "04:00
// America/Chicago" at any hour. Timers are untouched.
const target = Number(process.env.FAKE_NOW_MS);
if (!Number.isFinite(target)) throw new Error('FAKE_NOW_MS is required');
const RealDate = Date;
const offset = target - RealDate.now();
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(RealDate.now() + offset);
  }
  static now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = ShiftedDate;
