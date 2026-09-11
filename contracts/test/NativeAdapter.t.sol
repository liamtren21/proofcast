// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProofCastDreamDexAdapter} from "../src/ProofCastDreamDexAdapter.sol";
import {IProofCastNativeAdapter} from "../src/ProofCastInterfaces.sol";
import {TestBase} from "./TestBase.t.sol";

contract NativeAdapterTest is TestBase {
    ProofCastDreamDexAdapter internal adapter;

    function setUp() public {
        adapter = new ProofCastDreamDexAdapter();
    }

    function testNativeExecutionAndRecoveryAreFailClosedWithoutEvidence() public {
        assertTrue(!adapter.nativeExecutionEnabled());
        assertTrue(!adapter.nativeRecoveryEnabled());
        assertTrue(!adapter.supportsRecovery(address(0x1), bytes32("market"), 1));
        vm.expectRevert();
        adapter.placeBuyIoc(
            IProofCastNativeAdapter.TradeRequest(
                address(0x1),
                address(0x2),
                address(0x3),
                bytes32("market"),
                1,
                7,
                bytes32("venue"),
                1,
                500_000,
                1,
                1_000_000,
                1
            )
        );
        vm.expectRevert();
        adapter.recover(
            IProofCastNativeAdapter.RecoveryRequest(address(0x1), 7, bytes32("venue"), bytes32("market"), 1, 0, 1, 1)
        );
    }
}
