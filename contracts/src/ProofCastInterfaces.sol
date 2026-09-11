// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20ProofCastV2 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IProofCastNativeAdapter {
    enum ExecutionStatus {
        ZERO_FILL,
        PARTIAL_FILL,
        FILLED,
        SUBMITTED,
        PAYOUT_PENDING,
        RECOVERED
    }

    struct TradeRequest {
        address collateral;
        address pool;
        address resolutionModule;
        bytes32 marketId;
        uint64 generation;
        uint32 operatorId;
        bytes32 venueId;
        uint8 side;
        uint256 price;
        uint256 quantity;
        uint64 expiryNs;
        uint256 outcomeTokenId;
    }

    struct TradeResult {
        ExecutionStatus status;
        uint256 actualCost;
        uint256 filledAmount;
        uint128 nativeOrderId;
    }

    struct RecoveryRequest {
        address resolutionModule;
        uint32 operatorId;
        bytes32 venueId;
        bytes32 marketId;
        uint64 generation;
        uint8 outcomeIndex;
        uint256 positionAmount;
        uint256 recoveryNonce;
    }

    struct RecoveryResult {
        ExecutionStatus status;
        uint256 cashDelta;
        uint256 recoveredPosition;
    }

    function placeBuyIoc(TradeRequest calldata request) external returns (TradeResult memory);
    function recover(RecoveryRequest calldata request) external returns (RecoveryResult memory);
    function supportsRecovery(address resolutionModule, bytes32 marketId, uint64 generation)
        external
        view
        returns (bool);
}
