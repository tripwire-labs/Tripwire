import type { Metadata } from "next";
import { Nav } from "@/components/tripwire/nav";
import { Footer } from "@/components/tripwire/footer";
import { LiveSession } from "@/components/tripwire/live-session";

export const metadata: Metadata = { title: "Live settlement", description: "Play the buyer in a real Tripwire settlement session on Arc testnet." };

export default function LivePage() {
  return <><Nav escrowAddress={process.env.JOB_ESCROW_ADDRESS!}/><main className="live-page"><LiveSession/></main><Footer/></>;
}
