// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProofCastRegistry} from "../src/ProofCastRegistry.sol";
import {MockMarketCatalog} from "./mocks/MockMarketCatalog.sol";
import {TestBase} from "./TestBase.t.sol";

contract RegistryTest is TestBase {
    MockMarketCatalog internal catalog;
    ProofCastRegistry internal registry;
    uint256 internal constant CREATOR_KEY = 0xA11CE;
    address internal creator;
    bytes32 internal constant SESSION = keccak256("session-1");
    bytes32 internal constant TERMS = keccak256("terms-1");

    function setUp() public {
        catalog = new MockMarketCatalog();
        registry = new ProofCastRegistry(address(catalog));
        creator = vm.addr(CREATOR_KEY);
        catalog.setCurrent(bytes32("market-1"), 1, address(0x1001), address(0x2001));
        catalog.setCurrent(bytes32("market-2"), 2, address(0x1002), address(0x2002));
        vm.warp(100);
    }

    function _market(bytes32 id, uint64 generation, address pool, address module)
        internal
        pure
        returns (ProofCastRegistry.MarketRef memory)
    {
        return ProofCastRegistry.MarketRef({
            marketId: id,
            generation: generation,
            pool: pool,
            module: module,
            collateral: address(0x3001),
            outcomeToken: address(0x4001),
            yesId: 1,
            noId: 2,
            operatorId: 7,
            venueId: bytes32("venue"),
            tradingStart: 101,
            decisionCutoff: 150,
            expiry: 180
        });
    }

    function _register(ProofCastRegistry.MarketRef[] memory markets) internal {
        vm.prank(creator);
        registry.registerSession(SESSION, keccak256("manifest"), TERMS, markets, 140, 190);
    }

    function testRegisterOneToThreeActualMarketsAndEnumeratesRefs() public {
        ProofCastRegistry.MarketRef[] memory markets = new ProofCastRegistry.MarketRef[](2);
        markets[0] = _market(bytes32("market-1"), 1, address(0x1001), address(0x2001));
        markets[1] = _market(bytes32("market-2"), 2, address(0x1002), address(0x2002));
        _register(markets);
        assertEq(registry.marketCount(SESSION), 2);
        ProofCastRegistry.MarketRef memory second = registry.marketRef(SESSION, 1);
        assertEq(second.marketId, bytes32("market-2"));
    }

    function testRejectsDuplicateAndUnknownFutureAlias() public {
        ProofCastRegistry.MarketRef[] memory duplicate = new ProofCastRegistry.MarketRef[](2);
        duplicate[0] = _market(bytes32("market-1"), 1, address(0x1001), address(0x2001));
        duplicate[1] = duplicate[0];
        vm.expectRevert();
        _register(duplicate);

        ProofCastRegistry.MarketRef[] memory future = new ProofCastRegistry.MarketRef[](1);
        future[0] = _market(bytes32("future"), 99, address(0x9999), address(0x9998));
        vm.expectRevert();
        _register(future);
    }

    function testEnrollmentClosesAtBoundaryAndSignalCannotPrecedeEnrollment() public {
        ProofCastRegistry.MarketRef[] memory markets = new ProofCastRegistry.MarketRef[](1);
        markets[0] = _market(bytes32("market-1"), 1, address(0x1001), address(0x2001));
        _register(markets);

        vm.prank(creator);
        vm.expectRevert();
        registry.publishSignal(
            SESSION, bytes32("market-1"), ProofCastRegistry.SignalSide.YES, 500_000, 160, keccak256("evidence")
        );

        vm.warp(139);
        registry.assertEnrollmentOpen(SESSION);
        vm.warp(140);
        vm.expectRevert();
        registry.assertEnrollmentOpen(SESSION);
    }

    function testSignalAndAnnotationAreImmutableHistory() public {
        ProofCastRegistry.MarketRef[] memory markets = new ProofCastRegistry.MarketRef[](1);
        markets[0] = _market(bytes32("market-1"), 1, address(0x1001), address(0x2001));
        _register(markets);
        vm.warp(140);
        vm.prank(creator);
        registry.publishSignal(
            SESSION, bytes32("market-1"), ProofCastRegistry.SignalSide.ABSTAIN, 0, 160, keccak256("abstain")
        );
        vm.prank(creator);
        registry.annotate(SESSION, bytes32("market-1"), keccak256("annotation"));
        vm.prank(creator);
        vm.expectRevert();
        registry.publishSignal(
            SESSION, bytes32("market-1"), ProofCastRegistry.SignalSide.YES, 500_000, 160, keccak256("second")
        );
        assertEq(registry.annotationCount(SESSION, bytes32("market-1")), 1);
    }

    function testRelayedSignalRequiresCreatorAndCorrectEip712Domain() public {
        ProofCastRegistry.MarketRef[] memory markets = new ProofCastRegistry.MarketRef[](1);
        markets[0] = _market(bytes32("market-1"), 1, address(0x1001), address(0x2001));
        _register(markets);
        vm.warp(140);
        bytes32 evidenceHash = keccak256("relayed-evidence");
        uint256 nonce = 7;
        vm.expectRevert();
        registry.publishSignalBySig(
            SESSION,
            bytes32("market-1"),
            ProofCastRegistry.SignalSide.YES,
            500_000,
            160,
            evidenceHash,
            nonce,
            _relaySignature(block.chainid + 1, nonce, evidenceHash)
        );
        registry.publishSignalBySig(
            SESSION,
            bytes32("market-1"),
            ProofCastRegistry.SignalSide.YES,
            500_000,
            160,
            evidenceHash,
            nonce,
            _relaySignature(block.chainid, nonce, evidenceHash)
        );
        assertTrue(registry.hasSignal(SESSION, bytes32("market-1")));
    }

    function _relaySignature(uint256 chainId, uint256 nonce, bytes32 evidenceHash) internal returns (bytes memory) {
        bytes32 domainTypeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 signalTypeHash = keccak256(
            "Signal(bytes32 sessionId,bytes32 marketId,uint8 side,uint256 price,uint64 validUntil,bytes32 evidenceHash,uint256 nonce)"
        );
        bytes32 domain = keccak256(
            abi.encode(domainTypeHash, keccak256("ProofCastRegistry"), keccak256("1"), chainId, address(registry))
        );
        bytes32 structHash = keccak256(
            abi.encode(
                signalTypeHash,
                SESSION,
                bytes32("market-1"),
                ProofCastRegistry.SignalSide.YES,
                500_000,
                uint64(160),
                evidenceHash,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(CREATOR_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function testWrongCreatorAndPostCutoffSignalAreRejected() public {
        ProofCastRegistry.MarketRef[] memory markets = new ProofCastRegistry.MarketRef[](1);
        markets[0] = _market(bytes32("market-1"), 1, address(0x1001), address(0x2001));
        _register(markets);
        vm.warp(140);
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        registry.publishSignal(
            SESSION, bytes32("market-1"), ProofCastRegistry.SignalSide.YES, 500_000, 160, keccak256("evidence")
        );
        vm.warp(151);
        vm.prank(creator);
        vm.expectRevert();
        registry.publishSignal(
            SESSION, bytes32("market-1"), ProofCastRegistry.SignalSide.YES, 500_000, 160, keccak256("late")
        );
    }
}
