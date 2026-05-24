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
    if (order && !order.reduceOnly && order.coin && !openSymbols.has(order.coin)) {
      pendingSymbols.add(order.coin);
    }
  }

  const contexts = botState.entryOrdersContext || {};
  for (const ctx of Object.values(contexts)) {
    if (!ctx?.symbol || openSymbols.has(ctx.symbol)) continue;
    const ageMs = now - (ctx.ts || now);
    if (ageMs <= 30_000) pendingSymbols.add(ctx.symbol);
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
  const configuredMax = botState.config?.maxOpenPositions ?? 3;
  const openSymbols = getOpenPositionSymbols();
  const openCount = Math.max(openSymbols.size, botState.openPositions || 0);
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
    "CATASTROPHIC_LIQUIDITY",
    "ORDER_SUBMITTED_FAILED"
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
}

export function canOpenNewEntry(symbol?: string): boolean {
  calculatePositionSlots();
  const allowed = (botState.availableSlots || 0) > 0;
  if (!allowed) {
    console.log(`[ENTRY_BLOCKED] symbol=${symbol || botState.activeSymbol || "UNKNOWN"}, reason=MAX_OPEN_POSITIONS, openPositions=${botState.usedPositions || 0}, pendingEntries=${botState.pendingEntryCount || 0}, maxOpenPositions=${botState.configuredMaxPositions || 3}, availableSlots=${botState.availableSlots || 0}, slotReductionReason=${botState.slotReductionReason || "NONE"}`);
  }
  return allowed;
}
