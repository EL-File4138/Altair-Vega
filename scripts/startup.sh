#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: . scripts/startup.sh [--url <binary-url>] [--runtime-parent <dir>] [--keep-runtime]
       scripts/startup.sh [--url <binary-url>] [--runtime-parent <dir>] [--keep-runtime] [--] [args...]

Downloads a native Altair Vega executable into a temporary session workspace.
When sourced, the launcher prepends the downloaded binary to PATH and cleans the
workspace when the shell exits unless --keep-runtime is set. When executed, it
runs the binary once with any remaining arguments and cleans up on exit.

Environment:
  ALTAIR_VEGA_BIN_URL       Explicit binary URL when --url is omitted.
  ALTAIR_VEGA_GITHUB_REPO   GitHub repo for latest release lookup.
  ALTAIR_VEGA_RUNTIME_ROOT and TMPDIR are set for the launched process.

Launcher help:
  scripts/startup.sh --launcher-help
EOF
}

default_binary_url() {
  repo=${ALTAIR_VEGA_GITHUB_REPO:-EL-File4138/Altair-Vega}
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Linux) platform=linux ;;
    Darwin) platform=macos ;;
    *)
      printf 'error: unsupported OS for default binary URL: %s; pass --url or set ALTAIR_VEGA_BIN_URL\n' "$os" >&2
      exit 64
      ;;
  esac

  case "$arch" in
    x86_64|amd64) machine=x86_64 ;;
    arm64|aarch64) machine=aarch64 ;;
    *)
      printf 'error: unsupported architecture for default binary URL: %s; pass --url or set ALTAIR_VEGA_BIN_URL\n' "$arch" >&2
      exit 64
      ;;
  esac

  printf 'https://github.com/%s/releases/latest/download/altair-vega-%s-%s\n' "$repo" "$platform" "$machine"
}

download_to() {
  url=$1
  target=$2
  case "$url" in
    file://*)
      cp "${url#file://}" "$target"
      return
      ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$target"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$target" "$url"
    return
  fi
  printf 'error: curl or wget is required to download %s\n' "$url" >&2
  exit 127
}

binary_url=${ALTAIR_VEGA_BIN_URL:-}
runtime_parent=
keep_runtime=0
sourced=0

if (return 0 2>/dev/null); then
  sourced=1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url)
      binary_url=$2
      shift 2
      ;;
    --runtime-parent)
      runtime_parent=$2
      shift 2
      ;;
    --keep-runtime)
      keep_runtime=1
      shift
      ;;
    --launcher-help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [ -z "$binary_url" ]; then
  binary_url=$(default_binary_url)
fi

if [ -n "$runtime_parent" ]; then
  base_dir=$runtime_parent
elif [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] && [ -w "$XDG_RUNTIME_DIR" ]; then
  base_dir=$XDG_RUNTIME_DIR
elif [ -d /dev/shm ] && [ -w /dev/shm ]; then
  base_dir=/dev/shm
else
  base_dir=${TMPDIR:-/tmp}
fi

umask 077
workspace=$(mktemp -d "${base_dir%/}/altair-vega-session-XXXXXX")
runtime_root="$workspace/runtime"
tmp_root="$runtime_root/tmp"
bin_root="$workspace/bin"
binary_path="$bin_root/altair-vega"
mkdir -p "$runtime_root" "$tmp_root" "$bin_root"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$keep_runtime" -eq 1 ]; then
    printf 'keeping Altair Vega runtime at %s\n' "$workspace" >&2
  else
    rm -rf "$workspace"
  fi
  exit "$status"
}

cleanup_sourced_runtime() {
  trap - EXIT HUP INT TERM
  if [ "$keep_runtime" -eq 1 ]; then
    printf 'keeping Altair Vega runtime at %s\n' "$workspace" >&2
  else
    rm -rf "$workspace"
  fi
}

if [ "$sourced" -eq 0 ]; then
  trap cleanup EXIT HUP INT TERM
fi

download_to "$binary_url" "$binary_path"
chmod 700 "$binary_path"

if [ "$sourced" -eq 1 ]; then
  export ALTAIR_VEGA_RUNTIME_ROOT="$runtime_root"
  export ALTAIR_VEGA_KEEP_RUNTIME="$keep_runtime"
  export TMPDIR="$tmp_root"
  export TMP="$tmp_root"
  export TEMP="$tmp_root"
  export PATH="$bin_root:$PATH"
  trap cleanup_sourced_runtime EXIT
  printf 'Altair Vega is available as altair-vega for this shell session.\n' >&2
  printf 'runtime workspace: %s\n' "$workspace" >&2
  return 0
fi

ALTAIR_VEGA_RUNTIME_ROOT="$runtime_root" \
ALTAIR_VEGA_KEEP_RUNTIME="$keep_runtime" \
TMPDIR="$tmp_root" \
TMP="$tmp_root" \
TEMP="$tmp_root" \
PATH="$bin_root:$PATH" \
"$binary_path" "$@"
