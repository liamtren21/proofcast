// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProofCastRegistry} from "../src/ProofCastRegistry.sol";
import {ProofCastFactory} from "../src/ProofCastFactory.sol";
import {ProofCastExecutor} from "../src/ProofCastExecutor.sol";
import {ProofCastFollowerVault} from "../src/ProofCastFollowerVault.sol";
import {MockMarketCatalog} from "./mocks/MockMarketCatalog.sol";
import {MockNativeAdapter} from "./mocks/MockNativeAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {TestBase} from "./TestBase.t.sol";

contract EnrollmentTest is TestBase {
    MockMarketCatalog internal catalog;
    MockNativeAdapter internal adapter;
    MockERC20 internal token;
    ProofCastRegistry internal registry;
    ProofCastExecutor internal executor;
    ProofCastFactory internal factory;
    address internal creator = address(0xA11CE);
    address internal follower = address(0xB0B);
    bytes32 internal constant SESSION = keccak256("enrollment-session");
    bytes32 internal constant ENROLLMENT = keccak256("enrollment-1");
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
        markets[0] = ProofCastRegistry.MarketRef({
            marketId: MARKET,
            generation: 1,
            pool: address(0x1001),
            module: address(0x2001),
            collateral: address(token),
            outcomeToken: address(0x4001),
            yesId: 1,
            noId: 2,
            operatorId: 7,
            venueId: bytes32("venue"),
            tradingStart: 101,
            decisionCutoff: 150,
            expiry: 180
        });
        vm.warp(100);
        vm.prank(creator);
        registry.registerSession(SESSION, keccak256("manifest"), keccak256("terms"), markets, 140, 190);
    }

    function _policy() internal pure returns (ProofCastExecutor.Policy memory) {
        return ProofCastExecutor.Policy({
            allowedSideMask: 3,
            maxYesPrice: 600_000,
            maxNoPrice: 600_000,
            maxOrderCost: 1_000_000,
            totalRiskBudget: 2_000_000,
            validUntil: 180,
            termsHash: keccak256("terms"),
            nonce: 1
        });
    }

    function _createVault() internal returns (ProofCastFollowerVault vault) {
        vm.prank(follower);
        vault = ProofCastFollowerVault(factory.createVault(ENROLLMENT, SESSION, address(token)));
    }

    function testFollowerCreatesOwnVaultAndCreatorCannotEnrollOrWithdraw() public {
        ProofCastFollowerVault vault = _createVault();
        assertEq(vault.owner(), follower);
        assertEq(vault.beneficiary(), follower);
        vm.prank(creator);
        vm.expectRevert();
        executor.enroll(ENROLLMENT, _policy());
        vm.prank(creator);
        vm.expectRevert();
        vault.withdraw(1);
    }

    function testEnrollmentDoesNotNeedSignalButCannotHappenAfterSignal() public {
        _createVault();
        vm.warp(120);
        vm.prank(follower);
        executor.enroll(ENROLLMENT, _policy());
        vm.expectRevert();
        executor.execute(ENROLLMENT, MARKET);

        bytes32 secondEnrollment = keccak256("enrollment-2");
        vm.prank(follower);
        factory.createVault(secondEnrollment, SESSION, address(token));
        vm.warp(140);
        vm.prank(creator);
        registry.publishSignal(SESSION, MARKET, ProofCastRegistry.SignalSide.YES, 500_000, 160, keccak256("evidence"));
        vm.prank(follower);
        vm.expectRevert();
        executor.enroll(secondEnrollment, _policy());
    }

    function testRevokeFlagBlocksExecutionAtSameTimestampAndLeavesRecoveryPath() public {
        ProofCastFollowerVault vault = _createVault();
        vm.warp(120);
        vm.prank(follower);
        executor.enroll(ENROLLMENT, _policy());
        vm.prank(follower);
        executor.revokeEnrollment(ENROLLMENT);
        assertTrue(vault.revoked());
        vm.warp(140);
        vm.prank(creator);
        registry.publishSignal(SESSION, MARKET, ProofCastRegistry.SignalSide.YES, 500_000, 160, keccak256("evidence"));
        vm.expectRevert();
        executor.execute(ENROLLMENT, MARKET);
    }
}
