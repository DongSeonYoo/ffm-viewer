#!/bin/sh
set -eu

bundle_dir="src-tauri/target/release/bundle/dmg"
app_source="src-tauri/target/release/bundle/macos/FFM_dev.app"
install_dir="${FFM_DEV_INSTALL_DIR:-/Applications}"
install_app="$install_dir/FFM_dev.app"
staging_app="$install_dir/.FFM_dev.installing.$$"
backup_app="$install_dir/.FFM_dev.backup.$$"
installed=0
backed_up=0

[ -n "$install_dir" ] && [ "$install_dir" != "/" ] || {
  echo "Refusing unsafe FFM_DEV_INSTALL_DIR" >&2
  exit 1
}

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    rm -rf -- "$staging_app"
    if [ "$installed" -eq 1 ]; then
      rm -rf -- "$install_app"
    fi
    if [ "$backed_up" -eq 1 ] && [ -d "$backup_app" ]; then
      mv "$backup_app" "$install_app"
    fi
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM

mkdir -p "$bundle_dir"
find "$bundle_dir" -maxdepth 1 -type f -name 'FFM_dev_*.dmg' -delete

VITE_FFM_DIAGNOSTICS=1 pnpm tauri build \
  --bundles app,dmg \
  --config src-tauri/tauri.dev.conf.json

dmg=$(find "$bundle_dir" -maxdepth 1 -type f -name 'FFM_dev_*.dmg' -print -quit)
[ -n "$dmg" ] || {
  echo "FFM_dev DMG was not created" >&2
  exit 1
}
[ -d "$app_source" ] || {
  echo "FFM_dev app was not created" >&2
  exit 1
}

cp "$dmg" FFM_dev.dmg
mkdir -p "$install_dir"
rm -rf -- "$staging_app" "$backup_app"
ditto "$app_source" "$staging_app"

bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "$staging_app/Contents/Info.plist")
[ "$bundle_id" = "io.github.dongseonyoo.ffm-viewer.dev" ] || {
  echo "Unexpected FFM_dev bundle ID: $bundle_id" >&2
  exit 1
}
codesign --verify --deep --strict "$staging_app"

osascript -e 'tell application id "io.github.dongseonyoo.ffm-viewer.dev" to quit' \
  >/dev/null 2>&1 || true
quit_attempts=0
while pgrep -f "$install_app/Contents/MacOS/ffm-viewer" >/dev/null 2>&1; do
  quit_attempts=$((quit_attempts + 1))
  [ "$quit_attempts" -lt 30 ] || {
    echo "FFM_dev is still running; close or save its Scratch tabs and retry" >&2
    exit 1
  }
  sleep 0.1
done

if [ -d "$install_app" ]; then
  mv "$install_app" "$backup_app"
  backed_up=1
fi
mv "$staging_app" "$install_app"
installed=1

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$install_app"
codesign --verify --deep --strict "$install_app"

rm -rf -- "$backup_app"
installed=0
backed_up=0
trap - EXIT HUP INT TERM

if [ "${FFM_DEV_SKIP_LAUNCH:-0}" != "1" ]; then
  if ! open "$install_app"; then
    sleep 0.5
    open "$install_app"
  fi
fi

echo "Updated $PWD/FFM_dev.dmg"
echo "Installed $install_app"
