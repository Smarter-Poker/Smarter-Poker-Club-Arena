#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-selfhosted-runner.sh — stand up GitHub Actions runners on a Hetzner
# box and cut the hosted-runner bill to ~zero.
#
# Context (2026-09-01 cost audit): August was ~150,000 hosted runner-minutes
# (~$1,200). GitHub bills $0 for self-hosted minutes, and a warm runner keeps
# node_modules on disk, which turns the 12-minute vitest job into ~2 minutes.
#
# RUN THIS ON A **DEDICATED** CI BOX (a Hetzner CX32/CCX23 is plenty for two
# runners, ~€30/mo). DO NOT run it on the poker-engine VPS: CI builds would
# contend with live dealing for CPU.
#
# BOX-LEVEL TUNING LIVES IN scripts/ci/provision-ci-box.sh (run it as root,
# once, and again after adding runners): swap, nightly GC, the per-runner
# fair-share caps (VITEST_MAX_WORKERS=4, 3 GB heap), the idle-restart sweeper,
# browser system libraries, gh/jq/node. Eight runners on one box without it
# sat at load 69-75 and starved every job (2026-09-02).
#
# Prereqs on the box: Ubuntu 22+, a non-root user with passwordless sudo
# (playwright's --with-deps needs apt), Node is NOT required (workflows bring
# their own via actions/setup-node), git, curl.
#
# Usage (run once per runner instance; run it twice for two runners):
#   REPO=Smarter-Poker/Smarter-Poker-Club-Arena \
#   RUNNER_NAME=estate-ci-1 \
#   bash setup-selfhosted-runner.sh
#
# You need a registration token, minted from any machine where gh is
# authenticated with admin on the repo:
#   gh api -X POST /repos/$REPO/actions/runners/registration-token --jq .token
# Pass it as RUNNER_TOKEN=... (it expires after an hour; mint fresh).
#
# ACTIVATION is a separate, reversible step and touches no workflow file:
# the heavy CI jobs read `vars.CI_RUNNER` and fall back to ubuntu-latest.
#   gh api -X POST /repos/$REPO/actions/variables \
#     -f name=CI_RUNNER -f value=estate-linux         # route to self-hosted
#   gh api -X DELETE /repos/$REPO/actions/variables/CI_RUNNER   # instant rollback
#
# SECURITY NOTE: these repos are private and take no fork PRs; every PR author
# is an estate agent. If fork PRs are ever enabled, self-hosted runners must
# be revisited — a fork PR executes arbitrary code on the runner.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="${REPO:?set REPO=owner/name}"
RUNNER_NAME="${RUNNER_NAME:-estate-ci-$(hostname)}"
RUNNER_TOKEN="${RUNNER_TOKEN:?mint one: gh api -X POST /repos/$REPO/actions/runners/registration-token --jq .token}"
LABELS="${LABELS:-estate-linux}"
RUNNER_VERSION="${RUNNER_VERSION:-2.319.1}"

DIR="$HOME/actions-runner-${RUNNER_NAME}"
mkdir -p "$DIR" && cd "$DIR"

if [ ! -f config.sh ]; then
  curl -fsSL -o runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
fi

./config.sh --unattended \
  --url "https://github.com/${REPO}" \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$LABELS" \
  --replace

sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status

echo ""
echo "Runner '${RUNNER_NAME}' registered on ${REPO} with labels: ${LABELS}"
echo "Activate routing with the CI_RUNNER repository variable (see header)."
