import { botState } from "../state.js";
import { config } from "../config.js";

export interface PositionSlotState {
  configuredMaxPositions: number;
  effectiveMaxPositions: number;
  usedPositions: number;
  availableSlots: number;
  slotReductionReason: string;
  slotReductionIsHardSafety: boolean;
}

function openPositionCount(): number {
  const activeExchangePositions = (botState.allPositions || []).filter((p: any) => Math.abs(parseFloat(p?.szi || "0")) > 0);
  if (activeExchangePositions.length > 0) return activeExchangePositions.length;
  if (typeof botState.openPositions === "number" && botState.openPositions > 0) return botState.openPositions;
  return botState.positionDetails && Math.abs(parseFloat(botState.positionDetails?.szi || "0")) > 0 ? 1 : 0;
}

function currentHardSlotReason(usedPositions: number): string {
  const telemetry = botState.telemetry;
  const currentDrawdown = botState.analytics?.currentDrawdown || 0;
  const severeDrawdownIsReal =
    botState.drawdownSeverity === "HARD" &&
    (currentDrawdown >= 10 || ((botState.drawdownPauseUntil || 0) > Date.now() && currentDrawdown >= 5));

  if (!botState.apiConnected || !botState.wssConnected) return "WSS_API_UNHEALTHY";
  if ((botState.freeCollateralPct || 100) < 15 || (botState.availableMargin || 0) <= 0) return "UNSAFE_COLLATERAL";
  if (botState.phase === "CIRCUIT_BREAKER_ACTIVE" || botState.blocker === "CRITICAL_FAILURE") return "CORRUPTED_POSITION_STATE";
  if (severeDrawdownIsReal) return "SEVERE_DRAWDOWN";
  if (botState.protectionStatus === "REPAIRING") return "PROTECTION_REPAIRING";
  if (botState.protectionStatus === "FAILED_EMERGENCY_CLOSE_REQUIRED") return "EMERGENCY_CLOSE_FAILURE";

  if (usedPositions > 0) {
    if ((telemetry?.currentProtectionIssue || "").includes("MISSING_SL")) return "ACTIVE_POSITION_MISSING_SL";
    if ((telemetry?.currentProtectionIssue || "").includes("MISSING_TP")) return "ACTIVE_POSITION_MISSING_TP";
    if ((telemetry?.currentProtectionIssue || "").includes("DUPLICATE")) return "DUPLICATE_TP_SL_PROTECTION";
    if (telemetry?.protectionSyncHealth === "UNHEALTHY") return "PROTECTION_UNHEALTHY";
    if ((telemetry?.activeSlCount || 0) < 1 && botState.protectionStatus !== "CONFIRMED") return "ACTIVE_POSITION_MISSING_SL";
  }

  const scanner = botState.marketScanner;
  if ((scanner?.spreadQuality || 100) < 15 || (scanner?.liquidityScore || 100) < 15) return "CATASTROPHIC_SPREAD_LIQUIDITY";

  const apiError = botState.lastApiError || "";
  if (/reject|insufficient|invalid order|exchange/i.test(apiError)) return "EXCHANGE_ORDER_REJECTION_STATE";

  return "NONE";
}

export function calculatePositionSlots(): PositionSlotState {
  const configuredMaxPositions = Math.max(3, Math.floor(botState.config?.maxOpenPositions || config.MAX_OPEN_POSITIONS || 3));
  const usedPositions = openPositionCount();
  const slotReductionReason = currentHardSlotReason(usedPositions);
  const slotReductionIsHardSafety = slotReductionReason !== "NONE";
  const effectiveMaxPositions = slotReductionIsHardSafety
    ? Math.min(configuredMaxPositions, usedPositions)
    : configuredMaxPositions;
  const availableSlots = Math.max(0, effectiveMaxPositions - usedPositions);

  botState.configuredMaxPositions = configuredMaxPositions;
  botState.effectiveMaxPositions = effectiveMaxPositions;
  botState.usedPositions = usedPositions;
  botState.availableSlots = availableSlots;
  botState.slotReductionReason = slotReductionReason;
  botState.slotReductionIsHardSafety = slotReductionIsHardSafety;
  botState.maxAllowedPositions = effectiveMaxPositions;
  botState.dynamicPositionLimitReason = slotReductionIsHardSafety ? slotReductionReason : "NONE";

  return {
    configuredMaxPositions,
    effectiveMaxPositions,
    usedPositions,
    availableSlots,
    slotReductionReason,
    slotReductionIsHardSafety
  };
}

export function canOpenNewEntry(): boolean {
  const slots = calculatePositionSlots();
  return !slots.slotReductionIsHardSafety && slots.availableSlots > 0;
}
