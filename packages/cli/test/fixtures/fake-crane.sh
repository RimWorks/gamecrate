#!/bin/sh
# a fake docker for the crane tests. records each run's argv on one line and answers the verb.
# FAKE_ARGV_FILE where argv is recorded, FAKE_CONFIG_JSON what `crane config` prints,
# FAKE_FAIL_FIRST how many runs exit 1 first, FAKE_EXIT the code for every run.
# builtins only: PATH is the fixture dir alone, so wc, tr and cut are not there.

DEFAULT_CONFIG='{"config":{"Labels":null}}'

printf '%s\n' "$*" >> "$FAKE_ARGV_FILE"

if [ -n "$FAKE_FAIL_FIRST" ]; then
  count=0
  while IFS= read -r _line; do count=$((count + 1)); done < "$FAKE_ARGV_FILE"
  if [ "$count" -le "$FAKE_FAIL_FIRST" ]; then
    printf 'fake: 502 from the registry\n' >&2
    exit 1
  fi
fi

for arg in "$@"; do
  if [ "$arg" = "config" ]; then
    printf '%s\n' "${FAKE_CONFIG_JSON:-$DEFAULT_CONFIG}"
    exit "${FAKE_EXIT:-0}"
  fi
done

exit "${FAKE_EXIT:-0}"
