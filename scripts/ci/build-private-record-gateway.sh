#!/usr/bin/env bash
# Packaging only. This script cannot install, switch routes or toggle paid delivery.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output="$1"
revision="$2"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Full revision required' >&2; exit 1; }
[ ! -e "$output" ] || { echo 'Artifact destination must be fresh' >&2; exit 1; }
mkdir -p "$output"
cp "$repo/server/package.json" "$repo/server/package-lock.json" "$output/"
cp -R "$repo/server/dist-private-record-gateway" "$output/dist"
# Tests/qualification tools are never runtime payloads.
find "$output/dist" -type f \( -name '*.test.js' -o -name '*.test.js.map' -o -name '*.test.d.ts' -o -name '*.test.d.ts.map' \) -delete
npm ci --prefix "$output" --omit=dev --ignore-scripts --no-audit --no-fund
rm -rf "$output/node_modules/.bin"
node --input-type=module - "$repo" "$output" "$revision" <<'NODE'
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const [repo,output,revision]=process.argv.slice(2);
const {sealGatewayArtifact,GATEWAY_PUBLISHER_WORKFLOW}=await import(pathToFileURL(`${repo}/scripts/ci/private-record-gateway-artifact.mjs`));
const workflow=GATEWAY_PUBLISHER_WORKFLOW;
const hosted=process.env.GITHUB_ACTIONS==='true' && process.env.GITHUB_WORKFLOW_REF===workflow;
if (hosted && (execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim()!==revision || execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repo,encoding:'utf8'}).trim())) throw new Error('hosted artifact requires exact clean protected source');
sealGatewayArtifact(output,revision,hosted ? {validationOnly:false,builtBy:'github-actions',workflowRef:workflow,workflowSha:process.env.GITHUB_WORKFLOW_SHA,runId:process.env.GITHUB_RUN_ID} : {validationOnly:true,builtBy:'local-qualification'});
NODE
node "$repo/scripts/ci/private-record-gateway-artifact.mjs" verify "$output" "$revision"
