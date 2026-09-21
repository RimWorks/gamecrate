#!/bin/sh
# a fake steamcmd for the workshop dependency walk. same jammed, coloured output as
# fake-steamcmd.sh, but it writes each item's manifest from $FAKE_MANIFEST_DIR/<id>.txt so a
# download can introduce the next link in a chain.
#
# FAKE_FAIL_IDS      ids that print an ERROR! line instead

appid=""
ids=""
install=""
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

if [ -z "$install" ]; then
  printf 'FAKE: no +force_install_dir, refusing to guess a layout\n' >&2
  exit 64
fi

root="$install/steamapps/workshop/content/$appid"
printf 'Logging in user Anonymous to Steam Public...OK\n'
for id in $ids; do
  case " $FAKE_FAIL_IDS " in
    *" $id "*)
      printf 'ERROR! Download item %s failed (Failure).' "$id"
      continue
      ;;
  esac
  dir="$root/$id"
  mkdir -p "$dir/About"
  if [ -f "$FAKE_MANIFEST_DIR/$id.txt" ]; then
    cat "$FAKE_MANIFEST_DIR/$id.txt" > "$dir/About/About.txt"
  fi
  printf 'Downloading item %s ...' "$id"
  printf '\033[32mSuccess.\033[0m Downloaded item %s to "%s" (100 bytes) ' "$id" "$dir"
done
printf 'Unloading Steam API...OK\n'
