import { BotState } from "./types.js";
import { config } from "./config.js";

let _phase: any = config.PHASE_ONE_CONSERVATIVE ? "PHASE_1_CONTROLLED_LIVE" : "PHASE_2_ADAPTIVE_EXECUTION";

export const botState: BotState = {
  dryRun: config.DRY_RUN,
  get phase() {
    return _phase;
  },
  set phase(v: any) {
    let target = v;
    const oldPhase = _phase;
    if (oldPhase === "PHASE_2_ADAPTIVE_EXECUTION" && target !== "PHASE_2_ADAPTIVE_EXECUTION" && target !== "PHASE_1_CONTROLLED_LIVE" && target !== "CIRCUIT_BREAKER_ACTIVE" && !target.startsWith("VALIDATION_") && target !== "PAPER_MODE_ACTIVE") {
      console.log(`[NO_PHASE_DOWNGRADE_ARCHITECTURE] Attempted block downgrade to ${target}. Retaining unified PHASE_2_ADAPTIVE_EXECUTION.`);
      return;
    }
    _phase = target;
    import("./services/snapshotService.js").then(({ snapshotService }) => {
      snapshotService.saveSnapshot(botState);
    }).catch(() => {});
  },
  operationalState: "ACTIVE_TRADING",
  riskProfile: "BALANCED",
  maxAllowedPositions: config.MAX_OPEN_POSITIONS,
  dynamicPositionLimitReason: "Normal multi-position mode active",
  configuredMaxPositions: config.MAX_OPEN_POSITIONS,
  effectiveMaxPositions: config.MAX_OPEN_POSITIONS,
  usedPositions: 0,
  pendingEntryCount: 0,
  availableSlots: config.MAX_OPEN_POSITIONS,
  slotReductionReason: "NONE",
  slotReductionIsHardSafety: false,
  previousPhase: null,
  lastScanTime: Date.now(),
  scansSinceLastEntry: 0,
  phaseDowngradeReason: null,
  isUnified: false,
  blocker: null,
  apiConnected: false,
  wssConnected: false,
  accountEquity: 0,
  startOfDayEquity: 0,
  dailyPnlDate: "",
  dailyNetEquityChange: 0,
  availableMargin: 0,
  reservedPositionMargin: 0,
  reservedOrderMargin: 0,
  maintenanceMargin: 0,
  freeCollateralPct: 100,
  portfolioExposureUsedPct: 0,
  restingEntryOrderCount: 0,
  withdrawable: 0,
  marginUsed: 0,
  liquidationPrice: null,
  unrealizedPnl: 0,
  realizedPnl: 0,
  activeSymbol: "SOL",
  markPrice: 0,
  fundingRate: 0,
  fundingRates: { SOL: 0, BTC: 0, ETH: 0 },
  openPositions: 0,
  lastOrderId: null,
  lastFillPrice: null,
  lastCloseReason: null,
  validationStatus: null,
  validationStage: null,
  lastApiError: null,
  positionDetails: null,
  allPositions: [],
  trades: [],
  activeOrders: [],
  priceHistory: [],
  pnlHistory: [],
  cloudRunId: process.env.K_REVISION || process.env.HOSTNAME || "local",
  config: {
    maxExposure: 40,
    leverage: 2,
    stopLossPct: 1.2,
    takeProfitPct: 3.0,
    trailingStopLossEnabled: true,
    trailingStopLossActivationPct: 1.0,
    trailingStopLossTrailPct: 0.5,
    minEntrySize: 40,
    maxOpenPositions: config.MAX_OPEN_POSITIONS,
    dailyLossLimitPct: config.DAILY_LOSS_LIMIT_PCT,
    balanceReservePct: config.BALANCE_RESERVE_PCT,
    microScalpModeEnabled: config.MICRO_SCALP_MODE_ENABLED
  },
  apiBudget: {
    enabled: config.API_BUDGET_ENABLED,
    degradedMode: false,
    throttleReason: "NONE",
    restRequestsInWindow: 0,
    restBudgetLimit: config.API_MAX_REST_PER_MIN,
    executionRequestsPerMin: 0,
    protectionRequestsPerMin: 0,
    tpSlRequestsPerMin: 0,
    scannerRequestsPerMin: 0,
    accountRequestsPerMin: 0,
    metadataRequestsPerMin: 0,
    cacheHits: 0,
    blockedRequests: 0,
    lastUpdated: Date.now()
  },
  protection: {
    tpPrice: null,
    slPrice: null,
    trailingStopPrice: null,
    isTrailingActive: false,
    highestUnrealizedPnlPct: 0,
    currentLockedProfitPct: 0,
    activeProfitLockLevel: "NONE"
  },
  cooldownUntil: 0,
  cooldownType: "SOFT", // Initial default
  lastCooldownSymbol: "",
  cooldownOverrideActive: false,
  lastCloseSide: "NONE",
  lastEntryTimestamp: 0,
  dailyTradeCount: 0,
  lastTradeDate: new Date().toISOString().split("T")[0],
  overtradingPauseUntil: 0, // Set to 0 so we don't block trading on startup
  reverseLockUntil: 0,
  directionFlips: [],
  noTradeUntil: 0,
  chopState: "NONE",
  trendStrengthHistory: [],
  expectedDirectionHistory: [],
  chopRecoveryActive: false,
  feeEfficiencyPauseUntil: 0,
  peakEquity: 0,
  drawdownPauseUntil: 0,
  drawdownSeverity: "NONE",
  drawdownRecoveryProgress: 100,
  drawdownTroughEquity: 0,
  estimatedRecoveryThreshold: 0,
  lastSignalDirection: "NONE",
  missedRunnerTracking: {},
  feeEfficiency: {
    netPnlAfterFees: 0,
    feeToProfitRatio: 0,
    overtradingScore: 0,
    isPaused: false,
    pauseType: "NONE",
    pauseUntil: 0,
    eliteOverrideEligibility: false
  },
  feePauseOverrideActive: false,
  feeSuspensionMisses: {},
  assetFeeEfficiency: {},
  analytics: {
    totalTrades: 0,
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    cumulativeFees: 0,
    netProfitability: 0,
    currentDrawdown: 0,
    lessons: ["Awaiting initial trade data for analysis..."],
    updatedAt: Date.now(),
    averageTradeDuration: 0,
    winLossByMarketRegime: {},
    bestRegime: "N/A",
    worstRegime: "N/A",
    regimeDetailedStats: {},
    overtradingScore: 0,
    participationAudit: {
      totalScanned: 0,
      eligibleCandidates: 0,
      rejectedCandidates: 0,
      blockedBySizing: 0,
      blockedByDrawdown: 0,
      blockedByVolatility: 0,
      blockedByTrend: 0,
      blockedByCooldown: 0,
      blockedByRouter: 0,
      blockedByLiquidity: 0,
      lastTradeTime: null,
      participationParalysisActive: false,
      participationRate: 0,
      dominantRejectionReason: "UNKNOWN",
      finalExecutionVetoes: {}
    }
  },
  calibration: {
    confidenceOutcomes: {
      highConfidenceTrades: { count: 0, wins: 0, avgPnl: 0 },
      midConfidenceTrades: { count: 0, wins: 0, avgPnl: 0 }
    },
    calibrationScore: 1.0
  },
  expectancy: {
    byRegime: {},
    byAsset: {},
    rolling20: 0,
    rolling50: 0,
    rolling100: 0,
    globalExpectancyAfterFees: 0
  },
  participation: {
    scannedCount: 0,
    eligibleCount: 0,
    rejectedCount: 0,
    participationRate: 0,
    conversionRate: 0,
    missedRunnerCount: 0,
    falseBreakoutCount: 0
  },
  telemetry: {
    activeTpCount: 0,
    activeSlCount: 0,
    duplicateProtectionWarnings: 0,
    protectionSyncHealth: "UNKNOWN",
    lastProtectionSync: 0
  },
  rejectedSetups: [],
  recentCandidates: [],
  hypeStatus: "FOUND",
  hypeDiagnostics: {
    includedInUniverse: false,
    validPrice: false,
    metaLoaded: false,
    assetId: -1,
    activeInScanner: false,
    eligibility: "UNKNOWN",
    rejectionReason: null,
    selectedSide: "NONE",
    finalScore: 0,
    canTradeIfConditionsPass: false,
    updatedAt: Date.now()
  }
};

export const HYPE_MAPPING = {
  displaySymbol: "HYPE",
  exchangeSymbol: "HYPE",
  scannerSymbol: "HYPE",
  tradableSymbol: "HYPE",
};

export function normalizeSymbol(sym: string): string {
  if (!sym) return sym;
  return sym.toUpperCase().trim();
}

let assetMeta: any[] | null = null;

export function setAssetMeta(meta: any[]) {
  assetMeta = meta;
}

export function getAssetMetaGlobal(): any[] | null {
  return assetMeta;
}

export function getAssetId(symbol: string): number {
  const normSym = normalizeSymbol(symbol);
  if (!assetMeta) {
    return 0;
  }
  const asset = assetMeta.find((v: any) => v.name === normSym);
  if (!asset) {
    return 0;
  }
  return assetMeta.indexOf(asset);
}

export function getAssetMeta(symbol: string): any {
  const normSym = normalizeSymbol(symbol);
  if (!assetMeta) {
    return null;
  }
  let asset = assetMeta.find((v: any) => v.name === normSym);
  return asset;
}
