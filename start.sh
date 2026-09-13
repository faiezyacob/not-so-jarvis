#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

add_common_paths() {
    for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/node/bin"; do
        case ":$PATH:" in
            *":$dir:"*) ;;
            *) if [ -d "$dir" ]; then PATH="$dir:$PATH"; fi ;;
        esac
    done
    export PATH
}

refresh_shell() {
    hash -r 2>/dev/null || true
}

have_node() {
    command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1
}

add_common_paths
refresh_shell

if ! have_node; then
    printf '\nNode.js was not found on this system, but JARVIS needs it to run.\n\n'
    printf 'Download and install Node.js LTS now? [Y/N]: '
    read -r answer
    case "$answer" in
        [Yy]*)
            if ! bash "$SCRIPT_DIR/install-node.sh"; then
                printf '\nAutomatic install failed. Please install Node.js from https://nodejs.org/ (LTS) and run ./start.sh again.\n'
                exit 1
            fi
            add_common_paths
            refresh_shell
            ;;
        *)
            printf '\nPlease install Node.js from https://nodejs.org/ (LTS) and run ./start.sh again.\n'
            exit 1
            ;;
    esac
fi

if ! have_node; then
    printf '\nNode.js is still not available. Please install it from https://nodejs.org/ (LTS) and run ./start.sh again.\n'
    exit 1
fi

while true; do
    echo "Starting JARVIS server..."
    npm start
    code=$?
    if [ "$code" -eq 100 ]; then
        echo "Restarting JARVIS server..."
        continue
    fi
    echo "JARVIS server has exited (code $code)."
    break
done
