# Run the mocked Horse process contract on each development host

The Production Alerts merge precheck reproduced 34 failures on macOS before
any modeled process assertion ran. The shared unit fixture asserted that its
host was Linux before initializing the fake child, so teardown also failed on
an undefined child. The identical test and launcher passed in hosted Linux
CI 35294437826; its actual Linux process integration passed separately.

The test already mocks process creation and priority. Its setup now supplies
Linux as model input and restores the original platform property descriptor,
Node arguments and timers in teardown even on failure. Two new cases supply
Darwin and Windows and require the actual launcher guard to refuse before
priority lookup or fork. All 34 previous cases remain and all 36 pass locally.
The real Linux launcher and native process integration are unchanged.

This is a test-fixture correction needed to submit the existing alert fix.
It neither changes production execution nor establishes native Linux proof
from a macOS model. Required hosted checks remain separate.
