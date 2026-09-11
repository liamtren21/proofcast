// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProofCastRegistry} from "./ProofCastRegistry.sol";

/// @notice Explicit self-controlled testnet creator, not a second independent user.
/// @dev Has no custody or follower privileges; it can only publish its owner's test session.
contract ProofCastDemoCreator {
    address public immutable owner;
    ProofCastRegistry public immutable registry;
    constructor(address registry_) { owner=msg.sender;registry=ProofCastRegistry(registry_); }
    modifier onlyOwner(){require(msg.sender==owner,"owner");_;}
    function register(bytes32 id,bytes32 manifestHash,bytes32 termsHash,ProofCastRegistry.MarketRef[] calldata refs,uint64 enrollUntil,uint64 sessionUntil) external onlyOwner {
        registry.registerSession(id,manifestHash,termsHash,refs,enrollUntil,sessionUntil);
    }
    function publish(bytes32 sessionId,bytes32 marketId,ProofCastRegistry.SignalSide side,uint256 price,uint64 validUntil,bytes32 evidenceHash) external onlyOwner {
        registry.publishSignal(sessionId,marketId,side,price,validUntil,evidenceHash);
    }
}
