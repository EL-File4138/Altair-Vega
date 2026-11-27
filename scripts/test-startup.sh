#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
launcher="$repo_root/scripts/startup.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/altair-vega-launcher-test.XXXXXX")
work=$(CDPATH= cd -P -- "$work" && pwd)
trap 'rm -rf "$work"' EXIT HUP INT TERM
XDG_CACHE_HOME="$work/fallback"
export XDG_CACHE_HOME
mkdir -m 700 "$XDG_CACHE_HOME"

mkdir -p "$work/probe"
cat >"$work/stub.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$0" >>"$1/executables"
printf '%s\n' "${ALTAIR_VEGA_RUNTIME_ROOT:-}" >>"$1/runtime-roots"
printf '%s\n' "${TMPDIR:-}" >>"$1/tmpdirs"
EOF
chmod 700 "$work/stub.sh"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$work/stub.sh" >"$work/stub.sh.sha256"
else
  shasum -a 256 "$work/stub.sh" >"$work/stub.sh.sha256"
fi
cp "$work/stub.sh" "$work/stub.original"

sh -n "$launcher"
! grep -q 'Register-EngineEvent' "$repo_root/scripts/startup.ps1"
! grep -q '\$env:TMPDIR =' "$repo_root/scripts/startup.ps1"
sh "$launcher" --url "file://$work/stub.sh" --runtime-parent "$work/cache" -- "$work/probe"
printf '#!/bin/sh\nexit 99\n' >"$work/stub.sh"
sh "$launcher" --url "file://$work/stub.sh" --runtime-parent "$work/cache" -- "$work/probe"

first_executable=$(sed -n '1p' "$work/probe/executables")
second_executable=$(sed -n '2p' "$work/probe/executables")
[ "$first_executable" = "$second_executable" ]
[ -f "$first_executable" ]
[ -d "$(sed -n '1p' "$work/probe/runtime-roots")" ]

# A wrapper already on PATH verifies the binary again, not just at preparation.
cp "$first_executable" "$work/cached.original"
printf '#!/bin/sh\nexit 0\n' >"$first_executable"
if "${first_executable%/*}/bin/altair-vega" "$work/probe"; then
  printf 'wrapper ran a modified cached executable\n' >&2; exit 1
fi
cp "$work/cached.original" "$first_executable"

cp "$work/stub.original" "$work/stub.sh"
chmod 700 "$work/stub.sh"
sh "$launcher" --url "file://$work/stub.sh" --runtime-parent "$work/concurrent-cache" -- "$work/probe" &
first_pid=$!
sh "$launcher" --url "file://$work/stub.sh" --runtime-parent "$work/concurrent-cache" -- "$work/probe" &
second_pid=$!
wait "$first_pid"
wait "$second_pid"

sh -ec '
  before=${TMPDIR-}
  shell_options_before=$(set -o)
  launcher=$1 probe=$4
  set -- --url "$2" --runtime-parent "$3"
  . "$launcher"
  [ "${TMPDIR-}" = "$before" ]
  [ "$(set -o)" = "$shell_options_before" ]
  altair-vega "$probe"
' sh "$launcher" "file://$work/stub.sh" "$work/cache" "$work/probe"

printf '%064d\n' 0 >"$work/invalid.sha256"
if sh "$launcher" --url "file://$work/stub.sh" --checksum-url "file://$work/invalid.sha256" --runtime-parent "$work/invalid-cache" -- "$work/probe"; then
  printf 'expected checksum verification to fail\n' >&2
  exit 1
fi

# A new pin or checksum source must not silently reuse an old policy's cache.
if ALTAIR_VEGA_BIN_SHA256=$(printf '%064d' 0) sh "$launcher" --url "file://$work/stub.sh" --runtime-parent "$work/cache" -- "$work/probe"; then
  printf 'cached executable bypassed explicit pin\n' >&2; exit 1
fi
if sh "$launcher" --url "file://$work/stub.sh" --checksum-url "file://$work/invalid.sha256" --runtime-parent "$work/cache" -- "$work/probe"; then
  printf 'cached executable bypassed changed checksum source\n' >&2; exit 1
fi

# Sourcing must preserve caller variables, functions, options, traps and env.
bash -c '
  binary_url=sentinel; cache_root=sentinel; sourced=sentinel
  fail() { printf sentinel; }
  before_traps=$(trap -p)
  before_options=$(set +o)
  . "$1" --url "$2" --runtime-parent "$3"
  [ "$binary_url:$cache_root:$sourced" = sentinel:sentinel:sentinel ]
  [ "$(fail)" = sentinel ]
  [ "$(trap -p)" = "$before_traps" ]
  [ "$(set +o)" = "$before_options" ]
  if . "$1" --url; then exit 1; fi
' bash "$launcher" "file://$work/stub.sh" "$work/cache"

# Source-in-an-if disables errexit in many shells. Publication failures still
# must propagate explicitly and must not advertise a successful PATH setup.
mkdir "$work/failing-tools"
printf '#!/bin/sh\nexit 1\n' >"$work/failing-tools/mv"
chmod 700 "$work/failing-tools/mv"
PATH="$work/failing-tools:$PATH" bash -c '
  before=$PATH
  if . "$1" --url "$2" --runtime-parent "$3"; then exit 1; fi
  [ "$PATH" = "$before" ]
' bash "$launcher" "file://$work/stub.sh" "$work/cache"

# Reject an existing symlink or non-private cache without executing a probe.
scope_root=$(dirname "$(sed -n '1p' "$work/probe/runtime-roots")")
mkdir -m 700 "$work/unsafe-parent" "$work/foreign"
ln -s "$work/foreign" "$work/unsafe-parent/${scope_root##*/}"
if XDG_CACHE_HOME="$work/unsafe-parent" sh "$launcher" --url "file://$work/stub.sh" --runtime-parent "$work/unsafe-parent" -- "$work/probe"; then
  printf 'symlink cache was accepted\n' >&2; exit 1
fi
[ -z "$(ls -A "$work/foreign")" ]

# Separate verification policies retain separate wrappers; no URL redirects an
# already-sourced shell. Two sourced subshells also share $$ but use kernel locks.
cp "$work/stub.sh" "$work/other.sh"
cp "$work/stub.sh.sha256" "$work/other.sh.sha256"
bash -c '. "$1" --url "$2" --runtime-parent "$3"; altair-vega "$4"' bash "$launcher" "file://$work/stub.sh" "$work/concurrent-cache" "$work/probe" &
first_pid=$!
bash -c '. "$1" --url "$2" --runtime-parent "$3"; altair-vega "$4"' bash "$launcher" "file://$work/other.sh" "$work/concurrent-cache" "$work/probe" &
second_pid=$!
wait "$first_pid"; wait "$second_pid"

# Published curl | sh -s forms must execute, including dash (whose return test
# alone incorrectly claims every executed script is sourced).
cat "$launcher" | sh -s -- --url "file://$work/stub.sh" --runtime-parent "$work/cache" -- "$work/probe"
if command -v dash >/dev/null 2>&1; then
  cat "$launcher" | dash -s -- --url "file://$work/stub.sh" --runtime-parent "$work/cache" -- "$work/probe"
fi

# A failed or malformed stdin hash must not produce an empty policy directory.
mkdir "$work/hash-tools"
printf '#!/bin/sh\nexit 1\n' >"$work/hash-tools/sha256sum"
chmod 700 "$work/hash-tools/sha256sum"
if PATH="$work/hash-tools:$PATH" sh "$launcher" --url "file://$work/stub.sh" --runtime-parent "$work/hash-cache" -- "$work/probe"; then
  printf 'launcher ignored hash failure\n' >&2; exit 1
fi
printf '#!/bin/sh\nprintf malformed\\n\n' >"$work/hash-tools/sha256sum"
if PATH="$work/hash-tools:$PATH" sh "$launcher" --url "file://$work/stub.sh" --runtime-parent "$work/hash-cache" -- "$work/probe"; then
  printf 'launcher accepted malformed policy hash\n' >&2; exit 1
fi

# Resolve intermediate symlinks once. Retargeting the original spelling after
# validation must not redirect subsequent executable publication or execution.
mkdir -m 700 "$work/first-parent" "$work/second-parent" "$work/aliases" "$work/retarget-tools"
ln -s "$work/first-parent" "$work/aliases/selected"
if command -v sha256sum >/dev/null 2>&1; then
  real_hash=$(command -v sha256sum)
  hash_args=
else
  real_hash=$(command -v shasum)
  hash_args='-a 256'
fi
cat >"$work/retarget-tools/sha256sum" <<EOF
#!/bin/sh
if [ "\$#" -eq 0 ]; then
  rm -f "$work/aliases/selected"
  ln -s "$work/second-parent" "$work/aliases/selected"
fi
exec "$real_hash" $hash_args "\$@"
EOF
chmod 700 "$work/retarget-tools/sha256sum"
PATH="$work/retarget-tools:$PATH" sh "$launcher" --url "file://$work/stub.sh" --runtime-parent "$work/aliases/selected/cache" -- "$work/probe"
case "$(tail -n 1 "$work/probe/executables")" in "$work/first-parent/cache/"*) ;; *) exit 1 ;; esac
[ -z "$(ls -A "$work/second-parent")" ]

# Kernel locks are released even if the owner is killed without any trap.
# Synchronize through a FIFO so this does not depend on scheduling or sleeps.
if command -v flock >/dev/null 2>&1; then
  mkfifo "$work/lock-ready"
  sh -c 'exec 9>"$1"; flock 9; printf ready >"$2"; exec sleep 60' sh "$scope_root/.lock" "$work/lock-ready" &
  lock_owner=$!
  cat "$work/lock-ready" >/dev/null
  kill -KILL "$lock_owner"
  wait "$lock_owner" 2>/dev/null || true
  "${first_executable%/*}/bin/altair-vega" "$work/probe"
fi

# Busy scopes are refused; previous-boot scopes are covered explicitly.
mkdir -m 700 "$work/cache/altair-vega-launcher-$(id -u)-boot-old"
LC_ALL=C ps -o lstart= -p "$$" >"$scope_root/leases/$$"
if sh "$launcher" --runtime-parent "$work/cache" --cleanup; then
  printf 'cleanup removed a live lease\n' >&2; exit 1
fi
[ -f "$first_executable" ]
rm "$scope_root/leases/$$"

# A recycled PID or a previous boot must not make an inactive cache immortal.
printf 'different process instance\n' >"$scope_root/leases/$$"
mkdir -m 700 "$work/cache/altair-vega-launcher-$(id -u)-boot-old/leases"
LC_ALL=C ps -o lstart= -p "$$" >"$work/cache/altair-vega-launcher-$(id -u)-boot-old/leases/$$"

sh "$launcher" --runtime-parent "$work/cache" --cleanup
[ ! -e "$first_executable" ]
[ ! -e "$work/cache/altair-vega-launcher-$(id -u)-boot-old" ]

printf 'startup launcher tests passed\n'
