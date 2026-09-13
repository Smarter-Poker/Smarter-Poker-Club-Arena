# Await Persisted Table Studio Checkout In CI

The purchase test now waits for exactly one recorded purchase and the saved table selection before checking that the dialog closed and Neon City is selected in the real preview. It uses the existing 20-second Studio readiness budget and retains every final UI, persistence and exactly-once assertion.

CI run 34713854111 received the purchase response in 18 milliseconds, then observed the saved selection after the previous five-second dialog assertion had expired. Its final diagnostic snapshot showed the applied table and purchase success notification. This change fixes that test's missing wait for the complete checkout outcome; it does not certify production checkout latency or change product behavior.
