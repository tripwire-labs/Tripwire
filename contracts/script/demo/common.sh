#!/usr/bin/env bash
#
# Shared setup for the demo scripts. Sourced, never run directly.
#
# The two demo runs need keys that live in two different gitignored env files: the seller's
# and buyer's keys belong to the backend app (arc-nanopayments/.env.local), while the
# arbiter/owner key belongs to the contracts side (contracts/.env). Rather than duplicating
# either secret into the other file, this sources both and exposes one consistent set of
# names to every script.

set -euo pipefail

# Resolve paths relative to this file, not the caller's working directory, so the scripts
# work whether invoked from the repo root, contracts/, or script/demo/ itself.
DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../../.." && pwd)"

CONTRACTS_ENV="$REPO_ROOT/contracts/.env"
BACKEND_ENV="$REPO_ROOT/arc-nanopayments/.env.local"

# `set -a` marks everything defined while it's active for export, which is how a plain
# KEY=value file becomes environment variables without writing an explicit export per line.
load_env_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "Missing required env file: $file" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090  # path is computed at runtime; shellcheck can't follow it
  source "$file"
  set +a
}

load_env_file "$CONTRACTS_ENV"
load_env_file "$BACKEND_ENV"

RPC_URL="${RPC_URL:-https://rpc.testnet.arc.network}"
# Arc's native USDC. Not an env var because it's a fixed protocol address like the RPC URL,
# not one of Tripwire's own deployments — same reasoning lib/validationRegistry.ts uses for
# the Validation Registry address.
USDC_ADDRESS="0x3600000000000000000000000000000000000000"
EXPLORER_BASE="https://testnet.arcscan.app"

# Fail loudly at startup if any required name is missing, rather than letting `cast` fail
# later with an opaque error about an empty argument.
require_env() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      echo "Required env var $name is not set (checked $CONTRACTS_ENV and $BACKEND_ENV)" >&2
      exit 1
    fi
  done
}

require_env JOB_ESCROW_ADDRESS SELLER_BOND_ADDRESS SELLER_AGENT_ID

# --- small output helpers, so every script's terminal output reads the same on a recording ---

# All human-facing output goes to stderr, not stdout. Several helpers below return a value
# by echoing it (send_tx returns a tx hash), and callers capture that with $(...) or discard
# it with >/dev/null — either of which would also swallow the narration if it shared stdout.
# Keeping the two streams separate means the explorer links always reach the terminal, which
# is the entire point of running these on a recording.
step()  { printf '\n\033[1m==> %s\033[0m\n' "$*" >&2; }
info()  { printf '    %s\n' "$*" >&2; }
tx_link() { printf '    tx: %s/tx/%s\n' "$EXPLORER_BASE" "$1" >&2; }

# USDC has 6 decimals; cast's --to-unit understands that as "mwei" (10^6), which saves
# hand-rolling decimal formatting in bash.
format_usdc() { cast --to-unit "$1" mwei; }

usdc_balance_of() {
  cast call "$USDC_ADDRESS" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC_URL" | awk '{print $1}'
}

bond_of() {
  cast call "$SELLER_BOND_ADDRESS" "bondOf(uint256)(uint256)" "$SELLER_AGENT_ID" --rpc-url "$RPC_URL" | awk '{print $1}'
}

# Sends a transaction and prints its hash plus an explorer link. Uses --json so the hash is
# parsed out of structured output rather than scraped from cast's human-readable table.
send_tx() {
  local description="$1"
  shift
  info "$description"
  local hash
  # head -1 matters: a receipt's JSON repeats transactionHash inside every emitted log, so
  # an unfiltered grep returns one line per event and the "hash" becomes a multi-line blob.
  hash="$(cast send "$@" --rpc-url "$RPC_URL" --json | grep -o '"transactionHash":"[^"]*"' | head -1 | cut -d'"' -f4)"
  tx_link "$hash"
  echo "$hash"
}
