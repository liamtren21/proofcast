// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./TestBase.t.sol";
import "./mocks/MockMarketCatalog.sol";
import "../src/ProofCastDemoCreator.sol";
contract DemoCreatorTest is TestBase {
    function testOnlyOwnerCanRegisterAndPublishAndHistoryStaysImmutable() public {
        vm.warp(100);
        MockMarketCatalog catalog=new MockMarketCatalog();
        ProofCastRegistry registry=new ProofCastRegistry(address(catalog));
        ProofCastDemoCreator creator=new ProofCastDemoCreator(address(registry));
        bytes32 market=bytes32("market");bytes32 session=bytes32("session");
        catalog.setCurrent(market,1,address(0x1001),address(0x2001));
        ProofCastRegistry.MarketRef[] memory refs=new ProofCastRegistry.MarketRef[](1);
        refs[0]=ProofCastRegistry.MarketRef(market,1,address(0x1001),address(0x2001),address(0x3001),address(0x4001),1,2,7,bytes32("venue"),101,150,180);
        vm.prank(address(0xBAD));vm.expectRevert();creator.register(session,bytes32("manifest"),bytes32("terms"),refs,110,190);
        creator.register(session,bytes32("manifest"),bytes32("terms"),refs,110,190);
        assertEq(registry.creatorOf(session),address(creator));
        vm.warp(120);
        vm.prank(address(0xBAD));vm.expectRevert();creator.publish(session,market,ProofCastRegistry.SignalSide.YES,500000,160,bytes32("proof"));
        creator.publish(session,market,ProofCastRegistry.SignalSide.YES,500000,160,bytes32("proof"));
        assertEq(registry.signal(session,market).price,500000);
        vm.expectRevert();creator.publish(session,market,ProofCastRegistry.SignalSide.NO,400000,160,bytes32("revision"));
    }
}
