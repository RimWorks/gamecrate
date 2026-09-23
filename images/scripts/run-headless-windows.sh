#!/bin/sh
# run-headless-windows 'Z:\game\YourGame.exe' <args...>
set -eu

# shellcheck source=scripts/headless-common.sh
. /usr/local/lib/headless-common.sh

: "${PROTON_DIR:=/opt/proton}"
: "${DESKTOP:=1920x1080}"

drop_to_game_user "$@"

: "${STEAM_COMPAT_DATA_PATH:=$HOME/.proton}"
: "${STEAM_COMPAT_CLIENT_INSTALL_PATH:=$HOME/.steam}"

# the lavapipe ICD filename carries the arch on Debian and not on Arch
if [ -z "${VK_ICD_FILENAMES:-}" ]; then
  for icd in /usr/share/vulkan/icd.d/lvp_icd*.json; do
    [ -e "$icd" ] && VK_ICD_FILENAMES="$icd" && break
  done
  export VK_ICD_FILENAMES
fi

# where a game under wine looks for ffmpeg. Z: is the unix root
: "${WINEPATH:=Z:\\opt\\ffmpeg}"
export WINEPATH

mkdir -p "$STEAM_COMPAT_DATA_PATH" "$STEAM_COMPAT_CLIENT_INSTALL_PATH"
export STEAM_COMPAT_DATA_PATH STEAM_COMPAT_CLIENT_INSTALL_PATH PROTON_DIR DESKTOP

# explorer detaches, so the game's own exit code never gets back here.
# a proton variant cannot report GameFailed, which is why run demands --marker for one.

# without the virtual desktop Unity crashes one frame after "<RI> Input initialized".
# explorer detaches, so wineserver -w is what holds Xvfb open.
# shellcheck disable=SC2016 # deliberate: the inner sh expands these, not this shell
run_under_xvfb sh -c '
  set -e
  "$PROTON_DIR/proton" run explorer "/desktop=game,$DESKTOP" "$@"
  WINEPREFIX="$STEAM_COMPAT_DATA_PATH/pfx" exec "$PROTON_DIR/files/bin/wineserver" -w
' _ "$@"
