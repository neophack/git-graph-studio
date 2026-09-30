#!/bin/sh
# Module 15 — Build & Release Pipeline.
#
# The macOS install channel that needs no Apple Developer account. curl sets no
# com.apple.quarantine attribute (only LSFileQuarantineEnabled apps — browsers,
# Mail, AirDrop — do), so an app this script installs is never handed to
# Gatekeeper and opens on the first click: no "damaged" dialog, no manual
# `xattr -dr`. That is the account-less answer for the ad-hoc sealed dmg the CI
# publishes while no Developer ID / notarization secrets are configured
# (scripts/signing.mjs); a browser download of the same dmg stays blocked, and
# Homebrew is no way round it either — brew 7 stamps its own quarantine onto
# every cask install and removed --no-quarantine. Once the signing secrets
# exist (scripts/gen-signing-secrets.mjs) the dmg opens directly and this
# script becomes unnecessary.
#
# Usage:
#   curl -fsSL <raw repo url>/main/scripts/install-macos.sh | sh
#   scripts/install-macos.sh [version]     # explicit version, default: latest
#   GGS_INSTALL_DIR=/tmp/test scripts/install-macos.sh   # override the target
#
# The dmg's SHA256 is verified against the release's SHA256SUMS before anything
# is copied. A running instance aborts the install (replacing a live bundle can
# crash it); quit the app and re-run.

set -eu

repo="neophack/git-graph-studio"
app_name="Git Graph Studio"
version="${1:-}"

die() { echo "install-macos: $*" >&2; exit 1; }

case "$(uname -s)" in
	Darwin) ;;
	*) die "this installer is for macOS only" ;;
esac

case "$(uname -m)" in
	arm64) asset_arch=aarch64 ;;
	x86_64 | i386) asset_arch=x64 ;;
	*) die "unsupported architecture $(uname -m)" ;;
esac

if [ -z "$version" ]; then
	# The releases/latest page redirects to /tag/vX.Y.Z — version discovery with
	# no GitHub API call and no rate limit.
	tag_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' \
		"https://github.com/${repo}/releases/latest") ||
		die "cannot resolve the latest release of ${repo}"
	version=${tag_url##*/tag/}
	version=${version#v}
fi
case "$version" in
	v*) die "pass a bare version (0.1.7), not a tag (${version})" ;;
esac

dest=${GGS_INSTALL_DIR:-}
if [ -z "$dest" ]; then
	if [ -w /Applications ]; then
		dest=/Applications
	else
		dest=${HOME}/Applications
		mkdir -p "$dest"
	fi
fi

# GitHub serves a release asset whose name carries spaces (the tauri product name,
# "Git Graph Studio …") under a download URL with the spaces turned into dots; the
# SHA256SUMS entries use the real, spaced name.
dmg="Git.Graph.Studio_${version}_${asset_arch}.dmg"
sums_name="Git Graph Studio_${version}_${asset_arch}.dmg"
base="https://github.com/${repo}/releases/download/v${version}"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/ggs-install.XXXXXX")
mount_point=

cleanup() {
	if [ -n "$mount_point" ]; then hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true; fi
	rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

if pgrep -f "/${app_name}.app/Contents/MacOS/" >/dev/null 2>&1; then
	die "a running instance was found — quit ${app_name} first, then re-run"
fi

echo "==> downloading ${dmg} (via curl: no quarantine attribute, ever)"
curl -fL --retry 3 --retry-delay 2 -C - --progress-bar -o "${tmp}/${dmg}" "${base}/${dmg}" ||
	die "download failed — check the version (${version}); x64 dmgs ship only on 'full' release builds: https://github.com/${repo}/releases"
[ -f "${tmp}/${dmg}" ] || die "curl reported success but ${dmg} is missing"

curl -fsSL --retry 3 -o "${tmp}/SHA256SUMS" "${base}/SHA256SUMS" ||
	die "cannot fetch SHA256SUMS for v${version}"
expected=$(sed -n "s/^\([0-9a-f]\{64\}\)  ${sums_name}\$/\1/p" "${tmp}/SHA256SUMS")
[ -n "$expected" ] || die "no ${sums_name} entry in the release's SHA256SUMS"
actual=$(shasum -a 256 "${tmp}/${dmg}" | awk '{ print $1 }')
[ "$actual" = "$expected" ] ||
	die "SHA256 mismatch for ${dmg} — the download is corrupt; re-run the script"

echo "==> verifying disk image"
# hdiutil's listing is tab-separated but space-padded per column ("Apple_HFS   "),
# so the fs type matches by regex and the mount point is trimmed.
mount_point=$(hdiutil attach -nobrowse -readonly "${tmp}/${dmg}" 2>/dev/null |
	awk -F'\t' '$2 ~ /Apple_HFS/ { gsub(/ +$/, "", $3); print $3 }')
[ -n "$mount_point" ] || die "cannot mount ${dmg}"
[ -d "${mount_point}/${app_name}.app" ] || die "no ${app_name}.app inside the dmg"

echo "==> installing into ${dest}"
if [ -e "${dest}/${app_name}.app" ]; then
	rm -rf "${dest}/${app_name}.app"
fi
ditto "${mount_point}/${app_name}.app" "${dest}/${app_name}.app"

hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true
mount_point=

if xattr -p com.apple.quarantine "${dest}/${app_name}.app" >/dev/null 2>&1; then
	echo "install-macos: WARNING: the installed app carries a quarantine attribute" >&2
	echo "  (nothing in this path sets one — please report this). Remove it with:" >&2
	echo "  xattr -dr com.apple.quarantine '${dest}/${app_name}.app'" >&2
	exit 1
fi

echo "==> done: ${dest}/${app_name}.app (v${version})"
echo "    Open it from Launchpad, or:  open -a '${app_name}'"
echo "    The 'ggs' command joins your PATH at the app's next launch (its own setting)."
