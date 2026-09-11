// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProofCastNativeAdapter, IERC20ProofCastV2} from "../../src/ProofCastInterfaces.sol";

contract MockNativeAdapter is IProofCastNativeAdapter {
    mapping(address => bool) public registeredVaults;
    address public recoveryToken;
    uint256 public nextCost;
    uint256 public nextFill;
    ExecutionStatus public nextStatus;
    uint128 public nextOrderId;
    uint256 public nextRecoveryCash;
    ExecutionStatus public nextRecoveryStatus;

    function registerVault(address vault) external {
        registeredVaults[vault] = true;
    }

    function setRecoveryToken(address token) external {
        recoveryToken = token;
    }

    function setNextTrade(uint256 cost, uint256 fill, ExecutionStatus status, uint128 orderId) external {
        nextCost = cost;
        nextFill = fill;
        nextStatus = status;
        nextOrderId = orderId;
    }

    function setNextRecovery(uint256 cashDelta, ExecutionStatus status) external {
        nextRecoveryCash = cashDelta;
        nextRecoveryStatus = status;
    }

    function placeBuyIoc(TradeRequest calldata request) external returns (TradeResult memory result) {
        require(registeredVaults[msg.sender], "vault");
        require(
            request.collateral != address(0) && request.pool != address(0) && request.resolutionModule != address(0),
            "typed request"
        );
        if (nextCost > 0) {
            require(IERC20ProofCastV2(request.collateral).transferFrom(msg.sender, address(this), nextCost), "cost");
        }
        result = TradeResult(nextStatus, nextCost, nextFill, nextOrderId);
    }

    function recover(RecoveryRequest calldata request) external returns (RecoveryResult memory result) {
        require(registeredVaults[msg.sender] && recoveryToken != address(0), "vault");
        require(request.marketId != bytes32(0) && request.positionAmount > 0, "recovery request");
        if (nextRecoveryCash > 0) {
            require(IERC20ProofCastV2(recoveryToken).transfer(msg.sender, nextRecoveryCash), "cash");
        }
        result = RecoveryResult(nextRecoveryStatus, nextRecoveryCash, request.positionAmount);
    }

    function supportsRecovery(address, bytes32, uint64) external pure returns (bool) {
        return true;
    }
}
