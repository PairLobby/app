#!/bin/sh
set -eu
base=${PAIRLOBBY_DOWNLOAD_BASE:-https://pairlobby.com}
root=${PAIRLOBBY_INSTALL_DIR:-"$HOME/.local/share/pairlobby"}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
fetch() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$1" -o "$2"; }
verify() {
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$1" | cut -d ' ' -f 1)
    else actual=$(shasum -a 256 "$1" | cut -d ' ' -f 1); fi
    [ "$actual" = "$2" ] || { printf '%s\n' 'Download checksum failed.' >&2; exit 1; }
}
node_bin=$(command -v node || true)
if [ -z "$node_bin" ] || ! "$node_bin" -e 'let [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' >/dev/null 2>&1; then
    case $(uname -s) in Darwin) os=darwin;; Linux) os=linux;; *) printf '%s\n' 'Use the PowerShell installer on Windows.' >&2; exit 1;; esac
    case $(uname -m) in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) printf '%s\n' 'Unsupported CPU architecture.' >&2; exit 1;; esac
    printf '%s\n' 'Installing a private Node.js runtime…'
    fetch https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt "$work/node-shasums"
    archive=$(awk -v ending="-$os-$arch.tar.gz" 'index($2, ending) && substr($2,length($2)-length(ending)+1)==ending {print $2; exit}' "$work/node-shasums")
    [ -n "$archive" ] || { printf '%s\n' 'No compatible Node.js runtime found.' >&2; exit 1; }
    checksum=$(awk -v file="$archive" '$2==file {print $1}' "$work/node-shasums")
    fetch "https://nodejs.org/dist/latest-v22.x/$archive" "$work/node.tar.gz"
    verify "$work/node.tar.gz" "$checksum"
    tar -xzf "$work/node.tar.gz" -C "$work"
    runtime=${archive%.tar.gz}
    mkdir -p "$root/runtimes"
    if [ ! -d "$root/runtimes/$runtime" ]; then mv "$work/$runtime" "$root/runtimes/$runtime"; fi
    node_bin="$root/runtimes/$runtime/bin/node"
fi
fetch "$base/install.mjs" "$work/install.mjs"
"$node_bin" "$work/install.mjs" "$@"
