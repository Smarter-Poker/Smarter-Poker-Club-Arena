# Finish opening Table Studio after an early appearance update

If another tab changes an appearance field while Table Studio's first saved-design read is pending, the editor correctly rejects that older snapshot. It now starts a fresh complete read even if Realtime has not connected yet. Previously the controls could stay disabled indefinitely because recovery depended on a timer that only starts after the realtime connection is live.

The change preserves account and game-scope guards, keeps newer appearance choices intact, and avoids repeatedly reading during a pending local save. A mounted-component regression reproduces the disabled controls before the fix and checks that the fresh row restores both the changed felt and another saved appearance field. This identified race is not yet proven to be the cause of the earlier CI two-tab failure.
