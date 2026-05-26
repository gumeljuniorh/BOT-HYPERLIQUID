export type BotPhase = 
  | "PAPER_MODE_ACTIVE"
  | "LIVE_EXECUTION_BLOCKED"
  | "VALIDATION_READY"
  | "VALIDATION_RUNNING"
  | "VALIDATION_SUCCESS"
  | "VALIDATION_FAILED"
  | "PHASE_1_CONTROLLED_LIVE"
  | "PHASE_2_ADAPTIVE_EXECUTION"
  | "PHASE_0_STABILIZATION"
  | "CIRCUIT_BREAKER_ACTIVE";

export type OperationalState =
  | "ACTIVE_TRADING"
  | "MONITORING"
  | "PROTECTED_PAUSE"
  | "WSS_RECOVERY"
  | "RISK_REDUCTION_MODE"
  | "CRITICAL_FAILURE";

export type RiskProfile = "DEFENSIVE" | "BALANCED" | "AGGRESSIVE";

export interface TradeHistoryPoint {
  timestamp: number;
  value: number;
}

export interface BotConfig {
  maxExposure: number;
  leverage: number;
  stopLossPct: number;
  takeProfitPct: number;
  minEntrySize?: number;
  maxOpenPositions?: number;
  dailyLossLimitPct?: number;
  balanceReservePct?: number;
  microScalpModeEnabled?: boolean;
}

export interface ScannerOpportunity {
  symbol: string;
  markPrice: number;
  confidence: number;
  volatility: string;
  regime: string;
  liquidity: number;
  spread: number;
  htfAlignment: string;
  breakoutStatus: string;
  trendStrength: number;
  momentumScore: number;
  bias: string;
  eligibility: string;
  rejectionReason: string | null;
  trendMatch?: "TREND_MATCH_LONG" | "TREND_MATCH_SHORT" | "TREND_CONFLICT" | "NO_CLEAR_TREND";
  directionDecision?: "LONG continuation" | "SHORT continuation" | "LONG reversal" | "SHORT exhaustion/reversal" | "NO_TRADE";
  directionalBias?: "LONG" | "SHORT" | "REVERSAL_LONG" | "REVERSAL_SHORT" | "NEUTRAL" | string;
  regimeIntent?: "CONTINUATION" | "EXHAUSTION" | "RECOVERY" | "BREAKOUT" | string;
  longConfidence?: number;
  shortConfidence?: number;
  reversalProbability?: number;
  exhaustionProbability?: number;
  trendPhase?: string;
  leverageSelected?: number;
  leverageReason?: string;
  confirmationStatus?: string;
  confidencePass?: boolean;
  trendPass?: boolean;
  htfPass?: boolean;
  reversalPass?: boolean;
  expectedMovePass?: boolean;
  liquidityPass?: boolean;
  collateralPass?: boolean;
  watchlistState?: string;
}

export interface BotState {
  dryRun: boolean;
  phase: BotPhase;
  isProgrammaticClosing?: boolean;
  maxAllowedPositions?: number;
  dynamicPositionLimitReason?: string;
  configuredMaxPositions?: number;
  effectiveMaxPositions?: number;
  usedPositions?: number;
  pendingEntryCount?: number;
  availableSlots?: number;
  slotReductionReason?: string;
  slotReductionIsHardSafety?: boolean;
  operationalState?: OperationalState;
  riskProfile?: RiskProfile;
  previousPhase?: string | null;
  lastScanTime?: number | null;
  scansSinceLastEntry?: number;
  phaseDowngradeReason?: string | null;
  isUnified?: boolean;
  blocker: string | null;
  liveModeEnabled?: boolean;
  liveModeDiagnostics?: {
    DRY_RUN: boolean;
    LIVE_TRADING: boolean;
    privateKeyPresent: boolean;
    orderSubmissionEnabled: boolean;
    exchangeMutationsAllowed: boolean;
  };
  apiConnected: boolean;
  wssConnected: boolean;
  apiRateLimitUntil?: number;
  addressActionPacingUntil?: number;
  orderSubmittedFailedUntil?: number;
  apiBudget?: any;
  routerBlockCooldowns?: Record<string, number>;
  positionSizeInvalidCooldowns?: Record<string, number>;
  executionAttemptsMap?: Record<string, number>;
  executionThrottleUntil?: number;
  wssReconnectAttempts?: number;
  lastWssTime?: number;
  accountEquity: number;
  availableMargin: number;
  reservedPositionMargin?: number;
  reservedOrderMargin?: number;
  maintenanceMargin?: number;
  freeCollateralPct?: number;
  portfolioExposureUsedPct?: number;
  restingEntryOrderCount?: number;
  withdrawable: number;
  marginUsed: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
  action?: string;
  activeSymbol: string;
  markPrice: number;
  markPrices?: Record<string, number>;
  fundingRates?: Record<string, number>;
  marketScanner?: {
    liquidityScore: number;
    spreadQuality: number;
    volatilityGrade: string;
    confidenceRanking: number;
    higherTimeframeAlignment: string;
    regimeClassification: string;
    spreadScore?: number;
  };
  scannerOpportunities?: ScannerOpportunity[];
  fundingRate: number;
  openPositions: number;
  lastOrderId: string | null;
  lastFillPrice: number | null;
  lastCloseReason: string | null;
  validationStatus: string | null;
  validationStage: string | null;
  lastApiError: string | null;
  positionDetails: any | null;
  allPositions: any[];
  trades: TradeLog[];
  activeOrders: any[];
  priceHistory: TradeHistoryPoint[];
  pnlHistory: TradeHistoryPoint[];
  cloudRunId?: string;
  config: BotConfig;
  learningState?: LearningState;
  cmcIntelligence?: CMCTrendIntelligence;
  fundingReadinessScore?: "NOT_READY" | "WATCH" | "READY_SMALL_ADD" | "READY_SCALE" | string;
  volatilityClass?: string;
  narrativeStrength?: number;
  momentumPersistence?: number;
  executionPriorityRank?: number;
  autoRecoveryMode?: "ACTIVE" | "INACTIVE" | "ON" | "OFF" | string;
  correlatedExposure?: string[];
  chopState?: "TRUE_CHOP_NO_TRADE" | "DEVELOPING_BREAKOUT" | "DIRECTIONAL_CHOP_RECOVERY" | "CHOP_RECOVERY_MONITORING" | "CHOP_CLEARED_DIRECTIONAL" | "CHOP_ENTRY_APPROVED_REDUCED_RISK" | "NONE";
  preferredEntrySize?: number;
  actualEntrySize?: number;
  entryTier?: "STANDARD_ENTRY" | "REDUCED_ENTRY" | "MICRO_ENTRY" | "NONE";
  reducedSizeReason?: string;
  recoveryReason?: string;
  recoveryRiskLimits?: string;
  currentThresholdAdjustment?: number;
  participationRecoveryStatus?: string;
  recoveryExitConditions?: string;
  executionTrendMatch?: "TREND_MATCH_LONG" | "TREND_MATCH_SHORT" | "TREND_CONFLICT" | "NO_CLEAR_TREND" | null;
  executionDirectionDecision?: "LONG continuation" | "SHORT continuation" | "LONG reversal" | "SHORT exhaustion/reversal" | "NO_TRADE" | null;
  executionLeverageSelected?: number | null;
  executionLeverageReason?: string | null;
  executionConfirmationStatus?: string | null;
  trendStrengthHistory?: number[];
  expectedDirectionHistory?: string[];
  chopRecoveryActive?: boolean;
  entryOrdersContext?: Record<string, { symbol: string, side: string, size: number, px: number, confidence: number, regime: string, reason: string, ts: number }>;
  protection: {
    tpPrice: number | null;
    slPrice: number | null;
    trailingStopPrice: number | null;
    isTrailingActive: boolean;
    highestUnrealizedPnlPct?: number;
    currentLockedProfitPct?: number;
    activeProfitLockLevel?: string;
    highestFavorablePrice?: number | null;
    maxFavorableExcursionPct?: number;
    dynamicSlPrice?: number | null;
    runnerModeActive?: boolean;
    lastProfitLockLogLevel?: string;
    isLateButTradeable?: boolean;
    requiresTightTrailing?: boolean;
    isChopRecovery?: boolean;
  };
  protectionStatus?: "CONFIRMED" | "MISSING" | "REPAIRING" | "FAILED_EMERGENCY_CLOSE_REQUIRED";
  cooldownUntil?: number;
  cooldownType?: "HARD" | "SOFT" | "LOSS_COOLDOWN" | "WIN_COOLDOWN" | "CHOP_COOLDOWN" | "VOLATILITY_RESET_COOLDOWN" | "NARRATIVE_CONTINUATION_COOLDOWN" | "EARLY_REENTRY_COOLDOWN";
  lastCooldownSymbol?: string;
  cooldownOverrideActive?: boolean;
  lastExitWasSuccessful?: boolean;
  lastLoopTimestamp?: number;
  lastCloseSide?: "LONG" | "SHORT" | "NONE";
  lastEntryTimestamp?: number;
  dailyTradeCount?: number;
  lastTradeDate?: string;
  overtradingPauseUntil?: number;
  reverseLockUntil?: number;
  hypeStatus?: string;
  hypeDiagnostics?: {
    includedInUniverse: boolean;
    validPrice: boolean;
    metaLoaded: boolean;
    assetId: number;
    activeInScanner: boolean;
    eligibility: string;
    rejectionReason: string | null;
    selectedSide: string;
    finalScore: number;
    canTradeIfConditionsPass: boolean;
    updatedAt: number;
  };
  directionFlips?: number[];
  noTradeUntil?: number;
  feeEfficiencyPauseUntil?: number;
  peakEquity?: number;
  drawdownPauseUntil?: number;
  drawdownSeverity?: "NONE" | "SOFT" | "SOFT_LEVEL_1" | "SOFT_LEVEL_2" | "MODERATE" | "HARD" | "SEVERE" | "ELEVATED_DRAWDOWN";
  drawdownOverrideActive?: boolean;
  drawdownRecoveryProgress?: number;
  drawdownTroughEquity?: number;
  estimatedRecoveryThreshold?: number;
  lastSignalDirection?: "LONG" | "SHORT" | "NONE";
  feeEfficiency?: {
    netPnlAfterFees: number;
    feeToProfitRatio: number;
    overtradingScore: number;
    isPaused: boolean;
    pauseType?: "NONE" | "SOFT" | "HARD";
    pauseUntil?: number;
    eliteOverrideEligibility?: boolean;
  };
  feePauseOverrideActive?: boolean;
  feeSuspensionMisses?: Record<string, number>;
  assetFeeEfficiency?: Record<string, {
    totalFees: number;
    grossPnl: number;
    netPnl: number;
    feeToProfitRatio: number;
    avgFeePerTrade: number;
    avgRealizedMove: number;
    tradesAmount: number;
    isHighFeeMarket: boolean;
  }>;
  analytics: {
    totalTrades: number;
    totalWins?: number;
    totalLosses?: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    largestWin: number;
    largestLoss: number;
    cumulativeFees: number;
    netProfitability: number;
    currentDrawdown: number;
    lastDrawdownClearedAt?: number;
    lessons: string[];
    updatedAt: number;
    averageTradeDuration?: number;
    winLossByMarketRegime?: Record<string, { wins: number; losses: number; winRate: number }>;
    bestRegime?: string;
    worstRegime?: string;
    regimeDetailedStats?: Record<string, { wins: number; losses: number; winRate: number; netPnl: number; fees: number; averageDuration: number }>;
    overtradingScore?: number;
    expectancyAfterFees?: number;
    avgProjectedMove?: number;
    avgRealizedMove?: number;
    feeToProfitRatio?: number;
    falseBreakoutRate?: number;
    volatilityFailureRate?: number;
    missedRunnerCount?: number;
    postRallyContinuationScore?: number;
    recentEntryBias?: string;
    lastMissedRunner?: string;
    thresholdAdjustment?: number;
    recentContinuationSuccessRate?: number;
    recentFalseBreakouts?: number;
    TOO_CONSERVATIVE_OVERRIDE_ACTIVE?: boolean;
    lowVolExpectancy?: number;
    highVolExpectancy?: number;
    grossProfitability?: number;
    allTimeGainLoss?: number;
    longEdgeScore?: number;
    shortEdgeScore?: number;
    longWinRate?: number;
    shortWinRate?: number;
    regimeEdge?: Record<string, number>;
    feeAnalytics?: {
      totalFeesPaid: number;
      feeToProfitRatio: number;
      averageFeePerTrade: number;
      feeImpactPct: number;
    };
    participationAudit?: {
      totalScanned: number;
      eligibleCandidates: number;
      rejectedCandidates: number;
      blockedBySizing: number;
      blockedByDrawdown: number;
      blockedByVolatility: number;
      blockedByTrend: number;
      blockedByCooldown: number;
      blockedByRouter: number;
      blockedByLiquidity: number;
      lastTradeTime: number | null;
      participationParalysisActive: boolean;
      participationRate: number;
      dominantRejectionReason: string;
      finalExecutionVetoes: Record<string, string>;
    };
  };
  calibration?: {
    confidenceOutcomes: {
      highConfidenceTrades: { count: number, wins: number, avgPnl: number },
      midConfidenceTrades: { count: number, wins: number, avgPnl: number }
    },
    calibrationScore: number;
  };
  expectancy?: {
    byRegime: Record<string, { trades: number, expectancyAfterFees: number }>,
    byAsset: Record<string, { trades: number, expectancyAfterFees: number }>,
    rolling20: number,
    rolling50: number,
    rolling100: number,
    globalExpectancyAfterFees: number
  };
  participation?: {
    scannedCount: number;
    eligibleCount: number;
    rejectedCount: number;
    participationRate: number;
    conversionRate: number;
    missedRunnerCount: number;
    falseBreakoutCount: number;
    lowVolScanned?: number;
    lowVolApproved?: number;
    highVolScanned?: number;
    highVolApproved?: number;
    lowVolExpectancy?: number;
    highVolExpectancy?: number;
  };
  rejectedSetups?: RejectedSetup[];
  recentCandidates?: CandidateEvent[];
  cloudRuntimeHealth?: {
    CLOUD_RUNTIME_ACTIVE: boolean;
    LOOP_HEALTHY: boolean;
    WSS_HEALTHY: boolean;
    API_HEALTHY: boolean;
    SCANNER_ACTIVE: boolean;
    EXECUTOR_READY: boolean;
  };
  sizingTelemetry?: {
    lastSafeExposureComputed: number;
    lastExchangeMinimumRequired: number;
    marginBufferHealthPct: number;
    projectedFreeCollateralPct: number;
    projectedMarginUsagePct: number;
    rejectedTradesDueToSizing: number;
  };
  telemetry?: {
    activeTpCount: number;
    activeSlCount: number;
    duplicateProtectionWarnings: number;
    protectionSyncHealth: string;
    lastProtectionSync?: number;
    finalRouterAttemptsMap?: Record<string, number>;
    skippedLowPriorityCandidates?: number;
    sizingInvalidCooldownCount?: number;
    highRiskPrepareCount?: number;
    routerBlockCooldownCount?: number;
  };
  circuitBreakerHistory?: CircuitBreakerEvent[];
  missedRunnerTracking?: {
    [symbol: string]: {
      rejections: number;
      lastRejectionTime: number;
      lastRejectionPrice: number;
      expectedDirection: "LONG" | "SHORT" | "NONE";
      hasAttemptedOverride?: boolean;
      overrideActivationTime?: number;
    }
  };
}

export interface CircuitBreakerEvent {
  timestamp: number;
  reason: string;
  duration: number; // in milliseconds
}

export interface CandidateEvent {
  timestamp: number;
  symbol: string;
  side: "LONG" | "SHORT" | "NONE";
  confidence: number;
  regime: string;
  volatility: number;
  trendStrength: number;
  expectedMove: number;
  status: "ACCEPTED" | "REJECTED" | "MISSED_RUNNER";
  rejectionReason?: string;
  rejectionPrice?: number;
  currentPrice?: number;
  moveAfterRejectionPct?: number;
}

export interface RejectedSetup {
  symbol: string;
  confidence: number;
  requiredConfidence: number;
  regime: string;
  trendStrength: number;
  volatility: number;
  rejectionReason: string;
  originalScore?: number;
  penalties?: string[];
  finalScore?: number;
  longConfidence?: number;
  shortConfidence?: number;
  reversalProbability?: number;
  exhaustionProbability?: number;
  trendPhase?: string;
  directionalBiasWinner?: string;
  hardBlocker?: string | null;
  rejectedBy?: "SCORE" | "SAFETY_BLOCKER" | "UNKNOWN";
}

export interface TradeLog {
  id?: string;
  timestamp: number;
  type: "ENTRY" | "EXIT" | "MODIFICATION" | "VALIDATION";
  symbol: string;
  side: "LONG" | "SHORT" | "NONE";
  entryPrice?: number;
  exitPrice?: number;
  fillPrice?: number;
  orderId: string;
  closeOrderId?: string;
  leverage?: number;
  size?: number;
  notional?: number;
  fees?: number;
  slippage?: number;
  grossPnl?: number;
  netPnl?: number;
  realizedPnl?: number;
  unrealizedMaxGain?: number;
  unrealizedMaxDrawdown?: number;
  maxFavorableMove?: number;
  maxAdverseMove?: number;
  duration?: number;
  entryReason?: string;
  exitReason?: string;
  confidenceScore?: number;
  tradeQualityScore?: number;
  trendScore?: number;
  trendStrength?: number;
  momentumScore?: number;
  volatilityScore?: number;
  expectedMovePct?: number;
  fundingRate?: number;
  marketRegime?: string;
  htfAlignment?: boolean;
  apiLatency?: number;
  wssHealth?: string;
  reconciliationResult?: string;
}

export interface LearningBucket {
  id: string; // e.g. "REGIME:TRENDING|SIDE:LONG"
  type: "ASSET" | "REGIME" | "ENTRY_TYPE" | "DIRECTION" | "VOLATILITY" | "CONFIDENCE" | "DURATION";
  category: string; 
  recentTrades: number;
  recentWinRate: number;
  recentNetPnl: number;
  recentAvgHold: number;
  thresholdAdjustment: number;
  sizeAdjustment: number;
  cooldownPenalty: number;
  isPositiveEdge: boolean;
  isNegativeEdge: boolean;
}

export interface LearningState {
  buckets: Record<string, LearningBucket>;
  bestBuckets: string[];
  worstBuckets: string[];
  longEdgeScore: number;
  shortEdgeScore: number;
  bestRegime: string | null;
  worstRegime: string | null;
  globalLearningConfidence: number;
  corrupted: boolean;
  lastUpdateTimestamp: number;
}

export interface CMCTrendAsset {
  symbol: string;
  name: string;
  category: "TRENDING" | "GAINER" | "VOLUME_MOVER" | "MOST_WATCHED" | "RECENTLY_ADDED";
  narrative: string;
  volumeGrowth24h: number;
  marketCapGrowth24h: number;
  priceChange1h: number;
  priceChange24h: number;
  priceChange7d: number;
  status: "CMC_TREND_MATCHED_HYPERLIQUID" | "CMC_TREND_NOT_TRADABLE" | "SYMBOL_MAPPING_UNCERTAIN";
  matchedSymbol: string | null;
  trendScore: number;
  classification: "CMC_VOLATILE_GEM_CANDIDATE" | "STANDARD";
  action: "watching" | "matched" | "not tradable" | "candidate";
  momentumPersistenceScore?: number;
  finalExecutionScore?: number;
  executionPriority?: number;
}

export interface WatchlistAsset {
  symbol: string;
  matchedSymbol: string;
  addedTimestamp: number;
  lastScannedTimestamp: number;
  narrative: string;
  trendScore: number;
  volumeGrowth24h: number;
  momentumPersistence: number;
  state: "WATCHLIST_PREPARE_STATE" | "PREPARE" | "EXECUTED" | "REJECTED";
  metrics: {
    spreadQuality: number;
    liquidityQuality: number;
    directionalPersistence: number;
    breakoutPressure: number;
    volatilityExpansion: number;
    continuationStructure: string;
    momentumConsistency: number;
    lowVolCompressionQuality: number;
    narrativeStrongRounds: number;
    volumePersistenceRounds: number;
    spreadDegraded: boolean;
    liquidityDegraded: boolean;
    continuationResult: "STRENGTHENED" | "WEAKENED" | "NEUTRAL";
  };
  priorityScore: number;
  rank: number;
  rewardFeeRatio: number;
}

export interface CMCTrendIntelligence {
  assets: CMCTrendAsset[];
  lastScanTime: number;
  logs: string[];
  strongestNarrative?: string;
  weakeningNarrative?: string;
  emergingNarrative?: string;
  fadingNarrative?: string;
  narrativeHeat?: { name: string; score: number; trend: "STRENGTHENING" | "WEAKENING" | "EMERGING" | "FADING"; representativeSymbols: string[] }[];
  watchlist?: WatchlistAsset[];
}
