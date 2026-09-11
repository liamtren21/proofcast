// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20ProofCastV2, IProofCastNativeAdapter} from "./ProofCastInterfaces.sol";

/// @notice One follower's collateral and policy. No creator or executor can withdraw it.
contract ProofCastFollowerVault {
    uint256 public constant PRICE_SCALE = 1_000_000;

    struct Policy {
        uint8 allowedSideMask;
        uint256 maxYesPrice;
        uint256 maxNoPrice;
        uint256 maxOrderCost;
        uint256 totalRiskBudget;
        uint64 validUntil;
        bytes32 termsHash;
        uint256 nonce;
        bool active;
    }

    struct ExecutionRecord {
        bytes32 marketId;
        uint8 side;
        uint256 quotedPrice;
        uint256 requestedQuantity;
        uint256 actualCost;
        uint256 filledAmount;
        IProofCastNativeAdapter.ExecutionStatus status;
        uint128 nativeOrderId;
    }

    struct RecoveryConfig {
        address resolutionModule;
        uint32 operatorId;
        bytes32 venueId;
        uint64 generation;
        uint8 outcomeIndex;
        uint256 positionAmount;
        uint256 costBasis;
        bool resolved;
    }

    error Unauthorized();
    error InvalidPolicy();
    error PolicyLocked();
    error PolicyRevoked();
    error InvalidTrade();
    error InsufficientFreeCash();
    error InvalidDelta();
    error RecoveryUnavailable();

    address public immutable owner;
    address public immutable beneficiary;
    address public immutable executor;
    IProofCastNativeAdapter public immutable adapter;
    IERC20ProofCastV2 public immutable collateral;
    bytes32 public immutable sessionId;
    bytes32 public immutable enrollmentId;
    Policy public policy;
    bool public revoked;
    uint256 public openRisk;
    uint256 public realizedLoss;
    uint256 public totalSpent;
    uint256 public executionCount;
    uint256 public recoveryCount;

    mapping(uint256 => ExecutionRecord) public executions;
    mapping(bytes32 => uint256) public marketOpenRisk;
    mapping(bytes32 => RecoveryConfig) public recoveryConfigs;

    event Deposited(address indexed follower, uint256 requested, uint256 actualDelta);
    event Withdrawn(address indexed follower, uint256 actualDelta);
    event PolicyActivated(bytes32 indexed enrollmentId, uint256 nonce);
    event Revoked(bytes32 indexed enrollmentId, uint256 timestamp);
    event ExecutionRecorded(
        bytes32 indexed enrollmentId,
        bytes32 indexed marketId,
        uint256 indexed executionId,
        IProofCastNativeAdapter.ExecutionStatus status,
        uint256 actualCost,
        uint256 filledAmount,
        uint128 nativeOrderId
    );
    event RecoveryObserved(
        bytes32 indexed enrollmentId,
        bytes32 indexed marketId,
        IProofCastNativeAdapter.ExecutionStatus status,
        uint256 cashDelta,
        uint256 recoveredPosition
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert Unauthorized();
        _;
    }

    constructor(
        address owner_,
        address executor_,
        address adapter_,
        address collateral_,
        bytes32 sessionId_,
        bytes32 enrollmentId_
    ) {
        if (
            owner_ == address(0) || executor_ == address(0) || adapter_ == address(0) || collateral_ == address(0)
                || sessionId_ == bytes32(0) || enrollmentId_ == bytes32(0)
        ) revert InvalidPolicy();
        owner = owner_;
        beneficiary = owner_;
        executor = executor_;
        adapter = IProofCastNativeAdapter(adapter_);
        collateral = IERC20ProofCastV2(collateral_);
        sessionId = sessionId_;
        enrollmentId = enrollmentId_;
    }

    function deposit(uint256 amount) external onlyOwner returns (uint256 actualDelta) {
        uint256 beforeBalance = collateral.balanceOf(address(this));
        if (!collateral.transferFrom(msg.sender, address(this), amount)) revert InvalidDelta();
        uint256 afterBalance = collateral.balanceOf(address(this));
        if (afterBalance < beforeBalance) revert InvalidDelta();
        actualDelta = afterBalance - beforeBalance;
        emit Deposited(msg.sender, amount, actualDelta);
    }

    function withdraw(uint256 amount) external onlyOwner {
        uint256 balance = collateral.balanceOf(address(this));
        // IOC risk is collateral already spent, not a claim against remaining cash.
        if (amount > balance) revert InsufficientFreeCash();
        uint256 beforeBalance = balance;
        if (!collateral.transfer(owner, amount)) revert InvalidDelta();
        uint256 afterBalance = collateral.balanceOf(address(this));
        if (beforeBalance - afterBalance != amount) revert InvalidDelta();
        emit Withdrawn(owner, amount);
    }

    function initializePolicy(Policy calldata nextPolicy) external onlyExecutor {
        if (policy.active || policy.termsHash != bytes32(0)) revert PolicyLocked();
        if (
            nextPolicy.allowedSideMask == 0 || nextPolicy.allowedSideMask > 3 || nextPolicy.maxYesPrice == 0
                || nextPolicy.maxYesPrice > PRICE_SCALE || nextPolicy.maxNoPrice == 0
                || nextPolicy.maxNoPrice > PRICE_SCALE || nextPolicy.maxOrderCost == 0
                || nextPolicy.totalRiskBudget == 0 || nextPolicy.validUntil <= block.timestamp
                || nextPolicy.termsHash == bytes32(0)
        ) revert InvalidPolicy();
        policy = nextPolicy;
        policy.active = true;
        emit PolicyActivated(enrollmentId, nextPolicy.nonce);
    }

    function revoke() external {
        if (msg.sender != owner && msg.sender != executor) revert Unauthorized();
        if (!policy.active || revoked) revert PolicyLocked();
        revoked = true;
        emit Revoked(enrollmentId, block.timestamp);
    }

    function previewTrade(uint8 side, uint256 price, bytes32 marketId, uint64 generation)
        external
        view
        returns (uint256 quantity, uint256 maxCost)
    {
        if (
            marketId == bytes32(0) || generation == 0 || !policy.active || revoked
                || block.timestamp > policy.validUntil
        ) revert InvalidTrade();
        _checkSideAndPrice(side, price);
        uint256 remaining = _remainingRisk();
        maxCost = policy.maxOrderCost < remaining ? policy.maxOrderCost : remaining;
        uint256 balance = collateral.balanceOf(address(this));
        uint256 available = balance;
        if (maxCost > available) maxCost = available;
        quantity = (maxCost * PRICE_SCALE) / price;
        if (quantity == 0 || (price * quantity) / PRICE_SCALE == 0) revert InvalidTrade();
    }

    function executeTrade(IProofCastNativeAdapter.TradeRequest calldata request)
        external
        onlyExecutor
        returns (IProofCastNativeAdapter.TradeResult memory result)
    {
        if (!policy.active || revoked || block.timestamp > policy.validUntil) revert InvalidTrade();
        _checkSideAndPrice(request.side, request.price);
        if (
            request.collateral != address(collateral) || request.resolutionModule == address(0)
                || request.marketId == bytes32(0) || request.generation == 0 || request.quantity == 0
                || request.expiryNs <= uint64(block.timestamp) * 1e9
        ) revert InvalidTrade();
        uint256 expectedCost = (request.price * request.quantity + PRICE_SCALE - 1) / PRICE_SCALE;
        if (expectedCost == 0 || expectedCost > policy.maxOrderCost || expectedCost > _remainingRisk())
        {
            revert InvalidTrade();
        }
        RecoveryConfig storage existing = recoveryConfigs[request.marketId];
        if (existing.positionAmount != 0 && (
            existing.resolutionModule != request.resolutionModule || existing.generation != request.generation
            || existing.operatorId != request.operatorId || existing.venueId != request.venueId
            || existing.outcomeIndex != (request.side == 1 ? 0 : 1)
        )) revert InvalidTrade();
        uint256 beforeBalance = collateral.balanceOf(address(this));
        if (beforeBalance < expectedCost) revert InsufficientFreeCash();
        if (!collateral.approve(address(adapter), expectedCost)) revert InvalidDelta();
        result = adapter.placeBuyIoc(request);
        uint256 afterBalance = collateral.balanceOf(address(this));
        if (afterBalance > beforeBalance) revert InvalidDelta();
        uint256 actualCost = beforeBalance - afterBalance;
        if (actualCost != result.actualCost || actualCost > expectedCost || result.filledAmount > request.quantity) {
            revert InvalidDelta();
        }
        if (
            result.status == IProofCastNativeAdapter.ExecutionStatus.ZERO_FILL
                || result.status == IProofCastNativeAdapter.ExecutionStatus.SUBMITTED
        ) {
            if (actualCost != 0 || result.filledAmount != 0) revert InvalidDelta();
        }
        if (result.status == IProofCastNativeAdapter.ExecutionStatus.PARTIAL_FILL) {
            if (actualCost == 0 || result.filledAmount == 0 || result.filledAmount >= request.quantity) {
                revert InvalidDelta();
            }
        }
        if (result.status == IProofCastNativeAdapter.ExecutionStatus.FILLED) {
            if (actualCost == 0 || result.filledAmount != request.quantity) revert InvalidDelta();
        }
        if (
            result.status == IProofCastNativeAdapter.ExecutionStatus.PAYOUT_PENDING
                || result.status == IProofCastNativeAdapter.ExecutionStatus.RECOVERED
        ) revert InvalidDelta();
        if (
            actualCost == 0
                && (result.status == IProofCastNativeAdapter.ExecutionStatus.FILLED
                    || result.status == IProofCastNativeAdapter.ExecutionStatus.PARTIAL_FILL)
        ) revert InvalidDelta();
        if (
            actualCost > 0 && result.status != IProofCastNativeAdapter.ExecutionStatus.FILLED
                && result.status != IProofCastNativeAdapter.ExecutionStatus.PARTIAL_FILL
        ) revert InvalidDelta();
        if (!collateral.approve(address(adapter), 0)) revert InvalidDelta();

        openRisk += actualCost;
        marketOpenRisk[request.marketId] += actualCost;
        totalSpent += actualCost;
        executionCount += 1;
        executions[executionCount] = ExecutionRecord(
            request.marketId,
            request.side,
            request.price,
            request.quantity,
            actualCost,
            result.filledAmount,
            result.status,
            result.nativeOrderId
        );
        if (result.filledAmount > 0) {
            RecoveryConfig storage recovery = recoveryConfigs[request.marketId];
            if (recovery.resolved) recovery.resolved = false;
            recovery.positionAmount += result.filledAmount;
            recovery.costBasis += actualCost;
            recovery.resolutionModule = request.resolutionModule;
            recovery.operatorId = request.operatorId;
            recovery.venueId = request.venueId;
            recovery.generation = request.generation;
            recovery.outcomeIndex = request.side == 1 ? 0 : 1;
        }
        emit ExecutionRecorded(
            enrollmentId,
            request.marketId,
            executionCount,
            result.status,
            actualCost,
            result.filledAmount,
            result.nativeOrderId
        );
    }

    function recover(bytes32 marketId) external returns (IProofCastNativeAdapter.RecoveryResult memory result) {
        RecoveryConfig storage config = recoveryConfigs[marketId];
        if (config.resolved || config.positionAmount == 0 || config.resolutionModule == address(0)) {
            revert RecoveryUnavailable();
        }
        if (!adapter.supportsRecovery(config.resolutionModule, marketId, config.generation)) {
            revert RecoveryUnavailable();
        }
        uint256 beforeBalance = collateral.balanceOf(address(this));
        result = adapter.recover(
            IProofCastNativeAdapter.RecoveryRequest({
                resolutionModule: config.resolutionModule,
                operatorId: config.operatorId,
                venueId: config.venueId,
                marketId: marketId,
                generation: config.generation,
                outcomeIndex: config.outcomeIndex,
                positionAmount: config.positionAmount,
                recoveryNonce: recoveryCount + 1
            })
        );
        uint256 afterBalance = collateral.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != result.cashDelta) revert InvalidDelta();
        emit RecoveryObserved(enrollmentId, marketId, result.status, result.cashDelta, result.recoveredPosition);
        if (result.status == IProofCastNativeAdapter.ExecutionStatus.RECOVERED) {
            if (result.recoveredPosition != config.positionAmount) revert InvalidDelta();
            uint256 basis = config.costBasis;
            if (openRisk < basis) revert InvalidDelta();
            openRisk -= basis;
            if (marketOpenRisk[marketId] < basis) revert InvalidDelta();
            marketOpenRisk[marketId] -= basis;
            if (result.cashDelta < basis) realizedLoss += basis - result.cashDelta;
            config.positionAmount = 0;
            config.costBasis = 0;
            config.resolved = true;
            recoveryCount += 1;
        } else if (result.status == IProofCastNativeAdapter.ExecutionStatus.PAYOUT_PENDING) {
            if (result.cashDelta != 0 || result.recoveredPosition != 0) revert InvalidDelta();
        } else {
            revert RecoveryUnavailable();
        }
    }

    function _remainingRisk() internal view returns (uint256) {
        if (realizedLoss > policy.totalRiskBudget || openRisk > policy.totalRiskBudget - realizedLoss) return 0;
        return policy.totalRiskBudget - realizedLoss - openRisk;
    }

    function _checkSideAndPrice(uint8 side, uint256 price) internal view {
        if (side == 1) {
            if ((policy.allowedSideMask & 1) == 0 || price == 0 || price > policy.maxYesPrice) revert InvalidTrade();
        } else if (side == 2) {
            if ((policy.allowedSideMask & 2) == 0 || price == 0 || price > policy.maxNoPrice) revert InvalidTrade();
        } else {
            revert InvalidTrade();
        }
    }
}
