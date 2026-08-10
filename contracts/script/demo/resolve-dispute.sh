#!/usr/bin/env bash
#
# The final step of demo run 2, and the one piece of the flow with no other caller anywhere
# in the repo: the arbiter resolving a disputed job. agent.mts ends its dispute run by
# printing "Awaiting arbiter resolution via resolveDispute()" and exiting — this is what
# actually does it.
#
# MVP dispute resolution is a single arbiter address (the deployer wallet), disclosed as
# centralized-for-now in the README. That is exactly why this is a hand-run script and not
# an automated backend route: a human decides, then signs.
#
# Usage:  ./resolve-dispute.sh <jobId> [--seller-at-fault | --seller-cleared]
#
# --seller-at-fault (the demo-run-2 path) slashes the seller's reserved bond to the buyer
# AND refunds the escrowed principal — two separate payments, which is the whole mechanic
# Tripwire exists to demonstrate.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require_env DEPLOYER_PRIVATE_KEY DEPLOYER_ADDRESS

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <jobId> [--seller-at-fault | --seller-cleared]" >&2
  exit 1
fi

JOB_ID="$1"
VERDICT="${2:---seller-at-fault}"

case "$VERDICT" in
  --seller-at-fault) SELLER_AT_FAULT=true  ;;
  --seller-cleared)  SELLER_AT_FAULT=false ;;
  *) echo "Unknown verdict '$VERDICT' — use --seller-at-fault or --seller-cleared" >&2; exit 1 ;;
esac

# Read the job before touching anything: this both sanity-checks that the job is actually
# Disputed (resolveDispute reverts otherwise) and captures the before-state that makes the
# after-state meaningful on a recording.
step "Job $JOB_ID before resolution"
job_raw="$(cast call "$JOB_ESCROW_ADDRESS" \
  "jobs(uint256)(address,uint256,address,uint256,uint256,uint64,uint64,uint8,bytes32,bytes32)" \
  "$JOB_ID" --rpc-url "$RPC_URL")"

# cast prints one decoded return value per line, in the struct's declaration order.
buyer="$(echo "$job_raw"      | sed -n '1p')"
seller_payout="$(echo "$job_raw" | sed -n '3p')"
amount="$(echo "$job_raw"     | sed -n '4p' | awk '{print $1}')"
reserved_bond="$(echo "$job_raw" | sed -n '5p' | awk '{print $1}')"
status="$(echo "$job_raw"     | sed -n '8p')"

info "buyer         : $buyer"
info "seller payout : $seller_payout"
info "escrowed      : $(format_usdc "$amount") USDC"
info "reserved bond : $(format_usdc "$reserved_bond") USDC"
info "status        : $status (3 = Disputed)"

if [[ "$status" != "3" ]]; then
  echo "Job $JOB_ID is not Disputed (status $status) — resolveDispute would revert." >&2
  exit 1
fi

buyer_before="$(usdc_balance_of "$buyer")"
seller_before="$(usdc_balance_of "$seller_payout")"
bond_before="$(bond_of)"
# Gross posted bond, not just free bond. A slash drops gross and reserved by the same
# amount, so *free* bond comes out unchanged — reporting only free would hide the very
# thing this demo exists to show. Gross is the number that actually falls.
gross_before="$(cast call "$SELLER_BOND_ADDRESS" "bondBalance(uint256)(uint256)" "$SELLER_AGENT_ID" --rpc-url "$RPC_URL" | awk '{print $1}')"

step "Arbiter resolving: sellerAtFault=$SELLER_AT_FAULT"
info "arbiter wallet: $DEPLOYER_ADDRESS"
send_tx "resolveDispute($JOB_ID, $SELLER_AT_FAULT)" \
  "$JOB_ESCROW_ADDRESS" "resolveDispute(uint256,bool)" "$JOB_ID" "$SELLER_AT_FAULT" \
  --private-key "$DEPLOYER_PRIVATE_KEY" > /dev/null

# The point of the whole demo: show the money actually moved, and in which direction.
step "Balance changes"
buyer_after="$(usdc_balance_of "$buyer")"
seller_after="$(usdc_balance_of "$seller_payout")"
bond_after="$(bond_of)"
gross_after="$(cast call "$SELLER_BOND_ADDRESS" "bondBalance(uint256)(uint256)" "$SELLER_AGENT_ID" --rpc-url "$RPC_URL" | awk '{print $1}')"

info "buyer wallet    : $(format_usdc "$buyer_before") -> $(format_usdc "$buyer_after") USDC"
info "seller wallet   : $(format_usdc "$seller_before") -> $(format_usdc "$seller_after") USDC"
info "bond (gross)    : $(format_usdc "$gross_before") -> $(format_usdc "$gross_after") USDC"
info "bond (free)     : $(format_usdc "$bond_before") -> $(format_usdc "$bond_after") USDC"

if [[ "$SELLER_AT_FAULT" == "true" ]]; then
  info ""
  info "Seller at fault: the buyer received TWO payments — the slashed bond straight from"
  info "SellerBond, plus the escrowed principal refunded from JobEscrow. The seller's gross"
  info "bond balance is permanently reduced, not merely unreserved."
else
  info ""
  info "Seller cleared: paid exactly as if the buyer had called release(), and the bond"
  info "reservation was freed rather than slashed."
fi

info ""
info "escrow  : $EXPLORER_BASE/address/$JOB_ESCROW_ADDRESS"
info "bond    : $EXPLORER_BASE/address/$SELLER_BOND_ADDRESS"
