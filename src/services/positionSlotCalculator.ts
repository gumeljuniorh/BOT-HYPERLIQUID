import { botState } from "../state.js";

let lastSlotLog = "";
let lastSlotLogAt = 0;

function getOpenPositionSymbols(): Set<string> {
  const symbols = new Set<string>();
  for (const pos of botState.allPositions || []) {
    const symbol = pos.coin || pos.position?.coin;
    const size = Math.abs(parseFloat(pos.szi || pos.position?.szi || "0"));
    if (symbol && size > 0) symbols.add(symbol);
  }
  if (symbols.size === 0 && botState.positionDetails?.coin && Math.abs(parseFloat(botState.positionDetails?.szi || "0")) > 0) {
    symbols.add(botState.positionDetails.coin);
  }
  return symbols;
}

function countPendingEntrySymbols(openSymbols: Set<string>): number {
  const pendingSymbols = new Set<string>();
  const now = Date.now();

  for (const order of botState.activeOrders || []) {
    // Only count non-reduceOnly limit entries that are actually open
    // Wait, the user asked to ONLY count real open positions?
    // Let's only look at orders placed in the last 15 seconds to avoid artificially holding slots
    if (order && !order.reduceOnly && order.coin && !openSymbols.has(order.coin)) {
      if (order.timestamp && now - order.timestamp < 15000) {
        pendingSymbols.add(order.coin);
      }
    }
  }

  return pendingSymbols.size;
}

function logPositionSlotState(openPositions: number, pendingEntries: number, configuredMax: number, effectiveMax: number, availableSlots: number, reason: string): void {
  const payload = `openPositions=${openPositions}, pendingEntries=${pendingEntries}, maxOpenPositions=${configuredMax}, effectiveMaxPositions=${effectiveMax}, availableSlots=${availableSlots}, reason=${reason}`;
  const now = Date.now();
  if (payload !== lastSlotLog || now - lastSlotLogAt > 15_000) {
    console.log(`[POSITION_SLOT] ${payload}`);
    lastSlotLog = payload;
    lastSlotLogAt = now;
  }
}

export function calculatePositionSlots(): void {
  const now = Date.now();
  if (botState.blocker === "ORDER_SUBMITTED_FAILED") {
    if (!botState.orderSubmittedFailedUntil || now > botState.orderSubmittedFailedUntil) {
      console.log("[SLOT_CALCULATOR_RECOVERY] ORDER_SUBMITTED_FAILED temporary pacing state expired. Resetting blocker.");
      botState.blocker = null;
    }
  }

  const configuredMax = botState.config?.maxOpenPositions ?? 3;
  const openSymbols = getOpenPositionSymbols();
  const reportedOpenPositions = botState.openPositions || 0;
  const openCount = openSymbols.size;
  if (reportedOpenPositions !== openCount) {
    console.log(`[GHOST_SLOT_CLEARED] Reported openPositions=${reportedOpenPositions} reconciled to realOpenPositions=${openCount}. Reduce-only orders, failed orders, and stale pending entries do not consume slots.`);
    console.log(`[POSITION_SLOT_SOURCE_RECONCILED] Slots now count real open positions only.`);
    botState.openPositions = openCount;
  }
  const pendingEntries = countPendingEntrySymbols(openSymbols);
  const usedForSlots = openCount + pendingEntries;
  
  botState.configuredMaxPositions = configuredMax;
  botState.usedPositions = openCount;
  botState.pendingEntryCount = pendingEntries;

  let effectiveMax = configuredMax;
  let reason = "NONE";
  let isHardSafety = false;

  // Real hard safety reasons that should restrict trading slots
  if (botState.protectionStatus === "REPAIRING" || botState.protectionStatus === "FAILED_EMERGENCY_CLOSE_REQUIRED") {
     effectiveMax = usedForSlots; // prevent new, allow existing
     reason = `PROTECTION_${botState.protectionStatus}`;
     isHardSafety = true;
  }
  
  if (botState.telemetry && botState.telemetry.protectionSyncHealth === "UNHEALTHY") {
     effectiveMax = usedForSlots;
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
     effectiveMax = usedForSlots;
     reason = "WSS_API_UNSTABLE";
     isHardSafety = true;
  }
  
  // Free collateral constraints
  if ((botState.freeCollateralPct || 100) < 15) {
     effectiveMax = usedForSlots;
     reason = "INSUFFICIENT_COLLATERAL";
     isHardSafety = true;
  }

  // Other known hard blockers
  const hardBlockers = [
    "TP_SL_MISSING_FOR_OPEN_POSITION",
    "CRITICAL_FAILURE",
    "API_NOT_VERIFIED",
    "CORRUPTED_POSITION_STATE",
    "CATASTROPHIC_LIQUIDITY"
  ];
  
  const blocker = botState.blocker || "";
  if (!isHardSafety && hardBlockers.some(b => blocker.includes(b))) {
     effectiveMax = usedForSlots;
     reason = botState.blocker || "HARD_SAFETY_BLOCK";
     isHardSafety = true;
  }
  
  if (usedForSlots >= effectiveMax && isHardSafety) {
     effectiveMax = usedForSlots;
  }

  botState.effectiveMaxPositions = effectiveMax;
  botState.availableSlots = Math.max(0, effectiveMax - usedForSlots);
  botState.slotReductionReason = reason;
  botState.slotReductionIsHardSafety = isHardSafety;
  logPositionSlotState(openCount, pendingEntries, configuredMax, effectiveMax, botState.availableSlots, reason);

  if (isHardSafety && effectiveMax < configuredMax) {
      const modeLog2 = `[POSITION_SLOT_REDUCED_HARD_SAFETY_ONLY] Slots reduced from ${configuredMax} to ${effectiveMax} due to hard blocker: ${reason}`;
      if (modeLog2 !== lastSlotLog) {
         console.log(modeLog2);
         lastSlotLog = modeLog2; // prevent spam
      }
  }

  // Requirement: THREE_POSITION_MODE_ACTIVE
  if (configuredMax >= 3 && botState.availableSlots > 0 && reason === "NONE") {
      const modeLog = `[THREE_POSITION_MODE_ACTIVE] Multi-position trading allowed. Active positions: ${openCount}, Pending: ${pendingEntries}, Remaining Available: ${botState.availableSlots}`;
      if (modeLog !== lastSlotLog) {
         console.log(modeLog);
         lastSlotLog = modeLog;
      }
  }
}

export function canOpenNewEntry(symbol?: string): boolean {
  calculatePositionSlots();
  const allowed = (botState.availableSlots || 0) > 0;
  if (!allowed) {
    console.log(`[ENTRY_BLOCKED] symbol=${symbol || botState.activeSymbol || "UNKNOWN"}, reason=MAX_OPEN_POSITIONS, openPositions=${botState.usedPositions || 0}, pendingEntries=${botState.pendingEntryCount || 0}, maxOpenPositions=${botState.configuredMaxPositions || 3}, availableSlots=${botState.availableSlots || 0}, slotReductionReason=${botState.slotReductionReason || "NONE"}`);
  } else {
    // Only log occasionally or when checking a specific symbol to avoid spam
    if (symbol) {
        console.log(`[POSITION_SLOT_AVAILABLE] symbol=${symbol}, openPositions=${botState.usedPositions || 0}, pendingEntries=${botState.pendingEntryCount || 0}, maxOpenPositions=${botState.configuredMaxPositions || 3}, availableSlots=${botState.availableSlots || 0}`);
    }
  }
  return allowed;
}
