import Link from "next/link";
import { Reveal } from "@/components/tripwire/motion";
import { ArrowRight, ExternalLink } from "lucide-react";
import { Nav } from "@/components/tripwire/nav";
import { Footer } from "@/components/tripwire/footer";
import { SettlementMatrix } from "@/components/tripwire/settlement-matrix";

import { MechanismDiagram } from "@/components/tripwire/mechanism-diagram";
import { LifecycleCards } from "@/components/tripwire/home-live";

const ESCROW = process.env.JOB_ESCROW_ADDRESS!;
const explorer = `https://testnet.arcscan.app/address/${ESCROW}`;

export default function Home() {
  return (
    <>
      <Nav escrowAddress={ESCROW} />
      <main>
        <section className="hero-section shell">
          <div className="hero-grid-bg" aria-hidden="true" />

          <a className="signal-pill" href={explorer} target="_blank" rel="noopener noreferrer"><i /> Live on Arc testnet <ExternalLink size={12}/></a>
          <div className="hero-composition">
            <h1 className="hero-line hero-line-a">Payment that waits</h1>
            <div className="hero-matrix" aria-hidden="true"><SettlementMatrix dense /></div>
            <h1 className="hero-line hero-line-b">for proof.</h1>
          </div>
          <p className="hero-copy"><strong>Your money is held until the work is checked.</strong> And every seller puts down their own money first — so if they fail you, you get paid out of it.</p>
          <div className="hero-actions"><Link className="pill pill-primary" href="/live">Try it yourself <ArrowRight size={14}/></Link><a className="pill pill-secondary" href={explorer} target="_blank" rel="noopener noreferrer">Read the contracts <ExternalLink size={13}/></a></div>
          <p className="hero-proof micro-label">RUNNING ON ARC · REAL USDC · EVERY NUMBER READ FROM THE CONTRACTS</p>
        </section>

        <Reveal><section className="section shell" id="gap">
          <div className="section-heading"><p className="micro-label">01 / The gap</p><h2>The payment succeeded. <span>Did the work?</span></h2><p>Today&apos;s agent payments can prove the money moved. They can&apos;t prove you got anything worth paying for.</p></div>
          <div className="marketing-grid">
            <article><span className="card-index">01</span><h3>The money leaves instantly.</h3><p>Once an agent sends a payment, it&apos;s gone. Holding funds until the work is checked is listed as future work in the x402 spec — it doesn&apos;t exist yet.</p></article>
            <article><span className="card-index">02</span><h3>Nobody promises the outcome.</h3><p>Circle&apos;s own Agent Stack terms say they don&apos;t guarantee what a third-party agent actually does with your payment.</p></article>
            <article><span className="card-index">03</span><h3>So the buyer carries all the risk.</h3><p>If the agent sends junk — or nothing at all — you&apos;ve already paid. A successful request doesn&apos;t mean you got what you asked for.</p></article>
          </div>
        </section>

        </Reveal><Reveal><section className="section shell" id="lifecycle">
          <div className="section-heading"><p className="micro-label">02 / How it works</p><h2>Deposit. Hold. <span>Then pay — or don&apos;t.</span></h2><p>Every number below is read live from the contracts running on Arc.</p></div>
          <LifecycleCards />
        </section>

        </Reveal><Reveal><section className="section shell" id="mechanism">
          <div className="section-heading"><p className="micro-label">03 / Where the money goes</p><h2>You get paid for doing the work, <span>not for answering.</span></h2></div>
          <MechanismDiagram />
        </section>

        </Reveal><Reveal><section className="section shell">
          <div className="slash-panel">
            <div><p className="micro-label alarm-text">This really happened · Job 1</p><h2>The seller failed. The buyer got paid twice.</h2><p className="muted">Their money back, plus the seller&apos;s deposit on top. The seller lost their own money for doing bad work.</p></div>
            <div className="slash-ledger">
              <div><span>Money back</span><b>+0.030000 USDC</b></div>
              <div><span>Seller&apos;s deposit</span><b>+0.006000 USDC</b></div>
              <div className="total"><span>Buyer received</span><b>0.036000 USDC</b></div>
              <div><span>Seller&apos;s deposit after</span><b>0.050000 → 0.044000</b></div>
            </div>
            <a className="text-link" href="https://testnet.arcscan.app/tx/0x908063239226925e8fdd2cf61c6279c55c61e623bc701d38e8f98898c105f632" target="_blank" rel="noopener noreferrer">Verify the resolution transaction <ExternalLink size={13}/></a>
          </div>
        </section>

        </Reveal><Reveal><section className="section shell built-on">
          <div className="section-heading"><p className="micro-label">04 / Built on</p><h2>Extending the rails <span>agents already use.</span></h2></div>
          <div className="built-row">
            <div><b>Arc</b><span>USDC settlement chain</span></div><div><b>Circle x402</b><span>Discovery, pricing, delivery</span></div><div><b>ERC-8004</b><span>Identity and attestations</span></div><div><b>Agent Wallets</b><span>Custody upstream of escrow</span></div>
          </div>
        </section>

        </Reveal><Reveal><section className="section final-cta shell"><p className="micro-label">The buyer&apos;s seat is ready</p><h2>Choose a seller. See what arrives. <span>Decide who gets paid.</span></h2><Link className="pill pill-primary" href="/live">Start the live session <ArrowRight size={14}/></Link></section></Reveal>
      </main>
      <Footer />
    </>
  );
}
