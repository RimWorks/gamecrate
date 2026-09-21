#!/bin/sh
# a fake steamcmd for the tests. it reads the +workshop_download_item pairs off argv, makes the
# directories a real run would make, and prints the same jammed, coloured output: no newline
# between one item's "Success." and the next item's "Downloading item".
#
# FAKE_FAIL_IDS  ids that print an ERROR! line
# FAKE_SKIP_IDS  ids that print nothing at all
# FAKE_FLAKY_IDS ids that fail on their first pass and succeed on the next
# FAKE_BYTES     byte count in the success line
# FAKE_EXIT      exit code

appid=""
ids=""
install=""
# so a test can prove the argv order, which matters: force_install_dir after +login is ignored
[ -n "$HOME" ] && mkdir -p "$HOME" && printf '%s\n' "$*" > "$HOME/argv.txt"
while [ $# -gt 0 ]; do
  if [ "$1" = "+workshop_download_item" ]; then
    appid="$2"
    ids="$ids $3"
    shift 3
  elif [ "$1" = "+force_install_dir" ]; then
    install="$2"
    shift 2
  else
    shift
  fi
done

# a real steamcmd honours +force_install_dir for workshop downloads, verified 2026-09-21 on both
# the host binary and the steamcmd/steamcmd image. without it, it picks its own layout.
if [ -z "$install" ]; then
  printf 'FAKE: no +force_install_dir, refusing to guess a layout\n' >&2
  exit 64
fi

printf 'Redirecting stderr to "%s/logs/stderr.txt"\n' "$HOME"

# so a test can prove the lock is held at the steam HOME for the whole run
mkdir -p "$HOME"
[ -e "$HOME.lock" ] && : > "$HOME/lock-seen"

printf '\033[1m[  0%%] Checking for available updates...\033[0m\n'
printf 'Logging in user Anonymous to Steam Public...OK\n'

root="$install/steamapps/workshop/content/$appid"
for id in $ids; do
  case " $FAKE_SKIP_IDS " in
    *" $id "*) continue ;;
  esac
  case " $FAKE_FLAKY_IDS " in
    *" $id "*)
      if [ ! -e "$HOME/flaky-$id" ]; then
        : > "$HOME/flaky-$id"
        printf 'ERROR! Download item %s failed (Failure).' "$id"
        continue
      fi
      ;;
  esac
  case " $FAKE_FAIL_IDS " in
    *" $id "*)
      printf 'ERROR! Download item %s failed (Failure).' "$id"
      continue
      ;;
  esac
  dir="$root/$id"
  mkdir -p "$dir/About"
  printf '<ModMetaData />' > "$dir/About/About.xml"
  printf 'Downloading item %s ...' "$id"
  printf '\033[32mSuccess.\033[0m Downloaded item %s to "%s" (%s bytes) ' "$id" "$dir" "${FAKE_BYTES:-2463770}"
done

printf 'Unloading Steam API...OK\n'
exit "${FAKE_EXIT:-0}"
