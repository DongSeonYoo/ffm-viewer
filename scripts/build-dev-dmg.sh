#!/bin/sh
set -eu

bundle_dir="src-tauri/target/release/bundle/dmg"
mkdir -p "$bundle_dir"
find "$bundle_dir" -maxdepth 1 -type f -name 'FFM_dev_*.dmg' -delete

VITE_FFM_DIAGNOSTICS=1 pnpm tauri build --bundles dmg --config src-tauri/tauri.dev.conf.json

dmg=$(find "$bundle_dir" -maxdepth 1 -type f -name 'FFM_dev_*.dmg' -print -quit)
[ -n "$dmg" ] || {
  echo "FFM_dev DMG was not created" >&2
  exit 1
}

cp "$dmg" FFM_dev.dmg
echo "Updated $PWD/FFM_dev.dmg"
