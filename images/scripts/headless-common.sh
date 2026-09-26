#!/bin/sh
# Shared by run-headless and run-headless-windows. Not run on its own.

: "${SCREEN:=1920x1080x24}"
: "${GAME_UID:=1000}"

drop_to_game_user() {
  [ "$(id -u)" = 0 ] || return 0

  chown "$GAME_UID:$GAME_UID" "$HOME" 2>/dev/null || true

  # only the parents docker created for the mounts, never a mount itself, or this
  # chowns the caller's host files. mountinfo octal-escapes space, tab and backslash.
  awk -v home="$HOME" '
    { mp = $5
      gsub(/\\040/, " ",  mp); gsub(/\\011/, "\t", mp)
      gsub(/\\012/, "\n", mp); gsub(/\\134/, "\\", mp)
      if (index(mp, home "/") == 1) print mp }
  ' /proc/self/mountinfo \
  | while IFS= read -r mp; do
      d=$(dirname "$mp")
      while [ "$d" != "$HOME" ] && [ "$d" != "/" ]; do
        chown "$GAME_UID:$GAME_UID" "$d" 2>/dev/null || true
        d=$(dirname "$d")
      done
    done

  exec setpriv --reuid "$GAME_UID" --regid "$GAME_UID" --clear-groups \
    env HOME="$HOME" SCREEN="$SCREEN" DESKTOP="${DESKTOP:-}" "$0" "$@"
}

# do not exec this. Xvfb signals SIGUSR1 to xvfb-run when the display is ready and
# that never lands if xvfb-run is PID 1, which is what makes --init unnecessary.
run_under_xvfb() {
  xvfb-run -a -s "-screen 0 $SCREEN" "$@" &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null' HUP INT TERM
  status=0
  wait "$child" || status=$?
  return "$status"
}
