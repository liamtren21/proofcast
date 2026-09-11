// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProofCastMarketCatalog} from "./ProofCastRegistry.sol";

/// @notice Immutable Shannon binding for the verified DreamDEX market.
/// @dev The indexer exposes tradingStart/expiry, but not decisionCutoff. The
///      catalog therefore accepts any cutoff inside the verified trading window
///      and rejects every other market identity.
contract ShannonDreamDexCatalog is IProofCastMarketCatalog {
    bytes32 public immutable marketId;
    uint64 public immutable generation;
    address public immutable pool;
    address public immutable module;
    uint64 public immutable tradingStart;
    uint64 public immutable expiry;

    constructor(bytes32 marketId_, uint64 generation_, address pool_, address module_, uint64 tradingStart_, uint64 expiry_) {
        require(marketId_ != bytes32(0) && generation_ != 0 && pool_ != address(0) && module_ != address(0));
        require(tradingStart_ < expiry_);
        marketId = marketId_;
        generation = generation_;
        pool = pool_;
        module = module_;
        tradingStart = tradingStart_;
        expiry = expiry_;
    }

    function isCurrentMarket(
        bytes32 marketId_,
        uint64 generation_,
        address pool_,
        address module_,
        uint64 tradingStart_,
        uint64 decisionCutoff_,
        uint64 expiry_
    ) external view returns (bool) {
        return marketId_ == marketId && generation_ == generation && pool_ == pool && module_ == module
            && tradingStart_ == tradingStart && expiry_ == expiry && decisionCutoff_ >= tradingStart
            && decisionCutoff_ < expiry;
    }
}
