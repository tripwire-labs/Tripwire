/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { getJob, JobStatus, recoverJobIdSigner } from "./jobEscrow";
import { checkRateLimit, clientIpFrom } from "./rateLimit";
import { registerValidationRequest } from "./validationRegistry";
import type { SellerArchetype } from "./live/config";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Fails loudly at module load rather than silently defaulting to 0n — a misconfigured
// SELLER_AGENT_ID should be an obvious startup error, not a confusing "wrong seller"
// rejection on every request once real jobs start hitting it.
const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const rawJobEscrowAddress = process.env.JOB_ESCROW_ADDRESS;
if (rawJobEscrowAddress && !HEX_ADDRESS_RE.test(rawJobEscrowAddress)) {
  throw new Error(`JOB_ESCROW_ADDRESS is not a valid address: ${rawJobEscrowAddress}`);
}
const JOB_ESCROW_ADDRESS = rawJobEscrowAddress as `0x${string}` | undefined;

/** Parses a "$0.001"-style price string into USDC atomic units (6 decimals). */
function priceToAtomicUnits(price: string): bigint {
  return BigInt(Math.round(parseFloat(price.replace("$", "")) * 1_000_000));
}

/**
 * A fresh, globally-unique requestHash for one 402 response. The randomUUID is what
 * actually guarantees uniqueness — required both by the real registry (a second
 * validationRequest for an already-used hash reverts) and by JobEscrow's own
 * one-hash-one-job rule. The sellerAgentId/endpoint prefix carries no security meaning
 * (endpoint-binding is deliberately not enforced yet); it's purely so this hash reads as
 * something in logs instead of opaque bytes.
 */
function generateRequestHash(sellerAgentId: bigint, endpoint: string): `0x${string}` {
  return keccak256(toBytes(`${sellerAgentId}-${endpoint}-${randomUUID()}`));
}

/**
 * Wraps a Next.js route handler with JobEscrow settlement verification.
 *
 * Two-step flow, same shape x402 always had, but "payment" is now an on-chain
 * escrowed job instead of a signed Circle Gateway authorization:
 *
 *  1. No jobId presented -> 402 with what's needed to call JobEscrow.createJob()
 *     (price, sellerAgentId, requestHash, jobEscrowAddress). Plain JSON body, not the
 *     old base64 PAYMENT-REQUIRED header — that encoding existed to satisfy x402's
 *     signed-payload convention, which doesn't apply to a read-only job lookup.
 *  2. jobId presented (`x-job-id` header) -> read-only view call to JobEscrow.jobs(jobId)
 *     confirms status is Active and the seller/amount actually match this resource, and
 *     an `x-job-signature` proves the caller actually controls job.buyer — status/
 *     seller/amount alone only prove *some* valid job exists, not that this caller is
 *     the one who paid for it (jobIds are sequential and freely readable, so without
 *     this a job's content could be redeemed by anyone who saw or guessed its id, not
 *     just its buyer). Only then does the real handler run.
 */
export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
  options: { sellerAgentId: bigint; archetype: SellerArchetype },
) {
  const expectedAmount = priceToAtomicUnits(price);
  const { sellerAgentId, archetype } = options;

  return async (req: NextRequest) => {
    if (!JOB_ESCROW_ADDRESS) {
      return NextResponse.json({ error: "JOB_ESCROW_ADDRESS not configured" }, { status: 500 });
    }

    const jobIdHeader = req.headers.get("x-job-id");

    // No jobId yet — buyer hasn't created a job. Register a real validation request
    // naming JobEscrow as validator, then tell them what to create one against.
    if (!jobIdHeader) {
      // Rate-limited BEFORE the registry call, not after: registering a validation request
      // sends a real transaction paid for in USDC from the seller's wallet, so an
      // unauthenticated caller could otherwise drain that wallet with a curl loop. See
      // lib/rateLimit.ts for the full reasoning and the MVP caveats.
      const ip = clientIpFrom(req.headers);
      const limit = checkRateLimit(ip);
      if (!limit.allowed) {
        console.warn(`[escrow] rate-limited 402 for ${endpoint} from ${ip} (${limit.reason})`);
        return NextResponse.json(
          { error: "Too many quote requests — each one costs the seller an on-chain transaction." },
          { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
        );
      }

      console.log(`[escrow] 402 Job Required: ${endpoint}`);

      const requestHash = generateRequestHash(sellerAgentId, endpoint);
      let validationTxHash: `0x${string}`;
      try {
        validationTxHash = await registerValidationRequest({
          validatorAddress: JOB_ESCROW_ADDRESS,
          agentId: sellerAgentId,
          requestURI: endpoint,
          requestHash,
        });
      } catch (err) {
        console.error(
          `Failed to register validation request for ${endpoint}:`,
          err instanceof Error ? err.message : err,
        );
        return NextResponse.json({ error: "Failed to register validation request" }, { status: 500 });
      }

      return NextResponse.json(
        {
          price,
          sellerAgentId: sellerAgentId.toString(),
          requestHash,
          jobEscrowAddress: JOB_ESCROW_ADDRESS,
          validationTxHash,
        },
        { status: 402 },
      );
    }

    let jobId: bigint;
    try {
      jobId = BigInt(jobIdHeader);
    } catch {
      return NextResponse.json({ error: "x-job-id must be a valid integer" }, { status: 400 });
    }
    // BigInt("-1") parses without throwing, but a negative value can't be ABI-encoded
    // as the uint256 `jobs()` expects — catch it here with a clear 400 instead of
    // letting it fail deep inside the RPC call below.
    if (jobId < BigInt(0)) {
      return NextResponse.json({ error: "x-job-id must not be negative" }, { status: 400 });
    }

    const jobSignature = req.headers.get("x-job-signature");
    if (!jobSignature) {
      return NextResponse.json(
        { error: "x-job-signature is required — sign the jobId to prove you're its buyer" },
        { status: 401 },
      );
    }

    let job;
    try {
      job = await getJob(JOB_ESCROW_ADDRESS, jobId);
    } catch (err) {
      console.error(`Failed to read job ${jobId}:`, err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "Failed to look up job" }, { status: 500 });
    }

    if (job.status === JobStatus.None) {
      return NextResponse.json({ error: `Job ${jobId} does not exist` }, { status: 400 });
    }
    if (job.status !== JobStatus.Active) {
      return NextResponse.json({ error: `Job ${jobId} is not Active (status: ${job.status})` }, { status: 400 });
    }

    let signer: `0x${string}`;
    try {
      signer = await recoverJobIdSigner(JOB_ESCROW_ADDRESS, jobId, jobSignature as `0x${string}`);
    } catch {
      return NextResponse.json({ error: "x-job-signature is not a valid signature" }, { status: 400 });
    }
    if (signer.toLowerCase() !== job.buyer.toLowerCase()) {
      return NextResponse.json({ error: `x-job-signature was not signed by job ${jobId}'s buyer` }, { status: 401 });
    }

    if (job.sellerAgentId !== sellerAgentId) {
      return NextResponse.json({ error: `Job ${jobId} was not created for this seller` }, { status: 400 });
    }
    // Known limitation, deliberately deferred (see plans/08-disclosures.md): this only
    // checks seller + amount, not which endpoint the job was quoted for. Today the four
    // routes happen to have distinct prices, so this can't be exploited by accident, but
    // nothing stops a job created against one endpoint's price from being replayed
    // against a different endpoint charging the same amount. requestHash is real now
    // (see generateRequestHash/registerValidationRequest above) but deliberately isn't
    // endpoint-bound — closing that gap means encoding endpoint identity into the
    // registry's requestURI and checking it back here, decided against for now given
    // the timeline.
    if (job.amount !== expectedAmount) {
      return NextResponse.json(
        { error: `Job ${jobId} amount (${job.amount}) does not match the quoted price (${expectedAmount})` },
        { status: 400 },
      );
    }

    // The absent archetype represents a seller that never delivers. It must fail before the
    // delivery slot is claimed, otherwise Supabase would falsely say content arrived.
    if (archetype === "absent") {
      return NextResponse.json(
        { error: "The seller did not return a delivery before the request timed out." },
        { status: 504 },
      );
    }

    // One delivery per job, enforced by the primary key on job_deliveries rather than by a
    // read-then-write check here — two concurrent requests for the same jobId would both
    // pass a read-then-write check, and only the database can serialize them.
    //
    // This has to happen BEFORE the handler runs. A job stays Active until the buyer calls
    // release(), so without this the same jobId and signature could be replayed
    // indefinitely: one payment, unlimited copies of the paid content, with the buyer's
    // rational move being to never release at all. The tradeoff of claiming the slot first
    // is that a handler which throws afterwards burns the delivery; that is the right way
    // round for paid content, and these handlers are pure local computation with no
    // external calls to fail on.
    // Scope the delivery key to the escrow deployment. Job ids restart at zero after a
    // redeploy, and historical Supabase rows are intentionally retained; a bare job id
    // would let an old deployment's row block a current job with a false 409.
    const deliveryKey = `${JOB_ESCROW_ADDRESS.toLowerCase()}:${jobId}`;
    const { error: deliveryError } = await supabase.from("job_deliveries").insert({
      job_id: deliveryKey,
      endpoint,
      buyer: job.buyer,
    });
    if (deliveryError) {
      // 23505 is Postgres' unique_violation — the job was already delivered.
      if (deliveryError.code === "23505") {
        console.warn(`[escrow] replay rejected: job ${deliveryKey} was already delivered`);
        return NextResponse.json(
          { error: `Job ${jobId} has already been delivered — each job pays for one delivery.` },
          { status: 409 },
        );
      }
      // Any other database failure is a real outage. Fail closed: delivering anyway would
      // silently reopen the unlimited-replay hole this check exists to close.
      console.error("Failed to claim delivery slot:", deliveryError.message);
      return NextResponse.json({ error: "Failed to record delivery" }, { status: 500 });
    }

    try {
      // Record the job as settled in the same store the old settlement events used, so
      // the existing realtime dashboard keeps working off escrow jobs instead of Gateway
      // settlements. Unlike the delivery claim above, a failure here must never block a
      // delivery the buyer has already legitimately paid and authenticated for — this is
      // dashboard telemetry, not an authorization check.
      const { error } = await supabase.from("payment_events").insert({
        endpoint,
        payer: job.buyer,
        amount_usdc: (Number(job.amount) / 1e6).toString(),
        network: "arc-testnet",
        gateway_tx: null,
        raw: { jobId: jobId.toString(), sellerAgentId: job.sellerAgentId.toString() },
      });
      if (error) {
        console.error("Failed to record payment event:", error.message);
      }
    } catch (err) {
      console.error("Failed to record payment event:", err instanceof Error ? err.message : err);
    }

    console.log(`[escrow] Job ${jobId} verified Active: ${endpoint} — ${price} from ${job.buyer}`);

    if (archetype === "faulty") {
      return NextResponse.json({
        result: null,
        records: [{ id: "?", value: null }],
        warning: "payload truncated",
      });
    }

    return handler(req);
  };
}
