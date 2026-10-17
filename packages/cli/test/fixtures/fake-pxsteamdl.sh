#!/bin/sh
out="."
lanes=""
ids=""
[ -n "$FAKE_ARGV_FILE" ] && printf '%s\n' "$*" > "$FAKE_ARGV_FILE"
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -j) lanes="$2"; shift 2 ;;
    -t) shift 2 ;;
    --) shift; while [ $# -gt 0 ]; do ids="$ids $1"; shift; done ;;
    *) ids="$ids $1"; shift ;;
  esac
done

if [ -z "$lanes" ]; then
  printf 'FAKE: no -j, refusing to guess a lane count\n' >&2
  exit 64
fi

ok=0
failed=0
lines=""
for id in $ids; do
  case " $FAKE_SKIP_IDS " in
    *" $id "*) continue ;;
  esac
  case " $FAKE_FAIL_IDS " in
    *" $id "*)
      failed=$((failed + 1))
      lines="$lines
failed $id  Steam rejected the item: not found (EResult 9)"
      continue
      ;;
  esac
  mkdir -p "$out/$id/About"
  printf '<ModMetaData><packageId>fake.%s</packageId></ModMetaData>' "$id" > "$out/$id/About/About.xml"
  : > "$out/.$id.lock"
  ok=$((ok + 1))
  lines="$lines
ok     $id  Fake Mod $id"
done

[ -n "$FAKE_DELAY_MS" ] && sleep "$(awk "BEGIN { print $FAKE_DELAY_MS / 1000 }")"

printf '%s items, %s failed, 1.2s%s\n' "$((ok + failed))" "$failed" "$lines"
exit "${FAKE_EXIT:-0}"
