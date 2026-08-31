#!/usr/bin/env bash

set -euo pipefail

SOURCE_DIST=${1:-}
TARGET_DIST=${2:-}
MANIFEST_NAME=deploy-asset-manifest.txt

if [[ -z "$SOURCE_DIST" || -z "$TARGET_DIST" ]]; then
  echo "usage: $0 <source-dist> <target-dist>" >&2
  exit 64
fi

if [[ ! -d "$SOURCE_DIST" || ! -f "$SOURCE_DIST/$MANIFEST_NAME" ]]; then
  echo "source dist or $MANIFEST_NAME is missing: $SOURCE_DIST" >&2
  exit 66
fi

mkdir -p "$TARGET_DIST"

PREVIOUS_ASSETS=$(mktemp -d "${TMPDIR:-/tmp}/club-arena-previous-assets.XXXXXX")
trap 'rm -rf "$PREVIOUS_ASSETS"' EXIT

is_safe_asset_path() {
  local asset_path=$1
  [[ -n "$asset_path" ]] &&
    [[ "$asset_path" != /* ]] &&
    [[ "$asset_path" != ".." ]] &&
    [[ "$asset_path" != ../* ]] &&
    [[ "$asset_path" != */../* ]] &&
    [[ "$asset_path" != */.. ]]
}

preserve_asset() {
  local asset_path=$1
  local asset_source="$TARGET_DIST/assets/$asset_path"
  local asset_target="$PREVIOUS_ASSETS/$asset_path"

  if ! is_safe_asset_path "$asset_path"; then
    echo "unsafe asset path in previous manifest: $asset_path" >&2
    exit 65
  fi

  if [[ -f "$asset_source" ]]; then
    mkdir -p "$(dirname "$asset_target")"
    cp -p "$asset_source" "$asset_target"
  fi
}

if [[ -f "$TARGET_DIST/$MANIFEST_NAME" ]]; then
  if cmp -s "$SOURCE_DIST/$MANIFEST_NAME" "$TARGET_DIST/$MANIFEST_NAME"; then
    # A same-build retry must not rotate away the already retained generation.
    # The target is bounded by the prior successful sync, so preserving all of
    # its assets here is exactly current + previous, not unbounded history.
    while IFS= read -r asset_source; do
      preserve_asset "${asset_source#"$TARGET_DIST/assets/"}"
    done < <(find "$TARGET_DIST/assets" -type f -print)
  else
    while IFS= read -r asset_path || [[ -n "$asset_path" ]]; do
      preserve_asset "${asset_path%$'\r'}"
    done < "$TARGET_DIST/$MANIFEST_NAME"
  fi
elif [[ -d "$TARGET_DIST/assets" ]]; then
  # The first release with manifests must retain the entire deployed asset
  # directory once. Prior deploys used rsync --delete, so it represents one
  # generation; the new current-only manifest bounds every later release.
  while IFS= read -r asset_source; do
    preserve_asset "${asset_source#"$TARGET_DIST/assets/"}"
  done < <(find "$TARGET_DIST/assets" -type f -print)
fi

# CI can produce same-size files within the same one-second timestamp window.
# Checksums prevent rsync's size+mtime shortcut from leaving an old shell in
# place while build-info.json announces the new release.
rsync -a --checksum --delete "$SOURCE_DIST/" "$TARGET_DIST/"

if [[ -d "$PREVIOUS_ASSETS" ]]; then
  mkdir -p "$TARGET_DIST/assets"
  # Current assets are authoritative. A retained filename can only fill a gap
  # left by the new build; it can never overwrite new output.
  rsync -a --ignore-existing "$PREVIOUS_ASSETS/" "$TARGET_DIST/assets/"
fi
