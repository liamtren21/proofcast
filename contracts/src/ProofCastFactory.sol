// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProofCastFollowerVault} from "./ProofCastFollowerVault.sol";

interface IProofCastFactoryRegistry {
    function isRegistered(bytes32 sessionId) external view returns (bool);
}

interface IProofCastAdapterAdmin {
    function registerVault(address vault) external;
}

/// @notice Deploys one vault per follower enrollment. The caller becomes the owner.
contract ProofCastFactory {
    error InvalidEnrollment();
    error AlreadyCreated();
    error Unauthorized();

    address public immutable registry;
    address public immutable executor;
    address public immutable adapter;
    mapping(bytes32 => address) public vaultFor;
    mapping(bytes32 => bytes32) public sessionFor;

    event VaultCreated(
        bytes32 indexed enrollmentId, bytes32 indexed sessionId, address indexed follower, address vault
    );

    constructor(address registry_, address executor_, address adapter_) {
        if (registry_ == address(0) || executor_ == address(0) || adapter_ == address(0)) revert InvalidEnrollment();
        registry = registry_;
        executor = executor_;
        adapter = adapter_;
    }

    function createVault(bytes32 enrollmentId, bytes32 sessionId, address collateral) external returns (address vault) {
        if (enrollmentId == bytes32(0) || sessionId == bytes32(0) || vaultFor[enrollmentId] != address(0)) {
            revert AlreadyCreated();
        }
        if (!IProofCastFactoryRegistry(registry).isRegistered(sessionId) || collateral == address(0)) {
            revert InvalidEnrollment();
        }
        vault = address(new ProofCastFollowerVault(msg.sender, executor, adapter, collateral, sessionId, enrollmentId));
        vaultFor[enrollmentId] = vault;
        sessionFor[enrollmentId] = sessionId;
        IProofCastAdapterAdmin(adapter).registerVault(vault);
        emit VaultCreated(enrollmentId, sessionId, msg.sender, vault);
    }

    function ownerOf(bytes32 enrollmentId) external view returns (address) {
        address vault = vaultFor[enrollmentId];
        if (vault == address(0)) return address(0);
        return ProofCastFollowerVault(vault).owner();
    }
}
