import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { envAddress, publicClient, readJobs, usdc } from "@/lib/live/chain";
import { JOB_ESCROW_ABI, JobStatus } from "@/lib/jobEscrow";

export async function GET(request: NextRequest) {
  try {
    const jobs = await readJobs();
    const page = Math.max(1, Number(request.nextUrl.searchParams.get("page") ?? "1"));
    const limit = Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? "100")));
    const start = (page - 1) * limit;
    const selected = jobs.map((job, id) => ({ job, id })).reverse().slice(start, start + limit);

    let deliveries = new Map<string, { endpoint: string; delivered_at: string }>();
    try {
      const supabase = await createClient();
      const { data } = await supabase.from("job_deliveries").select("job_id,endpoint,delivered_at");
      deliveries = new Map((data ?? []).map((row) => {
        const [deployment, id] = row.job_id.includes(":") ? row.job_id.split(":") : [null, row.job_id];
        if (deployment && deployment.toLowerCase() !== envAddress("JOB_ESCROW_ADDRESS").toLowerCase()) return [`other:${row.job_id}`, row] as const;
        return [id, row] as const;
      }));
    } catch (error) {
      console.warn("Job delivery metadata unavailable", error);
    }

    const resolution = new Map<string, boolean>();
    const proofs = new Map<string, Record<string, `0x${string}`>>();
    try {
      const block = await publicClient.getBlockNumber();
      const window = BigInt(9_999);
      const fromBlock = block > window ? block - window : BigInt(0);
      const logs = await publicClient.getContractEvents({
        address: envAddress("JOB_ESCROW_ADDRESS"),
        abi: JOB_ESCROW_ABI,
        eventName: "JobResolved",
        fromBlock,
        toBlock: block,
      });
      for (const log of logs) {
        const id = log.args.jobId!.toString();
        resolution.set(id, Boolean(log.args.sellerAtFault));
        proofs.set(id, { ...(proofs.get(id) ?? {}), resolve: log.transactionHash });
      }
      for (const [eventName, key] of [["JobCreated", "create"], ["JobReleased", "release"], ["JobDisputed", "dispute"], ["JobTimedOut", "timeout"]] as const) {
        const eventLogs = await publicClient.getContractEvents({
          address: envAddress("JOB_ESCROW_ADDRESS"), abi: JOB_ESCROW_ABI, eventName, fromBlock, toBlock: block,
        });
        for (const log of eventLogs) {
          const id = log.args.jobId!.toString();
          proofs.set(id, { ...(proofs.get(id) ?? {}), [key]: log.transactionHash });
        }
      }
    } catch (error) {
      console.warn("Recent resolution labels unavailable", error);
    }

    const rows = selected.map(({ job, id }) => {
      const meta = deliveries.get(String(id));
      const sellerAtFault = resolution.get(String(id));
      return {
        id: String(id),
        buyer: job.buyer,
        sellerAgentId: job.sellerAgentId.toString(),
        sellerPayoutAddress: job.sellerPayoutAddress,
        amount: usdc(job.amount),
        reservedBond: usdc(job.reservedBond),
        completionDeadline: Number(job.completionDeadline),
        responseDeadline: Number(job.responseDeadline),
        status: job.status,
        statusLabel: job.status === JobStatus.Resolved && sellerAtFault === undefined ? "RESOLVED" : undefined,
        sellerAtFault,
        validationRequestHash: job.validationRequestHash,
        evidenceHash: job.evidenceHash,
        endpoint: meta?.endpoint ?? null,
        deliveredAt: meta?.delivered_at ?? null,
        proofs: proofs.get(String(id)) ?? {},
      };
    });
    return NextResponse.json({ jobs: rows, total: jobs.length, page, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Failed to read jobs", error);
    return NextResponse.json({ error: "The on-chain job stream is temporarily unavailable." }, { status: 503 });
  }
}
