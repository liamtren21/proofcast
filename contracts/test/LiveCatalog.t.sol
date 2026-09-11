// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./TestBase.t.sol";
import "../src/LiveShannonDreamDexCatalog.sol";

contract CatalogModule {
    IPCModuleState.Market private record;
    uint64 public nonce = 7;
    function set(address pool, address market) external {
        record.pool=pool; record.market=market; record.collateral=address(11);
        record.yesId=1; record.noId=2; record.tradingStart=90; record.expiry=200;
    }
    function markets(bytes32) external view returns(IPCModuleState.Market memory) { return record; }
    function marketNonce(bytes32) external view returns(uint64) { return nonce; }
    function roll() external { nonce++; }
}
contract CatalogPool {
    address public market;
    constructor(address market_) { market=market_; }
    function getBinaryPoolParams() external view returns(IPCPoolState.Params memory p) {
        p.market=market; p.collateralToken=address(11); p.outcomeToken=address(12);
        p.settlement=address(13); p.yesId=1; p.noId=2; p.oneCollateral=1e6; p.marketNonce=7;
    }
    function marketExpiryNs() external pure returns(uint64) { return 200e9; }
}
contract CatalogMarket { function status() external pure returns(uint8) { return 1; } }
contract LiveCatalogTest is TestBase {
    CatalogModule module;
    CatalogPool pool;
    LiveShannonDreamDexCatalog catalog;
    function setUp() public {
        vm.warp(100);
        module=new CatalogModule(); pool=new CatalogPool(address(new CatalogMarket()));
        module.set(address(pool),pool.market());
        catalog=new LiveShannonDreamDexCatalog(address(module),address(11),address(12),address(13));
    }
    function current(uint64 generation, uint64 start, uint64 cutoff, uint64 expiry) internal view returns(bool) {
        return catalog.isCurrentMarket(bytes32(uint256(1)),generation,address(pool),address(module),start,cutoff,expiry);
    }
    function testAcceptsCurrentNativeMarket() public view { assertTrue(current(7,90,190,200)); }
    function testRejectsExpiredMarket() public { vm.warp(200); assertTrue(!current(7,90,190,200)); }
    function testRejectsRolledGeneration() public { module.roll(); assertTrue(!current(7,90,190,200)); }
    function testRejectsForgedWindow() public view { assertTrue(!current(7,91,190,200)); assertTrue(!current(7,90,190,201)); }
    function testRejectsWrongModuleAndPool() public view {
        assertTrue(!catalog.isCurrentMarket(bytes32(uint256(1)),7,address(pool),address(22),90,190,200));
        assertTrue(!catalog.isCurrentMarket(bytes32(uint256(1)),7,address(23),address(module),90,190,200));
    }
}
