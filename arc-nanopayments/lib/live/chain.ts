import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET_RPC, JOB_ESCROW_ABI, JobStatus, type Job } from "@/lib/jobEscrow";
export { ARC_TESTNET_RPC } from "@/lib/jobEscrow";

export const ARC_EXPLORER = "https://testnet.arcscan.app";
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
export const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
export const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as const;
export const BUYER_AGENT_ID = "851888";

export const SELLER_BOND_ABI = [
  { type: "function", name: "bondBalance", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "reserved", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "bondOf", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_TESTNET_RPC),
  batch: { multicall: true },
});

export function envAddress(name: string): Address {
  const value = process.env[name];
  if (!value || !/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error(`${name} is not configured`);
  return value as Address;
}

export function usdc(value: bigint): string {
  return Number(formatUnits(value, 6)).toFixed(6);
}

export async function readSellerBond(agentId: bigint) {
  const address = envAddress("SELLER_BOND_ADDRESS");
  const [gross, reserved, free] = await Promise.all([
    publicClient.readContract({ address, abi: SELLER_BOND_ABI, functionName: "bondBalance", args: [agentId] }),
    publicClient.readContract({ address, abi: SELLER_BOND_ABI, functionName: "reserved", args: [agentId] }),
    publicClient.readContract({ address, abi: SELLER_BOND_ABI, functionName: "bondOf", args: [agentId] }),
  ]);
  return { gross, reserved, free };
}

export async function readJobs(): Promise<Job[]> {
  const address = envAddress("JOB_ESCROW_ADDRESS");
  const nextJobId = await publicClient.readContract({ address, abi: JOB_ESCROW_ABI, functionName: "nextJobId" });
  if (nextJobId === BigInt(0)) return [];
  const contracts = Array.from({ length: Number(nextJobId) }, (_, index) => ({
    address,
    abi: JOB_ESCROW_ABI,
    functionName: "jobs" as const,
    args: [BigInt(index)] as const,
  }));
  const rows = await publicClient.multicall({ contracts, allowFailure: true });
  return rows.flatMap((row) => {
    if (row.status !== "success") return [];
    const [buyer, sellerAgentId, sellerPayoutAddress, amount, reservedBond, completionDeadline, responseDeadline, status, validationRequestHash, evidenceHash] = row.result;
    return [{ buyer, sellerAgentId, sellerPayoutAddress, amount, reservedBond, completionDeadline, responseDeadline, status, validationRequestHash, evidenceHash } satisfies Job];
  });
}

export async function readBuyerBalance(): Promise<bigint> {
  const buyer = envAddress("BUYER_ADDRESS");
  return publicClient.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer] });
}

export function settledCount(jobs: Job[]): number {
  return jobs.filter((job) => job.status !== JobStatus.Active && job.status !== JobStatus.Disputed).length;
}
