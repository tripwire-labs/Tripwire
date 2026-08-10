#!/usr/bin/env bash
#
# Read-only snapshot of the deployed system: wiring, risk parameters, seller bond, and
# either one job or the most recent few. Sends no transactions and costs nothing, so it is
# safe to run at any point mid-recording to show state between steps.
#
# Usage:  ./status.sh [jobId]

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Human-readable names for JobEscrow.JobStatus — must stay in sync with the Solidity enum
# (contracts/src/JobEscrow.sol), same constraint lib/jobEscrow.ts's JobStatus map carries.
status_name() {
  case "$1" in
    0) echo "None (does not exist)" ;;
    1) echo "Active" ;;
    2) echo "Released" ;;
    3) echo "Disputed" ;;
    4) echo "Resolved" ;;
    5) echo "TimedOut" ;;
    *) echo "unknown ($1)" ;;
  esac
}

call_escrow() { cast call "$JOB_ESCROW_ADDRESS" "$@" --rpc-url "$RPC_URL" | awk '{print $1}'; }

step "Deployment"
info "JobEscrow  : $JOB_ESCROW_ADDRESS"
info "SellerBond : $SELLER_BOND_ADDRESS"
# Confirms the two-step deploy's setSellerBond() wiring actually took — createJob reverts
# with SellerBondNotSet if this is the zero address.
info "escrow.sellerBond() -> $(call_escrow 'sellerBond()(address)')"
info "escrow.ARBITER()    -> $(call_escrow 'ARBITER()(address)')"

step "Risk parameters"
info "minBondRatioBps          : $(call_escrow 'minBondRatioBps()(uint256)') (2000 = 20%)"
info "responseWindow           : $(call_escrow 'responseWindow()(uint64)') seconds"
info "validationRegistryEnabled: $(call_escrow 'validationRegistryEnabled()(bool)')"

step "Seller bond (agent $SELLER_AGENT_ID)"
gross="$(cast call "$SELLER_BOND_ADDRESS" "bondBalance(uint256)(uint256)" "$SELLER_AGENT_ID" --rpc-url "$RPC_URL" | awk '{print $1}')"
locked="$(cast call "$SELLER_BOND_ADDRESS" "reserved(uint256)(uint256)" "$SELLER_AGENT_ID" --rpc-url "$RPC_URL" | awk '{print $1}')"
info "gross posted : $(format_usdc "$gross") USDC"
info "reserved     : $(format_usdc "$locked") USDC"
info "free         : $(format_usdc "$(bond_of)") USDC"

next_job_id="$(call_escrow 'nextJobId()(uint256)')"
step "Jobs (nextJobId = $next_job_id)"

if [[ "$next_job_id" == "0" ]]; then
  info "No jobs created yet."
  exit 0
fi

# With no argument, show the last three jobs — enough to see a demo run's history without
# paging through everything once the contract has been used for a while.
if [[ $# -ge 1 ]]; then
  job_ids=("$1")
else
  job_ids=()
  for (( id = next_job_id - 1; id >= 0 && ${#job_ids[@]} < 3; id-- )); do
    job_ids+=("$id")
  done
fi

for job_id in "${job_ids[@]}"; do
  job_raw="$(cast call "$JOB_ESCROW_ADDRESS" \
    "jobs(uint256)(address,uint256,address,uint256,uint256,uint64,uint64,uint8,bytes32,bytes32)" \
    "$job_id" --rpc-url "$RPC_URL")"

  info ""
  info "job $job_id"
  info "  buyer         : $(echo "$job_raw" | sed -n '1p')"
  info "  seller agent  : $(echo "$job_raw" | sed -n '2p' | awk '{print $1}')"
  info "  amount        : $(format_usdc "$(echo "$job_raw" | sed -n '4p' | awk '{print $1}')") USDC"
  info "  reserved bond : $(format_usdc "$(echo "$job_raw" | sed -n '5p' | awk '{print $1}')") USDC"
  info "  status        : $(status_name "$(echo "$job_raw" | sed -n '8p')")"
done
