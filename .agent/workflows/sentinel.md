---
description: Activates the Sentinel real-time build monitoring agent.
---

# Sentinel Build Monitor

The **Sentinel** is an "always-on" script that watches your codebase in real-time. It runs immediately whenever you save a file.

## Features

- ⚡️ **Instant Feedback**: Runs type checks (`tsc`) and linting (`eslint`) on every save.
- 🛡️ **Gatekeeper**: Tells you immediately if you broke the build, preventing bad deployments.
- 🧹 **Auto-Suggestion**: Reminds you to run `lint:fix` if style issues are found.

## How to Activate

1. Open a **new terminal** (split pane recommended).
2. Run the Sentinel:

// turbo

```bash
node scripts/sentinel.js
```

3. Keep this running while you work. It will clear and refresh automatically.
