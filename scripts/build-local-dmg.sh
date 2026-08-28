#!/bin/sh
set -eu

channel=${1:-}
case "$channel" in
  beta)
    app_name="FFM_beta"
    bundle_id="io.github.dongseonyoo.ffm-viewer.beta"
    config_path="src-tauri/tauri.beta.conf.json"
    diagnostics=0
    install_dir="${FFM_BETA_INSTALL_DIR:-/Applications}"
    skip_launch="${FFM_BETA_SKIP_LAUNCH:-0}"
    ;;
  dev)
    app_name="FFM_dev"
    bundle_id="io.github.dongseonyoo.ffm-viewer.dev"
    config_path="src-tauri/tauri.dev.conf.json"
    diagnostics=1
    install_dir="${FFM_DEV_INSTALL_DIR:-/Applications}"
    skip_launch="${FFM_DEV_SKIP_LAUNCH:-0}"
    ;;
  *)
    echo "Usage: $0 beta|dev" >&2
    exit 2
    ;;
esac

bundle_dir="src-tauri/target/release/bundle/dmg"
app_source="src-tauri/target/release/bundle/macos/$app_name.app"
artifact="$PWD/$app_name.dmg"
artifact_staging="$PWD/.$app_name.dmg.installing.$$"
install_app="$install_dir/$app_name.app"
staging_app="$install_dir/.$app_name.installing.$$"
backup_app="$install_dir/.$app_name.backup.$$"
installed=0
backed_up=0

[ -n "$install_dir" ] && [ "$install_dir" != "/" ] || {
  echo "Refusing unsafe install directory" >&2
  exit 1
}

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -f -- "$artifact_staging"
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
find "$bundle_dir" -maxdepth 1 -type f -name "${app_name}_*.dmg" -delete

VITE_FFM_DIAGNOSTICS="$diagnostics" pnpm tauri build \
  --bundles app,dmg \
  --config "$config_path"

dmg=$(find "$bundle_dir" -maxdepth 1 -type f -name "${app_name}_*.dmg" -print -quit)
[ -n "$dmg" ] || {
  echo "$app_name DMG was not created" >&2
  exit 1
}
[ -d "$app_source" ] || {
  echo "$app_name app was not created" >&2
  exit 1
}

cp "$dmg" "$artifact_staging"
mkdir -p "$install_dir"
rm -rf -- "$staging_app" "$backup_app"
ditto "$app_source" "$staging_app"

actual_bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "$staging_app/Contents/Info.plist")
[ "$actual_bundle_id" = "$bundle_id" ] || {
  echo "Unexpected $app_name bundle ID: $actual_bundle_id" >&2
  exit 1
}
codesign --verify --deep --strict "$staging_app"

osascript -e "tell application id \"$bundle_id\" to quit" \
  >/dev/null 2>&1 || true
quit_attempts=0
while pgrep -f "$install_app/Contents/MacOS/ffm-viewer" >/dev/null 2>&1; do
  quit_attempts=$((quit_attempts + 1))
  [ "$quit_attempts" -lt 300 ] || {
    echo "$app_name is still running; close or save its Scratch tabs and retry" >&2
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

if [ "$skip_launch" != "1" ]; then
  if ! open "$install_app"; then
    sleep 0.5
    open "$install_app"
  fi
fi

mv -f "$artifact_staging" "$artifact"
rm -rf -- "$backup_app"
installed=0
backed_up=0
trap - EXIT HUP INT TERM

echo "Updated $artifact"
echo "Installed $install_app"
