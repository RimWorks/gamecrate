#!/bin/sh
# Shared by run-headless and run-headless-windows. Not run on its own.

: "${SCREEN:=1920x1080x24}"
: "${GAME_UID:=1000}"
: "${NESTED_DISPLAY:=:90}"

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
    env HOME="$HOME" SCREEN="$SCREEN" DESKTOP="${DESKTOP:-}" \
    NESTED_DISPLAY="$NESTED_DISPLAY" HOST_X11_DIR="${HOST_X11_DIR:-}" "$0" "$@"
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

# XTEST never reaches a client through XWayland, so a headed run on a wayland host cannot be
# clicked. Xephyr is a real X server, and it draws its own window onto the host display.
run_under_xephyr() {
  if ! command -v Xephyr >/dev/null 2>&1; then
    echo "run-headed: no Xephyr in this image. rebuild it on a newer runtime base." >&2
    exit 5
  fi
  game="$1"
  outer="${DISPLAY:-}"
  [ -n "$outer" ] || { echo "run-headed: no DISPLAY to host the nested server on" >&2; exit 5; }
  # the host socket is linked in under its own number, so the nested one has to differ or Xephyr
  # binds over the link it needs to reach the host
  [ "$outer" != "$NESTED_DISPLAY" ] || { echo "run-headed: nested display $NESTED_DISPLAY is the host's" >&2; exit 5; }

  # our /tmp/.X11-unix is a private tmpfs, so the host socket has to be linked in to reach it.
  # that is also what stops the nested display landing on top of the host's.
  if [ -n "${HOST_X11_DIR:-}" ]; then
    ln -sf "$HOST_X11_DIR/X${outer#:}" "/tmp/.X11-unix/X${outer#:}" || true
  fi

  Xephyr "$NESTED_DISPLAY" -screen "$SCREEN" -resizeable -name "$(basename "$game")" &
  server=$!
  waited=0
  until [ -S "/tmp/.X11-unix/X${NESTED_DISPLAY#:}" ]; do
    kill -0 "$server" 2>/dev/null || { echo "run-headed: Xephyr exited before it came up" >&2; exit 5; }
    [ "$waited" -lt 200 ] || { echo "run-headed: Xephyr never came up on $NESTED_DISPLAY" >&2; exit 5; }
    waited=$((waited + 1))
    sleep 0.1
  done

  DISPLAY="$NESTED_DISPLAY" "$@" &
  child=$!
  trap 'kill -TERM "$child" "$server" 2>/dev/null' HUP INT TERM
  status=0
  wait "$child" || status=$?
  kill -TERM "$server" 2>/dev/null || true
  return "$status"
}
