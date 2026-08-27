#!/bin/sh

set -eu

APP_NAME="FFM Viewer.app"
BUNDLE_ID="io.github.dongseonyoo.ffm-viewer"
ASSET_NAME="FFM-Viewer-macos-arm64.zip"
REPOSITORY="DongSeonYoo/ffm-viewer"
RELEASE_BASE_URL=${FFM_RELEASE_BASE_URL:-"https://github.com/$REPOSITORY/releases/latest/download"}
INSTALL_DIR=${FFM_INSTALL_DIR:-"$HOME/Applications"}
TARGET_APP="$INSTALL_DIR/$APP_NAME"

fail() {
  printf 'FFM Viewer install failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

download() {
  url=$1
  destination=$2

  set -- \
    --fail \
    --location \
    --retry 3 \
    --retry-max-time 300 \
    --connect-timeout 15 \
    --max-time 300 \
    --silent \
    --show-error \
    --output "$destination"

  case "$url" in
    https://*)
      set -- "$@" --proto '=https' --tlsv1.2
      ;;
  esac

  curl "$@" "$url"
}

[ "$(uname -s)" = "Darwin" ] || fail "this installer supports macOS only"

machine=$(uname -m)
if [ "$machine" != "arm64" ]; then
  translated=$(sysctl -in sysctl.proc_translated 2>/dev/null || printf '0')
  [ "$machine" = "x86_64" ] && [ "$translated" = "1" ] \
    || fail "this release supports Apple Silicon Macs only"
fi

case "$INSTALL_DIR" in
  /*) ;;
  *) fail "installation directory must be an absolute path" ;;
esac
[ "$INSTALL_DIR" != "/" ] || fail "refusing to install directly into /"

require_command curl
require_command ditto
require_command shasum
require_command /usr/libexec/PlistBuddy

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/ffm-viewer-install.XXXXXX")
ARCHIVE="$TEMP_ROOT/$ASSET_NAME"
CHECKSUM="$ARCHIVE.sha256"
EXTRACT_DIR="$TEMP_ROOT/extracted"
STAGED_APP="$INSTALL_DIR/.ffm-viewer-installing.$$"
BACKUP_APP="$INSTALL_DIR/.ffm-viewer-previous.$$"
target_changed=0
install_committed=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM

  if [ "$install_committed" -ne 1 ] && [ "$target_changed" -eq 1 ]; then
    if [ -e "$TARGET_APP" ] || [ -L "$TARGET_APP" ]; then
      rm -rf "$TARGET_APP"
    fi
    if [ -e "$BACKUP_APP" ] || [ -L "$BACKUP_APP" ]; then
      mv "$BACKUP_APP" "$TARGET_APP" || true
    fi
  fi

  if [ -e "$STAGED_APP" ] || [ -L "$STAGED_APP" ]; then
    rm -rf "$STAGED_APP"
  fi
  if [ "$install_committed" -eq 1 ] && { [ -e "$BACKUP_APP" ] || [ -L "$BACKUP_APP" ]; }; then
    rm -rf "$BACKUP_APP"
  fi
  rm -rf "$TEMP_ROOT"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

printf 'Downloading the latest FFM Viewer...\n'
download "$RELEASE_BASE_URL/$ASSET_NAME" "$ARCHIVE"
download "$RELEASE_BASE_URL/$ASSET_NAME.sha256" "$CHECKSUM"

printf 'Verifying the download...\n'
(
  cd "$TEMP_ROOT"
  shasum -a 256 -c "$(basename "$CHECKSUM")"
)

mkdir -p "$EXTRACT_DIR"
ditto -x -k "$ARCHIVE" "$EXTRACT_DIR"
SOURCE_APP="$EXTRACT_DIR/$APP_NAME"
[ -d "$SOURCE_APP" ] && [ ! -L "$SOURCE_APP" ] \
  || fail "release archive does not contain $APP_NAME"

actual_bundle_id=$(
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
    "$SOURCE_APP/Contents/Info.plist" 2>/dev/null || true
)
[ "$actual_bundle_id" = "$BUNDLE_ID" ] \
  || fail "release archive has an unexpected application identity"

mkdir -p "$INSTALL_DIR"
[ ! -e "$STAGED_APP" ] && [ ! -L "$STAGED_APP" ] \
  || fail "temporary installation path already exists"
[ ! -e "$BACKUP_APP" ] && [ ! -L "$BACKUP_APP" ] \
  || fail "temporary backup path already exists"

ditto "$SOURCE_APP" "$STAGED_APP"

if [ -e "$TARGET_APP" ] || [ -L "$TARGET_APP" ]; then
  mv "$TARGET_APP" "$BACKUP_APP"
  target_changed=1
fi

target_changed=1
mv "$STAGED_APP" "$TARGET_APP"
install_committed=1

if [ -e "$BACKUP_APP" ] || [ -L "$BACKUP_APP" ]; then
  rm -rf "$BACKUP_APP"
fi

spotlight_registered=0
if [ "${FFM_SKIP_REGISTER:-0}" != "1" ]; then
  LSREGISTER=${FFM_LSREGISTER_PATH:-"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"}
  if [ -x "$LSREGISTER" ]; then
    if "$LSREGISTER" -f "$TARGET_APP" >/dev/null 2>&1; then
      spotlight_registered=1
    fi
  fi
  if command -v mdimport >/dev/null 2>&1; then
    if mdimport "$TARGET_APP" >/dev/null 2>&1; then
      spotlight_registered=1
    fi
  fi
fi

printf '\nFFM Viewer is installed in %s\n' "$TARGET_APP"
if [ "$spotlight_registered" -eq 1 ]; then
  printf 'You can now find it with Spotlight.\n'
elif [ "${FFM_SKIP_REGISTER:-0}" != "1" ]; then
  printf 'Warning: Spotlight registration could not be completed.\n' >&2
  printf 'Open FFM Viewer once from %s, or run: mdimport "%s"\n' \
    "$TARGET_APP" "$TARGET_APP" >&2
fi

if [ "${FFM_SKIP_LAUNCH:-0}" != "1" ]; then
  if ! open "$TARGET_APP"; then
    printf 'Warning: FFM Viewer was installed, but could not be opened automatically.\n' >&2
    printf 'Open it manually from %s. If macOS blocks it, use System Settings > Privacy & Security > Open Anyway.\n' \
      "$TARGET_APP" >&2
  fi
fi
