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

contract RecoveryTest is TestBase {
    MockMarketCatalog internal catalog;
    MockNativeAdapter internal adapter;
    MockERC20 internal token;
    ProofCastRegistry internal registry;
    ProofCastExecutor internal executor;
    ProofCastFactory internal factory;
    ProofCastFollowerVault internal vault;
    address internal creator = address(0xA11CE);
    address internal follower = address(0xB0B);
    bytes32 internal constant SESSION = keccak256("recovery-session");
    bytes32 internal constant ENROLLMENT = keccak256("recovery-enrollment");
    bytes32 internal constant MARKET = bytes32("market-1");

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
        executor.enroll(
            ENROLLMENT, ProofCastExecutor.Policy(3, 600_000, 600_000, 1_000_000, 2_000_000, 180, keccak256("terms"), 1)
        );
        vm.warp(120);
        vm.prank(creator);
        registry.publishSignal(SESSION, MARKET, ProofCastRegistry.SignalSide.YES, 500_000, 160, keccak256("evidence"));
        adapter.setNextTrade(400_000, 800_000, IProofCastNativeAdapter.ExecutionStatus.PARTIAL_FILL, 77);
        executor.execute(ENROLLMENT, MARKET);
        adapter.setRecoveryToken(address(token));
        token.mint(address(adapter), 500_000);
    }

    function testRecoveryUsesFixedVaultAndRepeatedRecoveryCannotDoubleCount() public {
        adapter.setNextRecovery(450_000, IProofCastNativeAdapter.ExecutionStatus.RECOVERED);
        executor.recover(ENROLLMENT, MARKET);
        assertEq(vault.openRisk(), 0);
        assertEq(vault.realizedLoss(), 0);
        vm.expectRevert();
        executor.recover(ENROLLMENT, MARKET);
    }
}
