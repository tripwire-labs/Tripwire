// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {ISellerBond} from "./interfaces/ISellerBond.sol";
import {IValidationRegistry} from "./interfaces/IValidationRegistry.sol";

/// @title JobEscrow — one job, one escrowed USDC payment, released only on verified delivery
/// @notice Buyer's USDC sits here until the buyer releases it, an arbiter resolves a dispute
/// in the seller's favor, or a timeout auto-releases it — never before. The seller must have
/// bond reserved on SellerBond before a job can start, and a dispute resolved against the
/// seller slashes that same reservation to the buyer, on top of the escrowed refund.
///
/// Implemented incrementally, one function (plus its tests) per change — bodies still marked
/// TODO are pending, not forgotten. ERC-8004 Validation Registry wiring (the requestHash
/// gate in createJob, and the validationResponse attestation calls) landed in Phase 3 —
/// see isValidationRequestValid and _attestValidation.
contract JobEscrow {
    using SafeERC20 for IERC20;

    // ----------------------------------------------------------------- types

    enum JobStatus {
        None, // default zero value — also means "job doesn't exist", doubling as an existence check
        Active,
        Released,
        Disputed,
        Resolved,
        TimedOut
    }

    struct Job {
        address buyer;
        uint256 sellerAgentId;
        // Snapshotted via identityRegistry.ownerOf() at createJob() time, not re-read at
        // payout — a buyer commits to a specific counterparty at creation, and letting that
        // silently redirect via a mid-job agent-NFT transfer would let a bad actor launder a
        // payout through an NFT sale after delivery. (Contrast SellerBond.completeWithdrawal,
        // which deliberately pays the *current* owner — a withdrawal is the seller's own money
        // moving on their own initiative, not a buyer's already-committed payment.)
        address sellerPayoutAddress;
        uint256 amount;
        // amount * minBondRatioBps / 10000 at creation time — fixed for this job's lifetime.
        // This exact number is the only amount ever reserved, released, or slashed for this
        // job; no recomputation later, no partial-slash fallback needed.
        uint256 reservedBond;
        uint64 completionDeadline;
        // completionDeadline + responseWindow, snapshotted at createJob() time — same
        // rationale as reservedBond above, and the same pattern SellerBond's
        // withdrawalTimelock already uses for pendingWithdrawal.unlockTime: a later
        // owner change to the global responseWindow (shortened for a demo, say) must
        // never retroactively strip a buyer's remaining time to release()/dispute(), or
        // hand a seller more/less claimTimeout protection than they agreed to when the
        // job was created.
        uint64 responseDeadline;
        JobStatus status;
        // Hash of the seller's ERC-8004 validationRequest for this job. Checked against the
        // Validation Registry at createJob() time (isValidationRequestValid) when
        // validationRegistryEnabled, and reused as the attestation key at every exit path
        // (_attestValidation).
        bytes32 validationRequestHash;
        // Hash of buyer-submitted dispute evidence — the hash lands on-chain, not raw evidence.
        bytes32 evidenceHash;
    }

    // ---------------------------------------------------------------- state

    IERC20 public immutable USDC;
    IIdentityRegistry public immutable IDENTITY_REGISTRY;
    IValidationRegistry public immutable VALIDATION_REGISTRY;
    // MVP dispute resolution: a single arbiter address (the deployer wallet), disclosed in the
    // README as centralized-for-now. Separate from `owner` — same key for the hackathon, but a
    // one-line change to rotate later without touching risk-parameter ownership.
    address public immutable ARBITER;

    address public owner;
    // Settable exactly once post-deploy (see setSellerBond) — resolves the circular
    // constructor dependency: JobEscrow needs SellerBond's address, but SellerBond's
    // JOB_ESCROW is immutable and needs JobEscrow's address. JobEscrow deploys first with
    // this unset; SellerBond deploys second with JobEscrow's address baked in as immutable;
    // then setSellerBond() is called once to complete the wiring.
    ISellerBond public sellerBond;

    // Gates every Validation Registry external call behind an owner-toggleable switch — the
    // registry's own spec is "still under active discussion," so a flaky registry can never
    // brick fund movement. Owner-only fast kill switch, deliberately no timelock (see
    // setValidationRegistryEnabled).
    bool public validationRegistryEnabled = true;
    // Risk parameter: required bond as a fraction of job amount, in basis points (2000 = 20%,
    // the spec's starting default). Owner-settable, same category as SellerBond's
    // withdrawalTimelock.
    uint256 public minBondRatioBps = 2000;
    // Hard ceiling on minBondRatioBps (10_000 = 100%): bounds a careless or compromised owner
    // from requiring more collateral than a job is even worth, which would otherwise brick
    // createJob for every future job. No minimum — 0% is a legitimate (if risky) demo/testing
    // configuration: createJob/release/resolveDispute/claimTimeout all guard their SellerBond
    // calls behind `reservedBond > 0`, so a 0%-ratio job runs its full lifecycle without ever
    // touching SellerBond (which would otherwise reject the zero-amount calls) — same
    // reasoning as SellerBond's MAX_WITHDRAWAL_TIMELOCK having no floor.
    uint256 public constant MAX_MIN_BOND_RATIO_BPS = 10_000;
    // Risk parameter: smallest job a buyer may create, in USDC atomic units (1000 = $0.001,
    // matching the cheapest endpoint the demo backend prices). This exists for a security
    // reason, not an economic one. Validation request hashes are public on the ERC-8004
    // registry, and createJob consumes one permanently (validationRequestHashUsed). Without
    // a floor, anyone could watch the registry and burn a seller's freshly-registered hash
    // with a 1-unit job — a job so small its reservedBond rounds to zero, so it locks none
    // of the attacker's capital either. That is a complete, near-free denial of service on
    // a seller's ability to sell anything. A floor makes each burn cost the attacker a real
    // amount they can only recover by disputing (which requires convincing the arbiter) or
    // by waiting out claimTimeout — which pays the *seller*. Griefing therefore funds the
    // victim. This prices the attack rather than eliminating it; that tradeoff is deliberate
    // and disclosed.
    uint256 public minJobAmount = 1000;
    // Ceiling on minJobAmount (100 USDC), same role MAX_MIN_BOND_RATIO_BPS plays for the
    // ratio: bounds a careless or compromised owner from setting a floor so high that
    // createJob is bricked for every realistic job. No minimum — 0 disables the floor, which
    // is a legitimate testing configuration.
    uint256 public constant MAX_MIN_JOB_AMOUNT = 100e6;
    // Dispute window and timeout grace period, merged into one owner-settable duration: buyer
    // can release()/dispute() any time up to completionDeadline + responseWindow; after that,
    // anyone can claimTimeout().
    uint64 public responseWindow = 48 hours;
    // Mirrors SellerBond.MAX_WITHDRAWAL_TIMELOCK exactly, same rationale: bounds what a
    // compromised owner key can freeze (a century-long window would make claimTimeout
    // meaningless), no minimum so a demo recording can shorten it to near-zero.
    uint64 public constant MAX_RESPONSE_WINDOW = 30 days;
    // Hard ceiling on how far into the future a job's completionDeadline may be set, checked
    // in createJob. Two independent reasons this exists: (1) it bounds
    // completionDeadline + responseWindow (both uint64) well clear of type(uint64).max, so
    // that sum can never overflow and permanently lock a job's escrowed funds and reserved
    // bond with no path out; (2) a "no real deadline" sentinel like type(uint64).max — a
    // pattern this very codebase's own tests use for USDC allowances
    // (`approve(..., type(uint256).max)`) — would otherwise be a plausible integration
    // mistake that triggers exactly that overflow. Not owner-settable: this is a structural
    // safety bound, not a risk/business parameter like minBondRatioBps or responseWindow.
    uint64 public constant MAX_JOB_DURATION = 365 days;

    mapping(uint256 => Job) public jobs;
    uint256 public nextJobId;
    // Tracks every validationRequestHash that has already claimed a job, so a seller's
    // registered request can only ever back one createJob call — see
    // ValidationRequestHashAlreadyUsed. Only populated when validationRegistryEnabled (see
    // createJob), so the disabled pathway's bytes32(0) placeholder never collides here.
    mapping(bytes32 => bool) public validationRequestHashUsed;

    // ---------------------------------------------------------------- events

    event JobCreated(
        uint256 indexed jobId,
        address indexed buyer,
        uint256 indexed sellerAgentId,
        uint256 amount,
        uint256 reservedBond,
        uint64 completionDeadline
    );
    event JobReleased(uint256 indexed jobId);
    event JobDisputed(uint256 indexed jobId, bytes32 evidenceHash);
    event JobResolved(uint256 indexed jobId, bool sellerAtFault);
    event JobTimedOut(uint256 indexed jobId);
    event SellerBondSet(address sellerBond);
    event MinBondRatioBpsUpdated(uint256 previous, uint256 current);
    event MinJobAmountUpdated(uint256 previous, uint256 current);
    event ResponseWindowUpdated(uint64 previous, uint64 current);
    event ValidationRegistryEnabledUpdated(bool previous, bool current);

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotArbiter();
    error NotBuyer(uint256 jobId, address caller);
    error SellerBondAlreadySet();
    error SellerBondNotSet();
    error ZeroAmount();
    error DeadlineNotInFuture(uint64 completionDeadline);
    error DeadlineTooFar(uint64 completionDeadline, uint64 maxCompletionDeadline);
    // Doubles as the "job doesn't exist" check: a nonexistent jobId's status is JobStatus.None,
    // which is never JobStatus.Active — same "revert doubles as existence check" pattern used
    // throughout SellerBond.
    error JobNotActive(uint256 jobId, JobStatus status);
    error JobNotDisputed(uint256 jobId, JobStatus status);
    error ResponseWindowElapsed(uint256 jobId, uint64 claimableAfter);
    error ResponseWindowNotElapsed(uint256 jobId, uint64 claimableAfter);
    error MinBondRatioTooHigh(uint256 requested, uint256 max);
    error MinJobAmountTooHigh(uint256 requested, uint256 max);
    error ResponseWindowTooLong(uint64 requested, uint64 max);
    // Covers every way isValidationRequestValid can fail (unregistered hash, wrong
    // validator, wrong agent) — one distinct error type is enough for off-chain monitoring
    // to tell "registry-related createJob failure" apart from an unrelated bad-input
    // revert like ZeroAmount or DeadlineNotInFuture.
    error ValidationRequestInvalid(bytes32 requestHash, uint256 sellerAgentId);
    // isValidationRequestValid is a pure read — nothing else marks a requestHash as
    // consumed, so without this a hash could be reused across multiple jobs, and whichever
    // job's exit path attests last would silently overwrite an earlier job's attestation on
    // the same hash. Global (not per-agent), matching the real registry's own requestHash
    // uniqueness scope.
    error ValidationRequestHashAlreadyUsed(bytes32 requestHash);
    // See minJobAmount — dust jobs are a denial-of-service vector against the seller, not
    // merely uneconomic, so they get their own distinct error rather than reusing ZeroAmount.
    error JobAmountTooSmall(uint256 amount, uint256 minJobAmount);
    // A job whose reservedBond rounds down to zero carries no collateral at all, which means
    // no Tripwire guarantee — the buyer would be paying into an escrow with nothing backing a
    // dispute. Rejected outright rather than silently accepted, EXCEPT when minBondRatioBps
    // is itself zero, which is the deliberately-supported no-collateral demo configuration.
    error BondRoundsToZero(uint256 amount, uint256 minBondRatioBps);

    // ------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    modifier onlyArbiter() {
        _checkArbiter();
        _;
    }

    modifier onlyBuyer(uint256 jobId) {
        _checkBuyer(jobId);
        _;
    }

    /// @dev See onlyOwner — check kept out of the modifier so it isn't duplicated into every
    /// use site's bytecode (forge lint's unwrapped-modifier-logic rule).
    function _checkOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    /// @dev See onlyArbiter.
    function _checkArbiter() internal view {
        if (msg.sender != ARBITER) revert NotArbiter();
    }

    /// @dev See onlyBuyer.
    function _checkBuyer(uint256 jobId) internal view {
        if (msg.sender != jobs[jobId].buyer) revert NotBuyer(jobId, msg.sender);
    }

    // ----------------------------------------------------------- constructor

    constructor(address usdc_, address identityRegistry_, address validationRegistry_, address arbiter_) {
        USDC = IERC20(usdc_);
        IDENTITY_REGISTRY = IIdentityRegistry(identityRegistry_);
        VALIDATION_REGISTRY = IValidationRegistry(validationRegistry_);
        ARBITER = arbiter_;
        owner = msg.sender;
    }

    // ------------------------------------------------------------- functions

    /// @notice One-time wiring of the SellerBond address, completing the two-step deploy.
    /// Reverts if already set — this pointer is meant to be immutable in practice, just not
    /// in the Solidity keyword sense (it can't be, since it isn't known at construction).
    function setSellerBond(address sellerBond_) external onlyOwner {
        if (address(sellerBond) != address(0)) revert SellerBondAlreadySet();
        sellerBond = ISellerBond(sellerBond_);
        emit SellerBondSet(sellerBond_);
    }

    /// @notice Buyer opens a job: validates amount/deadline, reserves the seller's bond,
    /// pulls `amount` USDC into escrow. Reverts via SellerBond.reserve() if the seller's free
    /// bond can't cover minBondRatioBps of `amount` — no duplicate ratio check here,
    /// SellerBond is the source of truth for its own balances.
    /// @dev When validationRegistryEnabled, `validationRequestHash` must name this contract
    /// as validator for `sellerAgentId` on the Validation Registry (see
    /// isValidationRequestValid) — reverts ValidationRequestInvalid otherwise.
    /// `IDENTITY_REGISTRY.ownerOf` reverting for an unregistered `sellerAgentId` doubles as
    /// the existence check, same pattern as SellerBond.deposit.
    function createJob(uint256 sellerAgentId, uint256 amount, uint64 completionDeadline, bytes32 validationRequestHash)
        external
        returns (uint256 jobId)
    {
        if (amount == 0) revert ZeroAmount();
        // Checked separately from ZeroAmount above, which still stands on its own since
        // minJobAmount may legitimately be configured to 0. See minJobAmount for why a floor
        // exists at all — it is a DoS defence, not a business rule.
        if (amount < minJobAmount) revert JobAmountTooSmall(amount, minJobAmount);
        if (completionDeadline <= block.timestamp) revert DeadlineNotInFuture(completionDeadline);
        // Upper-bounds completionDeadline so completionDeadline + responseWindow can never
        // overflow uint64 below (see MAX_JOB_DURATION) — without this, a deadline near
        // type(uint64).max would permanently lock this job's escrow and reserved bond, since
        // every exit path (release/dispute/claimTimeout, and transitively resolveDispute)
        // computes that same sum.
        uint64 maxCompletionDeadline = uint64(block.timestamp) + MAX_JOB_DURATION;
        if (completionDeadline > maxCompletionDeadline) {
            revert DeadlineTooFar(completionDeadline, maxCompletionDeadline);
        }
        if (address(sellerBond) == address(0)) revert SellerBondNotSet();
        // Hard gate, not swallowed: a revert here can't be distinguished from inside this
        // call ("seller never registered" vs. "registry is down"), so silently continuing
        // would make the check meaningless every time anything goes wrong — including a
        // seller skipping registration on purpose. validationRegistryEnabled (not a
        // try/catch here) is the actual answer to "the registry is down for a long time":
        // the owner flips it off in one transaction, and createJob stops depending on it
        // entirely until it's back.
        if (validationRegistryEnabled) {
            if (!isValidationRequestValid(validationRequestHash, sellerAgentId)) {
                revert ValidationRequestInvalid(validationRequestHash, sellerAgentId);
            }
        }
        // One requestHash, one job — see ValidationRequestHashAlreadyUsed. Gated on the hash
        // being non-zero rather than on validationRegistryEnabled: bytes32(0) is the
        // placeholder every job carries while the registry is disabled, so keying off the
        // flag would either let two real hashes collide across a toggle (one job's exit
        // attestation silently overwriting another's on the same hash) or, if marked
        // unconditionally, make the second placeholder job collide with the first. Checking
        // the hash itself is what actually distinguishes "no hash" from "a real hash."
        if (validationRequestHash != bytes32(0)) {
            if (validationRequestHashUsed[validationRequestHash]) {
                revert ValidationRequestHashAlreadyUsed(validationRequestHash);
            }
            validationRequestHashUsed[validationRequestHash] = true;
        }

        // Snapshotted now, not re-read at payout — see the Job struct's sellerPayoutAddress
        // comment for why a buyer's committed counterparty must survive a mid-job NFT
        // transfer unchanged.
        address sellerPayoutAddress = IDENTITY_REGISTRY.ownerOf(sellerAgentId);

        // Fixed for this job's lifetime (invariant 1) — the only amount ever reserved,
        // released, or slashed for it, regardless of later minBondRatioBps changes. Can be
        // zero when minBondRatioBps is 0 (see the guard below) — a deliberately supported
        // demo/testing configuration, not an edge case to reject.
        uint256 reservedBond = (amount * minBondRatioBps) / 10_000;
        // Integer division rounds down, so a small enough amount produces zero collateral
        // even though a non-zero ratio was configured — a job with no bond behind it, which
        // is precisely the thing this contract exists to prevent. Only reachable when the
        // owner has deliberately set minBondRatioBps to 0 otherwise (see BondRoundsToZero).
        if (minBondRatioBps > 0 && reservedBond == 0) revert BondRoundsToZero(amount, minBondRatioBps);

        jobId = nextJobId++;
        jobs[jobId] = Job({
            buyer: msg.sender,
            sellerAgentId: sellerAgentId,
            sellerPayoutAddress: sellerPayoutAddress,
            amount: amount,
            reservedBond: reservedBond,
            completionDeadline: completionDeadline,
            // Snapshotted once, here — see the Job struct's responseDeadline comment for why
            // a later change to the global responseWindow must never retroactively move this.
            responseDeadline: completionDeadline + responseWindow,
            status: JobStatus.Active,
            validationRequestHash: validationRequestHash,
            evidenceHash: bytes32(0)
        });

        emit JobCreated(jobId, msg.sender, sellerAgentId, amount, reservedBond, completionDeadline);

        // Interactions last. If the seller's free bond can't cover reservedBond,
        // sellerBond.reserve() reverts and unwinds the job creation atomically — no separate
        // ratio check needed here, SellerBond is the source of truth for its own balances.
        // Skipped entirely when reservedBond is zero (minBondRatioBps == 0): SellerBond
        // rejects zero-amount calls, and there is genuinely nothing to reserve.
        if (reservedBond > 0) {
            sellerBond.reserve(sellerAgentId, reservedBond);
        }
        USDC.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @dev Best-effort ERC-8004 attestation, called from release/resolveDispute/
    /// claimTimeout. By the time any of them call this, the job's fate is already decided
    /// by JobEscrow's own state — a Validation Registry failure here must never block a
    /// payout that's otherwise ready (invariant 3). Checks validationRegistryEnabled first
    /// so a known-disabled registry costs one SLOAD instead of a wasted external call that
    /// would just get swallowed anyway.
    function _attestValidation(bytes32 requestHash, uint8 response, bytes32 responseHash, string memory tag) internal {
        if (!validationRegistryEnabled) return;
        try VALIDATION_REGISTRY.validationResponse(requestHash, response, "", responseHash, tag) {} catch {}
    }

    /// @notice Buyer accepts delivery: pays the seller in full, releases the bond
    /// reservation. Only callable by the job's buyer, while Active, and only up to the
    /// job's snapshotted responseDeadline — past that point only claimTimeout applies
    /// (invariant 4: the two windows are mutually exclusive by construction).
    function release(uint256 jobId) external onlyBuyer(jobId) {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Active) revert JobNotActive(jobId, job.status);
        if (block.timestamp >= job.responseDeadline) {
            revert ResponseWindowElapsed(jobId, job.responseDeadline);
        }

        job.status = JobStatus.Released;
        emit JobReleased(jobId);

        // Skipped when reservedBond is zero (minBondRatioBps was 0 at creation) — nothing
        // was ever reserved, and SellerBond rejects zero-amount calls.
        if (job.reservedBond > 0) {
            sellerBond.releaseReservation(job.sellerAgentId, job.reservedBond);
        }
        USDC.safeTransfer(job.sellerPayoutAddress, job.amount);
        _attestValidation(job.validationRequestHash, 100, bytes32(0), "RELEASED");
    }

    /// @notice Buyer disputes instead of releasing: records evidenceHash on-chain (the hash,
    /// not raw evidence) and flips status to Disputed. No fund movement yet — that only
    /// happens at resolveDispute. Only callable by the job's buyer, while Active, and only up
    /// to the job's snapshotted responseDeadline — same window release() enforces, so the two
    /// buyer-facing choices share one deadline.
    function dispute(uint256 jobId, bytes32 evidenceHash) external onlyBuyer(jobId) {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Active) revert JobNotActive(jobId, job.status);
        if (block.timestamp >= job.responseDeadline) {
            revert ResponseWindowElapsed(jobId, job.responseDeadline);
        }

        job.status = JobStatus.Disputed;
        job.evidenceHash = evidenceHash;
        emit JobDisputed(jobId, evidenceHash);
    }

    /// @notice Arbiter resolves a dispute. sellerAtFault=true slashes the reserved bond to
    /// the buyer and separately refunds the escrowed amount; sellerAtFault=false pays the
    /// seller as if released normally. MVP: single arbiter address, disclosed as
    /// centralized-for-now. Unlike Active jobs there is no timeout rescue once Disputed — a
    /// disallowed dispute sits until the arbiter acts (see plans/08-disclosures.md).
    function resolveDispute(uint256 jobId, bool sellerAtFault) external onlyArbiter {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Disputed) revert JobNotDisputed(jobId, job.status);

        job.status = JobStatus.Resolved;
        emit JobResolved(jobId, sellerAtFault);

        if (sellerAtFault) {
            // Buyer receives two separate payments: the slashed bond straight from
            // SellerBond, plus the escrowed amount refunded from JobEscrow's own
            // holdings — real compensation on top of just getting their own money back.
            // Skipped when reservedBond is zero — see release()'s equivalent comment.
            if (job.reservedBond > 0) {
                sellerBond.slash(job.sellerAgentId, job.reservedBond, job.buyer);
            }
            USDC.safeTransfer(job.buyer, job.amount);
            // responseHash carries the buyer's actual dispute evidence hash here (not
            // bytes32(0), unlike the other three attestation call sites) — this is what
            // makes the at-fault attestation genuinely content-addressed and checkable by
            // other systems, not just a bare score.
            _attestValidation(job.validationRequestHash, 0, job.evidenceHash, "SELLER_AT_FAULT");
        } else {
            // The dispute didn't find the seller at fault, so they're paid exactly as if
            // the buyer had called release() — same two calls, same amounts.
            if (job.reservedBond > 0) {
                sellerBond.releaseReservation(job.sellerAgentId, job.reservedBond);
            }
            USDC.safeTransfer(job.sellerPayoutAddress, job.amount);
            _attestValidation(job.validationRequestHash, 100, bytes32(0), "DISPUTE_RESOLVED_SELLER");
        }
    }

    /// @notice Anyone may trigger auto-release to the seller once the job's snapshotted
    /// responseDeadline has passed with the buyer having done nothing — without this a buyer
    /// could grief a seller forever by simply not responding.
    function claimTimeout(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Active) revert JobNotActive(jobId, job.status);
        if (block.timestamp < job.responseDeadline) {
            revert ResponseWindowNotElapsed(jobId, job.responseDeadline);
        }

        job.status = JobStatus.TimedOut;
        emit JobTimedOut(jobId);

        if (job.reservedBond > 0) {
            sellerBond.releaseReservation(job.sellerAgentId, job.reservedBond);
        }
        USDC.safeTransfer(job.sellerPayoutAddress, job.amount);
        // response=50, not 100: a timeout means the buyer simply never responded, not that
        // delivery was confirmed good. Scoring it identically to a real release() would
        // overclaim quality nobody actually verified; 50 reads as "indeterminate" on the
        // registry's 0-100 scale.
        _attestValidation(job.validationRequestHash, 50, bytes32(0), "TIMED_OUT");
    }

    /// @notice Update the risk parameter controlling how much bond a job requires, as a
    /// fraction of job amount in basis points. Applies to jobs created after the change —
    /// already-active jobs keep their snapshotted reservedBond (invariant 1). Capped at
    /// MAX_MIN_BOND_RATIO_BPS.
    function setMinBondRatioBps(uint256 newRatioBps) external onlyOwner {
        if (newRatioBps > MAX_MIN_BOND_RATIO_BPS) {
            revert MinBondRatioTooHigh(newRatioBps, MAX_MIN_BOND_RATIO_BPS);
        }
        emit MinBondRatioBpsUpdated(minBondRatioBps, newRatioBps);
        minBondRatioBps = newRatioBps;
    }

    /// @notice Update the smallest job amount a buyer may create. Applies to jobs created
    /// after the change — already-active jobs are unaffected. Capped at MAX_MIN_JOB_AMOUNT.
    /// See minJobAmount for why this parameter exists (validation-hash burn DoS), which is
    /// also why it belongs to the owner rather than being a fixed constant: the right floor
    /// depends on what a seller's endpoints actually cost.
    function setMinJobAmount(uint256 newMinJobAmount) external onlyOwner {
        if (newMinJobAmount > MAX_MIN_JOB_AMOUNT) {
            revert MinJobAmountTooHigh(newMinJobAmount, MAX_MIN_JOB_AMOUNT);
        }
        emit MinJobAmountUpdated(minJobAmount, newMinJobAmount);
        minJobAmount = newMinJobAmount;
    }

    /// @notice Update the combined dispute window / timeout grace period. Applies to jobs
    /// created after the change — an already-active job's deadline math was fixed at its own
    /// completionDeadline, set at creation time. Capped at MAX_RESPONSE_WINDOW.
    function setResponseWindow(uint64 newWindow) external onlyOwner {
        if (newWindow > MAX_RESPONSE_WINDOW) {
            revert ResponseWindowTooLong(newWindow, MAX_RESPONSE_WINDOW);
        }
        emit ResponseWindowUpdated(responseWindow, newWindow);
        responseWindow = newWindow;
    }

    /// @notice Fast kill switch for the Validation Registry integration. Deliberately no
    /// timelock, unlike the withdrawal/dispute timelocks elsewhere: blast radius if this
    /// were compromised is low (worst case is jobs created without a registered validation
    /// request, or attestations silently not written — neither touches escrowed funds or
    /// the bond-ratio check), and the whole point is to be flippable in one transaction the
    /// moment the registry misbehaves, not gated behind a delay.
    function setValidationRegistryEnabled(bool enabled_) external onlyOwner {
        emit ValidationRegistryEnabledUpdated(validationRegistryEnabled, enabled_);
        validationRegistryEnabled = enabled_;
    }

    /// @notice True if `requestHash` names this JobEscrow as validator for `sellerAgentId`
    /// on the Validation Registry. Never reverts — an unregistered hash, or the registry
    /// itself reverting outright, both just resolve to false. Serves two callers: createJob
    /// uses it as its hard gate, and it's public so off-chain monitoring can call it too —
    /// e.g. checking the registry is healthy before a buyer ever hits a failing createJob,
    /// without needing a real failed transaction as the signal.
    function isValidationRequestValid(bytes32 requestHash, uint256 sellerAgentId) public view returns (bool) {
        try VALIDATION_REGISTRY.getValidationStatus(requestHash) returns (
            address validatorAddress, uint256 agentId, uint8, bytes32, string memory, uint256
        ) {
            return validatorAddress == address(this) && agentId == sellerAgentId;
        } catch {
            return false;
        }
    }
}
