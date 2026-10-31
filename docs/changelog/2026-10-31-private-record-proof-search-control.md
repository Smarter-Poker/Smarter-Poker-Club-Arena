# Use the rendered roster search control in the failover proof

Production proof 41182510735 verified genuine member updates during primary failure and recovery, then waited until its overall timeout because the roster's input type=search exposes the searchbox role, not textbox. Use that actual role with a bounded 45-second fill. Keep the existing account, roster identity, update delivery, fallback, restoration and cleanup assertions. The retained contract test binds the locator to the rendered input type. No production runtime change.
