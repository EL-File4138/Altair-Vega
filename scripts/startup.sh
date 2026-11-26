#!/bin/sh

_altair_vega_launcher() (
set -eu
umask 077
sourced=$1
shift

usage() {
  cat >&2 <<'USAGE'
Usage: . scripts/startup.sh [--url <binary-url>] [--checksum-url <url>] [--runtime-parent <dir>]
       scripts/startup.sh [--url <binary-url>] [--checksum-url <url>] [--runtime-parent <dir>] [--] [args...]
       scripts/startup.sh [--runtime-parent <dir>] --cleanup

Downloads and verifies a native Altair Vega executable once per user boot/login
scope, then reuses it from a private cache. Runtime state is retained so failed
or interrupted commands can be retried. Use --cleanup to remove this scope.

When sourced, the launcher adds its wrapper to PATH for the current shell. It
does not install anything permanently, alter shell traps, or replace TMPDIR,
TMP, TEMP, or ALTAIR_VEGA_* in the parent shell.

Environment:
  ALTAIR_VEGA_BIN_URL          Explicit binary URL when --url is omitted.
  ALTAIR_VEGA_BIN_CHECKSUM_URL Checksum URL when --checksum-url is omitted.
  ALTAIR_VEGA_BIN_SHA256       Expected SHA-256 instead of downloading a sidecar.
  ALTAIR_VEGA_GITHUB_REPO      GitHub repo for latest release lookup.

The default checksum URL is <binary-url>.sha256. The cache is private to the
current user and boot/login identity. --cleanup removes inactive scopes for
this user, including previous boots. Disk-backed caches may survive reboot.
Use ALTAIR_VEGA_LAUNCHER_MODE=run when executing a renamed POSIX launcher.

--keep-runtime is accepted for compatibility and has no effect: the cache now
persists until --cleanup.
USAGE
}

fail() {
  printf 'error: %s\n' "$*" >&2
  return 1
}

default_binary_url() {
  repo=${ALTAIR_VEGA_GITHUB_REPO:-EL-File4138/Altair-Vega}
  case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=macos ;;
    *) fail "unsupported OS for default binary URL; pass --url or set ALTAIR_VEGA_BIN_URL"; return ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) machine=x86_64 ;;
    arm64|aarch64) machine=aarch64 ;;
    *) fail "unsupported architecture for default binary URL; pass --url or set ALTAIR_VEGA_BIN_URL"; return ;;
  esac
  printf 'https://github.com/%s/releases/latest/download/altair-vega-%s-%s\n' "$repo" "$platform" "$machine"
}

download_to() {
  case "$1" in
    file://*) cp "${1#file://}" "$2" ;;
    *)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$1" -o "$2"
      elif command -v wget >/dev/null 2>&1; then
        wget -qO "$2" "$1"
      else
        fail "curl or wget is required to download $1"
      fi
      ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum "$1") || return 1
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 "$1") || return 1
  else
    fail 'sha256sum or shasum is required to verify Altair Vega downloads'; return 1
  fi
  printf '%s\n' "$digest" | awk '{print $1}'
}

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(printf '%s' "$1" | sha256sum) || return 1
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(printf '%s' "$1" | shasum -a 256) || return 1
  else
    fail 'sha256sum or shasum is required to prepare Altair Vega cache'; return 1
  fi
  printf '%s\n' "$digest" | awk '{print $1}'
}

normalize_sha256() {
  printf '%s' "$1" | awk '{ value=tolower($1); if (length(value) == 64 && value ~ /^[0-9a-f]+$/) { print value; exit } }'
}

launcher_scope() {
  uid=$(id -u 2>/dev/null || printf '%s' "${USER:-unknown}")
  case "$(uname -s)" in
    Linux)
      boot_id=$(tr -cd '0-9A-Fa-f-' </proc/sys/kernel/random/boot_id 2>/dev/null || true)
      if [ -n "$boot_id" ]; then printf '%s-boot-%s\n' "$uid" "$boot_id"; return; fi
      ;;
    Darwin)
      boot_id=$(sysctl -n kern.boottime 2>/dev/null | tr -cd '0-9' || true)
      if [ -n "$boot_id" ]; then printf '%s-boot-%s\n' "$uid" "$boot_id"; return; fi
      ;;
  esac
  session_id=$(printf '%s' "${XDG_SESSION_ID:-${TERM_SESSION_ID:-login}}" | tr -cd '0-9A-Za-z._-')
  [ -n "$session_id" ] || session_id=login
  printf '%s-login-%s\n' "$uid" "$session_id"
}

prepare_executable_cache() {
  candidate=$1
  private_directory "$candidate" || return 1
  probe=$(mktemp "$candidate/.exec-probe.XXXXXXXX") || return 1
  if ! printf '#!/bin/sh\nexit 0\n' >"$probe" || ! chmod 700 "$probe" || ! "$probe" >/dev/null 2>&1; then
    rm -f "$probe"
    return 1
  fi
  rm -f "$probe"
}

private_directory() {
  # Shared parents must be sticky (e.g. /tmp). Never trust an existing link,
  # foreign owner, or group/world-accessible cache, even just for an exec probe.
  [ ! -L "$1" ] || return 1
  if [ ! -e "$1" ]; then mkdir "$1" 2>/dev/null || [ -d "$1" ] || return 1; fi
  [ ! -L "$1" ] && [ -d "$1" ] || return 1
  metadata=$(stat -c '%u %a' "$1" 2>/dev/null || stat -f '%u %Lp' "$1") || return 1
  [ "$metadata" = "$(id -u) 700" ]
}

safe_parent() {
  [ ! -L "$1" ] && [ -d "$1" ] || return 1
  ancestor=$(CDPATH= cd -P -- "$1" && pwd) || return 1
  while :; do
    metadata=$(stat -c '%u %a' "$ancestor" 2>/dev/null || stat -f '%u %Lp' "$ancestor") || return 1
    # No other user may rename an ancestor. A root-owned sticky temporary
    # parent permits safe atomic creation of our owner-private scope.
    case "$metadata" in "$(id -u) "[0-7][0145][0145]|"0 "[0-7][0145][0145]|'0 1777') ;; *) return 1 ;; esac
    [ "$ancestor" != / ] || break
    ancestor=${ancestor%/*}
    [ -n "$ancestor" ] || ancestor=/
  done
}

acquire_lock() {
  exec 9>"$1" || return 1
  if command -v flock >/dev/null 2>&1; then
    flock -w 300 9 || { exec 9>&-; return 75; }
  elif command -v lockf >/dev/null 2>&1; then
    lockf -t 300 9 || { exec 9>&-; return 75; }
  else
    exec 9>&-
    fail 'flock (Linux) or lockf (macOS) is required for safe launcher locking'; return 1
  fi
  # Cleanup can unlink a scope while a waiter holds its old lock-file inode.
  [ "$1" -ef /dev/fd/9 ] || { exec 9>&-; return 75; }
}

release_lock() { exec 9>&-; }

write_wrapper() {
  wrapper=$1
  key=$2
  temporary_wrapper="$wrapper.tmp.$$"
  cat >"$temporary_wrapper" <<EOF_WRAPPER || return 73
#!/bin/sh
set -eu
cache_root=\$(CDPATH= cd -- "\$(dirname "\$0")/../../.." && pwd)
exec 9>"\$cache_root/.lock"
if command -v flock >/dev/null 2>&1; then
  flock -w 300 9
elif command -v lockf >/dev/null 2>&1; then
  lockf -t 300 9
else
  echo 'flock (Linux) or lockf (macOS) is required' >&2; exit 1
fi
[ "\$cache_root/.lock" -ef /dev/fd/9 ] || exit 75
binary="\$cache_root/binaries/$key/altair-vega"
expected=\$(awk '{ value=tolower(\$1); if (length(value) == 64 && value ~ /^[0-9a-f]+$/) { print value; exit } }' "\$binary.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  digest=\$(sha256sum "\$binary")
else
  digest=\$(shasum -a 256 "\$binary")
fi
actual=\$(printf '%s\\n' "\$digest" | awk '{print \$1}')
if [ -z "\$expected" ] || [ "\$expected" != "\$actual" ]; then
  echo 'cached executable checksum verification failed; rerun the launcher' >&2; exit 65
fi
lease="\$cache_root/leases/\$\$"
LC_ALL=C ps -o lstart= -p "\$\$" >"\$lease"
exec 9>&-
exec env ALTAIR_VEGA_RUNTIME_ROOT="\$cache_root/runtime" "\$binary" "\$@"
EOF_WRAPPER
  [ -s "$temporary_wrapper" ] || return 1
  chmod 700 "$temporary_wrapper" && mv -f "$temporary_wrapper" "$wrapper"
}

binary_url=${ALTAIR_VEGA_BIN_URL:-}
checksum_url=${ALTAIR_VEGA_BIN_CHECKSUM_URL:-}
runtime_parent=
cleanup=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) [ "$#" -ge 2 ] || { fail '--url needs a value'; return 64; }; binary_url=$2; shift 2 ;;
    --checksum-url) [ "$#" -ge 2 ] || { fail '--checksum-url needs a value'; return 64; }; checksum_url=$2; shift 2 ;;
    --runtime-parent) [ "$#" -ge 2 ] || { fail '--runtime-parent needs a value'; return 64; }; runtime_parent=$2; shift 2 ;;
    --cleanup) cleanup=1; shift ;;
    --keep-runtime) printf 'warning: --keep-runtime has no effect; launcher state persists until --cleanup\n' >&2; shift ;;
    --launcher-help) usage; if [ "$sourced" -eq 1 ]; then return 0; else exit 0; fi ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if [ -n "$runtime_parent" ]; then
  base_dir=$runtime_parent
elif [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] && [ -w "$XDG_RUNTIME_DIR" ]; then
  base_dir=$XDG_RUNTIME_DIR
elif [ -d /dev/shm ] && [ -w /dev/shm ]; then
  base_dir=/dev/shm
else
  base_dir=${TMPDIR:-/tmp}
fi

scope=$(launcher_scope)
# mkdir -p is used only for an explicitly selected parent or the user's cache,
# never to prepare the predictable executable cache itself.
mkdir -p "$base_dir" || return 73
base_dir=$(CDPATH= cd -P -- "$base_dir" && pwd) || return 73
safe_parent "$base_dir" || { fail "unsafe launcher parent: $base_dir (require owner-private permissions)"; return 73; }
primary_cache_root="${base_dir%/}/altair-vega-launcher-$scope"
fallback_parent=${XDG_CACHE_HOME:-${HOME:-$base_dir}/.cache}
fallback_cache_root="${fallback_parent%/}/altair-vega-launcher-$scope"
if [ "$cleanup" -eq 1 ]; then
  for parent in "$base_dir" "$fallback_parent"; do
    [ -d "$parent" ] || continue
    parent=$(CDPATH= cd -P -- "$parent" && pwd) || return 73
    safe_parent "$parent" || { fail "unsafe cleanup parent: $parent"; return 73; }
    for cache_root in "$parent"/altair-vega-launcher-"$(id -u)"-*; do
      [ -e "$cache_root" ] || continue
      private_directory "$cache_root" || { fail "unsafe cleanup scope: $cache_root"; return 73; }
      lock_dir="$cache_root/.lock"
      acquire_lock "$lock_dir" || return 75
      busy=0
      for lease in "$cache_root"/leases/*; do
        [ -f "$lease" ] || continue
        pid=${lease##*/}
        case "$pid" in ''|*[!0-9]*) busy=1 ;; *)
          case "${cache_root##*/}" in
            "altair-vega-launcher-$scope")
              process_start=$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null || true)
              if [ -n "$process_start" ] && [ "$process_start" = "$(cat "$lease")" ]; then busy=1; else rm -f "$lease"; fi ;;
            *-boot-*) ;; # A different boot cannot contain a live process.
            *) if kill -0 "$pid" 2>/dev/null; then busy=1; else rm -f "$lease"; fi ;;
          esac ;;
        esac
      done
      if [ "$busy" -eq 1 ]; then release_lock "$lock_dir"; fail "cache is in use: $cache_root"; return 75; fi
      rm -rf "$cache_root" || return 73
      printf 'removed Altair Vega launcher cache: %s\n' "$cache_root" >&2
    done
  done
  if [ "$sourced" -eq 1 ]; then return 0; else exit 0; fi
fi

if [ -z "$binary_url" ]; then
  if ! binary_url=$(default_binary_url); then
    if [ "$sourced" -eq 1 ]; then return 64; else exit 64; fi
  fi
fi
if [ -z "$checksum_url" ] && [ -z "${ALTAIR_VEGA_BIN_SHA256:-}" ]; then checksum_url="$binary_url.sha256"; fi

if prepare_executable_cache "$primary_cache_root"; then
  cache_root=$primary_cache_root
elif { mkdir -p "$fallback_parent" && fallback_parent=$(CDPATH= cd -P -- "$fallback_parent" && pwd) && safe_parent "$fallback_parent" && fallback_cache_root="$fallback_parent/altair-vega-launcher-$scope" && prepare_executable_cache "$fallback_cache_root"; }; then
  cache_root=$fallback_cache_root
  printf 'warning: %s is not executable; using %s\n' "$base_dir" "$fallback_parent" >&2
else
  fail "neither $base_dir nor $fallback_parent can host executable Altair Vega cache files"
  if [ "$sourced" -eq 1 ]; then return 73; else exit 73; fi
fi

runtime_root="$cache_root/runtime"
binary_key=$(sha256_text "$binary_url
$checksum_url
${ALTAIR_VEGA_BIN_SHA256:-}") || return 127
case "$binary_key" in ''|*[!0-9a-f]*) fail 'invalid launcher policy hash'; return 65 ;; esac
[ "${#binary_key}" -eq 64 ] || { fail 'invalid launcher policy hash'; return 65; }
binary_dir="$cache_root/binaries/$binary_key"
binary_path="$binary_dir/altair-vega"
checksum_path="$binary_dir/altair-vega.sha256"
bin_root="$binary_dir/bin"
wrapper="$bin_root/altair-vega"
lock_dir="$cache_root/.lock"

if ! acquire_lock "$lock_dir"; then
  if [ "$sourced" -eq 1 ]; then return 75; else exit 75; fi
fi
trap 'release_lock "$lock_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
mkdir -p "$runtime_root" "$bin_root" "$cache_root/leases" || return 73
chmod 700 "$runtime_root" "$bin_root" "$cache_root/binaries" "$binary_dir" "$cache_root/leases" || return 73

cache_valid=0
if [ -f "$binary_path" ] && [ -f "$checksum_path" ]; then
  expected_checksum=$(normalize_sha256 "$(cat "$checksum_path")")
  if [ -n "${ALTAIR_VEGA_BIN_SHA256:-}" ]; then expected_checksum=$(normalize_sha256 "$ALTAIR_VEGA_BIN_SHA256"); fi
  actual_checksum=$(sha256_file "$binary_path" || true)
  if [ -n "$expected_checksum" ] && [ "$expected_checksum" = "$actual_checksum" ]; then
    cache_valid=1
  else
    rm -f "$binary_path" "$checksum_path"
  fi
fi

if [ "$cache_valid" -eq 0 ]; then
  mkdir -p "$binary_dir" || return 73
  chmod 700 "$binary_dir" || return 73
  if [ -n "${ALTAIR_VEGA_BIN_SHA256:-}" ]; then
    expected_checksum=$(normalize_sha256 "$ALTAIR_VEGA_BIN_SHA256")
  else
    checksum_download="$binary_dir/.checksum.download.$$"
    if download_to "$checksum_url" "$checksum_download"; then
      expected_checksum=$(normalize_sha256 "$(cat "$checksum_download")")
      rm -f "$checksum_download"
    else
      rm -f "$checksum_download"; release_lock "$lock_dir"
      if [ "$sourced" -eq 1 ]; then return 1; else exit 1; fi
    fi
  fi
  if [ -z "$expected_checksum" ]; then
    release_lock "$lock_dir"; fail "no valid SHA-256 checksum was supplied for $binary_url"
    if [ "$sourced" -eq 1 ]; then return 65; else exit 65; fi
  fi
  binary_download="$binary_dir/.binary.download.$$"
  if ! download_to "$binary_url" "$binary_download"; then
    rm -f "$binary_download"; release_lock "$lock_dir"
    if [ "$sourced" -eq 1 ]; then return 1; else exit 1; fi
  fi
  actual_checksum=$(sha256_file "$binary_download" || true)
  if [ "$expected_checksum" != "$actual_checksum" ]; then
    rm -f "$binary_download"; release_lock "$lock_dir"; fail "checksum verification failed for $binary_url"
    if [ "$sourced" -eq 1 ]; then return 65; else exit 65; fi
  fi
  chmod 700 "$binary_download" || return 73
  printf '%s\n' "$expected_checksum" >"$checksum_path.tmp.$$" || return 73
  mv -f "$binary_download" "$binary_path" || return 73
  mv -f "$checksum_path.tmp.$$" "$checksum_path" || return 73
fi
write_wrapper "$wrapper" "$binary_key" || return 73
release_lock "$lock_dir"

if [ "$sourced" -eq 1 ]; then
  printf 'Altair Vega is available as altair-vega for this shell session.\n' >&2
  printf 'launcher cache: %s (persists until --cleanup)\n' "$cache_root" >&2
  printf '%s\n' "$bin_root"
  return 0
fi
"$wrapper" "$@"
)

# POSIX sh cannot distinguish every renamed executed script from dot-sourcing.
# The published startup.sh name and explicit mode cover that ambiguity; Bash's
# return test also supports source <(curl ...). All preparation runs isolated.
if [ "${ALTAIR_VEGA_LAUNCHER_MODE:-}" != source ] && {
  [ "${ALTAIR_VEGA_LAUNCHER_MODE:-}" = run ] || [ "${0##*/}" = startup.sh ] ||
  { case $- in *i*) false ;; *s*) true ;; *) false ;; esac; } || ! (return 0 2>/dev/null)
}; then
  _altair_vega_launcher 0 "$@"
else
  if _altair_vega_launcher_path=$(_altair_vega_launcher 1 "$@"); then
    if [ -n "$_altair_vega_launcher_path" ]; then
      case ":$PATH:" in *":$_altair_vega_launcher_path:"*) ;; *) export PATH="$_altair_vega_launcher_path:$PATH" ;; esac
    fi
    unset _altair_vega_launcher_path
    unset -f _altair_vega_launcher
    return 0
  else
    unset _altair_vega_launcher_path
    unset -f _altair_vega_launcher
    return 1
  fi
fi
