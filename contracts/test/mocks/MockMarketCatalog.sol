// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockMarketCatalog {
    mapping(bytes32 => mapping(uint64 => mapping(address => mapping(address => bool)))) public current;

    function setCurrent(bytes32 marketId, uint64 generation, address pool, address module) external {
        current[marketId][generation][pool][module] = true;
    }

    function isCurrentMarket(bytes32 marketId, uint64 generation, address pool, address module, uint64, uint64, uint64)
        external
        view
        returns (bool)
    {
        return current[marketId][generation][pool][module];
    }
}
