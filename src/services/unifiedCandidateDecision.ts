import type { StrategySignal } from "../hyperliquidStrategy.js";
import type { CMCTrendAsset } from "../types.js";

export type UnifiedSide = "LONG" | "SHORT" | "NONE";
export type UnifiedSetupType =
  | "EARLY_CONTINUATION"
  | "CONFIRMED_CONTINUATION"
  | "PULLBACK_CONTINUATION"
  | "REVERSAL_ENTRY"
  | "EXHAUSTION_TRAP"
  | "DEAD_CHOP";
export type UnifiedLeverageTier = 0 | 1 | 2 | 4 | 8 | 10;
export type CmcDirectionalBias =
  | "LONG_CONTINUATION"
  | "SHORT_CONTINUATION"
  | "PULLBACK_LONG_CONTINUATION_CANDIDATE"
  | "PULLBACK_SHORT_CONTINUATION_CANDIDATE"
  | "REVERSAL_WARNING"
  | "NEUTRAL";

export interface UnifiedCandidateDecisionInput {
  symbol: string;
  signal: StrategySignal;
  cmc?: CMCTrendAsset | null;
  hlTechnicalScore: number;
  liquidityScore: number;
  spreadScore: number;
  rewardFeeScore: number;
  feePenalty: number;
  trendMatch?: string;
  rejectionReason?: string | null;
  maxLeverage?: number;
  apiHealthy: boolean;
  wssHealthy: boolean;
  freeCollateralPct: number;
  drawdownSeverity?: string;
  apiPressureActive?: boolean;
  hardSafetyClean: boolean;
}

export interface UnifiedCandidateDecision {
  symbol: string;
  selectedSide: UnifiedSide;
  sideReason: string;
  setupType: UnifiedSetupType;
  leverageTier: UnifiedLeverageTier;
  leverageReason: string;
  sizeTier: "MICRO" | "STANDARD" | "STRONG" | "ELITE" | "WATCH";
  sizeMultiplier: number;
  longScore: number;
  shortScore: number;
  continuationScore: number;
  reversalScore: number;
  exhaustionScore: number;
  trendCollapseRisk: number;
  liquidityScore: number;
  spreadScore: number;
  rewardFeeScore: number;
  cmcScore: number;
  hlTechnicalScore: number;
  finalExecutionScore: number;
  cmcDirectionalBias: CmcDirectionalBias;
  hlDirectionalConfirmation: "ALIGNED" | "CONFLICT" | "FORMING" | "NONE";
  directionDecision: "LONG continuation" | "SHORT continuation" | "LONG reversal" | "SHORT exhaustion/reversal" | "NO_TRADE";
  shouldEnter: boolean;
  action: "EXECUTE_LONG" | "EXECUTE_SHORT" | "WATCH" | "BLOCKED_HARD_SAFETY";
  logs: string[];
}

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const roundScore = (value: number) => Math.round(clamp(value));

function tierAtOrBelow(desired: UnifiedLeverageTier, maxLeverage: number): UnifiedLeverageTier {
  if (desired === 0 || desired === 1) return desired;
  const cap = Math.max(1, Math.floor(maxLeverage || 2));
  const tiers: UnifiedLeverageTier[] = [10, 8, 4, 2];
  return tiers.find((tier) => tier <= desired && tier <= cap) || (cap < 2 ? 1 : 2);
}

function classifyCmcBias(cmc?: CMCTrendAsset | null): {
  bias: CmcDirectionalBias;
  longMomentum: number;
  shortMomentum: number;
  logs: string[];
} {
  const logs: string[] = [];
  if (!cmc) {
    return { bias: "NEUTRAL", longMomentum: 45, shortMomentum: 45, logs };
  }

  const trend = clamp(cmc.trendScore || 0);
  const persistence = clamp(cmc.momentumPersistenceScore || 50);
  const volumeBoost = cmc.volumeGrowth24h >= 10 ? clamp(cmc.volumeGrowth24h, 0, 80) * 0.15 : 0;
  let longMomentum = 42 + trend * 0.12 + persistence * 0.12 + volumeBoost;
  let shortMomentum = 42 + trend * 0.12 + persistence * 0.12 + volumeBoost;
  let bias: CmcDirectionalBias = "NEUTRAL";

  if (cmc.priceChange1h > 0 && cmc.priceChange24h > 0 && trend >= 55) {
    longMomentum += 20;
    shortMomentum -= 10;
    bias = "LONG_CONTINUATION";
    logs.push(`[CMC_LONG_BIAS_APPLIED] ${cmc.matchedSymbol || cmc.symbol} positive 1h/24h CMC trend supports LONG continuation.`);
  } else if (cmc.priceChange1h < 0 && cmc.priceChange24h < 0 && trend >= 55) {
    shortMomentum += 20;
    longMomentum -= 10;
    bias = "SHORT_CONTINUATION";
    logs.push(`[CMC_SHORT_BIAS_APPLIED] ${cmc.matchedSymbol || cmc.symbol} negative 1h/24h CMC trend supports SHORT continuation.`);
  } else if (cmc.priceChange24h > 0 && cmc.priceChange1h < 0 && trend >= 55) {
    longMomentum += 16;
    shortMomentum += 4;
    bias = "PULLBACK_LONG_CONTINUATION_CANDIDATE";
    logs.push(`[CMC_PULLBACK_CONTINUATION_DETECTED] ${cmc.matchedSymbol || cmc.symbol} has positive 24h trend with 1h pullback; evaluating LONG continuation.`);
  } else if (cmc.priceChange24h < 0 && cmc.priceChange1h > 0 && trend >= 55) {
    shortMomentum += 16;
    longMomentum += 4;
    bias = "PULLBACK_SHORT_CONTINUATION_CANDIDATE";
    logs.push(`[CMC_PULLBACK_CONTINUATION_DETECTED] ${cmc.matchedSymbol || cmc.symbol} has negative 24h trend with 1h bounce; evaluating SHORT continuation.`);
  }

  if (Math.abs(cmc.priceChange24h || 0) >= 14 && Math.sign(cmc.priceChange1h || 0) !== Math.sign(cmc.priceChange24h || 0)) {
    bias = bias === "NEUTRAL" ? "REVERSAL_WARNING" : bias;
    logs.push(`[CMC_DIRECTIONAL_BIAS_MERGED_WITH_HL] ${cmc.matchedSymbol || cmc.symbol} CMC move shows possible exhaustion/pullback; local HL confirmation required.`);
  }

  return {
    bias,
    longMomentum: roundScore(longMomentum),
    shortMomentum: roundScore(shortMomentum),
    logs
  };
}

export function buildUnifiedCandidateDecision(input: UnifiedCandidateDecisionInput): UnifiedCandidateDecision {
  const logs: string[] = [];
  const signal = input.signal;
  const cmc = input.cmc || null;
  const cmcBias = classifyCmcBias(cmc);
  logs.push(...cmcBias.logs);

  const localLongStructure = clamp(signal.longConfidence ?? (signal.direction === "LONG" ? signal.confidence : 25));
  const localShortStructure = clamp(signal.shortConfidence ?? (signal.direction === "SHORT" ? signal.confidence : 25));
  const trendStrengthPct = clamp((signal.trendStrength || 0) * 100);
  const momentumPct = clamp((signal.momentumScore || 0) * 100);
  const volatilityPct = clamp((signal.volatilityScore || 0) * 100);
  const cmcScore = cmc ? clamp((cmc.trendScore || 0) * 0.65 + (cmc.momentumPersistenceScore || 50) * 0.35) : 45;
  const rewardFeeScore = clamp(input.rewardFeeScore);
  const spreadPenalty = input.spreadScore < 50 ? 14 : input.spreadScore < 70 ? 6 : 0;
  const trendCollapseRisk = signal.trendPhase === "TREND_COLLAPSE" || signal.marketRegime === "RANGING_CHOP"
    ? 70
    : signal.marketRegime === "CHAOTIC_VOL"
      ? 85
      : 15;

  const continuationScore = roundScore(
    trendStrengthPct * 0.34 +
    momentumPct * 0.28 +
    input.hlTechnicalScore * 0.2 +
    input.liquidityScore * 0.08 +
    input.spreadScore * 0.05 +
    cmcScore * 0.05
  );

  const exhaustionScore = clamp(signal.exhaustionProbability ?? 20);
  const reversalScore = roundScore(
    (signal.reversalProbability || 0) * 0.45 +
    exhaustionScore * 0.25 +
    trendCollapseRisk * 0.15 +
    volatilityPct * 0.15
  );

  const longExhaustionPenalty = signal.rawDirection === "LONG" && exhaustionScore >= 70 ? exhaustionScore * 0.22 : exhaustionScore * 0.08;
  const shortExhaustionPenalty = signal.rawDirection === "SHORT" && exhaustionScore >= 70 ? exhaustionScore * 0.22 : exhaustionScore * 0.08;
  const longScore = roundScore(
    localLongStructure * 0.42 +
    cmcBias.longMomentum * 0.22 +
    continuationScore * 0.15 +
    input.liquidityScore * 0.06 +
    input.spreadScore * 0.05 +
    rewardFeeScore * 0.1 -
    longExhaustionPenalty -
    spreadPenalty -
    trendCollapseRisk * 0.08
  );
  const shortScore = roundScore(
    localShortStructure * 0.42 +
    cmcBias.shortMomentum * 0.22 +
    Math.max(continuationScore, reversalScore) * 0.15 +
    input.liquidityScore * 0.06 +
    input.spreadScore * 0.05 +
    rewardFeeScore * 0.1 -
    shortExhaustionPenalty -
    spreadPenalty -
    trendCollapseRisk * 0.08
  );

  logs.push(`[LONG_SHORT_SCORE_CALCULATED] ${input.symbol} longScore=${longScore}, shortScore=${shortScore}, continuation=${continuationScore}, reversal=${reversalScore}, exhaustion=${Math.round(exhaustionScore)}.`);

  const activeCmcTrend = !!cmc && ((cmc.trendScore || 0) >= 70 || (cmc.momentumPersistenceScore || 0) >= 70);
  const sideThreshold = activeCmcTrend ? 40 : 45;
  const sideMargin = activeCmcTrend ? 5 : 8;
  let selectedSide: UnifiedSide = "NONE";
  let sideReason = "No side has enough edge.";

  if (longScore >= sideThreshold && longScore >= shortScore + sideMargin) {
    selectedSide = "LONG";
    sideReason = `LONG score ${longScore} cleared threshold ${sideThreshold} and beat SHORT by ${longScore - shortScore}.`;
    logs.push(`[FINAL_SIDE_SELECTED_BY_SCORE] ${input.symbol} selected LONG by unified score.`);
    logs.push(`[LONG_ENTRY_EDGE_CONFIRMED] ${input.symbol} LONG edge confirmed by HL/CMC score merge.`);
  } else if (shortScore >= sideThreshold && shortScore >= longScore + sideMargin) {
    selectedSide = "SHORT";
    sideReason = `SHORT score ${shortScore} cleared threshold ${sideThreshold} and beat LONG by ${shortScore - longScore}.`;
    logs.push(`[FINAL_SIDE_SELECTED_BY_SCORE] ${input.symbol} selected SHORT by unified score.`);
    logs.push(`[SHORT_ENTRY_EDGE_CONFIRMED] ${input.symbol} SHORT edge confirmed by HL/CMC score merge.`);
  } else if (Math.max(longScore, shortScore) >= sideThreshold) {
    logs.push(`[NO_BIAS_REJECTED_SIDE_EDGE_PRESENT] ${input.symbol} has side edge but scores are too close: long=${longScore}, short=${shortScore}. Waiting instead of defaulting LONG.`);
  }

  const earlyRegimes = new Set([
    "HEALTHY_LOW_VOL_EXPANSION",
    "LOW_VOL_SQUEEZE",
    "PRE_BREAKOUT_COMPRESSION",
    "EARLY_DIRECTIONAL_EXPANSION",
    "PRE_BREAKOUT_MOMENTUM",
    "MOMENTUM_BUILDING",
    "EARLY_CONTINUATION_ENTRY",
    "CONTROLLED_EARLY_PARTICIPATION"
  ]);

  let setupType: UnifiedSetupType = "DEAD_CHOP";
  if (selectedSide === "NONE" && !activeCmcTrend && input.hlTechnicalScore < 38) {
    setupType = "DEAD_CHOP";
  } else if (exhaustionScore >= 82 && reversalScore < 62 && continuationScore < 76) {
    setupType = "EXHAUSTION_TRAP";
    logs.push(`[EXHAUSTION_TRAP_AVOIDED] ${input.symbol} exhaustion is high without enough reversal confirmation; no chase.`);
  } else if (cmcBias.bias === "PULLBACK_LONG_CONTINUATION_CANDIDATE" || cmcBias.bias === "PULLBACK_SHORT_CONTINUATION_CANDIDATE" || signal.marketRegime === "PULLBACK_RETEST_VALID") {
    setupType = "PULLBACK_CONTINUATION";
  } else if (reversalScore >= 65 && (signal.trendPhase === "REVERSAL_TRANSITION" || signal.trendPhase === "EXHAUSTION" || signal.marketRegime?.includes("EXHAUSTION"))) {
    setupType = "REVERSAL_ENTRY";
  } else if (continuationScore >= 70 || signal.marketRegime?.includes("CONTINUATION") || signal.marketRegime === "RUNNER_SETUP_DETECTED") {
    setupType = "CONFIRMED_CONTINUATION";
  } else if (earlyRegimes.has(signal.marketRegime || "") || activeCmcTrend) {
    setupType = "EARLY_CONTINUATION";
  }

  logs.push(`[ENTRY_TIMING_CLASSIFIED] ${input.symbol} setupType=${setupType}, cmcBias=${cmcBias.bias}, hlDirection=${signal.direction || "NONE"}.`);
  if (setupType === "EARLY_CONTINUATION") logs.push(`[EARLY_CONTINUATION_ENTRY_APPROVED] ${input.symbol} eligible for controlled early continuation if hard safety passes.`);
  if (setupType === "CONFIRMED_CONTINUATION") logs.push(`[CONFIRMED_CONTINUATION_ENTRY_APPROVED] ${input.symbol} confirmed continuation quality detected.`);
  if (setupType === "PULLBACK_CONTINUATION") logs.push(`[PULLBACK_CONTINUATION_ENTRY_APPROVED] ${input.symbol} pullback continuation preferred entry detected.`);
  if (setupType === "REVERSAL_ENTRY") logs.push(`[REVERSAL_ENTRY_APPROVED] ${input.symbol} reversal entry requires exhaustion plus local confirmation.`);

  let directionDecision: UnifiedCandidateDecision["directionDecision"] = "NO_TRADE";
  if (selectedSide === "LONG") directionDecision = setupType === "REVERSAL_ENTRY" ? "LONG reversal" : "LONG continuation";
  if (selectedSide === "SHORT") directionDecision = setupType === "REVERSAL_ENTRY" ? "SHORT exhaustion/reversal" : "SHORT continuation";

  const selectedSideScore = selectedSide === "LONG" ? longScore : selectedSide === "SHORT" ? shortScore : Math.max(longScore, shortScore);
  const finalExecutionScore = roundScore(
    selectedSideScore * 0.38 +
    input.hlTechnicalScore * 0.2 +
    cmcScore * 0.14 +
    continuationScore * 0.1 +
    input.liquidityScore * 0.06 +
    input.spreadScore * 0.05 +
    rewardFeeScore * 0.07 -
    spreadPenalty -
    input.feePenalty * 0.5 -
    (setupType === "EXHAUSTION_TRAP" ? 20 : 0) -
    (setupType === "DEAD_CHOP" ? 18 : 0)
  );

  const emergencyRisk =
    !input.apiHealthy ||
    !input.wssHealthy ||
    input.freeCollateralPct < 20 ||
    ["HARD", "SEVERE", "ELEVATED_DRAWDOWN"].includes(input.drawdownSeverity || "") ||
    signal.marketRegime === "EXTREME_VOLATILITY" ||
    signal.marketRegime === "CHAOTIC_VOL";
  const drawdownClean = !input.drawdownSeverity || input.drawdownSeverity === "NONE";

  let desiredLeverage: UnifiedLeverageTier = 2;
  let leverageReason = "Controlled risk entry.";
  const cleanLiquidity = input.liquidityScore >= 70 && input.spreadScore >= 70;
  const excellentLiquidity = input.liquidityScore >= 82 && input.spreadScore >= 82;
  const cmcHlAligned =
    selectedSide !== "NONE" &&
    ((selectedSide === "LONG" && cmcBias.longMomentum >= cmcBias.shortMomentum) ||
      (selectedSide === "SHORT" && cmcBias.shortMomentum >= cmcBias.longMomentum));

  if (emergencyRisk) {
    desiredLeverage = 1;
    leverageReason = "Emergency-only leverage: drawdown, API/WSS, collateral, or chaotic volatility risk.";
    logs.push(`[EMERGENCY_1X_ONLY] ${input.symbol} 1x selected only because true emergency risk is active.`);
  } else if (
    finalExecutionScore >= 85 &&
    selectedSideScore >= 85 &&
    excellentLiquidity &&
    rewardFeeScore >= 75 &&
    cmcHlAligned &&
    !input.apiPressureActive &&
    drawdownClean
  ) {
    desiredLeverage = 10;
    leverageReason = "Elite CMC + HL alignment with excellent liquidity and reward/fee.";
    logs.push(`[LEVERAGE_10X_SELECTED] ${input.symbol} elite leverage tier selected.`);
  } else if (
    finalExecutionScore >= 70 &&
    selectedSideScore >= 65 &&
    cleanLiquidity &&
    (continuationScore >= 70 || cmcScore >= 75) &&
    rewardFeeScore >= 55
  ) {
    desiredLeverage = 8;
    leverageReason = "Strong continuation or trend/momentum setup.";
    logs.push(`[LEVERAGE_8X_SELECTED] ${input.symbol} strong trend leverage tier selected.`);
  } else if (
    finalExecutionScore >= 55 &&
    selectedSideScore >= 55 &&
    input.liquidityScore >= 60 &&
    input.spreadScore >= 60 &&
    rewardFeeScore >= 40
  ) {
    desiredLeverage = 4;
    leverageReason = "Standard confirmed setup with clean liquidity/spread.";
    logs.push(`[LEVERAGE_4X_SELECTED] ${input.symbol} standard confirmed leverage tier selected.`);
  } else {
    desiredLeverage = 2;
    logs.push(`[LEVERAGE_2X_SELECTED] ${input.symbol} controlled/uncertain setup uses 2x.`);
  }

  if (setupType === "REVERSAL_ENTRY" && desiredLeverage > 4) {
    desiredLeverage = 4;
    leverageReason = "Reversal entries cap leverage at 4x unless they mature into confirmed continuation.";
  }
  if (setupType === "EARLY_CONTINUATION" && desiredLeverage > 4) {
    desiredLeverage = 4;
    leverageReason = "Early continuation uses controlled 2x/4x until confirmation improves.";
  }

  const leverageTier = tierAtOrBelow(desiredLeverage, input.maxLeverage || 15);
  logs.push(`[UNIFIED_LEVERAGE_SELECTED] ${input.symbol} leverage=${leverageTier}x, setupType=${setupType}, finalScore=${finalExecutionScore}, reason=${leverageReason}`);

  let sizeTier: UnifiedCandidateDecision["sizeTier"] = "WATCH";
  let sizeMultiplier = 0.7;
  if (setupType === "EXHAUSTION_TRAP" || setupType === "DEAD_CHOP" || selectedSide === "NONE") {
    sizeTier = "WATCH";
    sizeMultiplier = 0.5;
  } else if (leverageTier >= 8 && finalExecutionScore >= 75) {
    sizeTier = leverageTier === 10 ? "ELITE" : "STRONG";
    sizeMultiplier = leverageTier === 10 ? 1.25 : 1.15;
    logs.push(`[HIGH_QUALITY_SETUP_SIZE_BOOST] ${input.symbol} ${sizeTier} setup receives controlled size boost.`);
    logs.push(`[HIGH_QUALITY_SETUP_LEVERAGE_BOOST] ${input.symbol} high-quality setup receives ${leverageTier}x tier.`);
  } else if (leverageTier === 4) {
    sizeTier = "STANDARD";
    sizeMultiplier = setupType === "REVERSAL_ENTRY" ? 0.8 : 1.0;
  } else {
    sizeTier = "MICRO";
    sizeMultiplier = 0.7;
    logs.push(`[CONTROLLED_RISK_ENTRY_REDUCED_SIZE] ${input.symbol} controlled setup uses reduced size, not a hard block.`);
  }

  if (sizeMultiplier < 1) {
    logs.push(`[SOFT_RISK_REDUCED_SIZE_NOT_LEVERAGE] ${input.symbol} soft uncertainty adjusted notional size while preserving selected leverage tier.`);
  }
  if (selectedSide !== "NONE" && finalExecutionScore >= 55 && setupType !== "EXHAUSTION_TRAP") {
    logs.push(`[GAIN_OPTIMIZED_ENTRY_APPROVED] ${input.symbol} unified model approves gain-optimized entry path if hard safety passes.`);
  }

  const shouldEnter =
    input.hardSafetyClean &&
    selectedSide !== "NONE" &&
    setupType !== "EXHAUSTION_TRAP" &&
    setupType !== "DEAD_CHOP" &&
    finalExecutionScore >= 38;

  const hlDirectionalConfirmation =
    signal.direction === selectedSide && signal.rawDirection === selectedSide
      ? "ALIGNED"
      : signal.direction !== "NONE" && selectedSide !== "NONE" && signal.direction !== selectedSide
        ? "CONFLICT"
        : selectedSide !== "NONE"
          ? "FORMING"
          : "NONE";

  return {
    symbol: input.symbol,
    selectedSide,
    sideReason,
    setupType,
    leverageTier,
    leverageReason,
    sizeTier,
    sizeMultiplier,
    longScore,
    shortScore,
    continuationScore,
    reversalScore,
    exhaustionScore: Math.round(exhaustionScore),
    trendCollapseRisk,
    liquidityScore: input.liquidityScore,
    spreadScore: input.spreadScore,
    rewardFeeScore,
    cmcScore: roundScore(cmcScore),
    hlTechnicalScore: roundScore(input.hlTechnicalScore),
    finalExecutionScore,
    cmcDirectionalBias: cmcBias.bias,
    hlDirectionalConfirmation,
    directionDecision,
    shouldEnter,
    action: !input.hardSafetyClean
      ? "BLOCKED_HARD_SAFETY"
      : selectedSide === "LONG" && shouldEnter
        ? "EXECUTE_LONG"
        : selectedSide === "SHORT" && shouldEnter
          ? "EXECUTE_SHORT"
          : "WATCH",
    logs
  };
}
