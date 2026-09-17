#!/usr/bin/env bash
set -euo pipefail

# The destination must be new; existing checkouts and account data are never changed.
if [[ $# != 1 ]]; then
  echo 'Usage: scripts/wacalls/build.sh NEW_BUILD_DIRECTORY' >&2
  exit 2
fi
revision=edeb31f0427aba896639db503153b777a405eccf
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/../.." && pwd)
if [[ -e "$1" ]]; then echo 'Build destination already exists' >&2; exit 2; fi
mkdir -p -- "$1"
build_dir=$(cd -- "$1" && pwd)
source_url=${WACALLS_SOURCE_DIR:-https://github.com/JotaDev66/WaCalls.git}
git clone --no-checkout -- "$source_url" "$build_dir/source"
git -C "$build_dir/source" checkout --detach "$revision"
[[ $(git -C "$build_dir/source" rev-parse HEAD) == "$revision" ]]
for patch in media-websocket console-connections target-pairing account-unlink qr-refresh; do
  git -C "$build_dir/source" apply --check "$repo_dir/patches/wacalls/$patch.patch"
  git -C "$build_dir/source" apply "$repo_dir/patches/wacalls/$patch.patch"
done
cd -- "$build_dir/source"
env GOOS="$(go env GOHOSTOS)" GOARCH="$(go env GOHOSTARCH)" go test ./cmd/server ./internal/voip/call
mkdir -p "$build_dir/artifacts"
go build -trimpath -o "$build_dir/artifacts/wacalls-server" ./cmd/server
env CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$build_dir/artifacts/wacalls-server-linux-amd64" ./cmd/server
cp LICENSE "$build_dir/artifacts/WaCalls-LICENSE"
{
  echo "upstream=https://github.com/JotaDev66/WaCalls"
  echo "revision=$revision"
  go version
  if command -v sha256sum >/dev/null; then
    sha256sum "$repo_dir/patches/wacalls/"*.patch "$build_dir/artifacts/"wacalls-server*
  else
    shasum -a 256 "$repo_dir/patches/wacalls/"*.patch "$build_dir/artifacts/"wacalls-server*
  fi
} > "$build_dir/artifacts/provenance.txt"
echo "Built artifacts: $build_dir/artifacts"
