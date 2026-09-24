#!/bin/sh
# a fake docker for the crane tests. records each run's argv, then a @@RUN@@ line, and answers
# the verb. the argv holds a shell script now, so one run is many lines and the marker ends it.
# FAKE_ARGV_FILE where argv is recorded, FAKE_CONFIG_JSON what `crane config` prints,
# FAKE_FAIL_FIRST how many runs exit 1 first, FAKE_EXIT the code for every run.
# builtins only: PATH is the fixture dir alone, so wc, tr and cut are not there.

DEFAULT_CONFIG='{"config":{"Labels":null}}'

printf '%s\n@@RUN@@\n' "$*" >> "$FAKE_ARGV_FILE"

# busybox tar has no --transform. fail the way the real image fails, so a test cannot pass
# against a command the container would reject.
case "$*" in
  *--transform*)
    printf 'tar: unrecognized option: transform\n' >&2
    exit 1
    ;;
esac

if [ -n "$FAKE_FAIL_FIRST" ]; then
  count=0
  while IFS= read -r line; do
    if [ "$line" = "@@RUN@@" ]; then count=$((count + 1)); fi
  done < "$FAKE_ARGV_FILE"
  if [ "$count" -le "$FAKE_FAIL_FIRST" ]; then
    printf 'fake: 502 from the registry\n' >&2
    exit 1
  fi
fi

case "$*" in
  *"'crane' 'config'"*)
    printf '%s\n' "${FAKE_CONFIG_JSON:-$DEFAULT_CONFIG}"
    exit "${FAKE_EXIT:-0}"
    ;;
esac

exit "${FAKE_EXIT:-0}"
