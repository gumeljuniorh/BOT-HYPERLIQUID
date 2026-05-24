import { botState } from "../state.js";

export function calculatePositionSlots(): void {
  const configuredMax = botState.config?.maxOpenPositions || 3;
  const used = botState.openPositions || 0;
  
  botState.configuredMaxPositions = configuredMax;
  botState.usedPositions = used;

  let effectiveMax = configuredMax;
  let reason = "NONE";
  let isHardSafety = false;

  // Real hard safety reasons that should restrict trading slots
  if (botState.protectionStatus === "REPAIRING" || botState.protectionStatus === "FAILED_EMERGENCY_CLOSE_REQUIRED") {
     effectiveMax = used; // prevent new, allow existing
     reason = `PROTECTION_${botState.protectionStatus}`;
     isHardSafety = true;
  }
  
  if (botState.telemetry && botState.telemetry.protectionSyncHealth === "UNHEALTHY") {
     effectiveMax = used;
     reason = "PROTECTION_SYNC_ERROR";
     isHardSafety = true;
  }
  
  // Severe drawdown
  if (botState.drawdownSeverity === "HARD" || botState.blocker === "HARD_DRAWDOWN_PAUSE_ACTIVE") {
     effectiveMax = 0;
     reason = "SEVERE_DRAWDOWN";
     isHardSafety = true;
  }

  // Bad connectivity or extreme API lag
  if (!botState.wssConnected || !botState.apiConnected) {
     effectiveMax = used;
     reason = "WSS_API_UNSTABLE";
     isHardSafety = true;
  }
  
  // Free collateral constraints
  if ((botState.freeCollateralPct || 100) < 15) {
     effectiveMax = used;
     reason = "INSUFFICIENT_COLLATERAL";
     isHardSafety = true;
  }

  // Other known hard blockers
  const hardBlockers = [
    "TP_SL_MISSING_FOR_OPEN_POSITION",
    "CRITICAL_FAILURE",
    "API_NOT_VERIFIED",
    "CORRUPTED_POSITION_STATE",
    "CATASTROPHIC_LIQUIDITY",
    "ORDER_SUBMITTED_FAILED"
  ];
  
  const blocker = botState.blocker || "";
  if (!isHardSafety && hardBlockers.some(b => blocker.includes(b))) {
     effectiveMax = used; 
     reason = botState.blocker || "HARD_SAFETY_BLOCK";
     isHardSafety = true;
  }
  
  if (used >= effectiveMax && isHardSafety) {
     effectiveMax = used;
  }

  botState.effectiveMaxPositions = effectiveMax;
  botState.availableSlots = Math.max(0, effectiveMax - used);
  botState.slotReductionReason = reason;
  botState.slotReductionIsHardSafety = isHardSafety;
}

export function canOpenNewEntry(): boolean {
  calculatePositionSlots();
  return (botState.availableSlots || 0) > 0;
}
