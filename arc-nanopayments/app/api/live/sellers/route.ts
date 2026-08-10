import { NextResponse } from "next/server";
import { getSellerConfigs } from "@/lib/live/config";
import { envAddress, publicClient, readJobs, readSellerBond, usdc } from "@/lib/live/chain";
import { JOB_ESCROW_ABI, JobStatus } from "@/lib/jobEscrow";

export async function GET() {
  try {
    const [configs, jobs] = await Promise.all([Promise.resolve(getSellerConfigs()), readJobs()]);
    const lostJobIds = new Set<string>();
    try {
      const block = await publicClient.getBlockNumber();
      const window = BigInt(9_999);
      const logs = await publicClient.getContractEvents({
        address: envAddress("JOB_ESCROW_ADDRESS"),
        abi: JOB_ESCROW_ABI,
        eventName: "JobResolved",
        fromBlock: block > window ? block - window : BigInt(0),
        toBlock: block,
      });
      for (const log of logs) if (log.args.sellerAtFault) lostJobIds.add(log.args.jobId!.toString());
    } catch (error) {
      console.warn("Recent dispute outcomes unavailable", error);
    }
    const sellers = await Promise.all(configs.map(async (seller) => {
      const bond = await readSellerBond(seller.agentId);
      const sellerJobs = jobs.filter((job) => job.sellerAgentId === seller.agentId);
      return {
        ...seller,
        agentId: seller.agentId.toString(),
        bond: { gross: usdc(bond.gross), reserved: usdc(bond.reserved), free: usdc(bond.free) },
        jobsSettled: sellerJobs.filter((job) => [JobStatus.Released, JobStatus.Resolved, JobStatus.TimedOut].includes(job.status as 2 | 4 | 5)).length,
        disputes: sellerJobs.filter((job) => lostJobIds.has(String(jobs.indexOf(job)))).length,
      };
    }));
    return NextResponse.json({ sellers, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Failed to read live sellers", error);
    return NextResponse.json({ error: "Seller bond data is temporarily unavailable." }, { status: 503 });
  }
}
