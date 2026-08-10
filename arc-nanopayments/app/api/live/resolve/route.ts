import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { nonceManager } from "viem/nonce";
import { arcTestnet } from "viem/chains";
import { getJob, JobStatus, resolveDisputeJob } from "@/lib/jobEscrow";
import { ARC_TESTNET_RPC, envAddress, readSellerBond, usdc } from "@/lib/live/chain";
import { getSellerByKey } from "@/lib/live/config";
import { clientIpFrom } from "@/lib/rateLimit";
import { verifySessionToken } from "@/lib/live/session-store";

function arbiterKey(): `0x${string}` | undefined {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
  // Local production builds run from arc-nanopayments while the deployment key remains in
  // the sibling contracts environment. Read it at request time without copying it into the
  // app or build output. Hosted deployments have no sibling file and must provide the same
  // server-only variable through their platform environment.
  const path = resolve(process.cwd(), "../contracts/.env");
  if (!existsSync(path)) return undefined;
  const match = readFileSync(path, "utf8").match(/^DEPLOYER_PRIVATE_KEY=(0x[a-fA-F0-9]{64})$/m);
  return match?.[1] as `0x${string}` | undefined;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { sessionId?: string; visitorId?: string } | null;
  if (!body?.sessionId || !body.visitorId) return NextResponse.json({ error: "Invalid resolution request." }, { status: 400 });
  const session = verifySessionToken(body.sessionId, body.visitorId, clientIpFrom(request.headers));
  const seller = session ? getSellerByKey(session.sellerKey) : undefined;
  if (!session || !seller) return NextResponse.json({ error: "Only a dispute created by this live session can be resolved." }, { status: 403 });
  const key = arbiterKey();
  if (!key) return NextResponse.json({ error: "The live arbiter is unavailable; replay evidence remains available." }, { status: 503 });
  try {
    const job = await getJob(envAddress("JOB_ESCROW_ADDRESS"), BigInt(session.jobId));
    if (job.status !== JobStatus.Disputed || job.evidenceHash.toLowerCase() !== session.evidenceHash.toLowerCase()) {
      return NextResponse.json({ error: "This signed session does not match a live disputed job." }, { status: 403 });
    }
    const before = await readSellerBond(seller.agentId);
    const account = privateKeyToAccount(key, { nonceManager });
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });
    const txHash = await resolveDisputeJob(wallet, envAddress("JOB_ESCROW_ADDRESS"), BigInt(session.jobId), true);
    const after = await readSellerBond(seller.agentId);
    return NextResponse.json({
      jobId: session.jobId,
      txHash,
      refund: usdc(BigInt(Math.round(Number(seller.price.slice(1)) * 1_000_000))),
      slashedBond: usdc((BigInt(Math.round(Number(seller.price.slice(1)) * 1_000_000)) * BigInt(2)) / BigInt(10)),
      bondBefore: usdc(before.gross),
      bondAfter: usdc(after.gross),
    });
  } catch (error) {
    console.error("Resolution failed", error);
    return NextResponse.json({ error: "The arbiter transaction did not settle. The disputed job remains safely locked." }, { status: 502 });
  }
}
