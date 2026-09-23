#!/bin/sh
# run-headless /game/YourGame <args...>
set -eu

# shellcheck source=scripts/headless-common.sh
. /usr/local/lib/headless-common.sh

drop_to_game_user "$@"

run_under_xvfb "$@"
