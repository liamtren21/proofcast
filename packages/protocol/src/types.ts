/** Wire types deliberately keep money and block quantities as decimal strings. */
export type Side = 'YES' | 'NO';
export type Decision = Side | 'ABSTAIN';
export type WindowState = 'REGISTERED' | 'AWAITING_SIGNAL' | 'PUBLISHED' | 'ABSTAIN' | 'NO_SIGNAL' | 'WITHDRAWN' | 'DATA_UNAVAILABLE';
export type ExecutionState = 'NOT_ENROLLED' | 'ACTIVE' | 'REVOKED' | 'PRECHECK_REJECTED' | 'SIMULATION_REVERT' | 'SUBMITTED' | 'SUBMITTED_UNKNOWN' | 'MINED_REVERT' | 'ZERO_FILL' | 'PARTIAL_FILL' | 'FILLED';
export type SettlementState = 'OPEN' | 'RESOLVED' | 'VOIDED' | 'PAYOUT_PENDING' | 'RECOVERED';

export interface MarketRef {
  chainId: 50312; module: string; operatorId: number; venueId: string; marketId: string; marketAddress: string; pool: string; generation: string;
  collateral: string; outcomeToken: string; yesId: string; noId: string; tradingStartSec: number; expirySec: number; decisionCutoffSec: number;
}
export interface SessionManifest { id: string; creator: string; title: string; strategyHash: string; manifestHash: string; termsHash: string; markets: MarketRef[]; enrollUntilSec: number; sessionUntilSec: number; withdrawn: boolean; }
export interface Enrollment { id: string; sessionId: string; follower: string; vault: string; allowedSides: Side[]; maxYesPriceRaw: string; maxNoPriceRaw: string; maxOrderCostRaw: string; totalRiskBudgetRaw: string; validUntilSec: number; nonce: string; termsHash: string; revoked: boolean; }
export interface Signal { id: string; sessionId: string; marketId: string; generation: string; version: 1; decision: Decision; maxSidePriceRaw: string; validUntilSec: number; evidenceHash: string; anchoredBlock: string | null; anchoredTxHash: string | null; }
