// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProofCastRegistry} from "./ProofCastRegistry.sol";
import {ProofCastFollowerVault} from "./ProofCastFollowerVault.sol";
import {IProofCastNativeAdapter} from "./ProofCastInterfaces.sol";

interface IProofCastExecutorFactory {
    function vaultFor(bytes32 enrollmentId) external view returns (address);
}

/// @notice Derives the native trade from anchored signal + follower policy.
contract ProofCastExecutor {
    struct Policy {
        uint8 allowedSideMask;
        uint256 maxYesPrice;
        uint256 maxNoPrice;
        uint256 maxOrderCost;
        uint256 totalRiskBudget;
        uint64 validUntil;
        bytes32 termsHash;
        uint256 nonce;
    }

    struct Enrollment {
        bytes32 sessionId;
        address follower;
        address vault;
        bool active;
    }

    error Unauthorized();
    error InvalidEnrollment();
    error NotExecutableSignal();
    error AlreadyExecuted();
    error InvalidFactory();

    address public immutable owner;
    ProofCastRegistry public immutable registry;
    IProofCastNativeAdapter public immutable adapter;
    address public factory;
    mapping(bytes32 => Enrollment) public enrollments;
    mapping(bytes32 => mapping(bytes32 => bool)) public consumedSignals;

    event FactorySet(address indexed factory);
    event Enrolled(
        bytes32 indexed enrollmentId, bytes32 indexed sessionId, address indexed follower, address vault, uint256 nonce
    );
    event EnrollmentRevoked(bytes32 indexed enrollmentId, address indexed follower);
    event ExecutionSubmitted(
        bytes32 indexed enrollmentId,
        bytes32 indexed marketId,
        IProofCastNativeAdapter.ExecutionStatus status,
        uint256 actualCost,
        uint256 filledAmount
    );

    constructor(address registry_, address adapter_) {
        if (registry_ == address(0) || adapter_ == address(0)) revert InvalidEnrollment();
        owner = msg.sender;
        registry = ProofCastRegistry(registry_);
        adapter = IProofCastNativeAdapter(adapter_);
    }

    function setFactory(address factory_) external {
        if (msg.sender != owner || factory != address(0) || factory_ == address(0)) revert Unauthorized();
        factory = factory_;
        emit FactorySet(factory_);
    }

    function enroll(bytes32 enrollmentId, Policy calldata requested) external {
        if (factory == address(0)) revert InvalidFactory();
        address vaultAddress = IProofCastExecutorFactory(factory).vaultFor(enrollmentId);
        if (vaultAddress == address(0)) revert InvalidEnrollment();
        ProofCastFollowerVault vault = ProofCastFollowerVault(vaultAddress);
        if (msg.sender != vault.owner() || enrollments[enrollmentId].vault != address(0)) revert Unauthorized();
        bytes32 sessionId = vault.sessionId();
        registry.assertEnrollmentOpen(sessionId);
        if (msg.sender == registry.creatorOf(sessionId) || requested.termsHash != registry.termsHashOf(sessionId)) {
            revert InvalidEnrollment();
        }
        if (requested.validUntil > registry.sessionUntilOf(sessionId)) revert InvalidEnrollment();
        if (address(vault.collateral()) != registry.marketRef(sessionId, 0).collateral) revert InvalidEnrollment();
        vault.initializePolicy(
            ProofCastFollowerVault.Policy({
                allowedSideMask: requested.allowedSideMask,
                maxYesPrice: requested.maxYesPrice,
                maxNoPrice: requested.maxNoPrice,
                maxOrderCost: requested.maxOrderCost,
                totalRiskBudget: requested.totalRiskBudget,
                validUntil: requested.validUntil,
                termsHash: requested.termsHash,
                nonce: requested.nonce,
                active: false
            })
        );
        enrollments[enrollmentId] = Enrollment(sessionId, msg.sender, vaultAddress, true);
        emit Enrolled(enrollmentId, sessionId, msg.sender, vaultAddress, requested.nonce);
    }

    function revokeEnrollment(bytes32 enrollmentId) external {
        Enrollment storage enrollment = enrollments[enrollmentId];
        if (msg.sender != enrollment.follower || enrollment.vault == address(0)) revert Unauthorized();
        ProofCastFollowerVault(enrollment.vault).revoke();
        enrollment.active = false;
        emit EnrollmentRevoked(enrollmentId, msg.sender);
    }

    function execute(bytes32 enrollmentId, bytes32 marketId)
        external
        returns (IProofCastNativeAdapter.TradeResult memory result)
    {
        Enrollment memory enrollment = enrollments[enrollmentId];
        if (
            !enrollment.active || enrollment.vault == address(0) || consumedSignals[enrollmentId][marketId]
                || registry.isWithdrawn(enrollment.sessionId)
        ) revert AlreadyExecuted();
        ProofCastRegistry.MarketRef memory market = registry.marketRefFor(enrollment.sessionId, marketId);
        ProofCastRegistry.Signal memory signal = registry.signal(enrollment.sessionId, marketId);
        if (
            signal.signalId == bytes32(0) || signal.side == ProofCastRegistry.SignalSide.ABSTAIN
                || signal.side == ProofCastRegistry.SignalSide.NONE || block.timestamp > signal.validUntil
        ) revert NotExecutableSignal();
        (uint256 quantity,) = ProofCastFollowerVault(enrollment.vault)
            .previewTrade(uint8(signal.side), signal.price, marketId, market.generation);
        if (signal.validUntil > type(uint64).max / 1e9) revert NotExecutableSignal();
        IProofCastNativeAdapter.TradeRequest memory request = IProofCastNativeAdapter.TradeRequest({
            collateral: market.collateral,
            pool: market.pool,
            resolutionModule: market.module,
            marketId: marketId,
            generation: market.generation,
            operatorId: market.operatorId,
            venueId: market.venueId,
            side: uint8(signal.side),
            price: signal.price,
            quantity: quantity,
            expiryNs: uint64(uint256(signal.validUntil) * 1e9),
            outcomeTokenId: signal.side == ProofCastRegistry.SignalSide.YES ? market.yesId : market.noId
        });
        result = ProofCastFollowerVault(enrollment.vault).executeTrade(request);
        consumedSignals[enrollmentId][marketId] = true;
        emit ExecutionSubmitted(enrollmentId, marketId, result.status, result.actualCost, result.filledAmount);
    }

    function recover(bytes32 enrollmentId, bytes32 marketId)
        external
        returns (IProofCastNativeAdapter.RecoveryResult memory result)
    {
        Enrollment memory enrollment = enrollments[enrollmentId];
        if (enrollment.vault == address(0)) revert InvalidEnrollment();
        result = ProofCastFollowerVault(enrollment.vault).recover(marketId);
    }
}
