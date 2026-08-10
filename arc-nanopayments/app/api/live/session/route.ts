import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, parseUnits, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { nonceManager } from "viem/nonce";
import { arcTestnet } from "viem/chains";
import { createJob, disputeJob, releaseJob, signJobId } from "@/lib/jobEscrow";
import { ARC_TESTNET_RPC, ARC_USDC, envAddress, publicClient, readSellerBond, usdc } from "@/lib/live/chain";
import { getSellerByKey } from "@/lib/live/config";
import { claimTour, createPendingToken, createSessionToken, verifyPendingToken, verifySessionToken } from "@/lib/live/session-store";
import { clientIpFrom } from "@/lib/rateLimit";

const JOB_DURATION_SECONDS = BigInt(3_600);

type StartBody = { action: "start"; sellerKey: string; visitorId: string };
type FundBody = { action: "fund"; quoteToken: string; visitorId: string };
type VerdictBody = { action: "verdict"; sessionId: string; visitorId: string; verdict: "accept" | "dispute" };
type Body = StartBody | FundBody | VerdictBody;

function replay(reason: string) {
  return NextResponse.json({ mode: "replay", reason, replayJobId: "1" }, { status: 200 });
}

function buyerWallet() {
  const key = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) throw new Error("BUYER_PRIVATE_KEY is not configured");
  const account = privateKeyToAccount(key, { nonceManager });
  return createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });
}

function ndjson(run: (send: (value: unknown) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      try { await run(send); } catch (error) {
        console.error("Live session failed", error);
        send({ type: "error", message: error instanceof Error ? error.message : "The live run stopped unexpectedly." });
      } finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Body | null;
  if (!body || !body.action || !("visitorId" in body) || !body.visitorId) {
    return NextResponse.json({ error: "Invalid session request." }, { status: 400 });
  }
  const ip = clientIpFrom(request.headers);

  if (body.action === "verdict") {
    const session = verifySessionToken(body.sessionId, body.visitorId, ip);
    if (!session) return NextResponse.json({ error: "This session is no longer available." }, { status: 404 });
    return ndjson(async (send) => {
      const wallet = buyerWallet();
      if (body.verdict === "accept") {
        send({ type: "verdict", verdict: "accept", message: "Calling release() — escrow will pay the seller." });
        const txHash = await releaseJob(wallet, envAddress("JOB_ESCROW_ADDRESS"), BigInt(session.jobId));
        send({ type: "released", txHash, jobId: session.jobId, message: "Seller paid in full; bond reservation freed." });
      } else {
        const evidenceHash = session.evidenceHash;
        send({ type: "evidence", evidenceHash, message: "Only this content hash is written on-chain; the raw evidence stays off-chain." });
        const txHash = await disputeJob(wallet, envAddress("JOB_ESCROW_ADDRESS"), BigInt(session.jobId), evidenceHash);
        send({ type: "disputed", txHash, evidenceHash, jobId: session.jobId, message: "Status is now DISPUTED. The escrow and reserved bond are still locked." });
      }
    });
  }


  // ---- Act II part 2: the spend. Only reached because the visitor asked for it. ----
  if (body.action === "fund") {
    const pending = verifyPendingToken(body.quoteToken, body.visitorId, ip);
    if (!pending) return NextResponse.json({ error: "That quote has expired. Choose the seller again." }, { status: 404 });
    const fundSeller = getSellerByKey(pending.sellerKey);
    if (!fundSeller) return NextResponse.json({ error: "Unknown seller." }, { status: 400 });

    return ndjson(async (send) => {
      const trustedEscrow = envAddress("JOB_ESCROW_ADDRESS");
      const wallet = buyerWallet();
      const buyer = wallet.account!;
      const url = `${request.nextUrl.origin}${fundSeller.endpoint}`;
      const amount = parseUnits(pending.price.slice(1), 6);

      const beforeBuyer = await publicClient.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] });
      const beforeBond = await readSellerBond(fundSeller.agentId);

      send({ type: "approval", message: `Approving exactly ${usdc(amount)} USDC for the trusted JobEscrow.` });
      const approveTxHash = await wallet.writeContract({ address: ARC_USDC, abi: erc20Abi, functionName: "approve", args: [trustedEscrow, amount] });
      await publicClient.waitForTransactionReceipt({ hash: approveTxHash });

      const completionDeadline = BigInt(Math.floor(Date.now() / 1000)) + JOB_DURATION_SECONDS;
      const { jobId, txHash: createTxHash } = await createJob(wallet, trustedEscrow, {
        sellerAgentId: fundSeller.agentId, amount, completionDeadline, validationRequestHash: pending.requestHash,
      });
      const [afterBuyer, afterBond] = await Promise.all([
        publicClient.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] }),
        readSellerBond(fundSeller.agentId),
      ]);
      send({
        type: "funded", jobId: jobId.toString(), approveTxHash, createTxHash, amount: usdc(amount),
        buyerBefore: usdc(beforeBuyer), buyerAfter: usdc(afterBuyer),
        bondReservedBefore: usdc(beforeBond.reserved), bondReservedAfter: usdc(afterBond.reserved),
        responseDeadline: Number(completionDeadline + BigInt(172_800)),
        message: "USDC entered escrow—not the seller wallet—and 20% was reserved from the seller's bond.",
      });

      const signature = await signJobId(wallet, trustedEscrow, jobId);
      const deliveryRes = await fetch(url, { ...buildRequestInit(fundSeller), headers: { ...(buildRequestInit(fundSeller).headers ?? {}), "x-job-id": jobId.toString(), "x-job-signature": signature } });
      const deliveryText = await deliveryRes.text();
      const evidenceHash = keccak256(toBytes(deliveryRes.ok ? deliveryText : "no-content-delivered"));
      const sessionId = createSessionToken({ visitorId: body.visitorId, ip, jobId: jobId.toString(), sellerKey: fundSeller.key, evidenceHash });
      send({
        type: "delivery", sessionId, archetype: fundSeller.archetype, ok: deliveryRes.ok, status: deliveryRes.status,
        payload: deliveryRes.ok ? JSON.parse(deliveryText) : null,
        message: fundSeller.archetype === "honest"
          ? "The payload arrived correctly. The seller still has not been paid."
          : fundSeller.archetype === "faulty"
            ? "HTTP succeeded, but the returned shape is visibly wrong. The seller still has not been paid."
            : "Nothing arrived. Your money remains in escrow, and you must dispute before the response deadline.",
      });
    });
  }

  const seller = getSellerByKey(body.sellerKey);
  if (!seller) return NextResponse.json({ error: "Unknown seller." }, { status: 400 });
  const limit = claimTour(ip, body.visitorId, seller.key);
  // "Already ran this seller" is NOT a capacity failure, and must not fall through to replay.
  // Doing so dropped the visitor into a canned replay of Job #1 — a different seller's job —
  // with inert verdict buttons and no proof links, and no way back. It is a normal, expected
  // state with an obvious remedy: pick a seller you have not run, or reset the tour.
  if (!limit.allowed && limit.duplicate) {
    return NextResponse.json({ mode: "already-done", sellerKey: seller.key, sellerName: seller.name }, { status: 200 });
  }
  if (!limit.allowed) return replay(`Live sessions are cooling down for ${limit.retryAfter}s.`);

  try {
    const [buyerBalance, sellerGasBalance, bond] = await Promise.all([
      publicClient.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [envAddress("BUYER_ADDRESS")] }),
      publicClient.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [envAddress("SELLER_ADDRESS")] }),
      readSellerBond(seller.agentId),
    ]);
    if (buyerBalance < BigInt(500_000)) return replay("The funded buyer is below the 0.500000 USDC safety floor.");
    if (sellerGasBalance < BigInt(100_000)) return replay("The seller gas wallet is below the 0.100000 USDC safety floor.");
    const requiredBond = parseUnits(seller.price.slice(1), 6) / BigInt(5);
    if (bond.free < requiredBond) return replay("This seller no longer has enough free bond for another live job.");
  } catch (error) {
    console.error("Preflight failed", error);
    return replay("Arc testnet preflight is unavailable, so this run uses verified history.");
  }

  // ---- Act II part 1: the free steps. Quote and validation only; no money moves. ----
  return ndjson(async (send) => {
    const trustedEscrow = envAddress("JOB_ESCROW_ADDRESS");
    const origin = request.nextUrl.origin;
    const url = `${origin}${seller.endpoint}`;

    send({ type: "quote-request", seller: seller.name, endpoint: seller.endpoint, message: "Asking the seller for terms. Nothing has been paid." });
    const quoteRes = await fetch(url, buildRequestInit(seller));
    if (quoteRes.status === 429) {
      send({ type: "replay", mode: "replay", replayJobId: "1", reason: "The quote registry is rate-limited, so this run switches to verified history." });
      return;
    }
    if (quoteRes.status !== 402) throw new Error(`Expected a 402 quote; seller returned ${quoteRes.status}.`);
    const quote = await quoteRes.json() as { price: string; sellerAgentId: string; requestHash: `0x${string}`; jobEscrowAddress: `0x${string}`; validationTxHash: `0x${string}` };

    // The buyer verifies the seller's terms against its own trusted values BEFORE any
    // approval exists to abuse. Never drop these checks.
    if (quote.jobEscrowAddress.toLowerCase() !== trustedEscrow.toLowerCase()) throw new Error("The seller quoted an untrusted escrow address; approval was refused.");
    if (quote.price !== seller.price || quote.sellerAgentId !== seller.agentId.toString()) throw new Error("The seller quote does not match the buyer's trusted price or identity.");

    send({ type: "quote", ...quote, endpoint: seller.endpoint, message: "402 Job Required. The seller has quoted terms; no payment moved." });
    send({ type: "validation", txHash: quote.validationTxHash, requestHash: quote.requestHash, message: "The seller registered this exact request for ERC-8004 validation." });

    // Stop here and hand control back. Funding is the visitor's decision, not ours.
    const quoteToken = createPendingToken({ visitorId: body.visitorId, ip, sellerKey: seller.key, requestHash: quote.requestHash, price: quote.price });
    send({
      type: "awaiting-funding",
      quoteToken,
      price: quote.price,
      message: `The seller wants ${quote.price} USDC. Nothing has left your wallet — you decide whether to fund the escrow.`,
    });
  });
}

/** Shared request shape so the quote and the delivery call the endpoint identically. */
function buildRequestInit(seller: { method: string }) {
  return seller.method === "POST"
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Tripwire live verification request" }) }
    : { method: "GET" };
}
