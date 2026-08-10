import { NextResponse } from "next/server";
import { JOB_ESCROW_ABI, JobStatus } from "@/lib/jobEscrow";
import { envAddress, publicClient, readBuyerBalance, readJobs, readSellerBond, settledCount, usdc } from "@/lib/live/chain";
import { getSellerConfigs } from "@/lib/live/config";

let cache: { at: number; value: unknown } | undefined;

export async function GET() {
  if (cache && Date.now() - cache.at < 5_000) return NextResponse.json(cache.value);
  try {
    const escrow = envAddress("JOB_ESCROW_ADDRESS");
    const primarySeller = getSellerConfigs()[0];
    const [jobs, bond, buyerBalance, ratio, responseWindow, registryEnabled, sellerBond, arbiter] = await Promise.all([
      readJobs(),
      readSellerBond(primarySeller.agentId),
      readBuyerBalance(),
      publicClient.readContract({ address: escrow, abi: JOB_ESCROW_ABI, functionName: "minBondRatioBps" }),
      publicClient.readContract({ address: escrow, abi: JOB_ESCROW_ABI, functionName: "responseWindow" }),
      publicClient.readContract({ address: escrow, abi: JOB_ESCROW_ABI, functionName: "validationRegistryEnabled" }),
      publicClient.readContract({ address: escrow, abi: JOB_ESCROW_ABI, functionName: "sellerBond" }),
      publicClient.readContract({ address: escrow, abi: JOB_ESCROW_ABI, functionName: "ARBITER" }),
    ]);
    const escrowed = jobs.reduce((sum, job) => sum + (job.status === JobStatus.Active || job.status === JobStatus.Disputed ? job.amount : BigInt(0)), BigInt(0));
    const value = {
      jobsSettled: settledCount(jobs),
      totalJobs: jobs.length,
      escrowed: usdc(escrowed),
      bond: { gross: usdc(bond.gross), reserved: usdc(bond.reserved), free: usdc(bond.free) },
      bondRatio: Number(ratio) / 100,
      responseWindowSeconds: Number(responseWindow),
      registryEnabled,
      buyerBalance: usdc(buyerBalance),
      identities: { jobEscrow: escrow, sellerBond, arbiter, primarySellerAgentId: primarySeller.agentId.toString() },
      updatedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), value };
    return NextResponse.json(value);
  } catch (error) {
    console.error("Failed to read live state", error);
    return NextResponse.json({ error: "Arc testnet state is temporarily unavailable." }, { status: 503 });
  }
}
