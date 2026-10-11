#!/bin/sh
# sandbox-run.sh: run a command with macOS sandbox-exec so that it can write
# only to the paths that the caller allows. It limits writes. It does not hide reads.
#
# The script calls its helper commands (dscl, id, sed, tr, head, uname,
# dirname, basename, cat, sandbox-exec) by absolute path. It does not use PATH,
# so a fake command in PATH cannot turn off a check.
# SANDBOX_EXEC replaces the sandbox command. It is for TESTS ONLY and not for
# agents. An agent that sets SANDBOX_EXEC turns the sandbox off.

usage() {
  /bin/cat <<'USAGE'
Usage: sandbox-run.sh [--allow-write <path>]... [--allow-tmp] -- <command> [args...]

Run <command> in a macOS sandbox. The command can write only to the allowed
paths, /dev/null, /dev/tty, /dev/dtracehelper, /dev/stdout, /dev/stderr, and
/dev/fd/0, /dev/fd/1, /dev/fd/2. Reads are not limited.

Options:
  --allow-write <path>  Allow writes under <path>. The path must exist.
                        Repeat the option for more paths.
  --allow-tmp           Allow writes under the real paths of $TMPDIR and /private/tmp.
  --help                Show this text.

The runner refuses "/", the home directory, a parent of the home directory,
and a path that contains a double quote, a newline, or a backslash.
It checks both $HOME and the real home directory of the account. It refuses
before it starts <command>. It exits with status 2 for a refusal or a usage error.
It fails closed with exit status 127 if sandbox-exec is missing or the
system is not macOS. The sandbox command is /usr/bin/sandbox-exec.
SANDBOX_EXEC replaces it. That is for tests only. Agents must not set it.
Exit status 71 comes from sandbox-exec itself, for example inside another sandbox.
Otherwise the exit status is the exit status of <command>.
USAGE
}

fail() {
  echo "sandbox-run: $1" >&2
  exit "${2:-2}"
}

lower() {
  printf '%s' "$1" | /usr/bin/tr '[:upper:]' '[:lower:]'
}

NL='
'

# Collapse repeated slashes and remove trailing slashes. "//" becomes "/".
normalize() {
  p=$(printf '%s' "$1" | /usr/bin/sed 's#//*#/#g')
  while [ "$p" != "/" ] && [ "${p%/}" != "$p" ]; do p=${p%/}; done
  printf '%s' "$p"
}

# Print the normalized real path of an existing path. Return 1 if it does not exist.
real_path() {
  if [ -d "$1" ]; then
    out=$(cd "$1" 2>/dev/null && pwd -P) || return 1
    normalize "$out"
  elif [ -e "$1" ]; then
    dir=$(/usr/bin/dirname -- "$1")
    base=$(/usr/bin/basename -- "$1")
    resolved=$(cd "$dir" 2>/dev/null && pwd -P) || return 1
    resolved=$(normalize "$resolved")
    if [ "$resolved" = "/" ]; then printf '/%s' "$base"; else printf '%s/%s' "$resolved" "$base"; fi
  else
    return 1
  fi
}

# Print the home directory from the user database, not from $HOME.
account_home() {
  user=$(/usr/bin/id -un 2>/dev/null)
  case "$user" in
    "" | *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  found=$(/usr/bin/dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null | /usr/bin/sed -n 's/^NFSHomeDirectory:[[:space:]]*//p' | /usr/bin/head -n 1)
  if [ -z "$found" ]; then
    found=$(/usr/bin/dscacheutil -q user -a name "$user" 2>/dev/null | /usr/bin/sed -n 's/^dir:[[:space:]]*//p' | /usr/bin/head -n 1)
  fi
  case "$found" in
    "" | "~"*) return 1 ;;
  esac
  printf '%s' "$found"
}

reject_unsafe_chars() {
  case "$1" in
    *\"* | *\\* | *"$NL"*) fail "refused path with a double quote, a newline, or a backslash: $1" ;;
  esac
}

PROFILE_RULES=""
HOME_LIST=""
HOME_PATHS=""

# Return 0 if the path $1 is the same directory as $2 or a parent of $2.
# This test compares device and inode, so a different spelling of the same name does not pass.
same_or_parent() {
  anc=$2
  while :; do
    [ ! -e "$anc" ] || [ ! "$1" -ef "$anc" ] || return 0
    case "$anc" in
      "" | "/") return 1 ;;
      */*) anc=${anc%/*}; [ -n "$anc" ] || anc=/ ;;
      *) return 1 ;;
    esac
  done
}

# Check one path, then add a profile rule for it.
add_allowed() {
  raw=$1
  [ -n "$raw" ] || fail "refused an empty path"
  reject_unsafe_chars "$raw"
  real=$(real_path "$raw") || fail "refused a path that does not exist: $raw"
  [ -n "$real" ] || fail "refused a path that does not exist: $raw"
  reject_unsafe_chars "$real"
  raw_norm=$(normalize "$raw")
  real_lower=$(lower "$real")
  raw_lower=$(lower "$raw_norm")
  [ "$real" != "/" ] || fail "refused to allow writes to /"
  [ "$raw_norm" != "/" ] || fail "refused to allow writes to /"
  old_ifs=$IFS
  IFS=$NL
  for home_lower in $HOME_LIST; do
    for candidate in "$real_lower" "$raw_lower"; do
      case "$home_lower/" in
        "$candidate"/*) fail "refused the home directory or a parent of the home directory: $raw" ;;
      esac
    done
  done
  for home_path in $HOME_PATHS; do
    if same_or_parent "$real" "$home_path"; then
      IFS=$old_ifs
      fail "refused the home directory or a parent of the home directory: $raw"
    fi
  done
  IFS=$old_ifs
  if [ -d "$real" ]; then
    PROFILE_RULES="$PROFILE_RULES(allow file-write* (subpath \"$real\"))$NL"
  else
    PROFILE_RULES="$PROFILE_RULES(allow file-write* (literal \"$real\"))$NL"
  fi
}

# Show help if it comes before "--".
for arg in "$@"; do
  case "$arg" in
    --) break ;;
    --help | -h) usage; exit 0 ;;
  esac
done

# Fail closed before anything else.
SANDBOX_CMD=${SANDBOX_EXEC:-/usr/bin/sandbox-exec}
[ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "this system is not macOS. The command was not run." 127
command -v "$SANDBOX_CMD" >/dev/null 2>&1 || fail "$SANDBOX_CMD was not found. The command was not run." 127

[ -n "${HOME:-}" ] || fail "HOME is not set. Set HOME to a temporary directory."
ACCOUNT_HOME=$(account_home) || fail "cannot find the real home directory of the account. The command was not run."
# Home directories to protect: $HOME and the account home, each as given and as a real path.
# The list has one path on each line. A home path with a newline is refused.
for home_path in "$HOME" "$ACCOUNT_HOME"; do
  home_real=$(real_path "$home_path") || home_real=$home_path
  for entry in "$(normalize "$home_path")" "$home_real"; do
    case "$entry" in
      *"$NL"*) fail "the home directory has a newline. Use a simple path." ;;
    esac
    HOME_LIST="$HOME_LIST$(lower "$entry")$NL"
    HOME_PATHS="$HOME_PATHS$entry$NL"
  done
done

ALLOW_TMP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-write)
      [ $# -ge 2 ] || fail "--allow-write needs a path"
      add_allowed "$2"
      shift 2
      ;;
    --allow-tmp) ALLOW_TMP=1; shift ;;
    --) shift; break ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done
[ $# -gt 0 ] || { usage >&2; fail "no command after --"; }

if [ "$ALLOW_TMP" = "1" ]; then
  [ -z "${TMPDIR:-}" ] || [ ! -d "$TMPDIR" ] || add_allowed "$TMPDIR"
  add_allowed /private/tmp
fi

PROFILE="(version 1)$NL(allow default)$NL(deny file-write*)$NL$PROFILE_RULES(allow file-write* (literal \"/dev/null\") (literal \"/dev/tty\") (literal \"/dev/dtracehelper\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") (literal \"/dev/fd/0\") (literal \"/dev/fd/1\") (literal \"/dev/fd/2\"))"

exec "$SANDBOX_CMD" -p "$PROFILE" "$@"
