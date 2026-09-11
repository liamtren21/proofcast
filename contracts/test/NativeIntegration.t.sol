// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../src/ProofCastDreamDexAdapter.sol";
import "./TestBase.t.sol";

contract NativeProtocolFixture {
    struct Params {address collateralToken;address market;address outcomeToken;uint256 yesId;uint256 noId;uint256 oneCollateral;uint256 setBacking;address feeRecipient;uint256 makerFeeBpsTimes1k;uint256 takerFeeBpsTimes1k;uint256 maxBuilderFeeBpsTimes1k;uint256 settlementFeeBpsTimes1k;address settlement;uint64 marketNonce;bool finalized;}
    mapping(address=>uint256) private cash;
    function balanceOf(address who) external view returns(uint256){return cash[who];}
    mapping(address=>mapping(address=>uint256)) public allowance;
    mapping(address=>mapping(uint256=>uint256)) private outcomes;
    mapping(address=>mapping(address=>bool)) public isOperator;
    uint256 public cost;uint256 public fill;uint64 public nonce=1;uint8 public lastKind;bool public resolved;
    uint256 public lastQuantity;
    uint256 public lastPrice;
    struct Grid {uint256 tickSize;uint256 minQuantity;uint256 lotSize;}
    function getOrderBookParameters() external pure returns(Grid memory){return Grid(1000,1000,1000);}
    function balanceOf(address who,uint256 id) external view returns(uint256){return outcomes[who][id];}
    function mint(address to,uint256 amount) external{cash[to]+=amount;}
    function approve(address spender,uint256 amount) external returns(bool){allowance[msg.sender][spender]=amount;return true;}
    function transfer(address to,uint256 amount) external returns(bool){cash[msg.sender]-=amount;cash[to]+=amount;return true;}
    function transferFrom(address from,address to,uint256 amount) external returns(bool){allowance[from][msg.sender]-=amount;cash[from]-=amount;cash[to]+=amount;return true;}
    function setOperator(address operator,bool enabled) external returns(bool){isOperator[msg.sender][operator]=enabled;return true;}
    function getBinaryPoolParams() external view returns(Params memory){return Params(address(this),address(this),address(this),256,257,1e6,0,address(0),0,0,0,0,address(this),nonce,false);}
    function marketNonce(bytes32) external view returns(uint64){return nonce;}
    function markets(bytes32) external view returns(uint256,uint8,uint8,address,uint32,bytes32,address,address,address,address,uint256,uint256,uint64,uint64){return(0,2,0,address(this),7,bytes32("venue"),address(0),address(0),address(this),address(this),256,257,0,uint64(block.timestamp+1 days));}
    function marketExpiryNs() external view returns(uint64){return uint64((block.timestamp+1 days)*1e9);}
    function status() external pure returns(uint8){return 1;}
    function configure(uint256 c,uint256 f,bool r) external{cost=c;fill=f;resolved=r;}
    function recycle() external{nonce++;}
    function placeBinaryOrder(uint8 kind,uint256 price,uint256 quantity,uint64,uint8 orderType,uint8,address,uint96,uint64) external payable returns(bool,uint128){
        require(orderType==2);lastPrice=price;lastQuantity=quantity;lastKind=kind;allowance[msg.sender][address(this)]-=cost;cash[msg.sender]-=cost;cash[address(this)]+=cost;outcomes[msg.sender][kind==0?256:257]+=fill;return(true,123);
    }
    function isFinalized(uint256) external view returns(bool){return resolved;}
    function owed(address,address) external pure returns(uint256){return 0;}
    function redeem(uint256 id,uint256 amount,address to) public returns(uint256 payout){require(resolved);require(isOperator[msg.sender][address(this)]);outcomes[msg.sender][id]-=amount;payout=id==256?amount:0;cash[address(this)]-=payout;cash[to]+=payout;}
    function finalizeAndRedeem(address,uint256 id,uint256 amount,address to) external returns(uint256){return redeem(id,amount,to);}
}
contract NativeIntegrationTest is TestBase {
    NativeProtocolFixture protocol;ProofCastDreamDexAdapter adapter;
    function setUp() public {
        protocol=new NativeProtocolFixture();adapter=new ProofCastDreamDexAdapter();
        adapter.setFactory(address(this));adapter.registerVault(address(this));
        protocol.mint(address(this),10000000);protocol.mint(address(protocol),10000000);protocol.approve(address(adapter),10000000);
    }
    function bind() internal {
        (bool ok,)=address(adapter).call(abi.encodeWithSignature("configureProtocol(address,address,address,address)",address(protocol),address(protocol),address(protocol),address(protocol)));assertTrue(ok);
        adapter.setNativeExecutionEnabled(true);
    }
    function request(uint8 side) internal view returns(IProofCastNativeAdapter.TradeRequest memory){
        return IProofCastNativeAdapter.TradeRequest(address(protocol),address(protocol),address(protocol),bytes32("market"),1,7,bytes32("venue"),side,500000,1000000,uint64((block.timestamp+1 hours)*1e9),side==1?256:257);
    }
    function testYesFillUsesObservedQuantityCostAndRefund() public {
        bind();protocol.configure(400000,1000000,false);
        IProofCastNativeAdapter.TradeResult memory result=adapter.placeBuyIoc(request(1));
        assertEq(uint256(result.status),uint256(IProofCastNativeAdapter.ExecutionStatus.FILLED));
        assertEq(result.actualCost,400000);assertEq(result.filledAmount,1000000);
        assertEq(protocol.balanceOf(address(this)),9600000);assertEq(protocol.allowance(address(adapter),address(protocol)),0);
    }
    function testNoKindPartialZeroAndPoolRecycleGuard() public {
        bind();protocol.configure(100000,200000,false);
        IProofCastNativeAdapter.TradeResult memory result=adapter.placeBuyIoc(request(2));
        assertEq(protocol.lastKind(),2);assertEq(result.filledAmount,200000);
        assertEq(uint256(result.status),uint256(IProofCastNativeAdapter.ExecutionStatus.PARTIAL_FILL));
        protocol.configure(0,0,false);result=adapter.placeBuyIoc(request(2));assertEq(uint256(result.status),0);
        protocol.recycle();vm.expectRevert();adapter.placeBuyIoc(request(2));
    }
    function testRedeemAfterGateDisabledAndRecycleOnlyOnce() public {
        bind();protocol.configure(400000,1000000,false);adapter.placeBuyIoc(request(1));
        protocol.configure(0,0,true);protocol.recycle();adapter.setNativeExecutionEnabled(false);
        IProofCastNativeAdapter.RecoveryRequest memory r=IProofCastNativeAdapter.RecoveryRequest(address(protocol),7,bytes32("venue"),bytes32("market"),1,0,1000000,1);
        IProofCastNativeAdapter.RecoveryResult memory result=adapter.recover(r);
        assertEq(result.cashDelta,1000000);assertEq(result.recoveredPosition,1000000);
        assertEq(uint256(result.status),uint256(IProofCastNativeAdapter.ExecutionStatus.RECOVERED));
        vm.expectRevert();adapter.recover(r);
    }
    function testQuantityRoundsDownToLotWithoutIncreasingBudget() public {
        bind();protocol.configure(500,1000,false);
        IProofCastNativeAdapter.TradeRequest memory r=request(1);r.quantity=1999;
        IProofCastNativeAdapter.TradeResult memory result=adapter.placeBuyIoc(r);
        assertEq(protocol.lastQuantity(),1000);assertEq(result.filledAmount,1000);assertEq(result.actualCost,500);
        assertEq(protocol.balanceOf(address(this)),9999500);
    }
    function testNoOutcomePriceIsConvertedToNativeYesPrice() public {
        bind();protocol.configure(300000,1000000,false);
        IProofCastNativeAdapter.TradeRequest memory r=request(2);r.price=350000;
        adapter.placeBuyIoc(r);
        assertEq(protocol.lastPrice(),650000);assertEq(protocol.lastKind(),2);
        assertEq(protocol.balanceOf(address(this)),9700000);
    }
    function testOffGridPriceAndSubMinimumLotAreRejectedBeforeTransfer() public {
        bind();protocol.configure(0,0,false);
        IProofCastNativeAdapter.TradeRequest memory r=request(1);r.price=500001;
        vm.expectRevert();adapter.placeBuyIoc(r);
        r.price=500000;r.quantity=999;
        vm.expectRevert();adapter.placeBuyIoc(r);
        assertEq(protocol.balanceOf(address(this)),10000000);
    }
}
