#!/usr/bin/env bash
set -u

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

have_node() { command -v node >/dev/null 2>&1; }

run_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        "$@"
    fi
}

node_major() {
    version="$(node -v 2>/dev/null || true)"
    version="${version#v}"
    printf '%s' "${version%%.*}"
}

node_is_supported() {
    major="$(node_major)"
    case "$major" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$major" -ge 18 ]
}

install_via_manager() {
    if [ "$OS" = "Darwin" ]; then
        command -v brew >/dev/null 2>&1 || return 1
        log 'Installing Node.js with Homebrew...'
        if brew install node; then return 0; fi
        return 1
    fi

    if command -v apt-get >/dev/null 2>&1; then
        log 'Installing Node.js with apt-get...'
        if run_root apt-get update && run_root apt-get install -y nodejs npm; then return 0; fi
        return 1
    fi

    if command -v dnf >/dev/null 2>&1; then
        log 'Installing Node.js with dnf...'
        if run_root dnf install -y nodejs; then return 0; fi
        return 1
    fi

    if command -v pacman >/dev/null 2>&1; then
        log 'Installing Node.js with pacman...'
        if run_root pacman -S --noconfirm nodejs npm; then return 0; fi
        return 1
    fi

    return 1
}

fetch_url() {
    url="$1"
    output="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$output"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$output" "$url"
    else
        return 1
    fi
}

fetch_text() {
    url="$1"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "$url"
    else
        return 1
    fi
}

download_tarball() {
    log 'Looking up the latest Node.js LTS release...'
    index="$(fetch_text 'https://nodejs.org/dist/index.json' || true)"
    if [ -z "$index" ]; then
        err 'Could not reach nodejs.org (curl/wget unavailable or offline).'
        return 1
    fi

    version="$(printf '%s' "$index" | grep -o '"version":"v[0-9.]*"[^}]*"lts":"[^"]*"' | head -n 1 | sed 's/^"version":"\(v[0-9.]*\)".*/\1/')"
    if [ -z "$version" ]; then
        version="$(printf '%s' "$index" | grep -o '"version":"v[0-9.]*"' | head -n 1 | sed 's/.*"\(v[0-9.]*\)"/\1/')"
    fi
    if [ -z "$version" ]; then
        err 'Could not determine the latest Node.js release.'
        return 1
    fi

    case "$ARCH" in
        arm64|aarch64) arch_part='arm64' ;;
        *) arch_part='x64' ;;
    esac
    case "$OS" in
        Darwin) os_part='darwin' ;;
        Linux) os_part='linux' ;;
        *) err "Unsupported platform: $OS"; return 1 ;;
    esac

    tarball="node-$version-$os_part-$arch_part.tar.gz"
    url="https://nodejs.org/dist/$version/$tarball"
    dest_dir="$HOME/.local/node"
    tmp_dir="$(mktemp -d)"

    log "Downloading $url ..."
    if ! fetch_url "$url" "$tmp_dir/$tarball"; then
        err 'Download failed.'
        rm -rf "$tmp_dir"
        return 1
    fi

    if ! tar -xzf "$tmp_dir/$tarball" -C "$tmp_dir"; then
        err 'Could not extract the Node.js archive.'
        rm -rf "$tmp_dir"
        return 1
    fi

    mkdir -p "$(dirname "$dest_dir")"
    rm -rf "$dest_dir"
    mv "$tmp_dir/node-$version-$os_part-$arch_part" "$dest_dir"
    rm -rf "$tmp_dir"

    log "Node.js $version installed to $dest_dir (adds to PATH via start.sh)."
    return 0
}

if have_node && node_is_supported; then
    exit 0
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

log 'Node.js was not found on this system.'

if install_via_manager; then
    if have_node && node_is_supported; then
        log "Node.js $(node -v) installed successfully."
        exit 0
    fi
    if have_node; then
        log "The package manager provided Node.js v$(node_major), which is too old; downloading the latest LTS instead."
    else
        log 'The package manager install did not put node on PATH; downloading the latest LTS instead.'
    fi
else
    log 'No usable package manager (or the install failed); downloading from nodejs.org instead.'
fi

if download_tarball; then
    exit 0
fi

err 'Could not install Node.js automatically. Please install it from https://nodejs.org/ (LTS) and run ./start.sh again.'
exit 1
