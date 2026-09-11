// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IProofCastMarketCatalog {
    function isCurrentMarket(
        bytes32 marketId,
        uint64 generation,
        address pool,
        address module,
        uint64 tradingStart,
        uint64 decisionCutoff,
        uint64 expiry
    ) external view returns (bool);
}

/// @notice Owns the session manifest and the append-only creator signal history.
contract ProofCastRegistry {
    uint256 public constant PRICE_SCALE = 1_000_000;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant SIGNAL_TYPEHASH = keccak256(
        "Signal(bytes32 sessionId,bytes32 marketId,uint8 side,uint256 price,uint64 validUntil,bytes32 evidenceHash,uint256 nonce)"
    );
    bytes32 private constant NAME_HASH = keccak256("ProofCastRegistry");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    enum SignalSide {
        NONE,
        YES,
        NO,
        ABSTAIN
    }

    struct MarketRef {
        bytes32 marketId;
        uint64 generation;
        address pool;
        address module;
        address collateral;
        address outcomeToken;
        uint256 yesId;
        uint256 noId;
        uint32 operatorId;
        bytes32 venueId;
        uint64 tradingStart;
        uint64 decisionCutoff;
        uint64 expiry;
    }

    struct SessionInfo {
        address creator;
        bytes32 manifestHash;
        bytes32 termsHash;
        uint64 enrollUntil;
        uint64 sessionUntil;
        bool withdrawn;
        uint8 marketCount;
        uint32 signalCount;
    }

    struct Signal {
        bytes32 signalId;
        SignalSide side;
        uint256 price;
        uint64 validUntil;
        bytes32 evidenceHash;
        uint256 nonce;
        uint64 anchoredAt;
    }

    error Unauthorized();
    error InvalidSession();
    error InvalidMarket();
    error MarketNotCurrent();
    error EnrollmentClosed();
    error SignalPhaseClosed();
    error SignalAlreadyAnchored();
    error InvalidSignal();
    error InvalidSignature();
    error InvalidAnnotation();

    IProofCastMarketCatalog public immutable catalog;
    mapping(bytes32 => SessionInfo) private sessions;
    mapping(bytes32 => MarketRef[]) private markets;
    mapping(bytes32 => mapping(bytes32 => bool)) private knownMarkets;
    mapping(bytes32 => mapping(bytes32 => Signal)) private signals;
    mapping(bytes32 => mapping(bytes32 => uint32)) public annotationCount;
    mapping(bytes32 => mapping(bytes32 => mapping(uint32 => bytes32))) public annotationHash;
    mapping(address => mapping(uint256 => bool)) public usedSignalNonces;

    event SessionRegistered(
        bytes32 indexed sessionId,
        address indexed creator,
        bytes32 manifestHash,
        bytes32 termsHash,
        uint64 enrollUntil,
        uint64 sessionUntil,
        uint8 marketCount
    );
    event SignalAnchored(
        bytes32 indexed sessionId,
        bytes32 indexed marketId,
        bytes32 indexed signalId,
        SignalSide side,
        uint256 price,
        uint64 validUntil,
        bytes32 evidenceHash,
        address signer
    );
    event AnnotationAdded(
        bytes32 indexed sessionId, bytes32 indexed marketId, uint32 indexed version, bytes32 contentHash
    );
    event SessionWithdrawn(bytes32 indexed sessionId, address indexed creator);

    constructor(address catalog_) {
        if (catalog_ == address(0)) revert InvalidSession();
        catalog = IProofCastMarketCatalog(catalog_);
    }

    function registerSession(
        bytes32 sessionId,
        bytes32 manifestHash,
        bytes32 termsHash,
        MarketRef[] calldata refs,
        uint64 enrollUntil,
        uint64 sessionUntil
    ) external {
        if (sessionId == bytes32(0) || manifestHash == bytes32(0) || termsHash == bytes32(0)) revert InvalidSession();
        if (sessions[sessionId].creator != address(0) || refs.length == 0 || refs.length > 3) revert InvalidSession();
        if (enrollUntil <= block.timestamp || enrollUntil >= sessionUntil) revert InvalidSession();

        for (uint256 i = 0; i < refs.length; i++) {
            MarketRef calldata ref = refs[i];
            if (
                ref.marketId == bytes32(0) || ref.generation == 0 || ref.pool == address(0) || ref.module == address(0)
                    || ref.collateral == address(0) || ref.outcomeToken == address(0) || ref.yesId == ref.noId
                    || ref.venueId == bytes32(0) || ref.tradingStart > ref.decisionCutoff
                    || ref.decisionCutoff >= ref.expiry || ref.tradingStart > enrollUntil
                    || enrollUntil >= ref.decisionCutoff || ref.decisionCutoff >= sessionUntil
                    || ref.expiry > sessionUntil
            ) revert InvalidMarket();
            if (knownMarkets[sessionId][ref.marketId]) revert InvalidMarket();
            if (!catalog.isCurrentMarket(
                    ref.marketId, ref.generation, ref.pool, ref.module, ref.tradingStart, ref.decisionCutoff, ref.expiry
                )) {
                revert MarketNotCurrent();
            }
            knownMarkets[sessionId][ref.marketId] = true;
            markets[sessionId].push(ref);
        }

        sessions[sessionId] = SessionInfo({
            creator: msg.sender,
            manifestHash: manifestHash,
            termsHash: termsHash,
            enrollUntil: enrollUntil,
            sessionUntil: sessionUntil,
            withdrawn: false,
            marketCount: uint8(refs.length),
            signalCount: 0
        });
        emit SessionRegistered(
            sessionId, msg.sender, manifestHash, termsHash, enrollUntil, sessionUntil, uint8(refs.length)
        );
    }

    function session(bytes32 sessionId) external view returns (SessionInfo memory) {
        return sessions[sessionId];
    }

    function marketCount(bytes32 sessionId) external view returns (uint256) {
        return markets[sessionId].length;
    }

    function marketRef(bytes32 sessionId, uint256 index) external view returns (MarketRef memory) {
        return markets[sessionId][index];
    }

    function marketRefFor(bytes32 sessionId, bytes32 marketId) external view returns (MarketRef memory) {
        return _market(sessionId, marketId);
    }

    function creatorOf(bytes32 sessionId) external view returns (address) {
        return sessions[sessionId].creator;
    }

    function termsHashOf(bytes32 sessionId) external view returns (bytes32) {
        return sessions[sessionId].termsHash;
    }

    function sessionUntilOf(bytes32 sessionId) external view returns (uint64) {
        return sessions[sessionId].sessionUntil;
    }

    function isRegistered(bytes32 sessionId) external view returns (bool) {
        return sessions[sessionId].creator != address(0);
    }

    function isWithdrawn(bytes32 sessionId) external view returns (bool) {
        return sessions[sessionId].withdrawn;
    }

    function isMarket(bytes32 sessionId, bytes32 marketId) external view returns (bool) {
        return knownMarkets[sessionId][marketId];
    }

    function assertEnrollmentOpen(bytes32 sessionId) public view {
        SessionInfo memory current = sessions[sessionId];
        if (
            current.creator == address(0) || current.withdrawn || block.timestamp >= current.enrollUntil
                || current.signalCount != 0
        ) {
            revert EnrollmentClosed();
        }
    }

    function publishSignal(
        bytes32 sessionId,
        bytes32 marketId,
        SignalSide side,
        uint256 price,
        uint64 validUntil,
        bytes32 evidenceHash
    ) external {
        if (msg.sender != sessions[sessionId].creator) revert Unauthorized();
        _publish(sessionId, marketId, side, price, validUntil, evidenceHash, 0, msg.sender);
    }

    function publishSignalBySig(
        bytes32 sessionId,
        bytes32 marketId,
        SignalSide side,
        uint256 price,
        uint64 validUntil,
        bytes32 evidenceHash,
        uint256 nonce,
        bytes calldata signature
    ) external {
        bytes32 structHash = keccak256(
            abi.encode(SIGNAL_TYPEHASH, sessionId, marketId, side, price, validUntil, evidenceHash, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        address signer = _recover(digest, signature);
        if (signer == address(0) || signer != sessions[sessionId].creator || usedSignalNonces[signer][nonce]) {
            revert InvalidSignature();
        }
        usedSignalNonces[signer][nonce] = true;
        _publish(sessionId, marketId, side, price, validUntil, evidenceHash, nonce, signer);
    }

    function signal(bytes32 sessionId, bytes32 marketId) external view returns (Signal memory) {
        return signals[sessionId][marketId];
    }

    function hasSignal(bytes32 sessionId, bytes32 marketId) external view returns (bool) {
        return signals[sessionId][marketId].signalId != bytes32(0);
    }

    function annotate(bytes32 sessionId, bytes32 marketId, bytes32 contentHash) external {
        if (
            msg.sender != sessions[sessionId].creator || !knownMarkets[sessionId][marketId] || contentHash == bytes32(0)
        ) revert InvalidAnnotation();
        uint32 version = annotationCount[sessionId][marketId] + 1;
        annotationCount[sessionId][marketId] = version;
        annotationHash[sessionId][marketId][version] = contentHash;
        emit AnnotationAdded(sessionId, marketId, version, contentHash);
    }

    function withdrawSession(bytes32 sessionId) external {
        if (msg.sender != sessions[sessionId].creator) revert Unauthorized();
        if (sessions[sessionId].withdrawn) revert InvalidSession();
        sessions[sessionId].withdrawn = true;
        emit SessionWithdrawn(sessionId, msg.sender);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    function _publish(
        bytes32 sessionId,
        bytes32 marketId,
        SignalSide side,
        uint256 price,
        uint64 validUntil,
        bytes32 evidenceHash,
        uint256 nonce,
        address signer
    ) internal {
        SessionInfo storage current = sessions[sessionId];
        MarketRef memory ref = _market(sessionId, marketId);
        if (current.creator == address(0) || current.withdrawn || !knownMarkets[sessionId][marketId]) {
            revert InvalidSession();
        }
        if (
            block.timestamp < current.enrollUntil || block.timestamp < ref.tradingStart
                || block.timestamp > ref.decisionCutoff
        ) revert SignalPhaseClosed();
        if (
            validUntil <= block.timestamp || validUntil > ref.expiry || validUntil > current.sessionUntil
                || evidenceHash == bytes32(0)
        ) revert InvalidSignal();
        if (signals[sessionId][marketId].signalId != bytes32(0)) revert SignalAlreadyAnchored();
        if (side == SignalSide.NONE || side > SignalSide.ABSTAIN) revert InvalidSignal();
        if (side == SignalSide.ABSTAIN) {
            if (price != 0) revert InvalidSignal();
        } else if (price == 0 || price > PRICE_SCALE) {
            revert InvalidSignal();
        }
        bytes32 signalId =
            keccak256(abi.encode(sessionId, marketId, side, price, validUntil, evidenceHash, nonce, signer));
        signals[sessionId][marketId] =
            Signal(signalId, side, price, validUntil, evidenceHash, nonce, uint64(block.timestamp));
        current.signalCount += 1;
        emit SignalAnchored(sessionId, marketId, signalId, side, price, validUntil, evidenceHash, signer);
    }

    function _market(bytes32 sessionId, bytes32 marketId) internal view returns (MarketRef memory ref) {
        if (!knownMarkets[sessionId][marketId]) revert InvalidMarket();
        MarketRef[] storage refs = markets[sessionId];
        for (uint256 i = 0; i < refs.length; i++) {
            if (refs[i].marketId == marketId) return refs[i];
        }
        revert InvalidMarket();
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > SECP256K1N_HALF) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
