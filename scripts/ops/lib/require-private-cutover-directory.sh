#!/usr/bin/env bash

# Source-only helper. A cutover artifact is an authority boundary: its parent
# must belong exclusively to the current operator, and no component may be a
# symlink that redirects a later open after verification.

cutover_stat_mode() {
  if [[ "$(uname -s)" == 'Darwin' ]]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

cutover_stat_owner() {
  if [[ "$(uname -s)" == 'Darwin' ]]; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

require_private_cutover_directory() {
  local requested="$1"
  local logical
  local physical

  [[ -d "$requested" && ! -L "$requested" ]] || {
    echo "Cutover parent must be an existing non-symlink directory: $requested" >&2
    return 66
  }
  logical="$(CDPATH='' cd -- "$requested" && pwd -L)" || return 66
  physical="$(CDPATH='' cd -- "$requested" && pwd -P)" || return 66
  [[ "$logical" == "$physical" ]] || {
    echo "Cutover parent path must contain no symlink components: $requested" >&2
    return 66
  }
  [[ "$(cutover_stat_owner "$physical")" == "${EUID}" ]] || {
    echo "Cutover parent must be owned by the current effective user: $physical" >&2
    return 66
  }
  [[ "$(cutover_stat_mode "$physical")" == '700' ]] || {
    echo "Cutover parent must have mode 0700: $physical" >&2
    return 66
  }

  CUTOVER_PRIVATE_DIRECTORY="$physical"
  export CUTOVER_PRIVATE_DIRECTORY
}
