#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Resize + recompress the images on the Club Arena FIRST-LOAD critical path.
#
# WHY (measured 2026-08-20, real browser against production):
#   The arena's first paint pulled 6.21 MB of images. Not because there were
#   many — because each was shipped at source resolution and displayed tiny:
#     header-help-v4.png    598x609 natural, rendered 40x40   -> 228x the pixels
#     btn-back.png         1317x310 natural, rendered 136x32  ->  94x
#     vip-card-v8.jpg       782x861 natural, rendered 40x40   -> 421x
#   A 297 KB PNG for a 40-pixel help icon is most of a second on mobile data.
#
# WHAT IT DOES
#   Resizes each to 3x its largest real render box (retina headroom to 3x DPR)
#   and requantises. Files keep their name AND extension, so nothing in the
#   source has to change and no reference can break.
#
# HOW THE SIZES WERE CHOSEN
#   Every entry below was measured in a real browser via
#   getBoundingClientRect() on the deployed arena, not guessed. Each header
#   asset is referenced from exactly one component (GlobalHeader.tsx), so its
#   render box is its maximum. Re-measure before adding an entry.
#
# SAFETY
#   `-resize WxH>` only ever shrinks — an image already smaller is untouched,
#   so re-running is a no-op. Verified quality with RMSE against the original:
#   the header icons land around 0.4% difference, i.e. visually identical.
#
# BULK MODE (--bulk) sweeps everything else under public/images/. Those assets
# are not on the arena's first paint, so this is about repo and deploy weight
# rather than load time — several are over 1 MB and a few are not referenced
# from either repo at all. It caps the longest edge at 1024 (nothing in this UI
# is drawn larger) and recompresses anything whose BYTES-PER-PIXEL says it was
# never optimised. Bytes-per-pixel is the idempotence key here: after a pass
# every file lands well under the threshold, so a second run is a no-op. Proved
# by running it twice and hashing.
#
# Usage:  bash scripts/optimize-arena-images.sh [--check|--bulk]
#         --check writes nothing and exits 1 if any asset is still LARGER than
#         its render box. The rule is dimensional, not byte-based: recompressing
#         a file always shaves a few percent, so a "could be smaller" gate would
#         fail forever and teach everyone to ignore it.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
CHECK=0
BULK=0
[ "${1:-}" = "--check" ] && CHECK=1
[ "${1:-}" = "--bulk" ] && BULK=1
# Compressed UI art lands at 0.24-0.55 bytes/px; 0.6 sits above every observed
# post-pass value, so nothing is ever picked up twice.
BPP_LIMIT=${BPP_LIMIT:-0.6}
BULK_MAX_EDGE=${BULK_MAX_EDGE:-1024}

command -v magick >/dev/null   || { echo "need imagemagick (brew install imagemagick)"; exit 2; }
command -v pngquant >/dev/null || { echo "need pngquant (brew install pngquant)"; exit 2; }

# path:max_width:max_height   (3x the measured render box)
TARGETS="
public/images/header-help-v4.png:120:120
public/images/header-settings-v4.png:120:120
public/images/header-messenger-v4.png:120:120
public/images/header-wallet-v4.png:120:120
public/images/btn-hamburger-v4.png:120:120
public/images/notification-bell-trimmed.png:120:120
public/images/btn-back.png:408:96
public/images/btn-hub-v4.png:384:96
public/images/brand-text-clean.png:288:96
public/images/vip-card-v8.jpg:120:120
public/images/tiles/daily-challenges-v8.jpg:480:740
public/images/tiles/player-stats-v8.jpg:480:740
public/images/tiles/leaderboards-v8.jpg:480:740
public/images/tiles/cashier-v8.jpg:480:740
public/images/tiles/marketplace-v8.jpg:480:740
public/images/icons/action-bar-horizontal.png:1024:682
public/images/bg-vault.jpg:1920:1080
public/images/shark-club-card.jpg:896:1200
"

total_before=0; total_after=0; oversized=0
for entry in $TARGETS; do
  [ -z "$entry" ] && continue
  f="${entry%%:*}"; rest="${entry#*:}"; w="${rest%%:*}"; h="${rest##*:}"
  [ -f "$f" ] || { echo "  skip (absent): $f"; continue; }
  before=$(stat -f %z "$f")
  cw=$(magick identify -format '%w' "$f")
  ch=$(magick identify -format '%h' "$f")
  total_before=$((total_before+before))

  # IDEMPOTENCE: decide on DIMENSIONS, never on bytes. Re-running pngquant over
  # an already-quantised file shaves another ~25% every time, so a byte-based
  # rule would keep "finding" work and would quietly degrade quality on each
  # run. An image already within its target box is finished — leave it alone.
  if [ "$cw" -le "$w" ] && [ "$ch" -le "$h" ]; then
    total_after=$((total_after+before))
    continue
  fi

  tmp="$(mktemp -t optimg).${f##*.}"
  magick "$f" -resize "${w}x${h}>" -strip -quality 88 "$tmp"
  if [ "${f##*.}" = "png" ]; then
    pngquant --quality=70-95 --speed 1 --force --output "$tmp.pq" "$tmp" 2>/dev/null && mv "$tmp.pq" "$tmp" || true
  fi
  after=$(stat -f %z "$tmp")
  total_after=$((total_after+after))
  pct=0
  [ "$before" -gt 0 ] && pct=$(( (before-after)*100/before ))
  printf "  %-46s %5dx%-5d -> %4dx%-5d %5d KB -> %4d KB (-%d%%)\n" \
    "${f#public/images/}" "$cw" "$ch" "$w" "$h" "$((before/1024))" "$((after/1024))" "$pct"
  oversized=$((oversized+1))
  [ "$CHECK" = "0" ] && mv "$tmp" "$f" || rm -f "$tmp"
done

echo
printf "TOTAL: %d KB -> %d KB  (saved %d KB, %d%%)\n" \
  "$((total_before/1024))" "$((total_after/1024))" \
  "$(((total_before-total_after)/1024))" \
  "$(( total_before>0 ? (total_before-total_after)*100/total_before : 0 ))"

if [ "$BULK" = "1" ]; then
  echo
  echo "── bulk pass: everything else under public/images/ ──"
  bulk_before=0; bulk_after=0; bulk_n=0
  while IFS= read -r f; do
    case "$TARGETS" in *"$f"*) continue;; esac   # critical-path files are done above
    before=$(stat -f %z "$f")
    w=$(magick identify -format '%w' "$f" 2>/dev/null) || continue
    h=$(magick identify -format '%h' "$f" 2>/dev/null) || continue
    # Written as an explicit if, not `A || B || C && { ...; }`. That chain
    # happens to work in bash, but || and && share precedence and left
    # associativity, so whether `set -e` aborts on the all-false case depends
    # on shell and context. Nothing here should rest on that.
    if [ -z "$w" ] || [ -z "$h" ] || [ "$w" = "0" ] || [ "$h" = "0" ]; then
      echo "  skip (no dimensions): ${f#public/images/}"
      bulk_before=$((bulk_before+before)); bulk_after=$((bulk_after+before)); continue
    fi
    if ! bpp=$(python3 -c "print(f'{$before/($w*$h):.4f}')" 2>/dev/null); then
      # Never silently treat an arithmetic failure as "already optimal" — say
      # so and move on, so a broken toolchain cannot look like a clean pass.
      echo "  skip (could not compute bytes/pixel): ${f#public/images/}"
      bulk_after=$((bulk_after+before)); continue
    fi
    over_edge=0
    if [ "$w" -gt "$BULK_MAX_EDGE" ] || [ "$h" -gt "$BULK_MAX_EDGE" ]; then over_edge=1; fi
    if ! over_bpp=$(python3 -c "print(1 if $bpp > $BPP_LIMIT else 0)" 2>/dev/null); then
      echo "  skip (could not compare bytes/pixel): ${f#public/images/}"
      bulk_after=$((bulk_after+before)); continue
    fi
    bulk_before=$((bulk_before+before))
    if [ "$over_edge" = "0" ] && [ "$over_bpp" = "0" ]; then bulk_after=$((bulk_after+before)); continue; fi
    tmp="$(mktemp -t optbulk).${f##*.}"
    magick "$f" -resize "${BULK_MAX_EDGE}x${BULK_MAX_EDGE}>" -strip -quality 88 "$tmp" 2>/dev/null || { rm -f "$tmp"; bulk_after=$((bulk_after+before)); continue; }
    if [ "${f##*.}" = "png" ]; then
      pngquant --quality=70-95 --speed 1 --force --output "$tmp.pq" "$tmp" 2>/dev/null && mv "$tmp.pq" "$tmp" || true
    fi
    after=$(stat -f %z "$tmp")
    if [ "$after" -lt "$before" ]; then
      pct=$(( (before-after)*100/before ))
      printf "  %-50s %6d KB -> %5d KB (-%d%%)\n" "${f#public/images/}" "$((before/1024))" "$((after/1024))" "$pct"
      mv "$tmp" "$f"; bulk_after=$((bulk_after+after)); bulk_n=$((bulk_n+1))
    else
      rm -f "$tmp"; bulk_after=$((bulk_after+before))
    fi
  done < <(find public/images -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \) | sort)
  echo
  printf "BULK: %d file(s) rewritten, %d KB -> %d KB (saved %d KB)\n" \
    "$bulk_n" "$((bulk_before/1024))" "$((bulk_after/1024))" "$(((bulk_before-bulk_after)/1024))"
fi

if [ "$CHECK" = "1" ] && [ "$oversized" -gt 0 ]; then
  echo "check: $oversized image(s) exceed their render box — run without --check"
  exit 1
fi
[ "$CHECK" = "1" ] && echo "check: every critical-path image is within its render box."
exit 0
