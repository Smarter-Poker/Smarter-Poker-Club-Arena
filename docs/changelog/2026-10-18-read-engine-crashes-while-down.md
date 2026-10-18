# Read engine crash evidence while the engine is down

The manual read-only host diagnostic required a successful HTTP health response before inspecting Docker. Run39135975680 refused during the October18 restart incident, withholding termination evidence precisely while the service was degraded.

Bind the diagnostic to the exact container ID, image ID and release label before and after reading. A matching health response still must name the expected release; down, unreadable and standby health are explicit observations. A process restart within the same selected container is recorded with both observations and runtimeStable=false; a different container or image is refused.

Read only typed Docker OOM, termination and restart events, plus allowlisted process-fatal/leadership/shutdown categories and a bounded set of known source frames. Raw logs, environment values, arbitrary event attributes and private error text never leave the host. This changes the original explicitly invoked diagnostic, with no timer, runtime mutation or release action.

The existing Python-via-Vitest regression exercises down/standby, malformed health, release/container mismatch, process replacement and sanitizer boundaries. This is a prerequisite for identifying the production restart cause; it does not claim to prevent engine restarts or repair tournament state.
