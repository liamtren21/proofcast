// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20ProofCast { function transfer(address to, uint256 value) external returns (bool); function transferFrom(address from, address to, uint256 value) external returns (bool); function approve(address spender, uint256 value) external returns (bool); }
interface IDreamDexProofCastPool { function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) external payable returns (bool success, uint128 id); function mintSet(address yesTo, address noTo, uint256 amount) external; }
interface IDreamDexProofCastModule { function finalizeMarket(bytes32 marketId) external; function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external; }
interface IERC6909ProofCast { function setOperator(address operator, bool approved) external returns (bool); }

/// @notice Versioned signal cards and bounded follower intents; native execution is deliberately fail-closed.
contract ProofCast {
    uint256 private constant PRICE_SCALE = 1_000_000;
    error Unauthorized(); error InvalidCard(); error InvalidIntent(); error NoArbitraryCall();
    address public immutable owner; address public immutable beneficiary; IERC20ProofCast public immutable collateral;
    bool public paused; mapping(bytes32 => bool) public published; mapping(bytes32 => bool) public consumed; mapping(address => bool) public creators; mapping(address => bool) public approvedPools; mapping(address => bytes32) public poolMarketIds; mapping(address => uint64) public poolGenerations;
    struct Card { bytes32 marketId; uint64 marketGeneration; bytes32 evidenceHash; uint64 validUntil; address creator; }
    struct Receipt { bytes32 intentId; bytes32 cardId; address follower; bytes32 marketId; uint64 marketGeneration; uint256 maxCost; uint64 expiry; bool executed; }
    mapping(bytes32 => Card) public cards; mapping(bytes32 => Receipt) public receipts;
    event CreatorSet(address indexed creator, bool allowed); event CardPublished(bytes32 indexed cardId, bytes32 marketId, uint64 generation, bytes32 evidenceHash, uint64 validUntil);
    event IntentAuthorized(bytes32 indexed intentId, bytes32 indexed cardId, address indexed follower, uint256 maxCost, uint64 expiry); event IntentRevoked(bytes32 indexed intentId); event ReceiptRecorded(bytes32 indexed intentId, bool executed);
    event PoolSet(address indexed pool, bytes32 indexed marketId, uint64 generation, bool allowed); event NativeOrderPlaced(bytes32 indexed intentId, address indexed pool, uint128 orderId, uint256 cost);
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; } modifier onlyCreator() { if (!creators[msg.sender]) revert Unauthorized(); _; }
    constructor(address collateral_, address beneficiary_) { owner=msg.sender; collateral=IERC20ProofCast(collateral_); beneficiary=beneficiary_; creators[msg.sender]=true; }
    function setCreator(address creator, bool allowed) external onlyOwner { creators[creator]=allowed; emit CreatorSet(creator,allowed); }
    function setPool(address pool, bytes32 marketId, uint64 generation, bool allowed) external onlyOwner { if (pool == address(0) || marketId == bytes32(0) || generation == 0) revert InvalidIntent(); approvedPools[pool]=allowed; poolMarketIds[pool]=marketId; poolGenerations[pool]=generation; emit PoolSet(pool,marketId,generation,allowed); }
    function deposit(uint256 amount) external onlyOwner { if (!collateral.transferFrom(msg.sender,address(this),amount)) revert InvalidIntent(); }
    function mintSet(address pool, uint256 amount) external onlyOwner { if (!collateral.approve(pool, amount)) revert InvalidIntent(); IDreamDexProofCastPool(pool).mintSet(address(this), address(this), amount); }
    function finalizeMarket(address module, bytes32 marketId) external onlyOwner { IDreamDexProofCastModule(module).finalizeMarket(marketId); }
    function redeem(address module, address outcomeToken, uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external onlyOwner { if (!IERC6909ProofCast(outcomeToken).setOperator(module, true)) revert InvalidIntent(); IDreamDexProofCastModule(module).redeem(operatorId, venueId, marketId, outcomeIdx, amount); }
    function publishCard(bytes32 cardId, bytes32 marketId, uint64 marketGeneration, bytes32 evidenceHash, uint64 validUntil) external onlyCreator { if (paused || published[cardId] || marketId==bytes32(0) || marketGeneration==0 || evidenceHash==bytes32(0) || validUntil <= block.timestamp) revert InvalidCard(); published[cardId]=true; cards[cardId]=Card(marketId,marketGeneration,evidenceHash,validUntil,msg.sender); emit CardPublished(cardId,marketId,marketGeneration,evidenceHash,validUntil); }
    function authorizeIntent(bytes32 intentId, bytes32 cardId, uint256 maxCost, uint64 expiry) external { Card memory c=cards[cardId]; if (paused || !published[cardId] || consumed[intentId] || expiry > c.validUntil || expiry <= block.timestamp || maxCost==0) revert InvalidIntent(); consumed[intentId]=true; receipts[intentId]=Receipt(intentId,cardId,msg.sender,c.marketId,c.marketGeneration,maxCost,expiry,false); emit IntentAuthorized(intentId,cardId,msg.sender,maxCost,expiry); }
    function revokeIntent(bytes32 intentId) external { Receipt storage r=receipts[intentId]; if (r.follower != msg.sender || r.executed) revert Unauthorized(); r.expiry=uint64(block.timestamp); emit IntentRevoked(intentId); }
    function recordReceipt(bytes32 intentId, bool executed) external onlyOwner { Receipt storage r=receipts[intentId]; if (r.follower==address(0) || r.executed) revert InvalidIntent(); r.executed=executed; emit ReceiptRecorded(intentId,executed); }
    /// @notice Executes only the card-bound follower intent through the typed DreamDEX IOC entry point.
    function executeBinaryIoc(bytes32 intentId, address pool, uint8 kind, uint256 price, uint256 quantity) external onlyOwner returns (uint128 orderId) {
        Receipt storage r=receipts[intentId]; Card memory c=cards[r.cardId];
        if (paused || r.follower==address(0) || r.executed || block.timestamp > r.expiry || !approvedPools[pool] || poolMarketIds[pool] != r.marketId || poolGenerations[pool] != r.marketGeneration || price == 0 || quantity == 0) revert InvalidIntent();
        uint256 cost=(price*quantity)/PRICE_SCALE; if (cost == 0 || cost > r.maxCost) revert InvalidIntent();
        if (!collateral.approve(pool,cost)) revert InvalidIntent();
        (bool success,uint128 id)=IDreamDexProofCastPool(pool).placeBinaryOrder(kind,price,quantity,uint64(r.expiry)*1e9,2,0,address(0),0,0); if (!success) revert InvalidIntent();
        r.executed=true; emit NativeOrderPlaced(intentId,pool,id,cost); emit ReceiptRecorded(intentId,true); return id;
    }
    function pause() external onlyOwner { paused=true; }
    function unpause() external onlyOwner { paused=false; }
    function collateralBalance() public view returns (uint256 value) { (bool ok,bytes memory data)=address(collateral).staticcall(abi.encodeWithSignature("balanceOf(address)",address(this))); if (!ok || data.length < 32) revert InvalidIntent(); value=abi.decode(data,(uint256)); }
    function withdraw(uint256 amount) external onlyOwner { if (amount > collateralBalance()) revert InvalidIntent(); if (!collateral.transfer(beneficiary,amount)) revert InvalidIntent(); }
    function arbitraryCall(address, bytes calldata) external pure { revert NoArbitraryCall(); }
}
