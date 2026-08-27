#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/ffm-viewer-install-test.XXXXXX")
ASSET_DIR="$TEST_ROOT/assets"
BUILD_DIR="$TEST_ROOT/build"
INSTALL_DIR="$TEST_ROOT/Applications"
ASSET_NAME="FFM-Viewer-macos-arm64.zip"
APP_NAME="FFM Viewer.app"
BUNDLE_ID="io.github.dongseonyoo.ffm-viewer"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'install test failed: %s\n' "$1" >&2
  exit 1
}

make_release() {
  bundle_id=$1

  rm -rf "$BUILD_DIR/$APP_NAME"
  mkdir -p "$ASSET_DIR" "$BUILD_DIR/$APP_NAME/Contents/MacOS"

  cat > "$BUILD_DIR/$APP_NAME/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>$bundle_id</string>
  <key>CFBundleName</key>
  <string>FFM Viewer</string>
</dict>
</plist>
PLIST

  printf '#!/bin/sh\nexit 0\n' > "$BUILD_DIR/$APP_NAME/Contents/MacOS/ffm-viewer"
  chmod +x "$BUILD_DIR/$APP_NAME/Contents/MacOS/ffm-viewer"

  rm -f "$ASSET_DIR/$ASSET_NAME" "$ASSET_DIR/$ASSET_NAME.sha256"
  ditto -c -k --sequesterRsrc --keepParent \
    "$BUILD_DIR/$APP_NAME" \
    "$ASSET_DIR/$ASSET_NAME"
  (
    cd "$ASSET_DIR"
    shasum -a 256 "$ASSET_NAME" > "$ASSET_NAME.sha256"
  )
}

make_release "$BUNDLE_ID"

run_installer_with_env() {
  env \
    FFM_RELEASE_BASE_URL="file://$ASSET_DIR" \
    FFM_INSTALL_DIR="$INSTALL_DIR" \
    "$@" \
    "$ROOT_DIR/install.sh"
}

run_installer() {
  run_installer_with_env FFM_SKIP_LAUNCH=1 FFM_SKIP_REGISTER=1
}

run_installer
[ -d "$INSTALL_DIR/$APP_NAME" ] || fail "app was not installed"

printf 'stale\n' > "$INSTALL_DIR/$APP_NAME/stale-file"
run_installer
[ ! -e "$INSTALL_DIR/$APP_NAME/stale-file" ] || fail "reinstall kept stale files"

printf 'known-good\n' > "$INSTALL_DIR/$APP_NAME/known-good"
make_release "example.invalid.ffm-viewer"
if run_installer >/dev/null 2>&1; then
  fail "archive with an unexpected bundle identifier was accepted"
fi
[ -e "$INSTALL_DIR/$APP_NAME/known-good" ] \
  || fail "bundle identity rejection replaced the existing app"

make_release "$BUNDLE_ID"
printf 'tampered\n' >> "$ASSET_DIR/$ASSET_NAME"
if run_installer >/dev/null 2>&1; then
  fail "tampered archive passed checksum verification"
fi
[ -d "$INSTALL_DIR/$APP_NAME" ] || fail "failed update removed the existing app"
[ -e "$INSTALL_DIR/$APP_NAME/known-good" ] \
  || fail "failed update replaced the existing app"

FAKE_REGISTER_BIN="$TEST_ROOT/fake-register-bin"
mkdir -p "$FAKE_REGISTER_BIN"
printf '#!/bin/sh\nexit 1\n' > "$FAKE_REGISTER_BIN/mdimport"
printf '#!/bin/sh\nexit 1\n' > "$FAKE_REGISTER_BIN/lsregister"
chmod +x "$FAKE_REGISTER_BIN/mdimport" "$FAKE_REGISTER_BIN/lsregister"

make_release "$BUNDLE_ID"
registration_output=$(
  run_installer_with_env \
    FFM_SKIP_LAUNCH=1 \
    FFM_LSREGISTER_PATH="$FAKE_REGISTER_BIN/lsregister" \
    PATH="$FAKE_REGISTER_BIN:$PATH" 2>&1
)
case "$registration_output" in
  *"You can now find it with Spotlight."*)
    fail "installer claimed Spotlight success after registration failures"
    ;;
esac
case "$registration_output" in
  *"Warning: Spotlight registration could not be completed."*) ;;
  *) fail "installer did not warn about Spotlight registration failures" ;;
esac

printf '#!/bin/sh\nexit 0\n' > "$FAKE_REGISTER_BIN/lsregister"
chmod +x "$FAKE_REGISTER_BIN/lsregister"
registration_output=$(
  run_installer_with_env \
    FFM_SKIP_LAUNCH=1 \
    FFM_LSREGISTER_PATH="$FAKE_REGISTER_BIN/lsregister" \
    PATH="$FAKE_REGISTER_BIN:$PATH" 2>&1
)
case "$registration_output" in
  *"You can now find it with Spotlight."*) ;;
  *) fail "installer did not report successful Spotlight registration" ;;
esac

FAKE_LAUNCH_BIN="$TEST_ROOT/fake-launch-bin"
mkdir -p "$FAKE_LAUNCH_BIN"
printf '#!/bin/sh\nexit 1\n' > "$FAKE_LAUNCH_BIN/open"
chmod +x "$FAKE_LAUNCH_BIN/open"
launch_output=$(
  run_installer_with_env \
    FFM_SKIP_REGISTER=1 \
    PATH="$FAKE_LAUNCH_BIN:$PATH" 2>&1
)
case "$launch_output" in
  *"was installed, but could not be opened automatically."*) ;;
  *) fail "installer did not warn about automatic launch failure" ;;
esac
case "$launch_output" in
  *"System Settings > Privacy & Security > Open Anyway."*) ;;
  *) fail "installer did not provide macOS manual opening guidance" ;;
esac
[ -d "$INSTALL_DIR/$APP_NAME" ] \
  || fail "automatic launch failure removed the installed app"

printf 'install test passed\n'
