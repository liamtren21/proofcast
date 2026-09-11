// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProofCastNativeAdapter, IERC20ProofCastV2} from "./ProofCastInterfaces.sol";

interface IDreamDexTypedPool {
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);
}

interface IPCPoolState {
    struct Grid {uint256 tickSize;uint256 minQuantity;uint256 lotSize;}
    struct Params {address collateralToken;address market;address outcomeToken;uint256 yesId;uint256 noId;uint256 oneCollateral;uint256 setBacking;address feeRecipient;uint256 makerFeeBpsTimes1k;uint256 takerFeeBpsTimes1k;uint256 maxBuilderFeeBpsTimes1k;uint256 settlementFeeBpsTimes1k;address settlement;uint64 marketNonce;bool finalized;}
    function getBinaryPoolParams() external view returns(Params memory);
    function marketExpiryNs() external view returns(uint64);
    function getOrderBookParameters() external view returns(Grid memory);
}
interface IPCModuleState {
    struct Market {uint256 question;uint8 slots;uint8 voidPolicy;address collateral;uint32 operatorId;bytes32 venueId;address oracle;address creator;address market;address pool;uint256 yesId;uint256 noId;uint64 tradingStart;uint64 expiry;}
    function markets(bytes32 id) external view returns(Market memory);
    function marketNonce(bytes32 id) external view returns(uint64);
}
interface IPCMarket {function status() external view returns(uint8);}
interface IPCOutcomes {
    function balanceOf(address owner,uint256 id) external view returns(uint256);
    function setOperator(address operator,bool enabled) external returns(bool);
}
interface IPCSettlement {
    function isFinalized(uint256 id) external view returns(bool);
    function redeem(uint256 id,uint256 amount,address to) external returns(uint256);
    function finalizeAndRedeem(address pool,uint256 id,uint256 amount,address to) external returns(uint256);
    function owed(address account,address token) external view returns(uint256);
}

/// @notice Typed DreamDEX boundary. It refuses to claim native fills or recovery until independently proven.
contract ProofCastDreamDexAdapter is IProofCastNativeAdapter {
    error Unauthorized();
    error NativeCapabilityUnavailable();
    error InvalidTypedRequest();

    address public immutable owner;
    address public factory;
    bool public nativeExecutionEnabled;
    bool public nativeRecoveryEnabled;
    address public protocolModule;
    address public protocolCollateral;
    address public protocolOutcomes;
    address public protocolSettlement;
    struct Holding {address pool;uint256 outcomeId;uint256 amount;}
    mapping(address=>mapping(bytes32=>Holding)) public holdings;
    mapping(address=>mapping(uint256=>bool)) public consumedRecoveryNonce;
    uint256 private entered;
    modifier nonReentrant(){if(entered!=0) revert InvalidTypedRequest();entered=1;_;entered=0;}

    function configureProtocol(address module_,address collateral_,address outcomes_,address settlement_) external {
        if(msg.sender!=owner||protocolModule!=address(0)) revert Unauthorized();
        if(module_.code.length==0||collateral_.code.length==0||outcomes_.code.length==0||settlement_.code.length==0) revert InvalidTypedRequest();
        protocolModule=module_;protocolCollateral=collateral_;protocolOutcomes=outcomes_;protocolSettlement=settlement_;
        nativeRecoveryEnabled=true;
    }
    mapping(address => bool) public registeredVaults;

    event FactorySet(address indexed factory);
    event VaultRegistered(address indexed vault);
    event NativeExecutionGateSet(bool enabled);

    constructor() {
        owner = msg.sender;
    }

    function setFactory(address factory_) external {
        if (msg.sender != owner || factory != address(0) || factory_ == address(0)) revert Unauthorized();
        factory = factory_;
        emit FactorySet(factory_);
    }

    function registerVault(address vault) external {
        if (msg.sender != factory || vault == address(0)) revert Unauthorized();
        registeredVaults[vault] = true;
        emit VaultRegistered(vault);
    }

    /// @dev Enabling this requires an external evidence review; the default remains false.
    function setNativeExecutionEnabled(bool enabled) external {
        if (msg.sender != owner) revert Unauthorized();
        if(enabled && protocolModule==address(0)) revert NativeCapabilityUnavailable();
        nativeExecutionEnabled = enabled;
        emit NativeExecutionGateSet(enabled);
    }

    function _key(bytes32 marketId,uint64 generation,uint8 index,uint32 operatorId,bytes32 venueId) internal pure returns(bytes32){
        return keccak256(abi.encode(marketId,generation,index,operatorId,venueId));
    }
    function _validate(TradeRequest calldata request) internal view {
        if(!nativeExecutionEnabled||!registeredVaults[msg.sender]) revert NativeCapabilityUnavailable();
        if(request.resolutionModule!=protocolModule||request.collateral!=protocolCollateral||request.marketId==bytes32(0)
            ||request.generation==0||request.side<1||request.side>2||request.price==0||request.price>1e6||request.quantity==0
            ||request.expiryNs<=block.timestamp*1e9) revert InvalidTypedRequest();
        IPCPoolState.Params memory p=IPCPoolState(request.pool).getBinaryPoolParams();
        IPCModuleState.Market memory m=IPCModuleState(protocolModule).markets(request.marketId);
        if(p.collateralToken!=protocolCollateral||p.outcomeToken!=protocolOutcomes||p.settlement!=protocolSettlement
            ||p.marketNonce!=request.generation||p.finalized||p.oneCollateral!=1e6
            ||request.outcomeTokenId!=(request.side==1?p.yesId:p.noId)
            ||m.pool!=request.pool||m.market!=p.market||m.collateral!=protocolCollateral||m.yesId!=p.yesId||m.noId!=p.noId
            ||m.operatorId!=request.operatorId||m.venueId!=request.venueId||IPCModuleState(protocolModule).marketNonce(request.marketId)!=request.generation
            ||IPCMarket(p.market).status()!=1||request.expiryNs>IPCPoolState(request.pool).marketExpiryNs()) revert InvalidTypedRequest();
    }
    function placeBuyIoc(TradeRequest calldata request) external nonReentrant returns(TradeResult memory result){
        _validate(request);
        uint256 orderQuantity=_orderQuantity(request);
        IERC20ProofCastV2 token=IERC20ProofCastV2(protocolCollateral);
        IPCOutcomes outcome=IPCOutcomes(protocolOutcomes);
        uint256 maximumCost=(request.price*orderQuantity+999999)/1e6;
        uint256 initialCash=token.balanceOf(address(this));
        uint256 initialQuantity=outcome.balanceOf(address(this),request.outcomeTokenId);
        if(!token.transferFrom(msg.sender,address(this),maximumCost)||token.balanceOf(address(this))!=initialCash+maximumCost) revert InvalidTypedRequest();
        if(!token.approve(request.pool,0)||!token.approve(request.pool,maximumCost)) revert InvalidTypedRequest();
        // Native pool prices are always YES prices; follower limits are outcome prices.
        (bool success,uint128 orderId)=IDreamDexTypedPool(request.pool).placeBinaryOrder(request.side==1?0:2,request.side==1?request.price:1e6-request.price,orderQuantity,request.expiryNs,2,0,address(0),0,0);
        if(!success||!token.approve(request.pool,0)) revert InvalidTypedRequest();
        uint256 cash=token.balanceOf(address(this));uint256 quantity=outcome.balanceOf(address(this),request.outcomeTokenId);
        if(cash<initialCash||cash>initialCash+maximumCost||quantity<initialQuantity) revert InvalidTypedRequest();
        uint256 cost=initialCash+maximumCost-cash;uint256 filled=quantity-initialQuantity;
        if(filled>orderQuantity||(filled==0)!=(cost==0)) revert InvalidTypedRequest();
        if(cash>initialCash&&!token.transfer(msg.sender,cash-initialCash)) revert InvalidTypedRequest();
        if(filled>0) _recordHolding(request,filled);
        return TradeResult(filled==0?ExecutionStatus.ZERO_FILL:filled==request.quantity?ExecutionStatus.FILLED:ExecutionStatus.PARTIAL_FILL,cost,filled,orderId);
    }
    function _orderQuantity(TradeRequest calldata request) internal view returns(uint256 quantity){
        IPCPoolState.Grid memory grid=IPCPoolState(request.pool).getOrderBookParameters();
        if(grid.tickSize==0||grid.lotSize==0||request.price%grid.tickSize!=0) revert InvalidTypedRequest();
        quantity=request.quantity/grid.lotSize*grid.lotSize;
        if(quantity==0||quantity<grid.minQuantity) revert InvalidTypedRequest();
    }
    function _recordHolding(TradeRequest calldata request,uint256 filled) internal {
        Holding storage h=holdings[msg.sender][_key(request.marketId,request.generation,request.side-1,request.operatorId,request.venueId)];
        if(h.amount>0&&(h.pool!=request.pool||h.outcomeId!=request.outcomeTokenId)) revert InvalidTypedRequest();
        h.pool=request.pool;h.outcomeId=request.outcomeTokenId;h.amount+=filled;
    }
    function recover(RecoveryRequest calldata request) external nonReentrant returns(RecoveryResult memory result){
        if(!nativeRecoveryEnabled||!registeredVaults[msg.sender]||request.resolutionModule!=protocolModule
            ||request.outcomeIndex>1||request.positionAmount==0||consumedRecoveryNonce[msg.sender][request.recoveryNonce]) revert NativeCapabilityUnavailable();
        Holding storage h=holdings[msg.sender][_key(request.marketId,request.generation,request.outcomeIndex,request.operatorId,request.venueId)];
        if(h.amount!=request.positionAmount) revert InvalidTypedRequest();
        IERC20ProofCastV2 token=IERC20ProofCastV2(protocolCollateral);
        IPCOutcomes outcome=IPCOutcomes(protocolOutcomes);IPCSettlement settlement=IPCSettlement(protocolSettlement);
        uint256 initialCash=token.balanceOf(address(this));uint256 initialQuantity=outcome.balanceOf(address(this),h.outcomeId);
        uint256 initialOwed=settlement.owed(address(this),protocolCollateral);
        h.amount=0;consumedRecoveryNonce[msg.sender][request.recoveryNonce]=true;
        if(!outcome.setOperator(protocolSettlement,true)) revert InvalidTypedRequest();
        uint256 payout=settlement.isFinalized(h.outcomeId)?settlement.redeem(h.outcomeId,request.positionAmount,address(this)):settlement.finalizeAndRedeem(h.pool,h.outcomeId,request.positionAmount,address(this));
        if(!outcome.setOperator(protocolSettlement,false)||token.balanceOf(address(this))!=initialCash+payout
            ||outcome.balanceOf(address(this),h.outcomeId)+request.positionAmount!=initialQuantity
            ||settlement.owed(address(this),protocolCollateral)!=initialOwed) revert InvalidTypedRequest();
        if(payout>0&&!token.transfer(msg.sender,payout)) revert InvalidTypedRequest();
        return RecoveryResult(ExecutionStatus.RECOVERED,payout,request.positionAmount);
    }
    function supportsRecovery(address resolutionModule,bytes32,uint64) external view returns(bool){
        return nativeRecoveryEnabled&&resolutionModule==protocolModule;
    }
}
