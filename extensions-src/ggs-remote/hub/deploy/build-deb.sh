#!/bin/sh
# Builds the Hub's standalone Linux packages (docs/ggs-remote-plan.md §20.9): one static
# musl binary — zero glibc dependency, runs on any x86_64 distro — wrapped as a deb
# (binary + systemd unit + example config) and as a plain tarball for everywhere else.
#
#   bash deploy/build-deb.sh                 build (musl target) then package
#   PREBUILT=./ggs-remote-hub bash deploy/build-deb.sh   package a binary built elsewhere
#   VERSION=0.1.0 bash deploy/build-deb.sh   override the version (CI passes the tag's)
#
# Always invoked as `bash <script>` (the repo's convention, 2026-10-14): a .sh committed
# from Windows carries no executable bit, and a direct invocation dies with Permission
# denied (exit 126).
#
# Needs cargo + the x86_64-unknown-linux-musl target (rustup target add …) + musl-gcc
# (musl-tools on Debian/Ubuntu) for the build path, and dpkg-deb for the deb itself.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
crate=$(dirname "$here")
target=x86_64-unknown-linux-musl
out="$crate/target/packages"
mkdir -p "$out"

version=${VERSION:-$(awk -F'"' '/^version/ {print $2; exit}' "$crate/Cargo.toml")}
binary="$crate/target/$target/release/ggs-remote-hub"

if [ -n "${PREBUILT:-}" ]; then
	binary=$PREBUILT
else
	cargo build --release --target "$target" --manifest-path "$crate/Cargo.toml"
fi
[ -x "$binary" ] || { echo "no binary at $binary" >&2; exit 1; }

# ---- the deb: /usr/bin + the systemd unit + the example config + a short README ----
deb_root="$crate/target/deb/ggs-remote-hub_${version}_amd64"
rm -rf "$deb_root"
install -D -m 755 "$binary" "$deb_root/usr/bin/ggs-remote-hub"
install -D -m 644 "$here/ggs-remote-hub.service" "$deb_root/lib/systemd/system/ggs-remote-hub.service"
install -D -m 644 "$here/hub.example.toml" "$deb_root/usr/share/ggs-remote-hub/hub.example.toml"
install -D -m 644 "$crate/README.md" "$deb_root/usr/share/doc/ggs-remote-hub/README.md"
mkdir -p "$deb_root/DEBIAN"
cat > "$deb_root/DEBIAN/control" <<EOF
Package: ggs-remote-hub
Version: $version
Section: net
Priority: optional
Architecture: amd64
Maintainer: Git Graph Studio <neophack@users.noreply.github.com>
Description: The GGS Remote Hub — the self-hosted, account-free relay
 Each PC's tray daemon keeps an outbound tunnel to this relay, and a phone's or another
 computer's browser reaches it over /u/<uuid>/ paths. Nothing is persisted: no database,
 no accounts, nothing to back up. Configure at /etc/ggs-hub/hub.toml (an example ships
 under /usr/share/ggs-remote-hub/), then: systemctl enable --now ggs-remote-hub.
EOF
# The unit's ExecStart reads /etc/ggs-hub/hub.toml: the example lands there as a conffile,
# so dpkg -i plus systemctl start runs out of the box and upgrades keep local edits.
install -D -m 644 "$here/hub.example.toml" "$deb_root/etc/ggs-hub/hub.toml"
printf '/etc/ggs-hub/hub.toml\n' > "$deb_root/DEBIAN/conffiles"
dpkg-deb --build --root-owner-group "$deb_root" "$out/ggs-remote-hub_${version}_amd64.deb"

# ---- the tarball: the same pieces, for every Linux that is not a Debian ----
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
install -D -m 755 "$binary" "$stage/ggs-remote-hub-${version}/ggs-remote-hub"
install -m 644 "$here/hub.example.toml" "$stage/ggs-remote-hub-${version}/hub.toml.example"
install -m 644 "$here/ggs-remote-hub.service" "$stage/ggs-remote-hub-${version}/ggs-remote-hub.service"
install -m 644 "$crate/README.md" "$stage/ggs-remote-hub-${version}/README.md"
tar -C "$stage" -czf "$out/ggs-remote-hub-${version}-x86_64-musl.tar.gz" "ggs-remote-hub-${version}"

echo "packages in $out:"
ls -l "$out"
