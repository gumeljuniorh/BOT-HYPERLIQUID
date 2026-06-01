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

function clearStalePendingEntryOrders(openSymbols: Set<string>): number {
  const now = Date.now();
  const before = (botState.activeOrders || []).length;
  botState.activeOrders = (botState.activeOrders || []).filter((order: any) => {
    if (!order || order.reduceOnly || !order.coin || openSymbols.has(order.coin)) return true;
    const ts = order.timestamp || order.time || 0;
    if (!ts || now - ts > 15000) return false;
    return true;
  });
  return before - (botState.activeOrders || []).length;
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
  const stalePendingCleared = clearStalePendingEntryOrders(openSymbols);
  if (stalePendingCleared > 0) {
    console.log(`[FAILED_ORDER_SLOT_RELEASED] Cleared ${stalePendingCleared} stale non-reduce-only pending entry reservation(s).`);
  }
  const reportedOpenPositions = botState.openPositions || 0;
  const openCount = openSymbols.size;
  if (reportedOpenPositions !== openCount) {
    botState.openPositions = openCount;
  }
  const pendingEntries = countPendingEntrySymbols(openSymbols);
  const usedForSlots = openCount + pendingEntries;
  
  if (usedForSlots === 0 && botState.protectionStatus !== "CONFIRMED") {
    console.log(`[SLOT_CALCULATOR_RECOVERY] Resetting stuck protectionStatus (${botState.protectionStatus}) to CONFIRMED because there are no open positions or pending entries.`);
    botState.protectionStatus = "CONFIRMED";
  }

  botState.configuredMaxPositions = configuredMax;
  botState.usedPositions = openCount;
  botState.pendingEntryCount = pendingEntries;

  let effectiveMax = configuredMax;
  let reason = "NONE";
  let isHardSafety = false;
  
  if (botState.isSmallAccountMode) {
      // 1 position for normal conditions, up to 2 if specifically allowed elsewhere, limit configuredMax initially
      effectiveMax = Math.min(configuredMax, 1);
      reason = "SMALL_ACCOUNT_POSITION_LIMIT_ACTIVE";
      isHardSafety = false;
      // We'll let bot.ts decide if a 2nd slot is allowed for elite setups by overriding this dynamically later if needed, but strict baseline here.
  }

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

  if ((botState.blocker === "MAX_POSITION_BLOCK_CONFIRMED" || botState.blocker === "ENTRY_BLOCKED_NO_AVAILABLE_SLOTS") && botState.availableSlots > 0 && !isHardSafety) {
    console.log(`[FALSE_MAX_POSITION_BLOCK_PREVENTED] Cleared stale ${botState.blocker} because realOpenPositions=${openCount}, pendingEntries=${pendingEntries}, availableSlots=${botState.availableSlots}.`);
    botState.blocker = null;
  }

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

export function reconcileEntrySloCapacity(symbol?: string): boolean {
  calculatePositionSlots();
  const realOpenPositions = botState.usedPositions || 0;
  const pendingEntries = botState.pendingEntryCount || 0;
  const effectiveMax = botState.effectiveMaxPositions ?? botState.configuredMaxPositions ?? 3;
  const availableSlots = botState.availableSlots || 0;
  const hardSafety = botState.slotReductionIsHardSafety === true;

  console.log(`[POSITION_SLOT_SOURCE_RECONCILED] symbol=${symbol || botState.activeSymbol || "UNKNOWN"}, realOpenPositions=${realOpenPositions}, pendingEntries=${pendingEntries}, effectiveMaxPositions=${effectiveMax}, availableSlots=${availableSlots}, hardSafety=${hardSafety}`);

  if (availableSlots > 0 && !hardSafety) {
    console.log(`[ENTRY_SLO_AVAILABLE_CONFIRMED] symbol=${symbol || botState.activeSymbol || "UNKNOWN"}, availableSlots=${availableSlots}`);
    return true;
  }

  if (!hardSafety && realOpenPositions + pendingEntries < effectiveMax) {
    botState.availableSlots = Math.max(0, effectiveMax - realOpenPositions - pendingEntries);
    console.log(`[ENTRY_SLO_RECONCILED] Rebuilt entry SLO capacity from real exchange position count.`);
    console.log(`[ENTRY_SLO_FALSE_BLOCK_PREVENTED] symbol=${symbol || botState.activeSymbol || "UNKNOWN"}, availableSlots=${botState.availableSlots}`);
    if (botState.availableSlots > 0) {
      if (botState.blocker === "MAX_POSITION_BLOCK_CONFIRMED" || botState.blocker === "ENTRY_BLOCKED_NO_AVAILABLE_SLOTS") {
        botState.blocker = null;
      }
      return true;
    }
  }

  return false;
}

export function canOpenNewEntry(symbol?: string): boolean {
  const allowed = reconcileEntrySloCapacity(symbol);
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
