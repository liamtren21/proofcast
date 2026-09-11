// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProofCastRegistry} from "../src/ProofCastRegistry.sol";
import {ProofCastFactory} from "../src/ProofCastFactory.sol";
import {ProofCastExecutor} from "../src/ProofCastExecutor.sol";
import {ProofCastFollowerVault} from "../src/ProofCastFollowerVault.sol";
import {IProofCastNativeAdapter} from "../src/ProofCastInterfaces.sol";
import {MockMarketCatalog} from "./mocks/MockMarketCatalog.sol";
import {MockNativeAdapter} from "./mocks/MockNativeAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {TestBase} from "./TestBase.t.sol";

contract ExecutionTest is TestBase {
    MockMarketCatalog internal catalog;
    MockNativeAdapter internal adapter;
    MockERC20 internal token;
    ProofCastRegistry internal registry;
    ProofCastExecutor internal executor;
    ProofCastFactory internal factory;
    ProofCastFollowerVault internal vault;
    address internal creator = address(0xA11CE);
    address internal follower = address(0xB0B);
    bytes32 internal constant SESSION = keccak256("execution-session");
    bytes32 internal constant ENROLLMENT = keccak256("execution-enrollment");
    bytes32 internal constant SECOND_ENROLLMENT = keccak256("cap-enrollment");
    bytes32 internal constant MARKET = bytes32("market-1");
    ProofCastFollowerVault internal other;

    function setUp() public {
        catalog = new MockMarketCatalog();
        adapter = new MockNativeAdapter();
        token = new MockERC20();
        registry = new ProofCastRegistry(address(catalog));
        executor = new ProofCastExecutor(address(registry), address(adapter));
        factory = new ProofCastFactory(address(registry), address(executor), address(adapter));
        executor.setFactory(address(factory));
        catalog.setCurrent(MARKET, 1, address(0x1001), address(0x2001));
        ProofCastRegistry.MarketRef[] memory markets = new ProofCastRegistry.MarketRef[](1);
        markets[0] = ProofCastRegistry.MarketRef(
            MARKET,
            1,
            address(0x1001),
            address(0x2001),
            address(token),
            address(0x4001),
            1,
            2,
            7,
            bytes32("venue"),
            101,
            150,
            180
        );
        vm.warp(100);
        vm.prank(creator);
        registry.registerSession(SESSION, keccak256("manifest"), keccak256("terms"), markets, 110, 190);
        vm.prank(follower);
        vault = ProofCastFollowerVault(factory.createVault(ENROLLMENT, SESSION, address(token)));
        token.mint(follower, 3_000_000);
        vm.prank(follower);
        token.approve(address(vault), 3_000_000);
        vm.prank(follower);
        vault.deposit(2_000_000);
        vm.warp(105);
        vm.prank(follower);
        executor.enroll(ENROLLMENT, _policy());
        vm.prank(follower);
        other = ProofCastFollowerVault(factory.createVault(SECOND_ENROLLMENT, SESSION, address(token)));
        vm.prank(follower);
        executor.enroll(
            SECOND_ENROLLMENT,
            ProofCastExecutor.Policy(1, 400_000, 400_000, 1_000_000, 2_000_000, 180, keccak256("terms"), 2)
        );
        vm.warp(120);
        vm.prank(creator);
        registry.publishSignal(SESSION, MARKET, ProofCastRegistry.SignalSide.YES, 500_000, 160, keccak256("evidence"));
    }

    function _policy() internal pure returns (ProofCastExecutor.Policy memory) {
        return ProofCastExecutor.Policy(3, 600_000, 400_000, 1_000_000, 2_000_000, 180, keccak256("terms"), 1);
    }

    function testExecuteDerivesSignalAndRecordsPartialActualDelta() public {
        adapter.setNextTrade(400_000, 800_000, IProofCastNativeAdapter.ExecutionStatus.PARTIAL_FILL, 77);
        IProofCastNativeAdapter.TradeResult memory result = executor.execute(ENROLLMENT, MARKET);
        assertEq(uint256(result.status), uint256(IProofCastNativeAdapter.ExecutionStatus.PARTIAL_FILL));
        assertEq(result.actualCost, 400_000);
        assertEq(vault.openRisk(), 400_000);
        assertEq(vault.totalSpent(), 400_000);
    }

    function testZeroFillIsNotFilledAndSignalCannotBeConsumedTwice() public {
        adapter.setNextTrade(0, 0, IProofCastNativeAdapter.ExecutionStatus.ZERO_FILL, 78);
        IProofCastNativeAdapter.TradeResult memory result = executor.execute(ENROLLMENT, MARKET);
        assertEq(uint256(result.status), uint256(IProofCastNativeAdapter.ExecutionStatus.ZERO_FILL));
        assertEq(vault.openRisk(), 0);
        vm.expectRevert();
        executor.execute(ENROLLMENT, MARKET);
    }

    function testSideSpecificCapRejectsSignalAboveFollowerBound() public {
        vm.expectRevert();
        executor.execute(SECOND_ENROLLMENT, MARKET);
        assertEq(other.openRisk(), 0);
    }
}
