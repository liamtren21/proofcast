// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProofCastFollowerVault} from "../src/ProofCastFollowerVault.sol";
import {IProofCastNativeAdapter} from "../src/ProofCastInterfaces.sol";
import {MockNativeAdapter} from "./mocks/MockNativeAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {TestBase} from "./TestBase.t.sol";

contract LifetimeRiskTest is TestBase {
    MockERC20 token;
    MockNativeAdapter adapter;
    ProofCastFollowerVault vault;
    function setUp() public {
        token = new MockERC20();
        adapter = new MockNativeAdapter();
        vault = new ProofCastFollowerVault(address(this),address(this),address(adapter),address(token),bytes32("s"),bytes32("e"));
        adapter.registerVault(address(vault));
        adapter.setRecoveryToken(address(token));
        token.mint(address(this),10_000_000);
        token.approve(address(vault),10_000_000);
        vault.deposit(10_000_000);
        vault.initializePolicy(ProofCastFollowerVault.Policy(3,600_000,600_000,1_000_000,2_000_000,uint64(block.timestamp+1 days),bytes32("terms"),1,true));
    }
    function request(bytes32 market, uint8 side) internal view returns(IProofCastNativeAdapter.TradeRequest memory r) {
        r = IProofCastNativeAdapter.TradeRequest(address(token),address(0x111),address(0x222),market,1,7,bytes32("venue"),side,500_000,2_000_000,uint64((block.timestamp+1 hours)*1e9),side);
    }
    function testRealizedLossCannotBeReusedAsBudget() public {
        adapter.setNextTrade(1_000_000,2_000_000,IProofCastNativeAdapter.ExecutionStatus.FILLED,1);
        vault.executeTrade(request(bytes32("m1"),1));
        adapter.setNextRecovery(0,IProofCastNativeAdapter.ExecutionStatus.RECOVERED);
        vault.recover(bytes32("m1"));
        vault.executeTrade(request(bytes32("m2"),1));
        vault.recover(bytes32("m2"));
        assertEq(vault.realizedLoss(),2_000_000);
        assertEq(vault.openRisk(),0);
        vm.expectRevert();
        vault.previewTrade(1,500_000,bytes32("m3"),1);
        vm.expectRevert();
        vault.executeTrade(request(bytes32("m3"),1));
    }
    function testOppositeSideCannotOverwriteUnrecoveredPosition() public {
        adapter.setNextTrade(100_000,200_000,IProofCastNativeAdapter.ExecutionStatus.PARTIAL_FILL,1);
        vault.executeTrade(request(bytes32("m1"),1));
        vm.expectRevert();
        vault.executeTrade(request(bytes32("m1"),2));
    }
    function testFractionalCostIsRoundedUpBeforeApproval() public {
        IProofCastNativeAdapter.TradeRequest memory r=request(bytes32("m1"),1);
        r.price=333_333;
        r.quantity=3;
        adapter.setNextTrade(1,3,IProofCastNativeAdapter.ExecutionStatus.FILLED,1);
        vault.executeTrade(r);
        assertEq(vault.openRisk(),1);
        assertEq(token.allowance(address(vault),address(adapter)),0);
    }
    function testUnusedCashCanBeWithdrawnWhilePositionRemainsRecoverable() public {
        adapter.setNextTrade(1_000_000,2_000_000,IProofCastNativeAdapter.ExecutionStatus.FILLED,1);
        vault.executeTrade(request(bytes32("m1"),1));
        vault.revoke();
        vault.withdraw(9_000_000);
        assertEq(token.balanceOf(address(vault)),0);
        assertEq(vault.openRisk(),1_000_000);
        adapter.setNextRecovery(500_000,IProofCastNativeAdapter.ExecutionStatus.RECOVERED);
        vault.recover(bytes32("m1"));
        vault.withdraw(500_000);
        assertEq(vault.openRisk(),0);
        assertEq(vault.realizedLoss(),500_000);
    }
    function testRemainingCashCanFundNextOrderWithoutDoubleCountingSpentRisk() public {
        vault.withdraw(8_000_000);
        adapter.setNextTrade(1_000_000,2_000_000,IProofCastNativeAdapter.ExecutionStatus.FILLED,1);
        vault.executeTrade(request(bytes32("m1"),1));
        (uint256 quantity,uint256 cost)=vault.previewTrade(1,500_000,bytes32("m2"),1);
        assertEq(quantity,2_000_000);assertEq(cost,1_000_000);
        vault.executeTrade(request(bytes32("m2"),1));
        assertEq(vault.openRisk(),2_000_000);assertEq(token.balanceOf(address(vault)),0);
        vm.expectRevert();vault.executeTrade(request(bytes32("m3"),1));
    }
}
