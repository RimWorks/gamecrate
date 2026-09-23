#!/bin/sh
# a fake steamcmd for the game-download tests. it records argv, honours +force_install_dir, and
# answers +app_update or +app_info_print.
#
# FAKE_APP_STATE  a state code, which makes +app_update report an error instead of success
# FAKE_EXIT       exit code

[ -n "$HOME" ] && mkdir -p "$HOME" && printf '%s\n' "$*" > "$HOME/argv.txt"

appid=""
install=""
update=""
info=""
while [ $# -gt 0 ]; do
  case "$1" in
    +force_install_dir) install="$2"; shift 2 ;;
    +app_update) update="$2"; appid="$2"; shift 2 ;;
    +app_info_print) info="$2"; appid="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -n "$info" ]; then
  # public first and on purpose: a parser that takes the first buildid it sees reads 111 here
  cat <<EOF
"$appid"
{
  "depots"
  {
    "branches"
    {
      "public"
      {
        "buildid"  "111"
        "timeupdated"  "1750000000"
      }
      "1.5"
      {
        "buildid"  "222"
        "timeupdated"  "1750000001"
      }
      "unstable"
      {
        "buildid"  "333"
        "pwdrequired"  "1"
      }
    }
  }
}
EOF
  exit "${FAKE_EXIT:-0}"
fi

if [ -n "$update" ]; then
  if [ -z "$install" ]; then
    printf 'FAKE: no +force_install_dir, refusing to guess a layout\n' >&2
    exit 64
  fi
  if [ -n "$FAKE_APP_STATE" ]; then
    printf "Error! App '%s' state is %s after update job.\n" "$appid" "$FAKE_APP_STATE"
    exit "${FAKE_EXIT:-1}"
  fi
  mkdir -p "$install"
  printf '1.6.4871 rev598\n' > "$install/Version.txt"
  printf "Success! App '%s' fully installed.\n" "$appid"
fi

exit "${FAKE_EXIT:-0}"
