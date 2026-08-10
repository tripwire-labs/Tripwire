export function MechanismDiagram() {
  return (
    <div className="mechanism-wrap">
      <svg className="mechanism-svg" viewBox="0 0 920 300" role="img" aria-labelledby="mechanism-title mechanism-desc">
        <title id="mechanism-title">Tripwire settlement mechanism</title>
        <desc id="mechanism-desc">Buyer payment and seller bond enter JobEscrow. Release and timeout pay the seller. A dispute resolved against the seller returns escrow and slashes the bond to the buyer.</desc>
        <g className="diagram-lines">
          <path d="M80 150H300"/><path d="M190 55V120H300"/><path d="M190 245V180H300"/>
          <path d="M500 150H580V62H700" className="path-ok"/><path d="M500 150H700" className="path-neutral"/><path d="M500 150H580V238H700" className="path-alarm"/>
        </g>
        <g className="diagram-node"><rect x="20" y="122" width="160" height="56" rx="10"/><text x="100" y="145">BUYER DEPOSIT</text><text className="sub" x="100" y="164">USDC principal</text></g>
        <g className="diagram-node small"><rect x="105" y="26" width="170" height="44" rx="8"/><text x="190" y="53">ERC-8004 + HASH</text></g>
        <g className="diagram-node small"><rect x="105" y="230" width="170" height="44" rx="8"/><text x="190" y="257">SELLER BOND · 20%</text></g>
        <g className="diagram-node primary"><rect x="300" y="105" width="200" height="90" rx="12"/><text x="400" y="140">JOBESCROW</text><text className="sub" x="400" y="164">money waits for proof</text></g>
        <g className="diagram-node ok"><rect x="700" y="35" width="185" height="54" rx="10"/><text x="792" y="58">RELEASE</text><text className="sub" x="792" y="76">seller paid</text></g>
        <g className="diagram-node neutral"><rect x="700" y="123" width="185" height="54" rx="10"/><text x="792" y="146">TIMEOUT</text><text className="sub" x="792" y="164">seller paid</text></g>
        <g className="diagram-node alarm"><rect x="700" y="211" width="185" height="54" rx="10"/><text x="792" y="234">DISPUTE → SLASH</text><text className="sub" x="792" y="252">buyer paid twice</text></g>
      </svg>
      <ol className="mechanism-mobile">
        <li><b>Buyer funds escrow</b><span>USDC enters JobEscrow, not the seller wallet.</span></li>
        <li><b>Seller bond reserved</b><span>20% is locked against the job, with ERC-8004 verification.</span></li>
        <li className="ok"><b>Release</b><span>Verified delivery pays the seller.</span></li>
        <li className="neutral"><b>Timeout</b><span>A silent buyer eventually pays the seller.</span></li>
        <li className="alarm"><b>Dispute and slash</b><span>Buyer receives the escrow refund plus the seller bond.</span></li>
      </ol>
    </div>
  );
}
