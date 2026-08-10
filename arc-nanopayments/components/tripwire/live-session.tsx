"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Clock3, ExternalLink, TriangleAlert } from "lucide-react";
import { CopyValue, middle } from "./copy-value";
import { usePolling } from "./live-hooks";
import { EvidenceZone } from "./live-evidence";
import { CountUp } from "./motion";
import { SettlementMatrix } from "./settlement-matrix";

type Seller = { key:string;name:string;archetype:"honest"|"faulty"|"absent";agentId:string;endpoint:string;price:string;service:string;description:string;bond:{gross:string;reserved:string;free:string};jobsSettled:number;disputes:number };
type SellersResponse = { sellers: Seller[]; updatedAt:string };
type State = { buyerBalance:string; updatedAt:string };
type StreamEvent = Record<string, unknown> & { type:string; message?:string; txHash?:string; jobId?:string; sessionId?:string; archetype?:string; payload?:unknown };

const explorerTx = (hash:string) => `https://testnet.arcscan.app/tx/${hash}`;
const explorerAgent = (id:string) => `https://testnet.arcscan.app/token/0x8004A818BFB912233c491871b3d84c89A494BD9e?a=${id}`;
const spring = { duration:.28, ease:[.2,0,.1,1] as const };

function visitorIdentity() {
  const stored = localStorage.getItem("tripwire-visitor-id");
  if (stored) return stored;
  const id = crypto.randomUUID(); localStorage.setItem("tripwire-visitor-id", id); return id;
}

async function readNdjson(response: Response, onEvent:(event:StreamEvent)=>void) {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const json = await response.json();
    // Three distinct terminal shapes, deliberately not collapsed: an already-run seller keeps
    // the visitor on the marketplace, a capacity limit falls back to replay, anything else is
    // a real error.
    const type = json.mode === "already-done" ? "already-done" : json.mode === "replay" ? "replay" : "error";
    onEvent({ type, ...json }); return;
  }
  if (!response.body) throw new Error("The live stream did not open.");
  const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer="";
  while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value??new Uint8Array(),{stream:!done});const lines=buffer.split("\n");buffer=lines.pop()??"";for(const line of lines)if(line.trim())onEvent(JSON.parse(line));if(done)break}
}

export function LiveSession() {
  const sellersQuery=usePolling<SellersResponse>("/api/live/sellers");
  const stateQuery=usePolling<State>("/api/live/state");
  const [visitorId,setVisitorId]=useState("");
  const [selected,setSelected]=useState<Seller|null>(null);
  const [phase,setPhase]=useState<"market"|"buy"|"verdict"|"outcome">("market");
  const [events,setEvents]=useState<StreamEvent[]>([]);
  const [busy,setBusy]=useState(false);
  const [completed,setCompleted]=useState<string[]>([]);
  const [ownedJobs,setOwnedJobs]=useState<string[]>([]);
  const [replay,setReplay]=useState(false);
  // Marketplace-level message for states that must NOT enter the session (already-run seller).
  const [notice,setNotice]=useState("");
  // Set when the quote has arrived and the visitor has not yet authorised the spend.
  const [pendingQuote,setPendingQuote]=useState<{token:string;price:string}|null>(null);
  const [payments,setPayments]=useState<{refund?:string;slash?:string;total?:string;bondBefore?:string;bondAfter?:string}>({});
  const [explanation,setExplanation]=useState("Choose a seller to inspect the collateral they have put at risk before you buy anything.");
  const sessionId=useRef("");
  const stageRef=useRef<HTMLDivElement>(null);
  const firstPhase=useRef(true);

  useEffect(()=>{setVisitorId(visitorIdentity());const done=localStorage.getItem("tripwire-completed");if(done)setCompleted(JSON.parse(done));const jobs=localStorage.getItem("tripwire-jobs");if(jobs)setOwnedJobs(JSON.parse(jobs));},[]);
  // Bring each new act into view. Skipped on first paint so landing on /live does not
  // yank the page, and offset by the sticky nav height so the act heading is never clipped.
  useEffect(()=>{
    if(firstPhase.current){firstPhase.current=false;return}
    const node=stageRef.current;
    if(!node)return;
    const reduced=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const top=node.getBoundingClientRect().top+window.scrollY-84;
    window.scrollTo({top:Math.max(0,top),behavior:reduced?"auto":"smooth"});
  },[phase]);

  const sellers=sellersQuery.data?.sellers??[];
  const latest=events.at(-1);

  function recordEvent(event:StreamEvent){setEvents(prev=>[...prev,event]);if(event.message)setExplanation(event.message);if(event.sessionId)sessionId.current=event.sessionId;if(event.jobId){setOwnedJobs(prev=>{const next=[...new Set([...prev,event.jobId!])];localStorage.setItem("tripwire-jobs",JSON.stringify(next));return next})}if(event.type==="awaiting-funding")setPendingQuote({token:String(event.quoteToken),price:String(event.price)});if(event.type==="funded")setPendingQuote(null);if(event.type==="delivery")setPhase("verdict");if(event.type==="replay")startReplay(String(event.reason??"Live capacity is unavailable."));}

  async function chooseSeller(seller:Seller){
    setSelected(seller);setEvents([]);setPayments({});setReplay(false);setNotice("");setPendingQuote(null);setPhase("buy");setBusy(true);
    setExplanation("First, the seller quotes the job. Nothing moves until the buyer independently verifies those terms.");
    try{
      const response=await fetch("/api/live/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"start",sellerKey:seller.key,visitorId})});
      // Peek before streaming: an already-run seller must never enter the session at all.
      if(response.headers.get("content-type")?.includes("application/json")){
        const json=await response.json() as {mode?:string;sellerName?:string};
        if(json.mode==="already-done"){
          setPhase("market");setSelected(null);
          setNotice(`You've already run ${json.sellerName ?? seller.name} in this tour. Pick a seller you haven't tried, or start a fresh tour to run it again.`);
          setExplanation("Each seller runs once per tour, so every run spends real testnet USDC on a new job rather than repeating one.");
          return;
        }
        if(json.mode==="replay"){startReplay(String((json as {reason?:string}).reason??"Live capacity is unavailable."));return}
        recordEvent({type:"error",...json});return;
      }
      await readNdjson(response,recordEvent)
    }catch(error){recordEvent({type:"error",message:error instanceof Error?error.message:"The live run stopped."})}
    finally{setBusy(false)}
  }

  async function verdict(choice:"accept"|"dispute"){if(!selected)return;setBusy(true);try{if(replay){await replayVerdict(choice);return}const response=await fetch("/api/live/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"verdict",sessionId:sessionId.current,visitorId,verdict:choice})});await readNdjson(response,recordEvent);if(choice==="dispute"){const resolution=await fetch("/api/live/resolve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:sessionId.current,visitorId})});const result=await resolution.json();if(!resolution.ok)throw new Error(result.error);recordEvent({type:"resolved",txHash:result.txHash,message:"The arbiter found the seller at fault. Watch the two buyer payments land separately."});const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;setPayments({refund:result.refund,bondBefore:result.bondBefore,bondAfter:result.bondAfter});if(!reduced)await new Promise(r=>setTimeout(r,500));setPayments(p=>({...p,slash:result.slashedBond}));if(!reduced)await new Promise(r=>setTimeout(r,500));setPayments(p=>({...p,total:(Number(result.refund)+Number(result.slashedBond)).toFixed(6)}));}finishSeller()}catch(error){recordEvent({type:"error",message:error instanceof Error?error.message:"The verdict could not settle."})}finally{setBusy(false)}}

  function startReplay(reason:string){setReplay(true);setExplanation(`${reason} This is a clearly labelled replay of real Job #1.`);setEvents([{type:"replay",message:reason},{type:"quote",message:"Historical 402 quote loaded: 0.030000 USDC, no payment yet."},{type:"validation",message:"Job #1 carries its real ERC-8004 validation request hash in the evidence stream below."},{type:"funded",jobId:"1",amount:"0.030000",message:"Job #1 escrowed 0.030000 USDC and reserved 0.006000 USDC."},{type:"delivery",archetype:selected?.archetype??"faulty",payload:{result:null,records:[]},message:"Replay delivery loaded. The bytes arrived, but the content was not acceptable."}]);setPhase("verdict")}
  async function replayVerdict(choice:"accept"|"dispute"){if(choice==="accept"){recordEvent({type:"released",message:"Replay branch: accepting would have paid the seller and left the buyer with no recourse."})}else{recordEvent({type:"disputed",message:"Replay: Job #1's evidence hash was written on-chain."});recordEvent({type:"resolved",txHash:"0x908063239226925e8fdd2cf61c6279c55c61e623bc701d38e8f98898c105f632",message:"The historical arbiter transaction found the seller at fault."});setPayments({refund:"0.030000",bondBefore:"0.050000",bondAfter:"0.044000"});await new Promise(r=>setTimeout(r,500));setPayments(p=>({...p,slash:"0.006000"}));await new Promise(r=>setTimeout(r,500));setPayments(p=>({...p,total:"0.036000"}))}finishSeller()}

  /**
   * The visitor authorising the spend. Deliberately a separate call and a separate click:
   * Act II used to run straight through quote -> approve -> createJob, so the page moved the
   * visitor's money before they had a chance to agree to it.
   */
  async function fundEscrow(){
    if(!pendingQuote)return;
    setBusy(true);
    try{
      const response=await fetch("/api/live/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"fund",quoteToken:pendingQuote.token,visitorId})});
      if(response.headers.get("content-type")?.includes("application/json")){
        const json=await response.json();
        recordEvent({type:"error",...json});return;
      }
      await readNdjson(response,recordEvent);
    }catch(error){recordEvent({type:"error",message:error instanceof Error?error.message:"Funding failed."})}
    finally{setBusy(false)}
  }

  function finishSeller(){if(!selected)return;setPhase("outcome");setCompleted(prev=>{const next=[...new Set([...prev,selected.key])];localStorage.setItem("tripwire-completed",JSON.stringify(next));return next})}
  function returnToMarket(){setPhase("market");setSelected(null);setEvents([]);setPayments({});sellersQuery.retry()}

  /**
   * Clears the visitor's completed-seller record so the marketplace reads as fresh again.
   * Without this the localStorage tour is permanent: a judge returning to the page — or the
   * same machine being used for a second demo — sees three greyed-out "done" cards and no way
   * back. Issues a new visitor id too, since the server's five-minute tour window is keyed on
   * it; that is what actually re-enables live runs rather than replay.
   */
  function resetTour(){
    localStorage.removeItem("tripwire-completed");
    localStorage.removeItem("tripwire-jobs");
    const fresh=crypto.randomUUID();
    localStorage.setItem("tripwire-visitor-id",fresh);
    setVisitorId(fresh);setCompleted([]);setOwnedJobs([]);setReplay(false);setNotice("");
    setExplanation("Fresh tour. Choose a seller to inspect the collateral they have put at risk before you buy anything.");
    returnToMarket();
  }

  const activeStep=latest?.type==="delivery"?4:events.some(e=>e.type==="funded")?3:events.some(e=>e.type==="validation")?2:events.length?1:0;
  return <>
    <section className="live-shell shell-wide">
      <div className="identity-card"><div className="identity-main"><span className="micro-label">You are</span><b>buyer-agent #851888</b><span>balance <strong>{stateQuery.data?.buyerBalance?<><CountUp value={stateQuery.data.buyerBalance}/> USDC</>:"—"}</strong></span><i/> <span>Arc testnet</span>{replay&&<em>Replay of job #1</em>}</div><p>We&apos;re lending you a funded buyer agent for this session — you&apos;d otherwise need testnet USDC of your own. Everything it does on-chain is real.</p></div>
      <div className="live-strip"><div className="live-strip-label"><span className="micro-label">Settlement history</span><span className="micro-label">live</span></div><SettlementMatrix compact/></div>
      <div className="act-progress" aria-label="Session acts"><span className={phase==="market"?"active":"done"}>01 Choose a seller</span><span className={phase==="buy"?"active":phase==="verdict"||phase==="outcome"?"done":""}>02 Buy the service</span><span className={phase==="verdict"||phase==="outcome"?"active":""}>03 Deliver your verdict</span></div>
      <div className="session-layout">
        <div className="session-stage" ref={stageRef}>
          <AnimatePresence mode="wait">
            {phase==="market"&&<motion.section key="market" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}} transition={spring} className="act-panel"><div className="act-title"><div><p className="micro-label">Act I · Choose a seller</p><h1>Who gets your job?</h1><p>Three sellers. Three possible outcomes. Their collateral is real; their behaviour is not revealed in advance.</p></div><div className="completion-markers" aria-label={`${completed.length} of 3 sellers completed`}>{["meridian","halcyon","vantage"].map(key=><i key={key} className={completed.includes(key)?"done":""}>{completed.includes(key)?<Check size={11}/>:null}</i>)}</div></div>
              {sellersQuery.loading?<div className="seller-grid">{[1,2,3].map(x=><div className="seller-card skeleton-card" key={x}/>)}</div>:sellersQuery.error&&!sellers.length?<div className="error-panel"><p>Seller bonds could not be read from Arc.</p><button className="pill pill-secondary" onClick={sellersQuery.retry}>Retry live read</button></div>:<div className="seller-grid">{sellers.map(seller=><SellerCard key={seller.key} seller={seller} completed={completed.includes(seller.key)} onChoose={()=>chooseSeller(seller)}/>)}</div>}
              {notice&&<p className="lesson-prompt notice">{notice} <button className="inline-retry" onClick={resetTour}>Start a fresh tour</button></p>}
              {!notice&&completed.length>0&&completed.length<3&&<p className="lesson-prompt">You&apos;ve completed {completed.length} of 3 outcomes. Try an unfinished seller—the next failure mode teaches something different. <button className="inline-retry" onClick={resetTour}>Or start over</button></p>}
              {!notice&&completed.length>=3&&<p className="lesson-prompt">You&apos;ve seen all three outcomes: a clean release, a faulty delivery, and a seller who never showed up. <button className="inline-retry" onClick={resetTour}>Start a fresh tour</button></p>}
            </motion.section>}
            {phase==="buy"&&selected&&<motion.section key="buy" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}} transition={spring} className="act-panel"><ActHeader label="Act II · Buy the service" title={selected.name} copy="You are creating a real escrowed job. Follow the quote, validation, funding, and delivery as each one settles."/><Pipeline events={events} activeStep={activeStep} busy={busy}/>
              {pendingQuote&&<div className="fund-gate"><div><p className="micro-label">Your decision</p><p>The seller wants <b>{pendingQuote.price} USDC</b>. Nothing has left the buyer wallet yet — funding the escrow is the first step that moves money.</p></div><button className="pill pill-primary" disabled={busy} onClick={fundEscrow}>{busy?"Funding…":`Fund escrow · ${pendingQuote.price}`}</button></div>}
            </motion.section>}
            {phase==="verdict"&&selected&&<motion.section key="verdict" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}} transition={spring} className="act-panel"><ActHeader label="Act III · Your verdict" title="Was this worth paying for?" copy="You have the service—or you do not. This decision is the moment a normal push payment does not give you."/>
              <DeliveryPayload event={events.findLast(e=>e.type==="delivery")} seller={selected}/>
              <div className="verdict-actions"><button disabled={busy} onClick={()=>verdict("accept")} className="verdict-button"><span>Accept delivery</span><small>release() · seller paid</small></button><button disabled={busy} onClick={()=>verdict("dispute")} className="verdict-button"><span>Dispute it</span><small>evidence hash · arbiter ruling</small></button></div>
              {selected.archetype==="absent"&&<div className="timeout-lesson"><Clock3 size={18}/><div><b>What if you do nothing?</b><p><code>claimTimeout()</code> pays the <strong>seller</strong>. It prevents buyer griefing; it is not a refund. A clearly simulated fast-forward is available as a lesson, but no timeout is fabricated on-chain.</p><button onClick={()=>setExplanation("SIMULATED FAST-FORWARD: after 48 hours, claimTimeout() would pay the seller. Against non-delivery, the buyer must actively dispute.")}>Simulate the timeout lesson</button></div></div>}
            </motion.section>}
            {phase==="outcome"&&selected&&<motion.section key="outcome" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} transition={spring} className="act-panel outcome-panel"><p className="micro-label">Settlement complete</p><h1>{payments.total?"The buyer was paid twice.":latest?.type==="released"?"The seller was paid in full.":"The verdict is recorded."}</h1>{payments.refund&&<div className="payment-stage" aria-live="polite"><div className={payments.refund?"landed":""}><span>Escrow refund</span><b>+{payments.refund} USDC</b></div><div className={payments.slash?"landed alarm":""}><span>Slashed bond</span><b>{payments.slash?`+${payments.slash} USDC`:"waiting…"}</b></div><div className={payments.total?"landed total":""}><span>Total to buyer</span><b>{payments.total?`+${payments.total} USDC`:"—"}</b></div><p>Seller gross bond: {payments.bondBefore} → {payments.bondAfter} USDC</p></div>}<p className="outcome-copy">{payments.total?"The seller paid for failing, out of their own stake. That is the tripwire.":selected.archetype!=="honest"?"You chose to accept this delivery. The seller was paid, even though the content was faulty—your verdict has consequences.":"Correct delivery settled cleanly. When the seller performs, Tripwire stays almost invisible."}</p><button className="pill pill-primary" onClick={returnToMarket}>{completed.length>=3?"Review all sellers":"Choose another seller"}<ArrowRight size={13}/></button></motion.section>}
          </AnimatePresence>
        </div>
        <aside className="explainer-rail"><p className="micro-label">What just happened</p><p>{explanation}</p><div><p className="micro-label">Without Tripwire</p><p>The payment would have left the buyer at the first request. A successful HTTP response—even a bad one—would offer no on-chain recourse.</p></div><ProofLedger events={events}/></aside>
      </div>
    </section>
    <EvidenceZone yours={ownedJobs}/>
    <AdoptSection/>
  </>;
}

function SellerCard({ seller, completed, onChoose }: { seller:Seller;completed:boolean;onChoose:()=>void }) {
  const reserved = Math.min(100, Number(seller.bond.reserved) / Math.max(Number(seller.bond.gross), .000001) * 100);
  return <article className={`seller-card ${completed ? "completed" : ""}`}>
    <div className="seller-top"><span className="micro-label">Agent <a href={explorerAgent(seller.agentId)} target="_blank" rel="noopener noreferrer">#{seller.agentId}</a></span>{completed && <span className="completed-chip"><Check size={10}/> done</span>}</div>
    <h2>{seller.name}</h2><p>{seller.description}</p>
    <div className="bond-figure"><span>Bond posted</span><b><CountUp value={seller.bond.gross}/> USDC</b><div className="bond-bar"><i style={{ width: `${reserved}%` }}/></div><small><CountUp value={seller.bond.free}/> free · <CountUp value={seller.bond.reserved}/> reserved</small></div>
    <dl><div><dt>Jobs settled</dt><dd>{seller.jobsSettled}</dd></div><div><dt>Disputes lost</dt><dd>{seller.disputes}</dd></div></dl>
    <div className="service-row"><div><span className="micro-label">Service</span><b>{seller.service}</b></div><span>{seller.price} USDC</span></div>
    <button className="pill pill-secondary" onClick={onChoose}>Choose {seller.name.split(" ")[0]}</button>
  </article>;
}
function ActHeader({label,title,copy}:{label:string;title:string;copy:string}){return <div className="act-title"><div><p className="micro-label">{label}</p><h1>{title}</h1><p>{copy}</p></div></div>}

/**
 * Accumulating proof list for the explainer rail.
 *
 * This previously rendered only the most recent event's txHash, which meant the rail read
 * "Proof links appear with each transaction" for most of a session — the steps that carry a
 * hash (validation, approve/createJob, release/dispute, resolve) are interleaved with steps
 * that do not, so `latest.txHash` was usually undefined. Every claim on this page is supposed
 * to be one click from Arcscan, so the rail keeps the whole chain of receipts instead.
 */
const PROOF_LABELS: Record<string,string> = {
  validation: "ERC-8004 request",
  funded: "Escrow funded",
  released: "release()",
  disputed: "dispute()",
  resolved: "resolveDispute()",
};

function ProofLedger({ events }: { events: StreamEvent[] }) {
  // Collect every hash the stream has produced, newest last, de-duplicated: `funded` carries
  // both the approve and createJob hashes, so it contributes two entries.
  const receipts: { label: string; hash: string }[] = [];
  for (const event of events) {
    const approve = typeof event.approveTxHash === "string" ? event.approveTxHash : undefined;
    if (approve) receipts.push({ label: "USDC approve", hash: approve });
    const create = typeof event.createTxHash === "string" ? event.createTxHash : undefined;
    if (create) receipts.push({ label: "createJob()", hash: create });
    if (event.txHash) receipts.push({ label: PROOF_LABELS[event.type] ?? event.type, hash: event.txHash });
  }
  const unique = receipts.filter((r, i) => receipts.findIndex((o) => o.hash === r.hash) === i);

  return (
    <div>
      <p className="micro-label">Proof</p>
      {unique.length === 0
        ? <span className="muted">Proof links appear with each transaction.</span>
        : <ul className="proof-ledger">{unique.map((receipt) => (
            <li key={receipt.hash}>
              <span>{receipt.label}</span>
              <a href={explorerTx(receipt.hash)} target="_blank" rel="noopener noreferrer">{middle(receipt.hash)} <ExternalLink size={11}/></a>
            </li>
          ))}</ul>}
    </div>
  );
}
function Pipeline({events,activeStep,busy}:{events:StreamEvent[];activeStep:number;busy:boolean}){const steps=[{title:"Ask for the service",event:"quote",copy:"402 handshake · nothing paid"},{title:"Register validation",event:"validation",copy:"ERC-8004 request on-chain"},{title:"Fund escrow",event:"funded",copy:"approve + createJob"},{title:"Delivery",event:"delivery",copy:"inspect what actually arrived"}];return <div className="pipeline" aria-live="polite">{steps.map((step,index)=>{const event=events.find(e=>e.type===step.event);const state=event?"done":activeStep===index+1||busy&&index===activeStep?"active":"pending";return <motion.article layout key={step.event} className={state} transition={spring}><span className="step-marker">{event?<Check size={13}/>:String(index+1).padStart(2,"0")}</span><div><h3>{step.title}</h3><p>{event?.message??step.copy}</p>{event?.txHash&&<a href={explorerTx(event.txHash)} target="_blank" rel="noopener noreferrer">{middle(event.txHash)} <ExternalLink size={11}/></a>}{step.event==="funded"&&event&&<div className="transfer-readout"><span>Buyer: {String(event.buyerBefore)} → {String(event.buyerAfter)} USDC</span><span>Reserved bond: {String(event.bondReservedBefore)} → {String(event.bondReservedAfter)} USDC</span></div>}</div></motion.article>})}</div>}
/**
 * Renders what the seller actually returned.
 *
 * A raw JSON dump made the visitor do the work of spotting what was wrong with it, which is
 * precisely the judgement the page is asking them to make. Fields are laid out as labelled
 * rows and each empty, null or placeholder value is called out inline, so "the request
 * succeeded but the content is worthless" is legible at a glance rather than inferred.
 */
function faultOf(value: unknown): string | null {
  if (value === null || value === undefined) return "no value returned";
  if (Array.isArray(value) && value.length === 0) return "empty list";
  if (typeof value === "string" && value.trim() === "") return "blank";
  if (typeof value === "string" && /^[?\-_.]+$/.test(value.trim())) return "placeholder";
  return null;
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return value.length ? `${value.length} item${value.length === 1 ? "" : "s"}` : "[ ]";
  if (typeof value === "object") return `{ ${Object.keys(value as object).length} fields }`;
  return String(value);
}

function DeliveryPayload({event,seller}:{event?:StreamEvent;seller:Seller}){
  const payload = (event?.payload ?? null) as Record<string, unknown> | null;
  const entries = payload && typeof payload === "object" ? Object.entries(payload) : [];
  const faults = entries.filter(([, v]) => faultOf(v) !== null).length;

  return <div className={`delivery-payload ${seller.archetype}`}>
    <div className="response-line">
      <span className="micro-label">HTTP response</span>
      <b>{String(event?.status??(seller.archetype==="absent"?504:200))} {seller.archetype==="absent"?"NO DELIVERY":"OK"}</b>
    </div>

    {seller.archetype==="absent"
      ? <div className="absent-state"><Clock3 size={20}/><p>No content arrived. Your principal and the seller&apos;s reserved bond are still locked.</p></div>
      : <div className="payload-fields">
          {entries.map(([key, value]) => {
            const fault = faultOf(value);
            return <div key={key} className={`payload-row ${fault ? "faulted" : ""}`}>
              <span>{key}</span>
              <b>{preview(value)}</b>
              {fault && <em><TriangleAlert size={11}/> {fault}</em>}
            </div>;
          })}
          {entries.length===0 && <div className="payload-row faulted"><span>body</span><b>empty</b><em><TriangleAlert size={11}/> nothing usable</em></div>}
          <details className="payload-raw"><summary>Raw response</summary><pre>{JSON.stringify(payload ?? {},null,2)}</pre></details>
        </div>}

    {seller.archetype==="faulty" && <p className="payload-warning">
      <TriangleAlert size={14}/> The request succeeded and you were charged for it. {faults > 0 ? `${faults} of ${entries.length} fields came back unusable.` : "The content is not what was requested."}
    </p>}
  </div>;
}

function AdoptSection() {
  const [tab, setTab] = useState<"sell" | "buy" | "console">("sell");
  const code = tab === "sell"
    ? 'export const GET = withGateway(\n  handler, "$0.01", "/api/premium/dataset"\n);'
    : tab === "buy"
      ? 'const { jobId } = await createJob(walletClient, JOB_ESCROW, {\n  sellerAgentId, amount, completionDeadline,\n  validationRequestHash\n});'
      : "No protocol integration required.\nPost bond · watch jobs · review disputes\nwithdraw free stake";
  return <section className="section shell" id="adopt">
    <div className="section-heading"><p className="micro-label">Adopt / Normal operation</p><h2>Agents transact. <span>Humans supervise.</span></h2><p>Use the middleware, point a buyer at it, or operate entirely from the console.</p></div>
    <div className="adopt-tabs" role="tablist">
      <button role="tab" aria-selected={tab === "sell"} onClick={() => setTab("sell")}>I sell a service</button>
      <button role="tab" aria-selected={tab === "buy"} onClick={() => setTab("buy")}>I buy services</button>
      <button role="tab" aria-selected={tab === "console"} onClick={() => setTab("console")}>I just want the console</button>
    </div>
    <div className="code-panel"><div className="line-numbers">{code.split("\n").map((_, i) => <span key={i}>{i + 1}</span>)}</div><pre>{code}</pre><CopyValue value={code} label="code snippet" compact={false}/></div>
  </section>;
}
