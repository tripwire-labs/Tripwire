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
            <div className="hero-matrix" aria-hidden="true"><SettlementMatrix compact /></div>
            <h1 className="hero-line hero-line-b">for proof.</h1>
          </div>
          <p className="hero-copy"><strong>Tripwire escrows agent-to-agent USDC on Arc and releases it only on verified delivery</strong> — backed by a seller bond that gets slashed when delivery fails.</p>
          <div className="hero-actions"><Link className="pill pill-primary" href="/live">Watch a live job settle <ArrowRight size={14}/></Link><a className="pill pill-secondary" href={explorer} target="_blank" rel="noopener noreferrer">Read the contracts <ExternalLink size={13}/></a></div>
          <p className="hero-proof micro-label">REAL CONTRACTS · REAL TESTNET USDC · ONE BORROWED BUYER IDENTITY</p>
        </section>

        <Reveal><section className="section shell" id="gap">
          <div className="section-heading"><p className="micro-label">01 / The gap</p><h2>The payment succeeded. <span>Did the work?</span></h2><p>Agent payment rails can prove that money moved. They cannot prove the thing purchased was worth paying for.</p></div>
          <div className="marketing-grid">
            <article><span className="card-index">01</span><h3>x402 pushes are irreversible.</h3><p>Conditional escrow transfers are named as future work in the x402 specification, not part of today&apos;s push-payment flow.</p></article>
            <article><span className="card-index">02</span><h3>Circle disclaims outcomes.</h3><p>Agent Stack&apos;s terms do not guarantee the performance, availability, or outcome of third-party agent transactions.</p></article>
            <article><span className="card-index">03</span><h3>So nothing covers the buyer.</h3><p>If the endpoint returns garbage—or nothing—the payment has already gone. Transport success is not delivery quality.</p></article>
          </div>
        </section>

        </Reveal><Reveal><section className="section shell" id="lifecycle">
          <div className="section-heading"><p className="micro-label">02 / The lifecycle</p><h2>Bond. Escrow. <span>Verified settlement.</span></h2><p>Every live value below is read from the deployed contracts.</p></div>
          <LifecycleCards />
        </section>

        </Reveal><Reveal><section className="section shell" id="mechanism">
          <div className="section-heading"><p className="micro-label">03 / The mechanism</p><h2>Money moves on an outcome, <span>not a request.</span></h2></div>
          <MechanismDiagram />
        </section>

        </Reveal><Reveal><section className="section shell">
          <div className="slash-panel">
            <div><p className="micro-label alarm-text">Recorded on Arc · Job 1</p><h2>The seller failed. The buyer was paid twice.</h2><p className="muted">Arbiter ruled the seller at fault. The bond is the tripwire.</p></div>
            <div className="slash-ledger">
              <div><span>Escrow refund</span><b>+0.030000 USDC</b></div>
              <div><span>Slashed seller bond</span><b>+0.006000 USDC</b></div>
              <div className="total"><span>Buyer received</span><b>0.036000 USDC</b></div>
              <div><span>Seller posted bond</span><b>0.050000 → 0.044000</b></div>
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
