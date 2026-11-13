#!/usr/bin/env bash
# Run a second, separate Abject from the AppImage for testing, beside the one
# you use every day. It keeps its own data, its own Electron profile and its
# own ports, so the two never touch each other's workspaces, settings or keys.
# It runs the newest build in release/ (what `pnpm incarnate:linux` just made),
# not the copy you run every day.
#
#   ./run-test-instance.sh            start the test instance
#   ./run-test-instance.sh --reset    delete its data first (a clean first run,
#                                     for testing onboarding), then start it
#
# Anything else on the command line is passed to the AppImage.
# Override the defaults with ABJECT_APPIMAGE, ABJECT_TEST_DIR, ABJECT_TEST_PORT.
set -euo pipefail

# The newest build in release/ beside this script, else the everyday copy.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEWEST_BUILD="$(ls -t "$HERE"/release/Abject-*.AppImage 2>/dev/null | head -1 || true)"
APPIMAGE="${ABJECT_APPIMAGE:-${NEWEST_BUILD:-$HOME/bin/Abject.AppImage}}"
TEST_DIR="${ABJECT_TEST_DIR:-$HOME/.config/abject-test}"
# The terminal and HTTP gateways follow at +4 and +5; the everyday instance
# uses 7719 to 7724.
PORT="${ABJECT_TEST_PORT:-7739}"

DATA_DIR="$TEST_DIR/data"
PROFILE_DIR="$TEST_DIR/electron"

reset=0
args=()
for arg in "$@"; do
  case "$arg" in
    --reset) reset=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) args+=("$arg") ;;
  esac
done

if [[ ! -x "$APPIMAGE" ]]; then
  echo "No AppImage to run at $APPIMAGE (set ABJECT_APPIMAGE to its path)." >&2
  exit 1
fi

# A test instance already up holds the port: starting or resetting under it
# would pull its data out from beneath it.
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "A test instance is already running on port $PORT. Close it first." >&2
  exit 1
fi

if (( reset )); then
  # Only ever a directory named for testing, never the everyday one.
  case "$TEST_DIR" in
    "$HOME/.config/abject"|"$HOME/.config/abject/"|"$HOME"|"$HOME/"|/|"")
      echo "Refusing to delete $TEST_DIR: that is not a test directory." >&2
      exit 1 ;;
  esac
  if [[ -d "$TEST_DIR" ]]; then
    echo "Deleting $TEST_DIR"
    rm -rf -- "$TEST_DIR"
  fi
fi

mkdir -p "$DATA_DIR" "$PROFILE_DIR"
echo "Test instance: $APPIMAGE (built $(date -r "$APPIMAGE" '+%b %d %H:%M'))"
echo "Test instance: data in $DATA_DIR, port $PORT"

# --user-data-dir gives it its own Electron profile: the app's
# one-instance-at-a-time lock lives there, so without it this launch would
# only focus the everyday window and quit.
ABJECTS_DATA_DIR="$DATA_DIR" WS_PORT="$PORT" \
  exec "$APPIMAGE" --user-data-dir="$PROFILE_DIR" ${args[@]+"${args[@]}"}
