#!/bin/sh
# a fake depotdownloader for the game-download and login tests. it records argv and env, honours
# -dir, and answers -manifest-only or a download.
#
# FAKE_NO_TOKEN no stored login: the prompt, then the crash a real one dies with when stdin is closed
# FAKE_TOKEN_REJECTED the stored token expired. FAKE_LOGIN_FAIL one EResult name
# FAKE_BRANCH_FAIL the branch password was wrong. FAKE_NOT_OWNED the account lacks the app
# FAKE_EXIT the exit code

PATH="/usr/bin:/bin:$PATH"

if [ -n "$HOME" ]; then
  mkdir -p "$HOME"
  printf '%s\n' "$*" > "$HOME/argv.txt"
  printf '%s\n' "${XDG_DATA_HOME:-}" > "$HOME/xdg.txt"
fi

# a real one opens its isolated storage before it reads a flag, so the store exists after any run
store=""
if [ -n "$XDG_DATA_HOME" ]; then
  store="$XDG_DATA_HOME/IsolatedStorage/abc123.v24/def456.z3n/Url.fakehash/AssemFiles"
  mkdir -p "$store"
fi

case " $* " in
  *" -V "*) printf 'DepotDownloader v3.4.0\nRuntime: .NET 9.0.0 on fake\n'; exit 0 ;;
esac

dir=""; app=""; branch="public"; manifest_only=""; remember=""
while [ $# -gt 0 ]; do
  case "$1" in
    -dir) dir="$2"; shift 2 ;;
    -app) app="$2"; shift 2 ;;
    -branch) branch="$2"; shift 2 ;;
    -manifest-only) manifest_only=1; shift ;;
    -remember-password) remember=1; shift ;;
    *) shift ;;
  esac
done

printf 'DepotDownloader v3.4.0\nConnecting to Steam3... Done!\n'

if [ -n "$FAKE_NO_TOKEN" ]; then
  printf 'Enter account password for "tester": \n'
  printf "Logging 'tester' into Steam3...\n"
  printf "Unhandled exception. System.ArgumentException: LogOn requires a username and password or access token to be set in 'details'.\n" >&2
  exit "${FAKE_EXIT:-134}"
fi
if [ -n "$FAKE_TOKEN_REJECTED" ]; then
  printf "Logging 'tester' into Steam3...\nAccess token was rejected (Expired).\n"
  exit "${FAKE_EXIT:-1}"
fi
if [ -n "$FAKE_LOGIN_FAIL" ]; then
  printf "Logging 'tester' into Steam3...\nUnable to login to Steam3: %s\n" "$FAKE_LOGIN_FAIL"
  exit "${FAKE_EXIT:-1}"
fi

printf "Logging 'tester' into Steam3... Done!\n"

# a real one saves the refresh token the moment the login succeeds
if [ -n "$remember" ] && [ -n "$store" ]; then
  printf 'fake token\n' > "$store/account.config"
fi

if [ -z "$app" ]; then
  printf 'Error: -app not specified!\n'
  exit 1
fi
if [ -n "$FAKE_NOT_OWNED" ]; then
  printf 'App %s (RimWorld) is not available from this account.\n' "$app"
  exit "${FAKE_EXIT:-1}"
fi
if [ -n "$FAKE_BRANCH_FAIL" ]; then
  printf 'Error: Password was invalid for branch %s (or the branch does not exist)\n' "$branch"
  exit "${FAKE_EXIT:-1}"
fi
if [ -z "$dir" ]; then
  printf 'FAKE: no -dir, refusing to guess a layout\n' >&2
  exit 64
fi
mkdir -p "$dir"
if [ -n "$manifest_only" ]; then
  printf 'Manifest 3402513235443928324 (public)\n' > "$dir/manifest_294103_3402513235443928324.txt"
  exit "${FAKE_EXIT:-0}"
fi
mkdir -p "$dir/.DepotDownloader"
: > "$dir/.DepotDownloader/depot.config"
printf '1.6.4871 rev598\n' > "$dir/Version.txt"
printf 'Downloading depot 294103 - RimWorld Linux\n'
printf 'Depot 294103 - Downloaded 219365280 bytes (577359346 bytes uncompressed)\n'
printf 'Total downloaded: 219365280 bytes (577359346 bytes uncompressed) from 1 depots\n'
exit "${FAKE_EXIT:-0}"
