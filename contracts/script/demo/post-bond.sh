#!/usr/bin/env bash
#
# Step 1 of both demo runs: the seller posts slashable USDC stake against their ERC-8004
# agent id. Nothing else in the system works until this exists — JobEscrow.createJob calls
# SellerBond.reserve, which reverts against a zero balance, so every job creation fails
# until a bond is posted.
#
# Usage:  ./post-bond.sh [amount-in-usdc]     (default: 0.05)
#
# Sizing: reservedBond is minBondRatioBps (20%) of the job amount, so the priciest demo
# endpoint ($0.03) reserves $0.006. 0.05 USDC covers every demo job several times over
# while leaving the seller's thin faucet balance intact for gas.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require_env SELLER_PRIVATE_KEY SELLER_ADDRESS

BOND_USDC="${1:-0.05}"
# parseUnits equivalent: 6-decimal USDC atomic units.
BOND_AMOUNT="$(cast --to-wei "$BOND_USDC" mwei)"

step "Posting seller bond"
info "seller wallet : $SELLER_ADDRESS"
info "agent id      : $SELLER_AGENT_ID"
info "amount        : $BOND_USDC USDC ($BOND_AMOUNT atomic units)"

wallet_balance="$(usdc_balance_of "$SELLER_ADDRESS")"
info "wallet balance: $(format_usdc "$wallet_balance") USDC"
# Gas on Arc is paid in USDC out of this same balance, so a bond that consumes the entire
# wallet would leave nothing to pay for the deposit transaction itself. Fail early with a
# clear message rather than mid-sequence with an out-of-funds revert.
if [[ "$(echo "$wallet_balance < $BOND_AMOUNT" | bc)" -eq 1 ]]; then
  echo "Seller wallet holds less USDC than the requested bond — fund it at faucet.circle.com" >&2
  exit 1
fi

step "Approving SellerBond to pull the stake"
# ERC-20 pull-payment: the bond contract spends an allowance the seller grants first.
send_tx "approve($SELLER_BOND_ADDRESS, $BOND_AMOUNT)" \
  "$USDC_ADDRESS" "approve(address,uint256)" "$SELLER_BOND_ADDRESS" "$BOND_AMOUNT" \
  --private-key "$SELLER_PRIVATE_KEY" > /dev/null

step "Depositing the bond"
send_tx "deposit($SELLER_AGENT_ID, $BOND_AMOUNT)" \
  "$SELLER_BOND_ADDRESS" "deposit(uint256,uint256)" "$SELLER_AGENT_ID" "$BOND_AMOUNT" \
  --private-key "$SELLER_PRIVATE_KEY" > /dev/null

step "Result"
info "free bond now : $(format_usdc "$(bond_of)") USDC"
info "explorer      : $EXPLORER_BASE/address/$SELLER_BOND_ADDRESS"
