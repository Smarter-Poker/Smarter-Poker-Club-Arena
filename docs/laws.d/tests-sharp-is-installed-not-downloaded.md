# tests/sharp-is-installed-not-downloaded.law.test.ts

sharp is a declared devDependency with the linux-x64/arm64 binaries pinned in package-lock.json, so no build installs it over the network mid-run; the temp-prefix fallback in sharp-loader.mjs stays as a no-regression net
