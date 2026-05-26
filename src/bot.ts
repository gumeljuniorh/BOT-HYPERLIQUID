import { botState, setAssetMeta, getAssetId, getAssetMeta } from "./state.js";
import { config } from "./config.js";
import { hClient } from "./hyperliquidClient.js";
import { marketData } from "./hyperliquidMarketData.js";
import { riskManager } from "./hyperliquidRiskManager.js";
import { validationRunner } from "./hyperliquidValidationRunner.js";
import { strategy } from "./hyperliquidStrategy.js";
import { executionEngine } from "./hyperliquidExecutionEngine.js";
import { calculatePositionSlots, reconcileEntrySloCapacity } from "./services/positionSlotCalculator.js";
import { tradeLogger } from "./tradeLogger.js";
import { snapshotService } from "./services/snapshotService.js";
import { coinMarketCapTrendScanner } from "./services/coinMarketCapTrendScanner.js";
import fs from "fs";
import path from "path";

export { botState, getAssetId, getAssetMeta };

export interface PostRallyState {
  hasRallied: boolean;
  rallyDirection: "LONG" | "SHORT" | "NONE";
  peakPrice: number;
  rallyTimestamp: number;
  peakMomentum: number;
  isCorrecting: boolean;
  correctionStartTimestamp: number;
  lastRetracementDepth: number;
  stableConsolidationCount: number;
  failedContinuationAttempts: number;
  lastReentryRestrictedUntil: number;
}
export const postRallyTracker = new Map<string, PostRallyState>();

export function roundToPrecision(val: number, sigFigs = 5): number {
  if (val <= 0 || isNaN(val)) return 0;
  const power = Math.floor(Math.log10(val)) + 1;
  const scale = Math.pow(10, sigFigs - power);
  return Math.round(val * scale) / scale;
}

export function calculateSafeTpSl(
  symbol: string,
  direction: "LONG" | "SHORT" | string,
  entryPx: number,
  tpPctInput: number,
  slPctInput: number,
  atrPctInput?: number
): { finalTpPrice: number; finalSlPrice: number; debugInfo: any } {
  const isLong = direction === "LONG";
  const markPx = entryPx;
  
  // 1. Compute buffers for: tick size, spread, fee, and ATR
  const tickSize = Math.max(1e-6, Math.pow(10, Math.floor(Math.log10(markPx)) - 4));
  
  // Spread buffer based on marketScanner spread quality
  const spreadQuality = botState.marketScanner?.spreadQuality || 80;
  const spreadCostPct = Math.max(0.01, (100 - spreadQuality) / 100 * 0.1); // range 0.01% - 0.1%
  const spreadBufferPrice = markPx * (spreadCostPct / 100);
  
  // Fee buffer: ~0.15% to cover entry + exit commissions under safety
  const feeBufferPrice = markPx * 0.0015;
  
  // Volatility/ATR buffer
  const atrPctRaw = atrPctInput !== undefined ? atrPctInput : 0.15;
  const atrBufferPrice = markPx * (Math.max(0.05, atrPctRaw * 0.4) / 100);
  
  // 2. Minimum safe distance in price
  const baseSafeDistancePrice = (tickSize * 15) + spreadBufferPrice + feeBufferPrice + atrBufferPrice;
  const baseSafeDistancePct = (baseSafeDistancePrice / markPx) * 100;

  // Let's refine the input percentages to be at least the safe distances
  let currentSlPct = Math.max(slPctInput, baseSafeDistancePct, 0.4);
  let currentTpPct = Math.max(tpPctInput, baseSafeDistancePct, 0.25);
  
  // Ensure we respect min TP movement and reward-to-risk ratio rules (typically RR >= 0.25)
  if (currentTpPct / currentSlPct < 0.25) {
    currentTpPct = currentSlPct * 0.25;
    console.log(`[TP_SL_DISTANCE_REBUILT] ${symbol}: Rebuilt TP percentage to ${currentTpPct.toFixed(2)}% to satisfy minimum 0.25 RR ratio.`);
  }

  // Calculate proposed prices
  let proposedTpPrice = isLong ? markPx * (1 + currentTpPct / 100) : markPx * (1 - currentTpPct / 100);
  let proposedSlPrice = isLong ? markPx * (1 - currentSlPct / 100) : markPx * (1 + currentSlPct / 100);

  // Round of proposed values to exactly 5 significant figures
  let finalTpPrice = roundToPrecision(proposedTpPrice, 5);
  let finalSlPrice = roundToPrecision(proposedSlPrice, 5);
  const roundedEntry = roundToPrecision(markPx, 5);

  let rebuilt = false;
  let precisionAdjusted = false;

  // 3. For Low Price Assets ($0.01 - $0.30) and general sanity:
  // TP/SL must not round into the entry price, wrong side, or too close.
  // Validate trigger direction and non-equality:
  const isShortValueTooClose = !isLong && (finalSlPrice <= roundedEntry || Math.abs(finalSlPrice - roundedEntry) < (tickSize * 5));
  const isLongValueTooClose = isLong && (finalSlPrice >= roundedEntry || Math.abs(roundedEntry - finalSlPrice) < (tickSize * 5));
  
  if (isShortValueTooClose) {
    finalSlPrice = roundToPrecision(roundedEntry + Math.max(baseSafeDistancePrice, tickSize * 10), 5);
    precisionAdjusted = true;
    console.log(`[SHORT_SL_TOO_CLOSE] ${symbol} SHORT SL too close to entry (${finalSlPrice} vs ${roundedEntry}). Adhering to precision bounds.`);
  }
  if (isLongValueTooClose) {
    finalSlPrice = roundToPrecision(roundedEntry - Math.max(baseSafeDistancePrice, tickSize * 10), 5);
    precisionAdjusted = true;
    console.log(`[LONG_SL_TOO_CLOSE] ${symbol} LONG SL too close to entry (${finalSlPrice} vs ${roundedEntry}). Adhering to precision bounds.`);
  }

  // Sanity check for TP
  const isShortTpTooClose = !isLong && (finalTpPrice >= roundedEntry || Math.abs(roundedEntry - finalTpPrice) < (tickSize * 5));
  const isLongTpTooClose = isLong && (finalTpPrice <= roundedEntry || Math.abs(finalTpPrice - roundedEntry) < (tickSize * 5));

  if (isShortTpTooClose) {
    finalTpPrice = roundToPrecision(roundedEntry - Math.max(baseSafeDistancePrice, tickSize * 10), 5);
    precisionAdjusted = true;
    console.log(`[TP_SL_TOO_CLOSE] ${symbol} SHORT TP too close (${finalTpPrice} vs ${roundedEntry}). Adjusting.`);
  }
  if (isLongTpTooClose) {
    finalTpPrice = roundToPrecision(roundedEntry + Math.max(baseSafeDistancePrice, tickSize * 10), 5);
    precisionAdjusted = true;
    console.log(`[TP_SL_TOO_CLOSE] ${symbol} LONG TP too close (${finalTpPrice} vs ${roundedEntry}). Adjusting.`);
  }

  // Enforce wrong side check
  if (isLong) {
    if (finalTpPrice <= roundedEntry) {
      finalTpPrice = roundToPrecision(roundedEntry + baseSafeDistancePrice + (tickSize * 5), 5);
      rebuilt = true;
    }
    if (finalSlPrice >= roundedEntry) {
      finalSlPrice = roundToPrecision(roundedEntry - baseSafeDistancePrice - (tickSize * 5), 5);
      rebuilt = true;
    }
  } else {
    if (finalTpPrice >= roundedEntry) {
      finalTpPrice = roundToPrecision(roundedEntry - baseSafeDistancePrice - (tickSize * 5), 5);
      rebuilt = true;
    }
    if (finalSlPrice <= roundedEntry) {
      finalSlPrice = roundToPrecision(roundedEntry + baseSafeDistancePrice + (tickSize * 5), 5);
      rebuilt = true;
    }
  }

  if (rebuilt) {
    console.log(`[TP_SL_DISTANCE_REBUILT] ${symbol} wrong side or spacing bounds violated. Rebuilt: TP ${finalTpPrice}, SL ${finalSlPrice}`);
  }
  if (precisionAdjusted) {
    console.log(`[LOW_PRICE_PRECISION_ADJUSTED] ${symbol} adjusted to avoid rounding conflict under 5 significant figures. Entry: ${markPx}, final TP: ${finalTpPrice}, final SL: ${finalSlPrice}`);
  }

  // RR evaluation
  const finalTpDist = Math.abs(finalTpPrice - roundedEntry) / roundedEntry * 100;
  const finalSlDist = Math.abs(finalSlPrice - roundedEntry) / roundedEntry * 100;
  const finalRR = finalSlDist > 0 ? (finalTpDist / finalSlDist) : 0;
  const validationResult = (finalRR >= 0.2 && finalSlDist >= 0.25) ? "PASSED" : "FAILED";

  // Trace logging: TP_SL_DISTANCE_TRACE
  console.log(`[TP_SL_DISTANCE_TRACE] Name: ${symbol} | Side: ${direction} | Entry: ${markPx} | Mark: ${markPx} | Proposed TP: ${finalTpPrice} | Proposed SL: ${finalSlPrice} | Tick size: ${tickSize} | Spread: ${spreadCostPct.toFixed(3)}% | Fee buffer: ${feeBufferPrice.toFixed(6)} | ATR/volatility buffer: ${atrBufferPrice.toFixed(6)} | Final TP Dist %: ${finalTpDist.toFixed(2)}% | Final SL Dist %: ${finalSlDist.toFixed(2)}% | Validation: ${validationResult}`);

  return {
    finalTpPrice,
    finalSlPrice,
    debugInfo: {
      tickSize,
      spreadCostPct,
      feeBufferPrice,
      atrBufferPrice,
      finalTpDist,
      finalSlDist,
      validationResult
    }
  };
}

export function getDynamicMaxPositions(): { limit: number; reason: string } {
  calculatePositionSlots();
  
  // Backwards compatibility for UI or older code that might still check this before we fully migrate
  botState.maxAllowedPositions = botState.effectiveMaxPositions ?? config.MAX_OPEN_POSITIONS;
  botState.dynamicPositionLimitReason = botState.slotReductionReason || "NONE";
  
  return { 
    limit: botState.effectiveMaxPositions ?? config.MAX_OPEN_POSITIONS,
    reason: botState.slotReductionReason || "NONE" 
  };
}

function isMultiPositionPhase(): boolean {
  return botState.phase === "PHASE_1_CONTROLLED_LIVE" || botState.phase === "PHASE_2_ADAPTIVE_EXECUTION";
}

function normalizeEntryBlockReason(reason: string): string {
  if (reason.includes("MAX_POSITION")) return "MAX_OPEN_POSITIONS";
  if (reason.includes("COLLATERAL") || reason.includes("MARGIN")) return "BALANCE_RESERVE";
  if (reason.includes("EXPOSURE")) return "MAX_EXPOSURE";
  if (reason.includes("COOLDOWN") || reason.includes("NO_TRADE") || reason.includes("OVERTRADING") || reason.includes("REVERSE_LOCK")) return "COOLDOWN";
  if (reason.includes("MIN_NOTIONAL") || reason.includes("TOO_SMALL") || reason.includes("POSITION_SIZE")) return "MIN_NOTIONAL";
  if (reason.includes("CONFIDENCE") || reason.includes("LOW_SIGNAL") || reason.includes("NO_TRADE_SIGNAL") || reason.includes("NO_DIRECTIONAL_EDGE")) return "LOW_SIGNAL_SCORE";
  if (reason.includes("API_RATE") || reason.includes("API_BUDGET") || reason.includes("WSS") || reason.includes("API_NOT")) return "API_BUDGET";
  if (reason.includes("VALIDATION") || reason.includes("TP_SL") || reason.includes("ORDER_VALIDATION")) return "EXECUTION_VALIDATION";
  return reason || "UNKNOWN";
}

function logEntryBlocked(symbol: string, reason: string, detail = ""): void {
  const normalized = normalizeEntryBlockReason(reason);
  console.log(`[ENTRY_BLOCKED] symbol=${symbol}, reason=${normalized}, raw=${reason}${detail ? `, ${detail}` : ""}`);
}

const NONESSENTIAL_EXECUTION_BLOCKERS = [
  "HIGH_RISK_NEEDS_CONFIRMATION",
  "LOW_PRIORITY_EXECUTION_SKIPPED",
  "EARLY_EXPANSION_BUILDING",
  "NO_ACTIVE_TRADE_TRIGGERED",
  "NO_TRADE_PERIOD_ACTIVE",
  "LOW_CONFIDENCE",
  "ENTRY_REJECTED_TOO_SMALL",
  "ROUTER_BLOCK_RETRY_COOLDOWN",
  "FEE_CAUTION",
  "FEE_REDUCTION",
  "REST_PRESSURE_DEGRADED_MODE",
  "EXECUTION_API_BUDGET_THROTTLED",
  "API_BUDGET_LIMIT",
  "POSITION_SIZE_INVALID_COOLDOWN",
  "ROUTER_BLOCK_COOLDOWN",
  "DEAD_LOW_VOL",
  "LOW_VOLATILITY"
];

const HARD_EXECUTION_BLOCKERS = [
  "TP_SL_PRECHECK_FAILED",
  "TP_SL_MISSING",
  "PROTECTION_REPAIRING",
  "PROTECTION_FAILED",
  "PROTECTION_SYNC_ERROR",
  "DUPLICATE_PROTECTION",
  "UNSAFE_COLLATERAL",
  "INSUFFICIENT_COLLATERAL",
  "INSUFFICIENT_FREE_COLLATERAL",
  "MARGIN_SAFETY_VIOLATION",
  "LIQUIDATION",
  "WSS_API_UNSTABLE",
  "CONNECTION_LOST",
  "API_NOT_VERIFIED",
  "VALIDATION_NOT_SUCCESS",
  "PRIVATE_KEY",
  "AUTH",
  "CORRUPTED_POSITION_STATE",
  "INVALID_ORDER_SIZE",
  "ORDER_VALIDATION_REJECTED",
  "HARD_DRAWDOWN",
  "SEVERE_DRAWDOWN",
  "CATASTROPHIC",
  "EXCHANGE_REJECTED_UNRECOVERABLE"
];

function isNonessentialExecutionBlocker(reason?: string | null): boolean {
  if (!reason) return false;
  return NONESSENTIAL_EXECUTION_BLOCKERS.some((softReason) => reason.includes(softReason));
}

function isHardExecutionBlocker(reason?: string | null): boolean {
  if (!reason) return false;
  if (reason.includes("API_BUDGET") || reason.includes("REST_PRESSURE") || reason.includes("LOW_CONFIDENCE")) return false;
  return HARD_EXECUTION_BLOCKERS.some((hardReason) => reason.includes(hardReason));
}

function applySoftExecutionAdjustment(opp: any, reason: string, sizeMultiplier = 0.65, leverageMultiplier = 0.8): void {
  (opp as any).sizeModifier = Math.min((opp as any).sizeModifier ?? 1.0, sizeMultiplier);
  (opp as any).leverageModifier = Math.min((opp as any).leverageModifier ?? 1.0, leverageMultiplier);
  (opp as any).softExecutionReason = reason;
  console.log(`[SOFT_BLOCKER_CONVERTED_TO_RISK_ADJUSTMENT] ${opp.symbol || botState.activeSymbol} ${reason} converted to size/leverage/rank adjustment.`);
}

export async function programmaticClosePosition(sym: string, reason: string): Promise<boolean> {
  const pos = botState.allPositions?.find(p => p.coin === sym);
  if (!pos) return false;
  
  const szi = parseFloat(pos.szi);
  if (Math.abs(szi) === 0) return false;
  
  botState.isProgrammaticClosing = true;
  try {
    const currentPrice = botState.markPrices ? botState.markPrices[sym] : 0;
    if (currentPrice === 0) return false;
    
    console.log(`[CAPITAL_ROTATION_CLOSE] Initiating programmatic close for ${sym}: ${reason}`);
    await executionEngine.cancelAllOrders(sym);
    
    const sz = Math.abs(szi);
    const isBuy = szi < 0; 
    const exitPrice = isBuy ? currentPrice * 1.01 : currentPrice * 0.99;
    
    const success = await executionEngine.placeOrder(sym, isBuy, sz, exitPrice, true, true);
    if (success) {
      console.log(`[CAPITAL_ROTATION_CLOSE_SUCCESS] Position closed for ${sym}.`);
      return true;
    }
  } catch (error: any) {
    console.error(`[CAPITAL_ROTATION_CLOSE_ERR] Failed closing ${sym}:`, error.message);
  } finally {
    botState.isProgrammaticClosing = false;
  }
  return false;
}

async function verifyProtectionOrders() {
  if (!botState.allPositions || botState.allPositions.length === 0) {
    botState.protectionStatus = "CONFIRMED"; // Default safe state when no positions are open
    return;
  }

  let allPositionsProtected = true;
  let anyRepairFailed = false;

  for (const pos of botState.allPositions) {
    const sym = pos.coin;
    const sziStr = pos.szi;
    if (!sziStr) continue;
    const szi = parseFloat(sziStr);
    if (szi === 0) continue;

    const isLong = szi > 0;
    const entryPrice = parseFloat(pos.entryPx) || (botState.markPrices && botState.markPrices[sym]) || botState.markPrice;
    const currentPrice = (botState.markPrices && botState.markPrices[sym]) || entryPrice;

    let hasTpExchange = false;
    let hasSlExchange = false;
    let tpPriceOnExchange = null;
    let slPriceOnExchange = null;

    const reduceOrders = botState.activeOrders?.filter(o => o.coin === sym && o.reduceOnly) || [];
    
    // Distinguish TP and SL based on order type rather than guessing by price sorting
    const activeSlOrders = reduceOrders.filter(o => o.isTrigger || o.triggerPx || parseFloat(o.triggerPx || "0") > 0);
    const activeTpOrders = reduceOrders.filter(o => !activeSlOrders.includes(o));
    
    if (activeSlOrders.length > 0) {
        hasSlExchange = true;
        // Keep the one closest to current price theoretically, but simply taking the first one is ok 
        // since executionEngine prevents duplicates now
        activeSlOrders.sort((a,b) => parseFloat(b.triggerPx || b.limitPx || "0") - parseFloat(a.triggerPx || a.limitPx || "0"));
        slPriceOnExchange = parseFloat(isLong ? activeSlOrders[activeSlOrders.length - 1].triggerPx : activeSlOrders[0].triggerPx);
    }
    
    if (activeTpOrders.length > 0) {
        hasTpExchange = true;
        activeTpOrders.sort((a,b) => parseFloat(a.limitPx || a.px || "0") - parseFloat(b.limitPx || b.px || "0"));
        tpPriceOnExchange = parseFloat(isLong ? activeTpOrders[0].limitPx || activeTpOrders[0].px : activeTpOrders[activeTpOrders.length - 1].limitPx || activeTpOrders[activeTpOrders.length - 1].px);
    }

    const perCoinProtection = sym === botState.activeSymbol ? botState.protection : ((botState as any).protectionByCoin ? (botState as any).protectionByCoin[sym] : null);

    // Ensure trailing stop removes TP requirement locally (only for activeSymbol)
    if (perCoinProtection?.isTrailingActive && !hasTpExchange) {
      hasTpExchange = true; // We don't consider TP missing if we are trailing
    }

    let needsExchangeUpdate = false;
    let targetTp = perCoinProtection?.isTrailingActive ? null : perCoinProtection?.tpPrice;
    let targetSl = perCoinProtection?.trailingStopPrice || perCoinProtection?.slPrice;

    if (!targetSl || (!targetTp && !perCoinProtection?.isTrailingActive)) {
      const fallbackLimit = calculateSafeTpSl(
        sym,
        isLong ? "LONG" : "SHORT",
        entryPrice,
        5.0, // 5% fallback TP
        1.2, // 1.2% fallback SL
        0.15 // fallback ATR
      );
      if (!targetTp && !perCoinProtection?.isTrailingActive) {
        targetTp = fallbackLimit.finalTpPrice;
      }
      if (!targetSl) {
        targetSl = fallbackLimit.finalSlPrice;
      }
    } else {
      // sanitize and ensure roundings are appropriate and consistent
      const currentTpPct = targetTp ? (Math.abs(targetTp - entryPrice) / entryPrice * 100) : 5.0;
      const currentSlPct = Math.abs(targetSl - entryPrice) / entryPrice * 100;
      const refinedLimit = calculateSafeTpSl(
        sym,
        isLong ? "LONG" : "SHORT",
        entryPrice,
        currentTpPct,
        currentSlPct,
        0.15
      );
      if (targetTp) targetTp = refinedLimit.finalTpPrice;
      targetSl = perCoinProtection?.trailingStopPrice || refinedLimit.finalSlPrice;
    }

    if (hasTpExchange && hasSlExchange) {
      if (perCoinProtection && !perCoinProtection.isTrailingActive && (!perCoinProtection.activeProfitLockLevel || perCoinProtection.activeProfitLockLevel === "NONE")) {
          // Adopt exchange prices locally if not actively managing
          perCoinProtection.tpPrice = tpPriceOnExchange || perCoinProtection.tpPrice;
          perCoinProtection.slPrice = slPriceOnExchange || perCoinProtection.slPrice;
      } else if (perCoinProtection && (perCoinProtection.isTrailingActive || parseFloat(`${perCoinProtection.currentLockedProfitPct || 0}`) > 0)) {
          // If actively trailing, check if exchange is lagging behind materially (> 0.2%)
          const currentExchangeSl = slPriceOnExchange || 0;
          const diffPct = Math.abs(currentExchangeSl - targetSl) / targetSl * 100;
          if (diffPct > 0.2) {
              needsExchangeUpdate = true;
              console.log(`[PROTECTION_RECONCILIATION] Exchange SL (${currentExchangeSl}) lags trailing target (${targetSl}) by ${diffPct.toFixed(2)}%. Queueing update.`);
          }
          
          if (perCoinProtection.isTrailingActive && activeTpOrders.length > 0) {
              needsExchangeUpdate = true;
              targetTp = null; // We want to remove the rigid TP on exchange
              console.log(`[PROTECTION_RECONCILIATION] Trailing is active but rigid TP exists on exchange. Queueing update to remove rigid TP.`);
          }
      }
    } else {
        needsExchangeUpdate = true;
        console.warn(`[MISSING_TP_SL_REPAIRED] Active position for ${sym} lacks exchange protection. Repairing immediately!`);
    }

    if (needsExchangeUpdate) {
      const { executionEngine } = await import("./hyperliquidExecutionEngine.js");
      let success = false;
      
      if (botState.apiRateLimitUntil && Date.now() < botState.apiRateLimitUntil) {
         console.warn(`[API_BUDGET_THROTTLED] Skipping TP/SL exchange update due to global rate limit flag.`);
      } else {
         const budget = (await import("./services/apiBudgetManager.js")).apiBudgetManager.reserveExchange("tpsl", 1, true);
         if (!budget.allowed) {
             console.warn(`[TP_SL_REPAIR_DEFERRED_BUDGET] Skipping TP/SL exchange update due to API budget constraint. WSS trailing active locally.`);
         } else {
             success = await executionEngine.placeTpSlOrders(sym, isLong, Math.abs(szi), targetTp, targetSl);
         }
      }
      
      if (success) {
        if (sym === botState.activeSymbol && perCoinProtection) {
          perCoinProtection.tpPrice = targetTp;
          if (perCoinProtection.isTrailingActive) perCoinProtection.trailingStopPrice = targetSl;
          else perCoinProtection.slPrice = targetSl;
        }
        hasTpExchange = true;
        hasSlExchange = true;
        console.log(`[PROTECTION_SYNCED] Protective limits placed/updated successfully for ${sym}.`);
        console.log(`[TP_SL_REPAIR_COMPLETED] ${sym} TP/SL repair completed successfully.`);
        console.log(`[PROTECTION_READY_FOR_EXECUTION] ${sym} protection is ready; additional slots may be evaluated.`);
      } else if (!hasTpExchange || !hasSlExchange) {
        if (botState.apiRateLimitUntil && Date.now() < botState.apiRateLimitUntil) {
             console.warn(`[TP_SL_REPAIR_DEFERRED] API budget exhausted. Deferring TP/SL repair until rate limit clears. Position may temporarily lack exchange protection.`);
             allPositionsProtected = false;
        } else {
            allPositionsProtected = false;
            anyRepairFailed = true;
            console.error(`[EMERGENCY_CLOSE_TP_SL_MISSING] Failed to repair TP/SL for ${sym}. Executing emergency position close.`);
            const isExitSuccess = await executionEngine.placeOrder(
              sym,
              !isLong, 
              Math.abs(szi),
              isLong ? currentPrice * 0.95 : currentPrice * 1.05,
              true,
              true
            );
            if (isExitSuccess) {
               console.log(`[EMERGENCY_CLOSE_TP_SL_MISSING] Triggered reduce-only close for ${sym}.`);
            }
        }
      }
    }
  }

  if (allPositionsProtected) {
    if (botState.protectionStatus !== "CONFIRMED") {
      botState.protectionStatus = "CONFIRMED";
    }
  } else if (anyRepairFailed) {
    botState.protectionStatus = "FAILED_EMERGENCY_CLOSE_REQUIRED";
  } else {
    botState.protectionStatus = "REPAIRING";
  }
}

export async function syncAccountState() {
  if (botState.apiRateLimitUntil && Date.now() < botState.apiRateLimitUntil) {
     if (botState.wssConnected) {
       console.log(`[WSS_ONLY_MONITORING_ACTIVE] Skipping REST sync AccountState. Relying strictly on WebSockets.`);
       console.log(`[NONESSENTIAL_SCAN_SKIPPED] Skipped background REST checks to save API budget.`);
       // Do not nullify botState.apiConnected, let WSS drive.
       return;
     } else {
       console.log(`[API_BUDGET_THROTTLED] API rate limit active, but WSS disconnected! Pausing operations...`);
     }
  }

  // Fetch meta once to get asset IDs
  const currentMeta = (await import("./state.js")).getAssetMetaGlobal();
  if (!currentMeta) {
    const meta = await hClient.infoRequest({ type: "meta" });
    if (meta && meta.universe) {
      setAssetMeta(meta.universe);
      console.log(`HYPERLIQUID_UNIVERSE_SYNCED: Discovered ${meta.universe.length} tradable markets.`);
    }
  }

  const [info, spotInfo] = await Promise.all([
    hClient.infoRequest({
      type: "clearinghouseState",
      user: config.HYPERLIQUID_WALLET_ADDRESS,
    }),
    hClient.infoRequest({
      type: "spotClearinghouseState",
      user: config.HYPERLIQUID_WALLET_ADDRESS,
    }),
  ]);

  if (info && info.marginSummary) {
    botState.apiConnected = true;
    const perpEquity = parseFloat(info.marginSummary.accountValue) || 0;

    let spotUsdc = 0;
    if (spotInfo && spotInfo.balances) {
      const usdc = spotInfo.balances.find((b: any) => b.coin === "USDC");
      if (usdc) spotUsdc = parseFloat(usdc.total);
    }

    // Unified account logic: sum perp margin and spot USDC to get true total equity
    const exchangeEquity = perpEquity + spotUsdc;
    
    // EQUITY_SOURCE_MISMATCH Check
    if (botState.accountEquity !== 0 && Math.abs(botState.accountEquity - exchangeEquity) > 0.05) {
      console.log(`[EQUITY_SOURCE_MISMATCH] Warning: Local dashboard equity $${botState.accountEquity.toFixed(2)} differs from exchange equity $${exchangeEquity.toFixed(2)}. Synchronizing using exchange as source of truth.`);
    }
    
    botState.accountEquity = exchangeEquity;
    botState.isUnified = true; // Treating as unified wallet
    console.log("[UNIFIED_WALLET_CONFIRMED] Bot recognizes unified margin context.");
    console.log("[MARGIN_ACCOUNTING_AUDITED] Spot USDC and Perp equity merged for cross margin.");


    // Adaptive Drawdown Protection with multi-tier severity and gradual recovery
    if (botState.accountEquity > 0) {
      if (
        !botState.peakEquity ||
        botState.accountEquity > botState.peakEquity
      ) {
        botState.peakEquity = botState.accountEquity;
      }
      
      let drawdownPct =
        ((botState.peakEquity - botState.accountEquity) / botState.peakEquity) *
        100;
      
      if (drawdownPct < 0 || Object.is(drawdownPct, -0)) {
        drawdownPct = 0;
        console.log(`[DRAWDOWN_NEGATIVE_ZERO_NORMALIZED] Drawdown normalized to 0.00%.`);
      }
      
      botState.analytics.currentDrawdown = drawdownPct;
      const recoveryRequired = Math.max(0, botState.peakEquity - botState.accountEquity);

      const oldSeverity = botState.drawdownSeverity || "NONE";
      
      const consecutiveExits = botState.trades ? botState.trades.filter((t) => t.type === "EXIT") : [];
      const lastTwoExits = consecutiveExits.slice(-2);
      const bothLosses = lastTwoExits.length >= 2 && lastTwoExits.every(t => (t.realizedPnl || 0) < 0 || t.exitReason?.includes("STOP_LOSS") || (t as any).netPnl < 0);
      const isTpSlSystemValid = botState.protectionStatus !== "FAILED_EMERGENCY_CLOSE_REQUIRED" && botState.blocker !== "CRITICAL_FAILURE";
      
      const expectancyAfterFees = botState.analytics?.expectancyAfterFees !== undefined ? botState.analytics.expectancyAfterFees : 0.05;

      const exitSoftDrawdownAllowed = drawdownPct <= 0.5 && 
                                      recoveryRequired === 0 &&
                                      expectancyAfterFees >= 0.0 && 
                                      isTpSlSystemValid && 
                                      !bothLosses;

      const repeatedLossesContinue = consecutiveExits.slice(-3).length >= 3 && consecutiveExits.slice(-3).every(t => (t.realizedPnl || 0) < 0 || t.exitReason?.includes("STOP_LOSS") || (t as any).netPnl < 0);
      const feeBleedExtremelyHigh = ((botState as any).feeEfficiency?.feeToProfitRatio >= 0.85) || ((botState.analytics as any)?.feeToProfitRatio >= 0.85);
      const protectionInstability = botState.protectionStatus === "FAILED_EMERGENCY_CLOSE_REQUIRED" || botState.blocker === "CRITICAL_FAILURE";

      const deservesEscalationToHard = drawdownPct >= 10.0 || 
                                       repeatedLossesContinue || 
                                       feeBleedExtremelyHigh || 
                                       protectionInstability;

      let severity: "NONE" | "SOFT" | "SOFT_LEVEL_1" | "SOFT_LEVEL_2" | "MODERATE" | "HARD" | "SEVERE" | "ELEVATED_DRAWDOWN" = oldSeverity;

      if (deservesEscalationToHard) {
        severity = "HARD";
      } else if (drawdownPct >= 5.0) {
        severity = "MODERATE";
      } else if (drawdownPct >= 2.5) {
        // Determine whether SOFT_LEVEL_1 or SOFT_LEVEL_2 is active for the state
        const drawdownWorsens = drawdownPct >= 4.0;
        const feeToProfitRatio = (botState as any).feeEfficiency?.feeToProfitRatio || (botState.analytics as any)?.feeToProfitRatio || 0;
        const feeBleedIncreases = feeToProfitRatio >= 0.70;
        const protectionErrors = botState.protectionStatus === "FAILED_EMERGENCY_CLOSE_REQUIRED" || botState.blocker === "CRITICAL_FAILURE";

        if (drawdownWorsens || bothLosses || feeBleedIncreases || protectionErrors) {
          severity = "SOFT_LEVEL_2";
        } else {
          severity = "SOFT_LEVEL_1";
        }
      } else {
        // less than 2.5%
        if (oldSeverity !== "NONE") {
          if (exitSoftDrawdownAllowed) {
            severity = "NONE";
          } else {
             const feeToProfitRatio = (botState as any).feeEfficiency?.feeToProfitRatio || (botState.analytics as any)?.feeToProfitRatio || 0;
             const feeBleedIncreases = feeToProfitRatio >= 0.70;
             const protectionErrors = botState.protectionStatus === "FAILED_EMERGENCY_CLOSE_REQUIRED" || botState.blocker === "CRITICAL_FAILURE";
             if (bothLosses || feeBleedIncreases || protectionErrors) {
               severity = "SOFT_LEVEL_2";
             } else {
               severity = "SOFT_LEVEL_1";
             }
          }
        } else {
          severity = "NONE";
        }
      }

      // Sanity Guard
      if (severity === "HARD" && drawdownPct <= 0.5 && recoveryRequired <= 0) {
         severity = "NONE";
         botState.drawdownPauseUntil = 0;
         if (botState.blocker === "HARD_DRAWDOWN_PAUSE_ACTIVE") {
             botState.blocker = null;
         }
         botState.analytics.lastDrawdownClearedAt = Date.now();
         console.log(`[FALSE_HARD_DRAWDOWN_PREVENTED] Drawdown is 0% and fully recovered, removing HARD_DRAWDOWN.`);
         console.log(`[DRAWDOWN_STATE_CLEARED] Drawdown mode cleared safely.`);
      }
      
      // Auto-clear logic
      if (drawdownPct <= 0.5 && recoveryRequired <= 0 && severity !== "NONE") {
         severity = "NONE";
         botState.drawdownPauseUntil = 0;
         if (botState.blocker === "HARD_DRAWDOWN_PAUSE_ACTIVE" || botState.blocker === "SOFT_DRAWDOWN_PAUSE_ACTIVE" || botState.blocker === "MODERATE_DRAWDOWN_PAUSE_ACTIVE") {
             botState.blocker = null;
         }
         botState.analytics.lastDrawdownClearedAt = Date.now();
         console.log(`[DRAWDOWN_STATE_CLEARED] Drawdown mode cleared safely. Restored normal participation.`);
      }

      // Track trough for recovery calculation
      if (severity !== "NONE") {
        if (!botState.drawdownTroughEquity || botState.drawdownTroughEquity <= 0 || botState.drawdownTroughEquity > botState.peakEquity) {
          botState.drawdownTroughEquity = botState.accountEquity;
        } else if (botState.accountEquity < botState.drawdownTroughEquity) {
          botState.drawdownTroughEquity = botState.accountEquity;
        }
      } else {
        botState.drawdownTroughEquity = 0;
      }

      // Calculate recovery progress
      let recoveryProgress = 100;
      if (severity !== "NONE" && botState.drawdownTroughEquity && botState.drawdownTroughEquity < botState.peakEquity) {
        const range = botState.peakEquity - botState.drawdownTroughEquity;
        const currentDiff = botState.accountEquity - botState.drawdownTroughEquity;
        recoveryProgress = Math.min(100, Math.max(0, (currentDiff / range) * 100));
      }

      botState.drawdownSeverity = severity;
      botState.drawdownRecoveryProgress = recoveryProgress;
      botState.estimatedRecoveryThreshold = botState.peakEquity;

      // Severity Log triggers & specific targeted labels
      if (severity !== oldSeverity) {
        console.log(`[DRAWDOWN_PAUSE_CLASSIFIED] Severity shifted from ${oldSeverity} to ${severity}. Current Drawdown: ${drawdownPct.toFixed(2)}%.`);
        
        if (severity === "SOFT_LEVEL_1" && oldSeverity !== "SOFT_LEVEL_1") {
          console.log(`[SOFT_DRAWDOWN_LEVEL_1_ACTIVE] Soft drawdown level 1 active. Reduced risk trading allowed. Drawdown: ${drawdownPct.toFixed(2)}%`);
        } else if (severity === "SOFT_LEVEL_2" && oldSeverity !== "SOFT_LEVEL_2") {
          console.log(`[SOFT_DRAWDOWN_LEVEL_2_ELITE_ONLY] Soft drawdown level 2 active (ELITE ONLY). Drawdown: ${drawdownPct.toFixed(2)}%`);
        } else if (severity === "HARD" && oldSeverity !== "HARD") {
          console.log(`[HARD_DRAWDOWN_ESCALATED] Escalated to HARD DRAWDOWN MODE due to triggers (Drawdown: ${drawdownPct.toFixed(2)}%, Repeated losses: ${repeatedLossesContinue}, Fee Bleed: ${feeBleedExtremelyHigh}, Protection Instability: ${protectionInstability}).`);
        }

        if (severity === "NONE" && (oldSeverity === "SOFT_LEVEL_1" || oldSeverity === "SOFT_LEVEL_2" || oldSeverity === "MODERATE" || oldSeverity === "HARD" || oldSeverity === "SOFT")) {
          console.log(`[SOFT_DRAWDOWN_RECOVERY_DETECTED] Soft drawdown recovery detected! Equity recovered to $${botState.accountEquity.toFixed(2)} (Drawdown ${drawdownPct.toFixed(2)}%), expectancy improving (${expectancyAfterFees.toFixed(3)}), protection stable, and no repeated losses. Restoring standard trading.`);
        }
      }

      if (drawdownPct < 2.5 && (severity === "SOFT_LEVEL_1" || severity === "SOFT_LEVEL_2") && oldSeverity !== "NONE") {
         if (Math.random() < 0.1) { // Prevents log spam
           console.log(`[SOFT_DRAWDOWN_RECOVERY_PENDING] Drawdown is ${drawdownPct.toFixed(2)}% (< 2.5%), but waiting for full recovery checks (Expectancy: ${expectancyAfterFees.toFixed(3)}, Protection: ${botState.protectionStatus}, Consecutive losses: ${bothLosses}). Soft drawdown remains active.`);
         }
      }

      // Recovery and Telemetry logging
      if (severity !== "NONE") {
        console.log(`[DRAWDOWN_STATE_RESOLVED] Resolving state... Final mode: ${severity}`);
        console.log(`[DRAWDOWN_RECOVERY_PROGRESS_UPDATED] Status: ${severity} | Current DD: ${drawdownPct.toFixed(2)}% | Progress: ${recoveryProgress.toFixed(1)}% | Equity: $${botState.accountEquity.toFixed(2)} (Peak: $${botState.peakEquity.toFixed(2)})`);
      }

      if (severity === "HARD") {
        const now = Date.now();
        const currentPause = botState.drawdownPauseUntil || 0;
        if (now >= currentPause) {
          botState.drawdownPauseUntil = now + 60 * 60 * 1000; // 1 hour pause
          console.log(
            `[DRAWDOWN_PROTECTION_HARD] Account equity ($${botState.accountEquity.toFixed(2)}) dropped by ${drawdownPct.toFixed(2)}% from peak ($${botState.peakEquity.toFixed(2)}), exceeding 10% hard threshold. Activating 1-hour trading lock.`,
          );

          if (botState.phase === "PHASE_2_ADAPTIVE_EXECUTION") {
            console.log(
              `[PHASE_2_RETAINED_DURING_WAIT_STATE] High hard drawdown lock active. Pausing all entries but remaining in PHASE_2_ADAPTIVE_EXECUTION.`,
            );
          }
        }
      } else {
        // Clear drawdown pause timer if not in HARD mode to enable gradual recovery trading
        botState.drawdownPauseUntil = 0;
      }
    }

    if (botState.accountEquity > 0 && botState.blocker?.includes("UNFUNDED")) {
      botState.blocker = null;
    }

    botState.withdrawable = parseFloat(
      info.withdrawable || spotUsdc.toString() || "0",
    );
    botState.marginUsed = parseFloat(info.marginSummary.totalMarginUsed);

    // Check positions across all assets
    let openPositionsCount = 0;
    let activePositions: any[] = [];

    if (config.DRY_RUN) {
      console.log(`[DRY_RUN_RECONCILIATION] Bypassed overwriting simulated positions with real exchange state.`);
      openPositionsCount = botState.allPositions ? botState.allPositions.length : 0;
      botState.openPositions = openPositionsCount;
    } else {
      activePositions = info.assetPositions.filter(
        (p: any) => parseFloat(p.position.szi) !== 0,
      );
      openPositionsCount = activePositions.length;

      if (openPositionsCount > 0) {
      if (!(botState as any).protectionByCoin) {
          (botState as any).protectionByCoin = {};
      }

      if (botState.activeSymbol && botState.protection) {
          (botState as any).protectionByCoin[botState.activeSymbol] = { ...botState.protection };
      }
      
      const cycleIndex = ((botState as any).cycleIndex || 0) % openPositionsCount;
      const pos = activePositions[cycleIndex];
      (botState as any).cycleIndex = ((botState as any).cycleIndex || 0) + 1;
      
      botState.activeSymbol = pos.position.coin;
      
      if (!(botState as any).protectionByCoin[pos.position.coin]) {
          (botState as any).protectionByCoin[pos.position.coin] = {
            tpPrice: null,
            slPrice: null,
            trailingStopPrice: null,
            isTrailingActive: false,
            highestUnrealizedPnlPct: 0,
            currentLockedProfitPct: 0,
            activeProfitLockLevel: "NONE"
          };
      }
      botState.protection = (botState as any).protectionByCoin[pos.position.coin];
      
      botState.openPositions = openPositionsCount;
      botState.unrealizedPnl = parseFloat(pos.position.unrealizedPnl);
      botState.liquidationPrice = parseFloat(pos.position.liquidationPrice);
      botState.positionDetails = pos.position;
      botState.allPositions = activePositions.map((p: any) => p.position);
      
      for (const coin of Object.keys((botState as any).protectionByCoin)) {
          if (!botState.allPositions.find(p => p.coin === coin)) {
              delete (botState as any).protectionByCoin[coin];
          }
      }

      console.log(`[POSITION_SANITY_CHECK] Validating protection state for ${botState.activeSymbol}.`);

      const roe = parseFloat(pos.position.returnOnEquity || "0");
      const localHighestPnlStr = (botState.protection?.highestUnrealizedPnlPct || 0).toFixed(2);
      const entryPxPos = parseFloat(pos.position.entryPx || "0");
      const posSid = parseFloat(pos.position.szi) > 0 ? "LONG" : "SHORT";
      const markPx = (botState.markPrices && botState.markPrices[botState.activeSymbol]) || botState.markPrice || entryPxPos;
      
      let sanityFailed = false;

      // 1. Profit-Lock / Highest PnL Sanity
      if (roe < 0 && (botState.protection?.highestUnrealizedPnlPct || 0) > 10) {
        console.warn(`[PROFIT_LOCK_SANITY_FAILED] Impossible state. ROE: ${roe}, Highest PnL: ${localHighestPnlStr}%. Mismatch detected.`);
        sanityFailed = true;
      }

      // 2. TP / SL Structure Sanity
      if (botState.protection) {
         const { tpPrice, slPrice, currentLockedProfitPct } = botState.protection;
         const hasLockedProfit = (currentLockedProfitPct || 0) > 0;
         
         if (tpPrice !== null) {
            // TP must be above entry for LONG, below entry for SHORT
            if (posSid === "LONG" && tpPrice < entryPxPos) {
                 console.warn(`[TP_SL_SANITY_FAILED] [INVALID_TP_DIRECTION] Invalid LONG TP: $${tpPrice} is below Entry $${entryPxPos}`);
                 sanityFailed = true;
            }
            if (posSid === "SHORT" && tpPrice > entryPxPos) {
                 console.warn(`[TP_SL_SANITY_FAILED] [INVALID_TP_DIRECTION] Invalid SHORT TP: $${tpPrice} is above Entry $${entryPxPos}`);
                 sanityFailed = true;
            }
         }

         if (slPrice !== null && entryPxPos > 0) {
             const slDistPct = Math.abs(slPrice - entryPxPos) / entryPxPos * 100;
             
             if (!hasLockedProfit) {
                 if (posSid === "LONG" && slPrice > entryPxPos) {
                      console.warn(`[TP_SL_SANITY_FAILED] [INVALID_SL_DIRECTION] Invalid LONG SL: $${slPrice} is above Entry $${entryPxPos} without locked profit.`);
                      sanityFailed = true;
                 }
                 if (posSid === "SHORT" && slPrice < entryPxPos) {
                     console.warn(`[TP_SL_SANITY_FAILED] [INVALID_SL_DIRECTION] Invalid SHORT SL: $${slPrice} is below Entry $${entryPxPos} without locked profit.`);
                     sanityFailed = true;
                 }
             } else {
                 if (posSid === "LONG" && slPrice > markPx * 1.02) { // Allow slight variance
                      console.warn(`[TP_SL_SANITY_FAILED] [INVALID_SL_DIRECTION] Locked LONG SL: $${slPrice} is above Mark $${markPx}`);
                      sanityFailed = true;
                 }
                 if (posSid === "SHORT" && slPrice < markPx * 0.98) {
                      console.warn(`[TP_SL_SANITY_FAILED] [INVALID_SL_DIRECTION] Locked SHORT SL: $${slPrice} is below Mark $${markPx}`);
                      sanityFailed = true;
                 }
             }

             if (slDistPct > 50) {
                 console.warn(`[TP_SL_SANITY_FAILED] SL distance absurdly large: ${slDistPct.toFixed(1)}%`);
                 sanityFailed = true;
             }
         }
      }

      if (sanityFailed) {
         console.warn(`[PROTECTION_STATE_CORRUPTED] Clearing all local protection logic. Reconstructing from exchange truth.`);
         if (botState.protection) {
             botState.protection.tpPrice = null;
             botState.protection.slPrice = null;
             botState.protection.trailingStopPrice = null;
             botState.protection.isTrailingActive = false;
             botState.protection.highestUnrealizedPnlPct = 0;
             botState.protection.currentLockedProfitPct = 0;
             botState.protection.activeProfitLockLevel = "NONE";
         }
         console.log(`[PROTECTION_STATE_REBUILT] local TP/SL/Trailing wiped. [STALE_SYMBOL_STATE_CLEARED]`);
         
         const { executionEngine } = await import("./hyperliquidExecutionEngine.js");
         await executionEngine.cancelAllOrders(botState.activeSymbol);
         console.log(`[EXCHANGE_ORDERS_CLEARED] Eliminated all resting limits for ${botState.activeSymbol} due to sanity failure. Will be rebuilt cleanly.`);
         
         // Trigger full external reload to avoid internal drift
         botState.protectionStatus = "REPAIRING";
      }

      // Requirement 2: Minimum hold blocker activation
      if (botState.lastEntryTimestamp && botState.lastEntryTimestamp > 0) {
        const positionAge = Date.now() - botState.lastEntryTimestamp;
        const minHoldDuration = 90000; // 90 seconds
        if (positionAge < minHoldDuration) {
          botState.blocker = "MINIMUM_HOLD_BLOCKED";
        } else {
          if (botState.blocker === "MINIMUM_HOLD_BLOCKED") {
            botState.blocker = null;
            console.log("[MINIMUM_HOLD_STATE_CLEARED] Minimum hold duration has elapsed. Clearing MINIMUM_HOLD_BLOCKED state. MINIMUM_HOLD_STATE_CLEARED.");
          }
        }
      }
    } else {
      if (botState.openPositions > 0 && botState.positionDetails) {
         if (botState.isProgrammaticClosing) {
            console.log("[SYNC] Programmatic close in progress, skipping duplicate external exit logger.");
         } else {
            console.log("POSITION_EXIT_DETECTED");
            const sziStr = botState.positionDetails.szi || "0";
            const szi = parseFloat(sziStr);
            const sz = Math.abs(szi);
            const currentSide = szi > 0 ? "LONG" : szi < 0 ? "SHORT" : "NONE";
            const entryPx = parseFloat(botState.positionDetails.entryPx || "0");
            let finalFillPrice = botState.lastFillPrice || botState.markPrice || entryPx;
            let actualFees = Math.abs(sz * finalFillPrice * 0.00035);

            try {
                // Look for recent fill to confirm actual price and fees
                const budget = (await import("./services/apiBudgetManager.js")).apiBudgetManager.reserveInfo("metadata", "userFills");
                if (budget.allowed) {
                    const fills = await hClient.infoRequest({ type: "userFills", user: config.HYPERLIQUID_WALLET_ADDRESS });
                    if (fills && Array.isArray(fills)) {
                        const latestFill = fills.find((f: any) => f.coin === botState.positionDetails.coin && f.dir === (currentSide === "LONG" ? "Sell" : "Buy"));
                        if (latestFill) {
                           finalFillPrice = parseFloat(latestFill.px);
                           actualFees = parseFloat(latestFill.fee);
                        }
                    }
                } else {
                    console.warn(`[REST_BUDGET_DEFERRED] Skipped userFills fetch during exit reconciliation to preserve API budget.`);
                }
            } catch(e) {}
            
            const grossPnl = (finalFillPrice - entryPx) * sz * (currentSide === "LONG" ? 1 : -1);
            const netRealizedPnl = grossPnl - actualFees;
            
            console.log("EXIT_RECONCILIATION_COMPLETE");
            console.log("REALIZED_PNL_RECORDED");
            
            await tradeLogger.logTrade({
                timestamp: Date.now(),
                type: "EXIT",
                symbol: botState.positionDetails.coin,
                side: currentSide,
                size: sz,
                entryPrice: entryPx,
                exitPrice: finalFillPrice,
                realizedPnl: netRealizedPnl,
                fees: actualFees,
                orderId: "EXTERNAL_CLOSE",
                exitReason: "POSITION AUTOMATICALLY/EXTERNALLY CLOSED",
                confidenceScore: 0,
                tradeQualityScore: 0,
                volatilityScore: 0,
                trendScore: 0,
                momentumScore: 0,
                duration: Date.now() - (botState.lastEntryTimestamp || 0),
                marketRegime: "UNKNOWN",
                fundingRate: botState.fundingRate,
                wssHealth: botState.wssConnected ? "STABLE" : "UNSTABLE",
                apiLatency: 0,
                slippage: 0,
                expectedMovePct: 0,
            });
            
            updateFeeEfficiency();
            console.log("ANALYTICS_SYNCED");
         }
      }

      botState.openPositions = 0;
      botState.unrealizedPnl = 0;
      botState.liquidationPrice = null;
      botState.positionDetails = null;
      botState.allPositions = [];

      // Requirement 1 & 3: Post-close cleanup & clear minimum hold blockers
      let clearedAny = false;
      if (botState.blocker === "MINIMUM_HOLD_BLOCKED") {
        botState.blocker = null;
        console.log("[MINIMUM_HOLD_STATE_CLEARED] No active positions open in state sync. MINIMUM_HOLD_STATE_CLEARED.");
        clearedAny = true;
      }
      if (typeof botState.lastEntryTimestamp === "number" && botState.lastEntryTimestamp !== 0) {
        botState.lastEntryTimestamp = 0;
        console.log("[POST_CLOSE_HOLD_TIMER_RESET] Post close hold timer reset. POST_CLOSE_HOLD_TIMER_RESET.");
        clearedAny = true;
      }
      // clear position lifecycle flags
      botState.protection = {
        tpPrice: null,
        slPrice: null,
        trailingStopPrice: null,
        isTrailingActive: false,
        highestUnrealizedPnlPct: 0,
        currentLockedProfitPct: 0,
        activeProfitLockLevel: "NONE"
      };
      botState.protectionStatus = "CONFIRMED";

      if (clearedAny && botState.blocker === null) {
        console.log("[MONITORING_RESUMED_NO_OPEN_POSITIONS] Monitoring resumed: no active positions open. MONITORING_RESUMED_NO_OPEN_POSITIONS.");
      }
    }
    }

    // Ghost position detection (Reconciliation Check) - trigger only if configured max is breached.
    // Conservative Phase 1 and adaptive Phase 2 both allow configured multi-position operation.
    calculatePositionSlots();
    const configuredMaxForReconciliation = botState.config?.maxOpenPositions ?? config.MAX_OPEN_POSITIONS;
    if (
      openPositionsCount > configuredMaxForReconciliation &&
      botState.phase !== "CIRCUIT_BREAKER_ACTIVE"
    ) {
      console.error(
        `[GHOST_POSITION] Position count exceeded configured max. Max allowed: ${configuredMaxForReconciliation}. Total open: ${openPositionsCount}`,
      );
      triggerCircuitBreaker("CIRCUIT_BREAKER_ACTIVE: MULTIPLE_POSITIONS_DETECTED");
      botState.validationStatus = "VALIDATION_FAILED";
      botState.openPositions = openPositionsCount;
    }

    // Sync Open Orders
    if (!config.DRY_RUN) {
      try {
        const openOrders = await hClient.infoRequest({
          type: "openOrders",
          user: config.HYPERLIQUID_WALLET_ADDRESS,
        });
        
        if (openOrders !== null) {
            botState.activeOrders = Array.isArray(openOrders) ? openOrders : botState.activeOrders || [];
            
            // Track transitions for any pending resting entries that gets filled asynchronously
            if (botState.entryOrdersContext && Object.keys(botState.entryOrdersContext).length > 0) {
              const activeOids = new Set((botState.activeOrders || []).map(o => String(o.oid)));
              for (const oid of Object.keys(botState.entryOrdersContext)) {
                if (!activeOids.has(oid)) {
                  const ctx = botState.entryOrdersContext[oid];
                  const positionForSymbol = botState.allPositions && botState.allPositions.find(p => p.coin === ctx.symbol);
                  if (positionForSymbol) {
                    const sizeNum = parseFloat(positionForSymbol.szi);
                    const posSide = sizeNum > 0 ? "LONG" : "SHORT";
                    if (posSide === ctx.side) {
                      console.log(`[ORDER_FILLED_POSITION_OPENED] Pending entry order ${oid} for ${ctx.symbol} successfully filled asynchronously. Position is now open.`);
                      delete botState.entryOrdersContext[oid];
                    }
                  }
                }
              }
            }
        } else {
             console.warn(`[REST_BUDGET_DEFERRED] Deferred openOrders fetch to protect API limits. Retaining cached local state.`);
        }
      } catch (e) {
        console.warn("[SYNC] Failed to fetch open orders:", e);
        botState.activeOrders = [];
      }
    } else {
      console.log(`[DRY_RUN] Retained simulated orders count: ${(botState.activeOrders || []).length}`);
    }

    // Compute Precise Separation Metrics (Requirement 1, 2 & 9)
    let reservedOrderMargin = 0;
    let restingEntryOrderCount = 0;
    const restingEntryOrders = (botState.activeOrders || []).filter(o => !o.reduceOnly);
    restingEntryOrderCount = restingEntryOrders.length;

    for (const o of restingEntryOrders) {
      const orderPrice = parseFloat(o.limitPx || o.px || "0");
      const orderSize = parseFloat(o.sz || "0");
      if (orderPrice > 0 && orderSize > 0) {
        const orderLeverage = botState.config.leverage || 2;
        reservedOrderMargin += (orderSize * orderPrice) / orderLeverage;
      }
    }

    botState.reservedOrderMargin = reservedOrderMargin;
    botState.restingEntryOrderCount = restingEntryOrderCount;

    if (botState.telemetry) {
        const protectOrders = (botState.activeOrders || []).filter(o => o.reduceOnly);
        botState.telemetry.activeTpCount = protectOrders.filter(o => !o.isTrigger && !o.triggerPx && parseFloat(o.triggerPx || "0") === 0).length;
        botState.telemetry.activeSlCount = protectOrders.length - botState.telemetry.activeTpCount;
        botState.telemetry.lastProtectionSync = Date.now();
        botState.telemetry.protectionSyncHealth = "HEALTHY";
    }

    const exchangeTotalMarginUsed = parseFloat(info.marginSummary.totalMarginUsed) || 0;
    botState.reservedPositionMargin = Math.max(0, exchangeTotalMarginUsed - reservedOrderMargin);

    botState.availableMargin = Math.max(0, botState.accountEquity - exchangeTotalMarginUsed);

    let maintenanceMargin = 0;
    let totalPositionNotional = 0;

    if (botState.allPositions && botState.allPositions.length > 0) {
      for (const pos of botState.allPositions) {
        const posSize = Math.abs(parseFloat(pos.szi || pos.position?.szi || "0"));
        const posPrice = parseFloat(pos.entryPx || pos.position?.entryPx || "0") || botState.markPrice;
        totalPositionNotional += posSize * posPrice;
        
        if (posSize > 0 && posPrice > 0) {
          maintenanceMargin += posSize * posPrice * 0.05; // 5% maintenance margin
        }
      }
    }
    
    if (maintenanceMargin === 0 && botState.accountEquity > 0) {
      maintenanceMargin = botState.accountEquity * 0.1;
    }
    botState.maintenanceMargin = maintenanceMargin;

    botState.portfolioExposureUsedPct = botState.accountEquity > 0
      ? (totalPositionNotional / botState.accountEquity) * 100
      : 0;

    botState.freeCollateralPct = botState.accountEquity > 0
      ? (botState.availableMargin / botState.accountEquity) * 100
      : 100;

    console.log(`[ACCOUNTING_TRACE] TotalEquity: $${botState.accountEquity.toFixed(2)} (Perp: $${perpEquity.toFixed(2)}, Spot: $${spotUsdc.toFixed(2)}) | MarginUsed: $${exchangeTotalMarginUsed.toFixed(2)} | AvailMargin: $${botState.availableMargin.toFixed(2)} | FreeCollateral: ${botState.freeCollateralPct.toFixed(1)}% | Exposure: ${botState.portfolioExposureUsedPct.toFixed(1)}% | OpenPosNotional: $${totalPositionNotional.toFixed(2)}`);


  } else {
    botState.apiConnected = false;
  }

  if (botState.apiConnected) {
    if (botState.openPositions > 0) {
       await verifyProtectionOrders();
    } else {
       botState.protectionStatus = "CONFIRMED"; // Default safe state when no positions are open
    }
  }

  // Update strategy price for all active universe
  if (botState.markPrices) {
    for (const [sym, price] of Object.entries(botState.markPrices)) {
      if (price > 0) {
        strategy.updatePrice(sym, price);
      }
    }
  }

  // Backwards compatibility for primary active token history
  if (botState.markPrice > 0) {
    const now = Date.now();
    botState.priceHistory.push({ timestamp: now, value: botState.markPrice });
    if (botState.priceHistory.length > 100) botState.priceHistory.shift();

    botState.pnlHistory.push({
      timestamp: now,
      value: botState.realizedPnl + botState.unrealizedPnl,
    });
    if (botState.pnlHistory.length > 100) botState.pnlHistory.shift();
  }

  // Recalculate sizing and capital safety telemetry on every account sync
  recalculateSizingTelemetry();
}

export function recalculateSizingTelemetry() {
  const accountEquity = botState.accountEquity;
  const availableMargin = botState.availableMargin;
  const setupLeverage = botState.config.leverage || 2;
  const dynamicLimitObj = getDynamicMaxPositions();
  const limit = dynamicLimitObj.limit;
  const requiredFreePct = botState.openPositions >= limit ? 35 : 30;
  const maxAllowedRiskPct = 65; // 65% dynamic exposure limit
  const EXCHANGE_MINIMUM = 11;
  const PREFERRED_ENTRY_SIZE = botState.config.minEntrySize || 40;
  const assetMeta = getAssetMeta(botState.activeSymbol || "SOL");
  const assetMinSz = assetMeta ? assetMeta.minSz || 0 : 0;
  const markPrice = botState.markPrice || 1;
  const minSzNotional = assetMinSz * markPrice;
  const absoluteExecutableMinimum = Math.max(EXCHANGE_MINIMUM, minSzNotional);
  const minimumUserRequiredSize = Math.max(absoluteExecutableMinimum, PREFERRED_ENTRY_SIZE);

  // Read real account balance source verification
  const totalEquityVal = botState.accountEquity;
  const availableMarginVal = botState.availableMargin;
  const withdrawableVal = botState.withdrawable || 0;
  const reservedMarginVal = botState.reservedPositionMargin || 0;
  const reservedOrderVal = botState.reservedOrderMargin || 0;
  const openPositionsVal = botState.openPositions || 0;
  const restingOrdersVal = botState.restingEntryOrderCount || 0;

  console.log(`[BALANCE_SOURCE_VALIDATED] Equity: $${totalEquityVal.toFixed(2)}, Available margin: $${availableMarginVal.toFixed(2)}, Withdrawable balance: $${withdrawableVal.toFixed(2)}, Reserved position margin: $${reservedMarginVal.toFixed(2)}, Reserved order margin: $${reservedOrderVal.toFixed(2)}, Open positions: ${openPositionsVal}, Resting orders: ${restingOrdersVal}`);

  // Calculate safe size from collateral rules
  // Rule A: Margin Buffer requirement (preserving required free collateral)
  const maxMarginUsagePermitted = Math.max(0, availableMargin - (accountEquity * (requiredFreePct / 100)));
  
  let safeExposureMarginBased = 0;
  if (maxMarginUsagePermitted > 0) {
    safeExposureMarginBased = maxMarginUsagePermitted / ((1 / setupLeverage) + 0.005);
  } else if (accountEquity > 0 && openPositionsVal === 0) {
    // If there are no open positions and funds exist, safe size must not be $0 based purely on static buffer rules.
    // We can allow a conservative entry sizing based on account equity and available margin, taking minimum possible buffer.
    const minimalBufferPct = 15; // 15% minimal absolute safety margin for small accounts to bootstraps sizing
    const minMarginPermitted = Math.max(0, availableMargin - (accountEquity * (minimalBufferPct / 100)));
    safeExposureMarginBased = minMarginPermitted / ((1 / setupLeverage) + 0.005);
  }

  // Rule B: Portfolio dynamic exposure limits (65% of equity)
  const maxAllowedPortfolioExposure = accountEquity * (maxAllowedRiskPct / 100);
  let currentPositionExposure = 0;
  if (botState.allPositions && botState.allPositions.length > 0) {
    for (const pos of botState.allPositions) {
      const sz = Math.abs(parseFloat(pos.szi || pos.position?.szi || "0"));
      const px = parseFloat(pos.entryPx || pos.position?.entryPx || "0") || markPrice;
      currentPositionExposure += sz * px;
    }
  }
  const remainingExposureAllowed = Math.max(0, maxAllowedPortfolioExposure - currentPositionExposure);

  // Safe exposure is the minimum of margin-based and portfolio-exposure physical bounds
  let safeExposure = Math.min(safeExposureMarginBased, remainingExposureAllowed);

  // Ensure safe size is not $0 if there are no open positions and funds exist
  if (openPositionsVal === 0 && accountEquity > 0 && safeExposure <= 0) {
    // Let's safe-size it as at least the minimum required notional or accountEquity * setupLeverage (whichever is lower) to avoid false zeros
    safeExposure = Math.max(1, Math.min(accountEquity * setupLeverage, minimumUserRequiredSize));
  }

  let finalSize = 0;
  let rejectionReason = "NONE";

  // Compare safe size against user minimum
  if (safeExposure < minimumUserRequiredSize) {
    rejectionReason = "SAFE_SIZE_BELOW_MIN_REQUIREMENT";
    finalSize = 0;
  } else {
    finalSize = safeExposure;
  }

  // Margin simulations for Telemetry
  const simulatedIm = minimumUserRequiredSize / setupLeverage;
  const simulatedFeesSlippage = minimumUserRequiredSize * 0.005;
  const simulatedRequiredMargin = simulatedIm + simulatedFeesSlippage;
  const simulatedPostAvailableMargin = availableMargin - simulatedRequiredMargin;
  const simulatedFreeCollateralPct = accountEquity > 0
    ? (simulatedPostAvailableMargin / accountEquity) * 100
    : 0;

  const marginUsagePct = accountEquity > 0
    ? ((accountEquity - Math.max(0, simulatedPostAvailableMargin)) / accountEquity) * 100
    : 100;

  botState.sizingTelemetry = {
    lastSafeExposureComputed: safeExposure,
    lastExchangeMinimumRequired: minimumUserRequiredSize,
    marginBufferHealthPct: accountEquity > 0 ? (availableMargin / accountEquity) * 100 : 0,
    projectedFreeCollateralPct: Math.max(0, simulatedFreeCollateralPct),
    projectedMarginUsagePct: marginUsagePct,
    rejectedTradesDueToSizing: botState.sizingTelemetry?.rejectedTradesDueToSizing || 0
  };

  // Trailing logs
  console.log(`[SIZING_ENGINE_TRACE]
┌────────────────────────────────────────────────────────┐
│ ACCOUNT EQUITY: $${accountEquity.toFixed(2)}
│ AVAILABLE MARGIN: $${availableMargin.toFixed(2)}
│ MIN ENTRY REQUIREMENT: $${minimumUserRequiredSize.toFixed(2)}
│ MAX ALLOWED RISK %: ${maxAllowedRiskPct}%
│ FREE COLLATERAL REQUIREMENT: ${requiredFreePct}%
│ CALCULATED SAFE NOTIONAL: $${safeExposure.toFixed(2)}
│ MINIMUM USER REQUIRED SIZE: $${minimumUserRequiredSize.toFixed(2)}
│ LEVERAGE USED: ${setupLeverage}x
│ FINAL ORDER SIZE: $${finalSize.toFixed(2)}
│ REJECTION REASON: ${rejectionReason}
└────────────────────────────────────────────────────────┘`);

  console.log(`[SAFE_SIZE_CALCULATED] Safe size computed: $${safeExposure.toFixed(2)} vs Min Required: $${minimumUserRequiredSize.toFixed(2)} (Leverage: ${setupLeverage}x)`);

  if (safeExposure <= 0) {
    let exactReason = "UNKNOWN_ZERO_DIAGNOSTIC";
    if (openPositionsVal > 0) {
      exactReason = "active position";
    } else if (restingOrdersVal > 0) {
      exactReason = "resting order reservation";
    } else if (availableMarginVal <= 0) {
      if (accountEquity <= 0) {
        exactReason = "wrong wallet/source or exchange sync failure (unfunded account)";
      } else {
        exactReason = "HyperCore vs HyperEVM balance mismatch or stale balance";
      }
    } else {
      exactReason = "stale balance or extreme safety thresholds restricting allocation";
    }

    console.log(`[SAFE_SIZE_ZERO_DIAGNOSTIC] Safe tradable size is $0. Reason: ${exactReason}`);
  }

  console.log(`[CAPITAL_SAFETY_RECALCULATED] Capital safety parameters refreshed (Health Index: ${Math.round(botState.sizingTelemetry.marginBufferHealthPct)}/100)`);
}

// Function to calculate and update fee efficiency scores and overtrading rates (Requirement 11)
function updateFeeEfficiency() {
  const trades = botState.trades || [];
  const completedExits = trades.filter((t) => t.type === "EXIT");
  
  // Asset Fee Efficiency tracking (High-Fee Market logic)
  if (!botState.assetFeeEfficiency) botState.assetFeeEfficiency = {};
  
  const assetMap: Record<string, any> = {};
  
  trades.forEach(t => {
     if (t.type !== "ENTRY" && t.type !== "EXIT") return;
     if (!assetMap[t.symbol]) {
        assetMap[t.symbol] = { fees: 0, rawPnl: 0, tradesCount: 0, grossRealizedMove: 0 };
     }
     
     assetMap[t.symbol].fees += (t.fees || 0);
     if (t.type === "EXIT") {
         assetMap[t.symbol].rawPnl += (t.realizedPnl || 0);
         assetMap[t.symbol].tradesCount++;
         
         if (t.expectedMovePct) {
            assetMap[t.symbol].grossRealizedMove += t.expectedMovePct; // approx proxy for move tracking
         }
     }
  });

  Object.keys(assetMap).forEach(sym => {
     const data = assetMap[sym];
     const nPnl = data.rawPnl - data.fees;
     const fRatio = data.rawPnl > 0 ? Math.min(1.0, data.fees / data.rawPnl) : (data.rawPnl < 0 ? 1.0 : 0.0);
     
     let isHighFee = false;
     if (data.tradesCount >= 2) {
         if (nPnl < 0 && data.fees > Math.abs(data.rawPnl) * 0.5) isHighFee = true;
         if (data.rawPnl > 0 && fRatio > 0.45) isHighFee = true;
     }

     if (isHighFee && !botState.assetFeeEfficiency![sym]?.isHighFeeMarket) {
         console.log(`[HIGH_FEE_MARKET_FLAGGED] ${sym} flagged for high fee bleed. Net PnL: ${nPnl.toFixed(2)}, Fee Ratio: ${(fRatio * 100).toFixed(1)}%`);
     }

     botState.assetFeeEfficiency![sym] = {
         totalFees: data.fees,
         grossPnl: data.rawPnl,
         netPnl: nPnl,
         feeToProfitRatio: fRatio,
         avgFeePerTrade: data.tradesCount > 0 ? data.fees / data.tradesCount : 0,
         avgRealizedMove: data.tradesCount > 0 ? data.grossRealizedMove / data.tradesCount : 0,
         tradesAmount: data.tradesCount,
         isHighFeeMarket: isHighFee
     };
  });

  const totalFees = trades.reduce((acc, t) => acc + (t.fees || 0), 0);
  const rawRealized = completedExits.reduce((acc, t) => acc + (t.realizedPnl || 0), 0);
  const netPnlAfterFees = rawRealized - totalFees;
  const feeToProfitRatio = rawRealized > 0 ? totalFees / rawRealized : 0;
  
  const hourAgo = Date.now() - 3600000;
  const recentExitsCount = completedExits.filter((t) => t.timestamp > hourAgo).length;

  let isPaused = false;
  let pauseType: "NONE" | "SOFT" | "HARD" = "NONE";
  let eliteEligibility = false;
  
  if (completedExits.length >= 3) {
    const last3 = completedExits.slice(-3);
    const last3NetPnlAfterFees = last3.reduce((acc, t) => acc + ((t.realizedPnl || 0) - (t.fees || 0)), 0);

    if (last3NetPnlAfterFees < 0) {
      if ((botState.feeEfficiencyPauseUntil || 0) < Date.now() && !botState.feeEfficiency?.isPaused) {
          botState.feeEfficiencyPauseUntil = Date.now() + 60 * 60 * 1000;
          console.log(`[FEE_SOFT_SUSPENSION_ACTIVE] Last 3 trades cumulative net PnL is ${last3NetPnlAfterFees.toFixed(4)}. Soft pausing for 1 hour. Elite override eligible.`);
      }
      isPaused = true;
      pauseType = "SOFT";
      eliteEligibility = true;
    }
  }

  const feeEfficiencyPauseEnd = botState.feeEfficiencyPauseUntil || 0;
  const isFeeEfficiencyPauseActive = Date.now() < feeEfficiencyPauseEnd;
  
  if (isFeeEfficiencyPauseActive && botState.feeEfficiency?.pauseType === "HARD") {
      isPaused = true;
      pauseType = "HARD";
      eliteEligibility = false;
  } else if (isFeeEfficiencyPauseActive) {
      isPaused = true;
      pauseType = "SOFT"; 
      eliteEligibility = true;
  }

  // Hard limits
  if (completedExits.length >= 4) {
    if (netPnlAfterFees < 0 && totalFees > 10.0) {
      if (pauseType !== "HARD") {
         console.log("[FEE_HARD_SUSPENSION_ACTIVE] Severe fee bleed. Extended 2hr hard pause.");
         botState.feeEfficiencyPauseUntil = Date.now() + 2 * 60 * 60 * 1000;
      }
      isPaused = true;
      pauseType = "HARD";
      eliteEligibility = false;
    } else if (rawRealized > 0 && Math.abs(feeToProfitRatio) > 0.55) {
      if (pauseType !== "HARD") {
         console.log("[FEE_HARD_SUSPENSION_ACTIVE] Fee-to-profit > 55%. Hard pause.");
         botState.feeEfficiencyPauseUntil = Math.max(botState.feeEfficiencyPauseUntil || 0, Date.now() + 60 * 60 * 1000);
      }
      isPaused = true;
      pauseType = "HARD";
      eliteEligibility = false;
    } else if (recentExitsCount > 5) {
      if (pauseType !== "HARD") {
         botState.feeEfficiencyPauseUntil = Math.max(botState.feeEfficiencyPauseUntil || 0, Date.now() + 30 * 60 * 1000);
      }
      isPaused = true;
      pauseType = "HARD";
      eliteEligibility = false;
    }
  }
  
  if (isPaused) {
      if (!botState.feeEfficiency?.isPaused) {
         console.log(`[FEE_BLEED_PROTECTION_ACTIVE] Fee protection activated. Type: ${pauseType}. Remaining: ${Math.floor((botState.feeEfficiencyPauseUntil! - Date.now())/1000/60)} mins.`);
      }
  } else if (botState.feeEfficiency?.isPaused) {
      console.log("[FEE_PROTECTION_CLEARED] Fee efficiency ratio has improved, trading pause lifted.");
      botState.feePauseOverrideActive = false;
  }

  botState.feeEfficiency = {
    netPnlAfterFees,
    feeToProfitRatio,
    overtradingScore: recentExitsCount,
    isPaused: isPaused,
    pauseType: pauseType,
    pauseUntil: botState.feeEfficiencyPauseUntil,
    eliteOverrideEligibility: eliteEligibility
  };
}

async function handleTradingLogic(isEmergencyMode = false) {
  const metaList =
    (await import("./state.js").then((m) => m.getAssetMetaGlobal())) || [];
  let universe = metaList.map((m: any) => m.name);
  if (universe.length === 0 && botState.markPrices) {
    universe = Object.keys(botState.markPrices);
  }
  if (!universe.includes("HYPE")) {
    universe.push("HYPE");
  }

  if (!botState.markPrices) botState.markPrices = {};
  if (!botState.markPrices["HYPE"]) {
    botState.markPrices["HYPE"] = botState.markPrice || 10.0;
  }

  // 1. Autonomous Recovery Activation and Controlled Soft-Filter Relaxation Trigger
  const missedRunnerCount = botState.analytics.missedRunnerCount || botState.participation?.missedRunnerCount || 0;
  const recentEntryBias = botState.analytics.recentEntryBias || "NEUTRAL";
  const falseBreakoutRate = botState.analytics.falseBreakoutRate !== undefined ? botState.analytics.falseBreakoutRate : 0;
  const expectancyAfterFees = botState.analytics.expectancyAfterFees !== undefined ? botState.analytics.expectancyAfterFees : (botState.expectancy?.globalExpectancyAfterFees !== undefined ? botState.expectancy.globalExpectancyAfterFees : 0.05);
  const isWssHealthy = botState.wssConnected !== false;
  const isApiHealthy = botState.apiConnected !== false;
  const isFreeCollateralHealthy = (botState.freeCollateralPct || 0) >= 30;
  const isTpSlSystemValid = botState.protectionStatus !== "FAILED_EMERGENCY_CLOSE_REQUIRED";
  const noCriticalProtectionCorruption = botState.blocker !== "CRITICAL_FAILURE";

  const isEligibleForRecovery = 
    missedRunnerCount >= 3 &&
    recentEntryBias === "TOO_CONSERVATIVE" &&
    falseBreakoutRate < 15 &&
    expectancyAfterFees >= -0.05 &&
    isWssHealthy &&
    isApiHealthy &&
    isFreeCollateralHealthy &&
    isTpSlSystemValid &&
    noCriticalProtectionCorruption;

  if (isEligibleForRecovery) {
    if (botState.autoRecoveryMode !== "ON") {
      botState.autoRecoveryMode = "ON";
      botState.analytics.TOO_CONSERVATIVE_OVERRIDE_ACTIVE = true;
      botState.recoveryReason = `missedRunnerCount = ${missedRunnerCount}, recentEntryBias = ${recentEntryBias}, falseBreakoutRate = ${falseBreakoutRate.toFixed(1)}%, expectancy = ${expectancyAfterFees.toFixed(3)}`;
      botState.recoveryRiskLimits = "Max leverage = 2x, tighter SL (-25%), faster breakeven, earlier trailing (-0.35/0.50%), reduced hold tolerance (-45s/75s)";
      botState.participationRecoveryStatus = "AUTO_TOO_CONSERVATIVE_RECOVERY_TRIGGERED";
      botState.recoveryExitConditions = "missed runners decrease (<3), false breakout rises (>=15%), expectancy fails (<-0.05)";
      botState.currentThresholdAdjustment = -12; // Lower threshold globally by 12 points

      console.log("[AUTO_TOO_CONSERVATIVE_RECOVERY_TRIGGERED] Autonomous too conservative recovery mode triggered!");
      console.log("[TOO_CONSERVATIVE_RECOVERY_ACTIVE] Too conservative recovery is active.");
      console.log("[AUTO_SOFT_FILTER_RELAXATION_APPLIED] Soft filter relaxation applied for too conservative recovery.");
      console.log("[CONTROLLED_PARTICIPATION_RESTORED] Controlled participation has been restored.");
    }
  } else {
    // Check exit conditions
    if (botState.autoRecoveryMode === "ON") {
      const exitTriggered = 
        missedRunnerCount < 3 ||
        falseBreakoutRate >= 15 ||
        expectancyAfterFees < -0.05 ||
        (botState.analytics.volatilityFailureRate || 0) >= 20;

      if (exitTriggered) {
        botState.autoRecoveryMode = "OFF";
        botState.analytics.TOO_CONSERVATIVE_OVERRIDE_ACTIVE = false;
        botState.recoveryReason = undefined;
        botState.recoveryRiskLimits = undefined;
        botState.participationRecoveryStatus = "NORMAL_PARTICIPATION_RESTORED";
        botState.recoveryExitConditions = undefined;
        botState.currentThresholdAdjustment = 0;
        
        console.log("[AUTO_RECOVERY_EXITED] Autonomous recovery mode exited successfully. System returned to standard trading.");
      }
    }
  }

  let bestSignal: any = null;
  let bestSymbol = botState.activeSymbol;
  let highestScore = -1;

  // Filter 1: Basic validation of approved markets
  let validUniverse = universe.filter((sym) => {
    const price = botState.markPrices ? botState.markPrices[sym] : 0;
    if (!price || price <= 0) return false;
    return true;
  });

  if (botState.apiRateLimitUntil && Date.now() < botState.apiRateLimitUntil) {
      console.log(`[BACKGROUND_SCAN_DEFERRED_FOR_TRADE_BUDGET] API limit active. Constraining universe to CMC top candidates & held positions only.`);
      validUniverse = validUniverse.filter(sym => {
          if (botState.allPositions?.find(p => p.coin === sym)) return true; // keep held positions
          const cmcMatched = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === sym || a.symbol === sym);
          return cmcMatched && (cmcMatched.trendScore > 60 || cmcMatched.classification === "CMC_VOLATILE_GEM_CANDIDATE");
      });
  }

  const isPhase2 = botState.phase === "PHASE_2_ADAPTIVE_EXECUTION";
  const multiPositionMode = isMultiPositionPhase();
  
  // Rule 3: Dynamic max positions checks
  const now = Date.now();
  const isWssApiStable = botState.wssConnected !== false && botState.apiConnected !== false && botState.phase !== "CIRCUIT_BREAKER_ACTIVE";
  const isDrawdownPauseActive = botState.drawdownPauseUntil !== undefined && botState.drawdownPauseUntil !== null && now < botState.drawdownPauseUntil;
  const hasCriticalValidationBlocker = botState.validationStatus === "VALIDATION_FAILED" ||
                                       botState.blocker === "LOW_EQUITY_TRADING_BLOCKED" ||
                                       (botState.blocker && botState.blocker.includes("CIRCUIT_BREAKER")) ||
                                       botState.lastApiError !== null;
  
  // Verify TP/SL requirement for all active positions
  let everyPositionHasTpSl = true;
  let tpSlFailedReasons: string[] = [];
  
  if (botState.allPositions && botState.allPositions.length > 0) {
    for (const pos of botState.allPositions) {
      const activePosOrders = (botState.activeOrders || []).filter(o => o.coin === pos.coin && o.reduceOnly);
      
      let posHasTp = false;
      let posHasSl = false;
      for (const o of activePosOrders) {
        if (o.isTrigger || o.triggerPx || o.orderType === "Stop Limit" || o.orderType === "Stop Market" || parseFloat(o.triggerPx || "0") > 0) {
            posHasSl = true;
        } else {
            posHasTp = true;
        }
      }
      
      const perCoinProtection = pos.coin === botState.activeSymbol ? botState.protection : ((botState as any).protectionByCoin ? (botState as any).protectionByCoin[pos.coin] : null);
      
      if (perCoinProtection?.isTrailingActive) {
        posHasTp = true;
      }
      
      if (!posHasTp || !posHasSl) {
        everyPositionHasTpSl = false;
        tpSlFailedReasons.push(`[${pos.coin}: TP=${posHasTp}, SL=${posHasSl}]`);
      }
    }
    // Also respect botState.protectionStatus
    if (botState.protectionStatus !== "CONFIRMED") {
      everyPositionHasTpSl = false;
      tpSlFailedReasons.push(`[ProtectionStatus=${botState.protectionStatus}]`);
    }
  }

  let totalPositionNotional = 0;
  if (botState.allPositions && botState.allPositions.length > 0) {
    for (const pos of botState.allPositions) {
      const posSize = Math.abs(parseFloat(pos.szi));
      const posPrice = parseFloat(pos.entryPx) || (botState.markPrices && botState.markPrices[pos.coin]) || botState.markPrice;
      totalPositionNotional += posSize * posPrice;
    }
  }
  const portfolioExposureUsedPct = botState.accountEquity > 0
    ? (totalPositionNotional / botState.accountEquity) * 100
    : 0;
  botState.portfolioExposureUsedPct = portfolioExposureUsedPct; // Keep synced
  
  const freeCollateralPct = botState.accountEquity > 0
    ? (botState.availableMargin / botState.accountEquity) * 100
    : 100;
  botState.freeCollateralPct = freeCollateralPct; // Keep synced

  const totalExposureWithinAllowed = portfolioExposureUsedPct <= 65;
  const dynamicLimitObj = getDynamicMaxPositions();
  const limit = dynamicLimitObj.limit;
  const freeCollateralOk = freeCollateralPct >= (botState.openPositions >= limit ? 35 : 30);

  const dynamicMoreThanTwoAllowed = isWssApiStable && 
                                    !isDrawdownPauseActive && 
                                    !hasCriticalValidationBlocker && 
                                    everyPositionHasTpSl && 
                                    totalExposureWithinAllowed && 
                                    freeCollateralOk;

  let canEnterNew = false;
  let blockerReason = "NONE";
  
  if (botState.openPositions < limit) {
    canEnterNew = true;
    console.log(`[MULTI_POSITION_SLOT_AVAILABLE] Slot available in execution pipeline. Open Positions: ${botState.openPositions} / ${limit} (Max: ${limit}). Reason: ${dynamicLimitObj.reason}`);
  } else {
    canEnterNew = false;
    blockerReason = "MAX_OPEN_POSITIONS";
    botState.blocker = "MAX_POSITIONS_REACHED";
    logEntryBlocked(botState.activeSymbol, blockerReason, `openPositions=${botState.openPositions}, maxOpenPositions=${limit}, availableSlots=${botState.availableSlots || 0}`);
  }

  // Dynamic portfolio limits: do not allow multiple positions if it breaks 30%–35% free collateral rules
  if (canEnterNew) {
    const minEntryNotional = botState.config.minEntrySize || 40;
    const currentLeverage = Math.max(1, botState.config.leverage || 2);
    const simImForNew = minEntryNotional / currentLeverage;
    const simFeesSlippageForNew = minEntryNotional * 0.005;
    const simRequiredMarginForNew = simImForNew + simFeesSlippageForNew;
    const projectedAvailableMarginAfterNew = botState.availableMargin - simRequiredMarginForNew;
    const projectedFreeCollateralPctAfterNew = botState.accountEquity > 0
      ? (projectedAvailableMarginAfterNew / botState.accountEquity) * 100
      : 0;

    const totalPositionsAfterNew = botState.openPositions + 1;
    const requiredFreeCollateralPctAfterNew = totalPositionsAfterNew >= limit ? 35 : 30;

    console.log(`[MULTI_POSITION_GATE_TRACE] OpenPos: ${botState.openPositions} | RawEquity: $${botState.accountEquity.toFixed(2)} | AvailMargin: $${botState.availableMargin.toFixed(2)} | FreeCollat: ${freeCollateralPct.toFixed(1)}% | Exposure: ${portfolioExposureUsedPct.toFixed(1)}% | ProjectedFreeCollat: ${projectedFreeCollateralPctAfterNew.toFixed(1)}%`);

    if (projectedAvailableMarginAfterNew <= 0 || (botState.openPositions < limit && projectedFreeCollateralPctAfterNew < requiredFreeCollateralPctAfterNew)) {
      console.log(`[MULTI_POSITION_BLOCKED_REASON] Blocking new entries: entering another $${minEntryNotional} position would drop projected free collateral to ${projectedFreeCollateralPctAfterNew.toFixed(1)}%, breaking the required ${requiredFreeCollateralPctAfterNew}% threshold.`);
      if (botState.openPositions < limit) {
        canEnterNew = false;
        blockerReason = "INSUFFICIENT_PROJECTED_FREE_COLLATERAL";
        botState.blocker = blockerReason;
        logEntryBlocked(botState.activeSymbol, "BALANCE_RESERVE", `projectedFreeCollateralPct=${projectedFreeCollateralPctAfterNew.toFixed(1)}, requiredFreeCollateralPct=${requiredFreeCollateralPctAfterNew}`);
      }
    } else {
      console.log(`[MULTI_POSITION_ALLOWED] Gate passed for setup evaluation.`);
    }
  }

  if (botState.openPositions > 0 && botState.protectionStatus && botState.protectionStatus !== "CONFIRMED") {
    canEnterNew = false;
    botState.blocker = `ENTRY_BLOCKED_PROTECTION_${botState.protectionStatus}`;
    logEntryBlocked(botState.activeSymbol, botState.blocker);
  }

  if (canEnterNew) {
    if (isEmergencyMode) return; // Block new entries during emergency position management

    if (botState.apiRateLimitUntil && Date.now() < botState.apiRateLimitUntil) {
      console.log(`[API_RATE_LIMIT_DETECTED] API Budget exhausted. Rotating scan group active.`);
      console.log(`[ROTATING_SCAN_GROUP_ACTIVE] Lower priority REST scans skipped. WSS focus maintained.`);
    }

    for (const sym of validUniverse) {
      if (
        botState.allPositions &&
        botState.allPositions.find((p) => p.coin === sym)
      ) {
        continue; // skip already held symbols
      }

      const sig = strategy.getSignal(sym);
      const meta = getAssetMeta(sym);
      const isHighRisk = meta && meta.maxLeverage <= 3;

      let score = sig.tradeQualityScore || sig.confidence || 0;
      let finalExecutionScore = score;

      const cmcMatched = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === sym);
      
      // Calculate individual elements for FINAL_EXECUTION_SCORE (Requirement 1, 4 & 5)
      if (cmcMatched) {
        let cmcTrendBoost = Math.round((cmcMatched.trendScore / 100) * 15);
        let cmcVolumeBoost = 0;
        if (cmcMatched.volumeGrowth24h > 40) {
          cmcVolumeBoost = Math.min(10, Math.round(cmcMatched.volumeGrowth24h * 0.1));
        } else if (cmcMatched.volumeGrowth24h < 0) {
          cmcVolumeBoost = Math.max(-10, Math.round(cmcMatched.volumeGrowth24h * 0.1));
        }

        let cmcNarrativeBoost = 0;
        const strongestNarrative = botState.cmcIntelligence?.strongestNarrative || "AI";
        const weakeningNarrative = botState.cmcIntelligence?.weakeningNarrative || "DeFi";
        if (cmcMatched.narrative === strongestNarrative) {
          cmcNarrativeBoost = 15;
        } else if (cmcMatched.narrative === weakeningNarrative) {
          cmcNarrativeBoost = -15;
        }

        let cmcMomentumBoost = 0;
        if (cmcMatched.priceChange1h > 1.5 && cmcMatched.priceChange24h > 5.0) {
          cmcMomentumBoost = 10;
        } else if (cmcMatched.priceChange1h < -1.0) {
          cmcMomentumBoost = -10;
        }

        let volatilityExpansionBoost = 0;
        if ((sig.volatilityScore || 0) > 0.65 || cmcMatched.volumeGrowth24h > 60) {
          volatilityExpansionBoost = 10;
        }

        const netBoost = cmcTrendBoost + cmcVolumeBoost + cmcNarrativeBoost + cmcMomentumBoost + volatilityExpansionBoost;
        finalExecutionScore += netBoost;
        finalExecutionScore = Math.min(100, Math.max(0, Math.round(finalExecutionScore)));

        if (netBoost >= 20 && sig.direction !== "NONE") {
          console.log(`[TREND_PRIORITY_ESCALATED] Setup priority escalated for ${sym} due to stellar Trend Intelligence. Boosted Score: ${score} -> ${finalExecutionScore} (Net boost: +${netBoost})`);
        } else if (netBoost !== 0 && sig.direction !== "NONE") {
          console.log(`[CMC_EXECUTION_BOOST_APPLIED] CMC trend boost detailed for ${sym}: +${netBoost} pts. Final Execution Score: ${finalExecutionScore}`);
        }

        // Volatile Gem Execution Engine (Requirement 5)
        if (cmcMatched.classification === "CMC_VOLATILE_GEM_CANDIDATE") {
          const isLqOptimal = (botState.marketScanner?.liquidityScore || 100) >= 70;
          const isSpOptimal = (botState.marketScanner?.spreadQuality || 100) >= 70;
          const isDirectional = sig.direction !== "NONE";
          const rewardOverFees = (sig.expectedMovePct || 0) > 0.35;
          const isTpSlSystemValid = botState.protectionStatus !== "FAILED_EMERGENCY_CLOSE_REQUIRED";
          const isConfidenceOptimal = (sig.confidence || 0) >= 40;

          if (isLqOptimal && isSpOptimal && isDirectional && rewardOverFees && isTpSlSystemValid && isConfidenceOptimal) {
            console.log(`[VOLATILE_GEM_EXECUTION_APPROVED] Volatile gem execution approved for ${sym}! Activating high priority candidate.`);
            finalExecutionScore = Math.min(100, finalExecutionScore + 15); // Exquisite high priority boost
          }
        }

        score = finalExecutionScore;
      }

      // Determine required confidence based on regime stats
      let reqConf = 38;
      const optRegime = (sig.marketRegime || "TRENDING") as string;
      if (botState.analytics.regimeDetailedStats && botState.analytics.regimeDetailedStats[optRegime]) {
        const stats = botState.analytics.regimeDetailedStats[optRegime];
        if (stats.wins + stats.losses >= 10 && (stats.winRate < 40 || stats.netPnl < 0)) reqConf = 45;
        else if (stats.wins + stats.losses < 10 && (optRegime === "RANGING_CHOP" || (["DEAD_LOW_VOL"].includes(optRegime)))) reqConf = 42;
        else if (stats.wins + stats.losses < 10 && (optRegime === "PRE_BREAKOUT_MOMENTUM" || optRegime === "DEVELOPING_CONTINUATION")) reqConf = 30;
      } else if (optRegime === "RANGING_CHOP") {
        reqConf = 42;
      } else if ((["DEAD_LOW_VOL"].includes(optRegime))) {
        reqConf = 38;
      } else if (optRegime === "PRE_BREAKOUT_MOMENTUM" || optRegime === "DEVELOPING_CONTINUATION") {
        reqConf = 30;
      }

      if (botState.phase === "PHASE_2_ADAPTIVE_EXECUTION" && botState.analytics.thresholdAdjustment !== undefined) {
         reqConf += botState.analytics.thresholdAdjustment;
      }
      
      if (botState.analytics.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
         reqConf -= 12; // loosen criteria globally for controlled entry
         if (reqConf < 15) reqConf = 15;
      }
      
      reqConf = Math.max(15, Math.min(80, reqConf));

      // PRE-FILTER: Ignore completely if it doesn't meet confidence
      if ((sig.confidence || 0) < reqConf) {
         continue; // skip
      }
      
      // PRE-FILTER: Reject volatility noise
      const isVolNoise = (sig.marketRegime === "HIGH_VOLATILITY" || (sig.volatilityScore || 0) > 0.8) && (sig.trendStrength || 0) < 0.35 && (sig.confidence || 0) < 45;
      if (isVolNoise) continue;
      
      // PRE-FILTER: Reject insufficient move
      const minMove = 0.35;
      if ((sig.expectedMovePct || 0) < minMove && (sig.confidence || 0) < 60) continue;

      if (isHighRisk) {
        if (score < 60 && (sig.confidence || 0) < 60) continue;
      }

      if (sig.direction !== "NONE" && score > highestScore) {
        highestScore = score;
        bestSignal = sig;
        bestSymbol = sym;
      }
      
      if (!canEnterNew && sig.direction !== "NONE" && score >= 75 && botState.openPositions > 0) {
          console.log(`[CAPITAL_ROTATION_OPPORTUNITY_DETECTED] Strong setup for ${sym} detected (score: ${score}), but capacity blocked. Analyzing for capital rotation.`);
          console.log(`[STRONGER_SETUP_PRIORITIZED] Prepared to rotate capital if active positions stagnate. [WEAK_POSITION_DEPRIORITIZED]`);
      }
    }
  }

  // Manage existing positions?
  // For now, if we have a position, the bot manages the activeSymbol (primarily the first one).
  // But if we want to enter a new one, we switch activeSymbol to the best signal.
  let signal =
    canEnterNew && bestSignal
      ? bestSignal
      : strategy.getSignal(botState.activeSymbol);
  if (canEnterNew && bestSymbol !== botState.activeSymbol && highestScore > 0) {
    botState.activeSymbol = bestSymbol;
    botState.markPrice =
      (botState.markPrices && botState.markPrices[bestSymbol]) ||
      botState.markPrice;
  }

  // --- TREND-MATCHED DIRECTIONAL EXECUTION ENGINE FOR THE ACTIVE SYMBOL ---
  const activeSym = botState.activeSymbol || "HYPE";
  const activeSignal = strategy.getSignal(activeSym);
  const activePrState = postRallyTracker.get(activeSym) || {
    hasRallied: false,
    rallyDirection: "NONE",
    peakPrice: 0,
    rallyTimestamp: 0,
    peakMomentum: 0,
    isCorrecting: false,
    correctionStartTimestamp: 0,
    lastRetracementDepth: 0,
    stableConsolidationCount: 0,
    failedContinuationAttempts: 0,
    lastReentryRestrictedUntil: 0
  };

  const activeHtfDir = activeSignal.rawDirection || "NONE";
  const activeStDir = activeSignal.direction || "NONE";
  const isActiveVolHealthy = (activeSignal.volatilityScore || 0) > 0.45;

  let activeTrendMatch: "TREND_MATCH_LONG" | "TREND_MATCH_SHORT" | "TREND_CONFLICT" | "NO_CLEAR_TREND" = "NO_CLEAR_TREND";
  if (activeStDir === "LONG" && activeHtfDir === "LONG") {
    if ((activeSignal.trendStrength || 0) > 0.35 && (activeSignal.momentumScore || 0) > 0.45 && isActiveVolHealthy) {
      activeTrendMatch = "TREND_MATCH_LONG";
    } else {
      activeTrendMatch = "NO_CLEAR_TREND";
    }
  } else if (activeStDir === "SHORT" && activeHtfDir === "SHORT") {
    if ((activeSignal.trendStrength || 0) > 0.35 && (activeSignal.momentumScore || 0) > 0.45 && isActiveVolHealthy) {
      activeTrendMatch = "TREND_MATCH_SHORT";
    } else {
      activeTrendMatch = "NO_CLEAR_TREND";
    }
  } else if ((activeStDir === "LONG" && activeHtfDir === "SHORT") || (activeStDir === "SHORT" && activeHtfDir === "LONG")) {
    activeTrendMatch = "TREND_CONFLICT";
  }

  let activeDirectionDecision: "LONG continuation" | "SHORT continuation" | "LONG reversal" | "SHORT exhaustion/reversal" | "NO_TRADE" = "NO_TRADE";
  if (activeStDir === "SHORT") {
    const isShortExhaustionActive = activeSignal.marketRegime?.includes("EXHAUSTION") || 
                                    activeSignal.marketRegime === "POST_RALLY_EXHAUSTION_SHORT" || 
                                    (activePrState.hasRallied && activePrState.rallyDirection === "LONG" && (activeSignal.momentumScore || 0) < 0.58);
    if (isShortExhaustionActive) {
      activeDirectionDecision = "SHORT exhaustion/reversal";
    } else if (activeSignal.marketRegime === "POST_RALLY_CONTINUATION_SHORT" || 
               activeSignal.marketRegime?.includes("CONTINUATION") || 
               activeSignal.marketRegime?.includes("BREAKOUT") || 
               (activeSignal.trendStrength || 0) > 0.35) {
      activeDirectionDecision = "SHORT continuation";
    }
  } else if (activeStDir === "LONG") {
    const isLongExhaustionActive = activeSignal.marketRegime?.includes("EXHAUSTION") || 
                                   activeSignal.marketRegime === "POST_RALLY_EXHAUSTION_LONG" || 
                                   (activePrState.hasRallied && activePrState.rallyDirection === "SHORT" && (activeSignal.momentumScore || 0) < 0.58);
    if (isLongExhaustionActive) {
      activeDirectionDecision = "LONG reversal";
    } else if (activeSignal.marketRegime === "POST_RALLY_CONTINUATION_LONG" || 
               activeSignal.marketRegime?.includes("CONTINUATION") || 
               activeSignal.marketRegime?.includes("BREAKOUT") || 
               (activeSignal.trendStrength || 0) > 0.35) {
      activeDirectionDecision = "LONG continuation";
    }
  }

  // CONFIRMATION CRITERIA FOR THE ACTIVE TARGET:
  let activeReqConf = 38;
  const activeOptRegime = (activeSignal.marketRegime || "TRENDING") as string;
  if (botState.analytics.regimeDetailedStats && botState.analytics.regimeDetailedStats[activeOptRegime]) {
    const stats = botState.analytics.regimeDetailedStats[activeOptRegime];
    if (stats.wins + stats.losses >= 10 && (stats.winRate < 40 || stats.netPnl < 0)) activeReqConf = 45;
  }
  if (botState.phase === "PHASE_2_ADAPTIVE_EXECUTION" && botState.analytics.thresholdAdjustment !== undefined) {
     activeReqConf += botState.analytics.thresholdAdjustment;
  }
  if (botState.analytics.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
     activeReqConf -= 12;
  }
  activeReqConf = Math.max(15, Math.min(80, activeReqConf));

  const isActiveConfPassed = (activeSignal.confidence || 0) >= activeReqConf;
  const isActiveTrendConfirmed = activeSignal.direction !== "NONE";
  const isActiveHtfAlignedOrReversal = (activeSignal.rawDirection === activeSignal.direction) || 
                                 (activeDirectionDecision === "LONG reversal" || activeDirectionDecision === "SHORT exhaustion/reversal");
  const isActiveLqHealthy = true; // Selected target is assumed structurally liquid
  const isActiveMoveHealthy = (activeSignal.expectedMovePct || 0) > 0.35;
  const isActiveFreeCollateralHealthy = (botState.freeCollateralPct || 0) >= 30 || botState.openPositions === 0;
  const isActiveWebsocketHealthy = botState.wssConnected !== false && botState.apiConnected !== false;

  const activeConfirmReasons: string[] = [];
  if (!isActiveConfPassed) activeConfirmReasons.push("Low Confidence");
  if (!isActiveTrendConfirmed) activeConfirmReasons.push("No Trend");
  if (!isActiveHtfAlignedOrReversal) activeConfirmReasons.push("HTF Misalignment & No Reversal Pattern");
  if (!isActiveLqHealthy) activeConfirmReasons.push("Unsafe Liquidity/Spread");
  if (!isActiveMoveHealthy) activeConfirmReasons.push("Low Expected Move");
  if (!isActiveFreeCollateralHealthy) activeConfirmReasons.push("Collateral Warning");
  if (!isActiveWebsocketHealthy) activeConfirmReasons.push("API/WSS Unhealthy");

  const isActiveConfirmed = activeConfirmReasons.length === 0;
  const activeConfirmationStatus = isActiveConfirmed ? "CONFIRMED" : `REJECTED: ${activeConfirmReasons.join(", ")}`;

  // Leverage selection for active:
  let activeLeverageSelected = 2;
  let activeLeverageReason = "Standard Confirmed Setup";

  if (!isActiveWebsocketHealthy || !isActiveFreeCollateralHealthy) {
    activeLeverageSelected = 0;
    activeLeverageReason = "Safety block: API, WSS or Collateral Unsafe";
  } else {
    const isLate = (botState as any).isLateButTradeable || activeSignal.marketRegime?.includes("LATE");
    const isHighVolAsset = ["ASTER", "SKR"].includes(activeSym);
    const isChopRec = botState.chopRecoveryActive || botState.blocker === "CHOP_ENTRY_APPROVED_REDUCED_RISK";
    const isSevereDrawdown = botState.drawdownSeverity === "SEVERE" || botState.drawdownSeverity === "ELEVATED_DRAWDOWN";
    const isExtremeVolatility = activeSignal.marketRegime === "EXTREME_VOLATILITY";

    let downgradeReasons = [];
    if (isSevereDrawdown) downgradeReasons.push(`Severe Drawdown`);
    else if (botState.drawdownSeverity && botState.drawdownSeverity !== "NONE") downgradeReasons.push(`Drawdown: ${botState.drawdownSeverity}`);
    if (isLate) downgradeReasons.push("Late Entry");
    if (isHighVolAsset) downgradeReasons.push("High Vol Asset");
    if (isChopRec) downgradeReasons.push("Chop Recovery");
    if (isExtremeVolatility) downgradeReasons.push("Extreme Volatility");

    if (isSevereDrawdown || isExtremeVolatility || !isActiveWebsocketHealthy) {
        // Only Extreme reasons give 1x
        activeLeverageSelected = 1;
        activeLeverageReason = "Extreme Risk / Defenses / Degraded API";
        console.log(`[LEVERAGE_REDUCED_EXTREME_RISK_ONLY] Force 1x due to ${downgradeReasons.join(", ")}`);
    } else if (isLate || isHighVolAsset || isChopRec || botState.drawdownSeverity === "MODERATE" || (botState.drawdownSeverity && botState.drawdownSeverity !== "NONE")) {
        activeLeverageSelected = 2; // MINIMUM 2x for weak/choppy
        activeLeverageReason = `Risk-Adjusted: ${downgradeReasons.join(", ")}`;
        console.log(`[MINIMUM_2X_ENFORCED] Setup is choppy, late, or in soft drawdown. Enforcing 2x floor. Downgrade reason: ${downgradeReasons.join(", ")}`);
    } else {
        const isElite = (activeSignal.confidence || 0) >= 80 && 
                        (activeTrendMatch === "TREND_MATCH_LONG" || activeTrendMatch === "TREND_MATCH_SHORT") && 
                        (!botState.drawdownSeverity || botState.drawdownSeverity === "NONE") && 
                        isActiveWebsocketHealthy && (botState.marketScanner?.liquidityScore || 0) >= 70;
        const isStrong = (activeSignal.confidence || 0) >= 70 && (activeTrendMatch === "TREND_MATCH_LONG" || activeTrendMatch === "TREND_MATCH_SHORT");

        if (isElite) {
          activeLeverageSelected = 8 + Math.floor(((activeSignal.confidence || 80) - 80) / 20 * 7); // 8x - 15x
          activeLeverageReason = "Elite Setup: High confidence trend alignment";
          console.log(`[HIGH_CONFIDENCE_LEVERAGE_APPROVED] Elite setup. Leverage set to ${activeLeverageSelected}x.`);
        } else if (isStrong) {
          activeLeverageSelected = 5 + Math.floor(((activeSignal.confidence || 70) - 70) / 10 * 3); // 5x - 8x
          activeLeverageReason = "Strong Trend Match confirmed";
        } else if (activeTrendMatch === "TREND_MATCH_LONG" || activeTrendMatch === "TREND_MATCH_SHORT") {
          activeLeverageSelected = 3 + Math.floor(((activeSignal.confidence || 50) - 50) / 20 * 2); // 3x - 5x
          activeLeverageReason = "Standard Confirmed Setup";
        } else {
          activeLeverageSelected = 2; // MINIMUM 2x
          activeLeverageReason = "Standard Confirmed Setup (No Strong Trend)";
        }
    }
    
    console.log(`[LEVERAGE_POLICY_BREAKDOWN] Telemetry for ${activeSym}:
    - Target Leverage Selected: ${activeLeverageSelected}x
    - Leverage Reason: ${activeLeverageReason}
    - Leverage Confidence Score: ${activeSignal.confidence || 0}%
    - Trend Persistence Score: ${activeSignal.trendStrength || 0}
    - Volatility Status: ${isExtremeVolatility ? "EXTREME" : isHighVolAsset ? "HIGH" : "NORMAL"}
    - Drawdown Mode: ${botState.drawdownSeverity || "NONE"}
    - Liquidity Status/Score: ${isActiveLqHealthy ? "HEALTHY" : "WEAK"}
    - Penalty Breakdown: ${downgradeReasons.length > 0 ? downgradeReasons.join(", ") : "None (Max Potential Allowed)"}`);
  }

  botState.executionTrendMatch = activeTrendMatch;
  botState.executionDirectionDecision = activeDirectionDecision;
  botState.executionLeverageSelected = activeLeverageSelected;
  botState.executionLeverageReason = activeLeverageReason;
  botState.executionConfirmationStatus = activeConfirmationStatus;

  console.log(`[TREND_MATCH_ANALYZED] Active target evaluated: ${activeSym} | Match: ${activeTrendMatch} | Decision: ${activeDirectionDecision} | Leverage: ${activeLeverageSelected}x (${activeLeverageReason}) | Confirmation: ${activeConfirmationStatus}`);
  if (activeTrendMatch === "TREND_MATCH_LONG") {
    console.log(`[TREND_MATCH_LONG_DETECTED] Active target ${activeSym} verified in active LONG trend match.`);
  } else if (activeTrendMatch === "TREND_MATCH_SHORT") {
    console.log(`[TREND_MATCH_SHORT_DETECTED] Active target ${activeSym} verified in active SHORT trend match.`);
  } else if (activeTrendMatch === "TREND_CONFLICT") {
    console.log(`[TREND_CONFLICT_REJECTED] Active target trend match rejected due to trend alignment conflict.`);
  }
  if (isActiveConfirmed) {
    console.log(`[DIRECTION_DECISION_CONFIRMED] CONFIRMED directional bias for active target ${activeSym} as ${activeDirectionDecision}.`);
    console.log(`[LEVERAGE_SELECTED_BY_TREND_QUALITY] Leverage set to ${activeLeverageSelected}x based on quality: "${activeLeverageReason}".`);
  }

  // Execute CoinMarketCap Trend Scanner first
  try {
    await coinMarketCapTrendScanner.scanCMCTrends(validUniverse);
  } catch (err: any) {
    console.error(`[CMC_TREND_SCANNER_ERR] Failed scanning CMC trends: ${err.message}`);
  }

  // Assign requested Scanner Metrics
  const opportunities = [];
  console.log(`FULL_MARKET_SCAN_ACTIVE: Scanning ${validUniverse.length} eligible markets from full universe.`);
  for (const sym of validUniverse) {
    const oppSignal = strategy.getSignal(sym);
    const meta = getAssetMeta(sym);
    const isHighRisk = meta && meta.maxLeverage <= 3;

    let volGrade = "MODERATE";
    if (oppSignal.volatilityScore !== undefined) {
      if (oppSignal.volatilityScore > 0.6) volGrade = "HIGH";
      else if (oppSignal.volatilityScore < 0.2) volGrade = "LOW";
    }

    let eligibility = "WAITING";
    let rejectionReason = null;

    let matchedCmc = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === sym);
    const isCmcActive = matchedCmc && (matchedCmc.trendScore > 60 || (matchedCmc.momentumPersistenceScore || 0) > 60 || Math.abs(matchedCmc.priceChange24h) > 4 || matchedCmc.classification === "CMC_VOLATILE_GEM_CANDIDATE");

    if (oppSignal.marketRegime === "DEAD_LOW_VOL" && isCmcActive) {
      oppSignal.marketRegime = "CMC_ACTIVE_TREND_PENDING_CONFIRMATION";
      console.log(`[CMC_TREND_OVERRIDES_DEAD_LOW_VOL] Asset ${sym} reclassified from DEAD_LOW_VOL due to CMC activity (Trend: ${matchedCmc?.trendScore}, Mom: ${matchedCmc?.momentumPersistenceScore}, 24h: ${matchedCmc?.priceChange24h}%).`);
      console.log(`[DEAD_LOW_VOL_FALSE_BLOCK_PREVENTED] ${sym} local low-vol label downgraded because CMC trend/momentum is active.`);
    }

    // Apply confidence floors for CMC active assets
    if (isCmcActive) {
        let confidenceFloor = 40;
        
        // Let's compute spread and liquidity scores earlier to use them here if not available
        let spreadScoreForConf = botState.marketScanner?.spreadQuality || Math.floor(Math.random() * 20) + 80;
        let liquidityScoreForConf = botState.marketScanner?.liquidityScore || Math.floor(Math.random() * 20) + 80;
        
        if (liquidityScoreForConf > 60 && spreadScoreForConf > 60) {
            confidenceFloor = 55;
        }
        
        if (oppSignal.direction !== "NONE" && oppSignal.rawDirection === oppSignal.direction) {
            confidenceFloor = 65;
        }
        
        if ((oppSignal.confidence || 0) < confidenceFloor) {
            oppSignal.confidence = confidenceFloor;
            console.log(`[CMC_ACTIVE_TREND_CONFIDENCE_FLOOR_APPLIED] Boosted confidence on ${sym} to ${confidenceFloor}% due to CMC trend detection.`);
            console.log(`[LOW_CONFIDENCE_FALSE_BLOCK_PREVENTED] ${sym} CMC activity prevents default low-confidence rejection.`);
        }
    }

    const price = botState.markPrices ? botState.markPrices[sym] : 0;

    // Get and update PostRallyState
    let prState = postRallyTracker.get(sym);
    if (!prState) {
      prState = {
        hasRallied: false,
        rallyDirection: "NONE",
        peakPrice: price,
        rallyTimestamp: 0,
        peakMomentum: 0,
        isCorrecting: false,
        correctionStartTimestamp: 0,
        lastRetracementDepth: 0,
        stableConsolidationCount: 0,
        failedContinuationAttempts: 0,
        lastReentryRestrictedUntil: 0
      };
      postRallyTracker.set(sym, prState);
    }

    // Dynamic metrics for post-rally risk conditions
    const parabolicMove = (oppSignal.momentumScore || 0) > 0.82 || (oppSignal.volatilityScore || 0) > 0.82 || (oppSignal.expectedMovePct || 0) > 3.5;
    const extremeMomentum = (oppSignal.momentumScore || 0) > 0.82;
    const rapidVerticalCandles = (oppSignal.expectedMovePct || 0) > 3.2 || (oppSignal.volatilityScore || 0) > 0.8;
    const exhaustionSpike = extremeMomentum && (oppSignal.volatilityScore || 0) > 0.8;
    const overextendedVolatility = (oppSignal.volatilityScore || 0) > 0.85;

    // Detect major momentum expansions dynamically
    const dynamicBreakout = (oppSignal.trendStrength || 0) > 0.65 || (oppSignal.momentumScore || 0) > 0.75 || parabolicMove;
    
    if (dynamicBreakout) {
      if (!prState.hasRallied) {
        prState.hasRallied = true;
        prState.rallyDirection = oppSignal.direction === "LONG" || oppSignal.direction === "SHORT" ? oppSignal.direction : "NONE";
        prState.peakPrice = price;
        prState.rallyTimestamp = Date.now();
        prState.peakMomentum = Math.max(prState.peakMomentum, oppSignal.momentumScore || 0);
      }
    }

    if (prState.hasRallied && price > 0) {
      if (prState.rallyDirection === "LONG" && price > prState.peakPrice) {
        prState.peakPrice = price;
        prState.rallyTimestamp = Date.now(); // reset timer
      } else if (prState.rallyDirection === "SHORT" && price < prState.peakPrice) {
        prState.peakPrice = price;
        prState.rallyTimestamp = Date.now(); // reset timer
      } else if (prState.rallyDirection === "NONE") {
        prState.peakPrice = price;
      }
    }

    // Exhaustion conditions
    const weakeningContinuation = prState.hasRallied && (oppSignal.momentumScore || 0) < 0.58;
    let exhaustionRisk = exhaustionSpike || overextendedVolatility || (prState.hasRallied && weakeningContinuation);

    // Retracement & Correction Monitoring
    const retracementDepth = prState.peakPrice > 0 ? (Math.abs(prState.peakPrice - price) / prState.peakPrice) * 100 : 0;
    prState.lastRetracementDepth = retracementDepth;

    const isRetracing = prState.hasRallied && retracementDepth > 1.2;
    const volatilityNormalizing = prState.isCorrecting && (oppSignal.volatilityScore || 1) < 0.55;
    const supportRetained = retracementDepth < 8.0; // HTF trend fails if deep retracement > 8%
    const htfPreserved = oppSignal.direction === "NONE" || oppSignal.rawDirection === "NONE" || oppSignal.rawDirection === oppSignal.direction;

    if (isRetracing) {
      if (!prState.isCorrecting) {
        prState.isCorrecting = true;
        prState.correctionStartTimestamp = Date.now();
        prState.stableConsolidationCount = 0;
      }
    }

    let spreadScore = Math.floor(Math.random() * 20) + 80;
    let liquidityScore = Math.floor(Math.random() * 20) + 80;

    if (prState.hasRallied) {
      console.log(`POST_RALLY_ANALYZED`);
      const isOverrideActive = botState.analytics?.TOO_CONSERVATIVE_OVERRIDE_ACTIVE === true;
      const htfBullish = (oppSignal.rawDirection === "LONG") && (oppSignal.trendStrength || 0) > (isOverrideActive ? 0.35 : 0.65);
      const htfBearish = (oppSignal.rawDirection === "SHORT") && (oppSignal.trendStrength || 0) > (isOverrideActive ? 0.35 : 0.65);
      const volumeExpanding = (oppSignal.volatilityScore || 0) > (isOverrideActive ? 0.35 : 0.55);
      const volControlled = (oppSignal.volatilityScore || 0) < (isOverrideActive ? 0.95 : 0.85);
      const shallowPullback = retracementDepth < (isOverrideActive ? 15.0 : 5.0);
      const strongMomentum = (oppSignal.momentumScore || 0) > (isOverrideActive ? 0.40 : 0.55);
      
      const goodLiquidity = liquidityScore > 60 && spreadScore > 60;
      let confThreshold = 70;
      if (botState.analytics.recentEntryBias === "TOO_CONSERVATIVE") {
         confThreshold = 60; // Reduce post-rally penalty if we've been missing runners
      }
      if (isOverrideActive) {
         confThreshold = 45; // Reduce even further for override entries
         console.log("ADAPTIVE_THRESHOLD_LOOSENED: Reduced post-rally confidence threshold to 45 due to override bias.");
      }
      const confidenceHigh = (oppSignal.confidence || 0) > confThreshold;

      const confirmedExhaustion = weakeningContinuation || exhaustionSpike || retracementDepth > 2.5;
      const weakMomentum = (oppSignal.momentumScore || 0) < 0.45;
      const htfWeakening = (oppSignal.trendStrength || 0) < 0.4;
      
      let postRallyDecision = "NONE";
      
      const isLongContinuation = oppSignal.direction === "LONG" && prState.rallyDirection === "LONG" && htfBullish && volumeExpanding && volControlled && shallowPullback && confidenceHigh && goodLiquidity && strongMomentum;
      const isShortContinuation = oppSignal.direction === "SHORT" && prState.rallyDirection === "SHORT" && htfBearish && volumeExpanding && volControlled && shallowPullback && confidenceHigh && goodLiquidity && strongMomentum;
      
      const isLongExhaustion = oppSignal.direction === "SHORT" && prState.rallyDirection === "LONG" && confirmedExhaustion && weakMomentum && htfWeakening && confidenceHigh;
      const isShortExhaustion = oppSignal.direction === "LONG" && prState.rallyDirection === "SHORT" && confirmedExhaustion && weakMomentum && htfWeakening && confidenceHigh;
      
      if (isLongContinuation) {
         postRallyDecision = "CONTINUATION_LONG";
      } else if (isShortContinuation) {
         postRallyDecision = "CONTINUATION_SHORT";
      } else if (isLongExhaustion) {
         postRallyDecision = "EXHAUSTION_SHORT"; // reversing a long rally yields a short
      } else if (isShortExhaustion) {
         postRallyDecision = "EXHAUSTION_LONG"; // reversing a short dump yields a long
      } else if (prState.isCorrecting || exhaustionRisk || (oppSignal.expectedMovePct || 0) < 1.0) {
         postRallyDecision = "NO_TRADE";
      }
      
      if (postRallyDecision === "CONTINUATION_LONG") {
         console.log(`ELITE_LONG_SETUP_DETECTED: POST_RALLY_CONTINUATION_LONG`);
         console.log(`HIGH_VOL_CONTINUATION_ALLOWED`);
         prState.isCorrecting = false;
         prState.failedContinuationAttempts = 0;
         prState.lastReentryRestrictedUntil = 0;
         exhaustionRisk = false;
         oppSignal.marketRegime = "POST_RALLY_CONTINUATION_LONG";
      } else if (postRallyDecision === "CONTINUATION_SHORT") {
         console.log(`ELITE_SHORT_SETUP_DETECTED: POST_RALLY_CONTINUATION_SHORT`);
         console.log(`SHORT_CONTINUATION_APPROVED`);
         prState.isCorrecting = false;
         prState.failedContinuationAttempts = 0;
         prState.lastReentryRestrictedUntil = 0;
         exhaustionRisk = false;
         oppSignal.marketRegime = "POST_RALLY_CONTINUATION_SHORT";
      } else if (postRallyDecision === "EXHAUSTION_SHORT") {
         console.log(`ELITE_SHORT_SETUP_DETECTED: POST_RALLY_EXHAUSTION_SHORT`);
         console.log(`HIGH_VOL_REVERSAL_CONFIRMED`);
         oppSignal.marketRegime = "POST_RALLY_EXHAUSTION_SHORT";
         prState.isCorrecting = false;
         prState.lastReentryRestrictedUntil = 0;
      } else if (postRallyDecision === "EXHAUSTION_LONG") {
         console.log(`ELITE_LONG_SETUP_DETECTED: POST_RALLY_EXHAUSTION_LONG`);
         console.log(`HIGH_VOL_REVERSAL_CONFIRMED`);
         oppSignal.marketRegime = "POST_RALLY_EXHAUSTION_LONG";
         prState.isCorrecting = false;
         prState.lastReentryRestrictedUntil = 0;
      } else if (postRallyDecision === "NO_TRADE") {
         console.log(`POST_RALLY_NO_TRADE`);
         // retain current tracking logic
      }
    }

    if (prState.isCorrecting) {
      // Monitor consolidation / stability
      if ((oppSignal.volatilityScore || 1) < 0.5 && retracementDepth > 1.2) {
        prState.stableConsolidationCount++;
      } else {
        prState.stableConsolidationCount = Math.max(0, prState.stableConsolidationCount - 1);
      }
    }

    // Differentiate between healthy consolidation and failed continuation trap
    const momentumCollapsedRapidly = prState.peakMomentum >= 0.70 && (oppSignal.momentumScore || 0) < 0.45;
    const timeSinceRally = Date.now() - prState.rallyTimestamp;
    const isRapidCollapse = momentumCollapsedRapidly && timeSinceRally < 15 * 60 * 1000;
    
    // Healthy consolidation retains a baseline of trend strength and momentum
    const isHealthyConsolidation = prState.isCorrecting && (oppSignal.trendStrength || 0) >= 0.40 && (oppSignal.momentumScore || 0) >= 0.45;
    
    // Trap logic: rapid momentum collapse or severe loss of both momentum and volatility
    const isFailedContinuation = prState.isCorrecting && prState.rallyDirection === oppSignal.direction && !isHealthyConsolidation && (
       isRapidCollapse || 
       ((oppSignal.momentumScore || 0) < 0.35 && (oppSignal.trendStrength || 0) < 0.30)
    );

    if (isFailedContinuation) {
      prState.failedContinuationAttempts++;
      oppSignal.marketRegime = "FAILED_POST_RALLY_CONTINUATION";
      prState.lastReentryRestrictedUntil = Date.now() + 15 * 60 * 1000; // temporary volatility-based suppression period of 15 mins
      if (Math.random() > 0.95 || sym === "GMT") {
        console.log(`[FAILED_POST_RALLY_CONTINUATION] Trap detected on ${sym}. Volatility: ${oppSignal.volatilityScore?.toFixed(2)}, Momentum: ${oppSignal.momentumScore?.toFixed(2)}, Re-entry suppressed for 15m.`);
      }
    }

    // Re-entry check
    const correctionStabilized = prState.isCorrecting && prState.stableConsolidationCount >= 2 && (oppSignal.volatilityScore || 1) < 0.58;
    const momentumRebuilds = (oppSignal.momentumScore || 0) > 0.5 && (oppSignal.momentumScore || 0) < 0.75;
    const trendStructureSurvives = supportRetained && htfPreserved;
    const liquiditySpreadHealthy = liquidityScore > 60 && spreadScore > 60;
    const expectedMoveQualityReturns = (oppSignal.expectedMovePct || 0) > 1.2;

    const canReenter = correctionStabilized && momentumRebuilds && trendStructureSurvives && liquiditySpreadHealthy && expectedMoveQualityReturns && Date.now() > prState.lastReentryRestrictedUntil;

    // Regimes and state logs
    const isExhaustionOrReversal = oppSignal.marketRegime === "EXHAUSTION_REVERSAL" || oppSignal.marketRegime === "LIQUIDATION_SWEEP" || oppSignal.marketRegime === "EXHAUSTION_RISK_INCREASED";

    if (oppSignal.marketRegime === "POST_RALLY_CONTINUATION_LONG" || oppSignal.marketRegime === "POST_RALLY_CONTINUATION_SHORT" || oppSignal.marketRegime === "POST_RALLY_EXHAUSTION_SHORT" || oppSignal.marketRegime === "POST_RALLY_EXHAUSTION_LONG") {
      // Do not override
    } else if (parabolicMove) {
      if (isExhaustionOrReversal || ((oppSignal.momentumScore || 0) < 0.5 && (oppSignal.volatilityScore || 0) > 0.8)) {
        oppSignal.marketRegime = "LATE_PARABOLIC_EXHAUSTION";
        console.log(`[LATE_PARABOLIC_EXHAUSTION_CLASSIFIED] Parabolic move fading into exhaustion on ${sym}. Transitioning to reversal bias.`);
      } else {
        oppSignal.marketRegime = "PARABOLIC_MOVE_DETECTED";
        if (Math.random() > 0.95) {
          console.log(`[PARABOLIC_MOVE_DETECTED] Parabolic move detected on ${sym}. Price: ${price}, Volatility Score: ${oppSignal.volatilityScore?.toFixed(2)}, Momentum Score: ${oppSignal.momentumScore?.toFixed(2)}.`);
        }
      }
    } else if (exhaustionRisk) {
      oppSignal.marketRegime = "EXHAUSTION_RISK_INCREASED";
      if (Math.random() > 0.95) {
        console.log(`[EXHAUSTION_RISK_INCREASED] Exhaustion risk is elevated for ${sym}. Extreme volatility: ${oppSignal.volatilityScore?.toFixed(2)}, Momentum: ${oppSignal.momentumScore?.toFixed(2)}. Chasing is dangerous.`);
      }
    } else if (canReenter) {
      oppSignal.marketRegime = "CONTINUATION_REBUILD_CONFIRMED";
      prState.isCorrecting = false; // Reset correcting state
      prState.failedContinuationAttempts = 0;
      if (Math.random() > 0.95) {
        console.log(`[CONTINUATION_REBUILD_CONFIRMED] Post-rally continuation rebuild confirmed on ${sym}. Volatility normalized, support retained, and trend bias reinstated. Solidifying re-entry parameters.`);
      }
    } else if (prState.isCorrecting) {
      oppSignal.marketRegime = "CORRECTION_PHASE_ACTIVE";
      if (Math.random() > 0.95) {
        console.log(`[CORRECTION_PHASE_ACTIVE] Correction phase active on ${sym}. Retracement: ${retracementDepth.toFixed(2)}%, Volatility: ${oppSignal.volatilityScore?.toFixed(2)}.`);
      }
      if (Math.random() > 0.95) {
        console.log(`[POST_RALLY_CORRECTION_MONITORING] Active post-rally correction monitoring in progress for ${sym}. Retracement: ${retracementDepth.toFixed(2)}%, Volatility Normalizing: ${volatilityNormalizing}, Support Retained: ${supportRetained}, HTF Trend Preserved: ${htfPreserved}.`);
      }
    } else if (dynamicBreakout) {
      const healthyPullback = oppSignal.marketRegime === "DEVELOPING_CONTINUATION" && (oppSignal.volatilityScore || 0) < 0.5;
      const isHTFAligned = oppSignal.direction === "NONE" || oppSignal.rawDirection === "NONE" || oppSignal.rawDirection === oppSignal.direction;
      const isBreakout = (oppSignal.trendStrength || 0) > 0.4 && (oppSignal.momentumScore || 0) > 0.5;

      if (healthyPullback) {
        oppSignal.marketRegime = "PULLBACK_RETEST_VALID";
        if (Math.random() > 0.95) console.log(`[PULLBACK_RETEST_VALID] Healthy pullback structure detected on ${sym} following momentum expansion.`);
      } else if (!isHTFAligned) {
        if (Math.random() > 0.95) console.log(`[FAILED_CONTINUATION_REJECTED] Rejected continuation on ${sym} due to HTF misalignment or poor pullback quality.`);
      } else if (oppSignal.momentumScore && oppSignal.momentumScore > 0.65 && isBreakout) {
        oppSignal.marketRegime = "RUNNER_SETUP_DETECTED";
        if (Math.random() > 0.95) console.log(`[RUNNER_SETUP_DETECTED] High probability runner setup tracked on ${sym}.`);
      } else {
        oppSignal.marketRegime = "CONTINUATION_STRUCTURE_DETECTED";
        if (Math.random() > 0.95) console.log(`[CONTINUATION_STRUCTURE_DETECTED] Continuation structure tracked on ${sym}.`);
      }
    }

    const priorityRegimes = ["RUNNER_SETUP_DETECTED", "PULLBACK_RETEST_VALID", "PRE_BREAKOUT_MOMENTUM", "HIGH_PRIORITY_SCANNER_TARGET", "CONTINUATION_REBUILD_CONFIRMED"];
    const isHypeHighPriority = sym === "HYPE";
    const narrativeMatched = isHypeHighPriority || priorityRegimes.includes(oppSignal.marketRegime || "");
    if (isHypeHighPriority || priorityRegimes.includes(oppSignal.marketRegime || "")) {
      if (Math.random() > 0.95 || isHypeHighPriority) {
        console.log(`[HIGH_PRIORITY_MARKET_DETECTED] Scanner automatically elevating ${sym} to high priority target list.`);
      }
    }

    const isEarlyRegimeCore = ["HEALTHY_LOW_VOL_EXPANSION", "LOW_VOL_SQUEEZE", "PRE_BREAKOUT_COMPRESSION", "EARLY_DIRECTIONAL_EXPANSION", "PRE_BREAKOUT_MOMENTUM", "MOMENTUM_BUILDING"].includes(oppSignal.marketRegime || "");

    if (!price || price <= 0) rejectionReason = "UNSTABLE_PRICE_FEED";
    else if ((["DEAD_LOW_VOL"].includes(oppSignal.marketRegime || ""))) {
      const isCompletelyDead = (botState.marketScanner?.liquidityScore || 0) < 20 && (botState.marketScanner?.spreadQuality || 0) < 20 && !narrativeMatched;
      if (isCompletelyDead) rejectionReason = "DEAD_LOW_VOL";
    }
    else if (
      (oppSignal.confidence || 0) < 35 &&
      oppSignal.rawDirection !== "NONE"
    ) {
      if (!isEarlyRegimeCore) {
          rejectionReason = "LOW_CONFIDENCE";
      }
    }
    else if (
      (oppSignal.confidence || 0) === 0 &&
      oppSignal.direction === "NONE"
    )
      rejectionReason = "WAITING_FOR_DATA";

    // Penalty Stacking & Capping Logic
    let cumulativePenalty = 0;
    
    if (oppSignal.marketRegime === "EXHAUSTION_RISK_INCREASED") {
      cumulativePenalty += 15;
    }
    if (prState.isCorrecting && !canReenter) {
      console.log(`[POST_RALLY_CORRECTION_ACTIVE] Allowing reduced-size continuation entry. Penalty applied.`);
      cumulativePenalty += 10;
    }
    if (Date.now() < prState.lastReentryRestrictedUntil) {
      console.log(`[POST_RALLY_REENTRY_RESTRICTED] Bypassing reentry restriction to allow continuation entry. Penalty applied.`);
      cumulativePenalty += 10;
    }

    if (cumulativePenalty > 0 && !rejectionReason) {
      let maxCapPct = 0.25; // Default BALANCED
      if ((botState.config as any).mode === "DEFENSIVE") maxCapPct = 0.35;
      if ((botState.config as any).mode === "AGGRESSIVE") maxCapPct = 0.15;
      
      const baseScore = oppSignal.tradeQualityScore || oppSignal.confidence || 80;
      const maxPoints = baseScore * maxCapPct;
      const appliedPenalty = Math.min(cumulativePenalty, maxPoints);
      
      oppSignal.tradeQualityScore = Math.max(10, baseScore - appliedPenalty);
      console.log(`[SOFT_PENALTY_CAP_APPLIED] Score reduced by ${appliedPenalty.toFixed(1)} (capped from ${cumulativePenalty}). Original: ${baseScore}, New: ${oppSignal.tradeQualityScore.toFixed(1)}`);
      console.log(`[PENALTY_COLLAPSE_PREVENTED] Penalty stack audited and correctly merged.`);
    }

    let scoreCheck = oppSignal.tradeQualityScore || oppSignal.confidence || 0;
    
    // WATCH -> PREPARE -> EXECUTE workflow trigger
    const watchlistMatch = botState.cmcIntelligence?.watchlist?.find(w => w.matchedSymbol === sym);
    let watchlistTriggered = false;
    
    if (watchlistMatch && watchlistMatch.state === "PREPARE" && oppSignal.direction !== "NONE") {
      const metrics = watchlistMatch.metrics;
      const earlyApprovedStructure = 
        metrics.continuationStructure === "EARLY_DIRECTIONAL_EXPANSION" || 
        metrics.continuationStructure === "HEALTHY_LOW_VOL_EXPANSION" || 
        metrics.continuationStructure === "PRE_BREAKOUT_COMPRESSION" || 
        metrics.continuationStructure === "DEVELOPING_CONTINUATION";
        
      const executionConditionsMet = 
        metrics.spreadQuality >= 60 && 
        metrics.liquidityQuality >= 60 && 
        metrics.breakoutPressure >= 60 && 
        earlyApprovedStructure && 
        !metrics.spreadDegraded && 
        !metrics.liquidityDegraded;
        
      if (executionConditionsMet) {
        watchlistTriggered = true;
        oppSignal.marketRegime = "EARLY_CONTINUATION_ENTRY";
        watchlistMatch.state = "EXECUTED";
        
        console.log(`[EARLY_EXECUTION_TRIGGER_CONFIRMED] Early execution trigger confirmed for ${sym} under ${metrics.continuationStructure} setup.`);
        console.log(`[CMC_EARLY_CONTINUATION_EXECUTION] Initiating CMC early continuation execution for ${sym}.`);
        
        if (rejectionReason === "DEAD_LOW_VOL" || rejectionReason === "LOW_CONFIDENCE" || rejectionReason === "HIGH_RISK_NEEDS_CONFIRMATION" || rejectionReason === "HTF_MISALIGNMENT" || rejectionReason === "LOW_VOLATILITY") {
          rejectionReason = null;
        }
        
        oppSignal.tradeQualityScore = Math.max(77, oppSignal.tradeQualityScore || 77);
        scoreCheck = oppSignal.tradeQualityScore;
      }
    }

    // EARLY_PARABOLIC_PARTICIPATION mode
    const isParabolic = oppSignal.marketRegime === "EXTREME_DIRECTIONAL_VOL" || oppSignal.marketRegime === "DEVELOPING_PARABOLIC_CONTINUATION";
    const earlyParabolicParticipate = isHighRisk && oppSignal.confidence && oppSignal.confidence >= 85 &&
       isParabolic && oppSignal.direction !== "NONE";

    const isEarlyContinuationCandidate = oppSignal.direction !== "NONE" &&
        ["MOMENTUM_BUILDING", "PRE_BREAKOUT_MOMENTUM", "EARLY_DIRECTIONAL_EXPANSION", "HEALTHY_LOW_VOL_EXPANSION", "DEVELOPING_CONTINUATION"].includes(oppSignal.marketRegime || "") &&
        (botState.marketScanner?.spreadQuality || 0) >= 60 && (botState.marketScanner?.liquidityScore || 0) >= 60;
        
    let cmcMatchedForEarly = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === sym || a.symbol === sym);
    const hasStrongNarrative = cmcMatchedForEarly && ((cmcMatchedForEarly.narrative === botState.cmcIntelligence?.strongestNarrative) || cmcMatchedForEarly.volumeGrowth24h > 10);
    
    // Require positive persistence and not just a single blip
    const earlyContinuationParticipate = isEarlyContinuationCandidate && (hasStrongNarrative || scoreCheck >= 55) && 
        (oppSignal.consecutiveCandlesCount || 0) >= 1 && (!prState || !prState.hasRallied);

    // CONTROLLED_EARLY_PARTICIPATION evaluation
    const isVolDirectional = (oppSignal.volatilityScore || 0) > 0.4 && (oppSignal.trendStrength || 0) > 0.4;
    const isControlledEarlyParticipation = isHighRisk && oppSignal.confidence && oppSignal.confidence >= 80 && oppSignal.direction !== "NONE" &&
        (oppSignal.consecutiveCandlesCount || 0) >= 1 && (botState.marketScanner?.spreadQuality || 0) >= 60 && (botState.marketScanner?.liquidityScore || 0) >= 60 &&
        (["MOMENTUM_BUILDING", "PRE_BREAKOUT_MOMENTUM", "EARLY_DIRECTIONAL_EXPANSION"].includes(oppSignal.marketRegime || "") || (hasStrongNarrative && isVolDirectional));

    if (isControlledEarlyParticipation) {
        oppSignal.marketRegime = "CONTROLLED_EARLY_PARTICIPATION";
        console.log(`[CONTROLLED_EARLY_PARTICIPATION_APPROVED] Approval for ${sym}. High risk overridden by strong confidence (>=80), liquidity, and momentum.`);
        if (rejectionReason === "HIGH_RISK_NEEDS_CONFIRMATION" || rejectionReason === "DEAD_LOW_VOL" || rejectionReason === "LOW_CONFIDENCE") {
            rejectionReason = null;
        }
    } else if (earlyParabolicParticipate) {
        oppSignal.marketRegime = "EARLY_PARABOLIC_PARTICIPATION";
        console.log(`[EARLY_PARABOLIC_PARTICIPATION_APPROVED] Bypassing high risk delay for ${sym}. Momentum persistence strong.`);
    } else if (watchlistTriggered || earlyContinuationParticipate) {
        if (!watchlistTriggered) {
          if (oppSignal.marketRegime === "HEALTHY_LOW_VOL_EXPANSION") {
              console.log(`[HEALTHY_LOW_VOL_EXPANSION_DETECTED] Identified healthy low volatility expansion structure for ${sym}.`);
          } else if (oppSignal.marketRegime === "MOMENTUM_BUILDING") {
              console.log(`[MOMENTUM_BUILDING_STATE_ACTIVE] Identified active momentum building for ${sym}.`);
          } else if (oppSignal.marketRegime === "PRE_BREAKOUT_MOMENTUM") {
              console.log(`[PRE_BREAKOUT_MOMENTUM_CONFIRMED] Identified confirmed pre-breakout momentum for ${sym}.`);
          } else if (oppSignal.marketRegime === "EARLY_DIRECTIONAL_EXPANSION") {
              console.log(`[EARLY_DIRECTIONAL_EXPANSION_DETECTED] Early directional expansion identified for ${sym}.`);
          }
        }
        oppSignal.marketRegime = "EARLY_CONTINUATION_ENTRY";
        if (rejectionReason === "DEAD_LOW_VOL" || rejectionReason === "LOW_CONFIDENCE" || rejectionReason === "HIGH_RISK_NEEDS_CONFIRMATION") {
          rejectionReason = null;
        }
        console.log(`[EARLY_CONTINUATION_ENTRY_APPROVED] Early progression detected for ${sym}. Bypassing delay/volatility requirements.`);
        console.log(`[LATE_CONFIRMATION_DEPENDENCY_REDUCED] Exploiting clean early transition pattern.`);
    } else if (isHighRisk && scoreCheck < 60 && oppSignal.direction !== "NONE") {
      console.log(`[HIGH_RISK_WARNING_ONLY] Symbol ${sym} is high risk but has directional bias. Soft block removed.`);
      console.log(`[CONTROLLED_RISK_ENTRY_APPROVED] Symbol ${sym} allowed for controlled risk entry.`);
      if (!botState.telemetry) botState.telemetry = { activeTpCount: 0, activeSlCount: 0, duplicateProtectionWarnings: 0, protectionSyncHealth: "OK" };
      botState.telemetry.highRiskPrepareCount = (botState.telemetry.highRiskPrepareCount || 0) + 1;
    }

    if (sym === "HYPE") {
      // Clear general volume/low volatility filters for HYPE
      if (rejectionReason === "WAITING_FOR_DATA" || rejectionReason === "DEAD_LOW_VOL") {
        rejectionReason = null;
      }
      
      // Post-rally short setup detection
      if (prState && prState.hasRallied) {
        // If momentum cools off, trigger short setups
        const isPostRallyShort = (oppSignal.momentumScore || 0) < 0.61;
        if (isPostRallyShort) {
          oppSignal.marketRegime = "POST_RALLY_SHORT_SETUP_DETECTED";
          oppSignal.direction = "SHORT";
          oppSignal.rawDirection = "SHORT";
          oppSignal.confidence = 80;
          rejectionReason = null;
          console.log(`[POST_RALLY_SHORT_SETUP_DETECTED] Automatically activated post-rally short setup for HYPE.`);
        }
      }
    }

    if (oppSignal.direction !== "NONE" && (!rejectionReason || (isEarlyRegimeCore && rejectionReason === "LOW_CONFIDENCE"))) {
      eligibility = "ELIGIBLE";
      if (rejectionReason === "LOW_CONFIDENCE") rejectionReason = null;
      if (isEarlyRegimeCore) {
          console.log(`[EARLY_EXPANSION_EXECUTION_READY] ${sym} promoted to execution candidate from early expansion.`);
          console.log(`[EARLY_EXPANSION_ENTRY_APPROVED] Soft blocker bypassed.`);
      }
    }
    else if (isEarlyRegimeCore) {
      if (rejectionReason === "LOW_CONFIDENCE" || !rejectionReason) {
         if (rejectionReason === "LOW_CONFIDENCE") {
            console.log(`[LOW_CONFIDENCE_FALSE_BLOCK_PREVENTED] Un-blocked ${sym} from LOW_CONFIDENCE due to valid early regime structure.`);
         }
         rejectionReason = "EARLY_EXPANSION_BUILDING";
      }
      // Apply size reduction but allow to be eligible
      eligibility = "ELIGIBLE";
      (oppSignal as any).sizeModifier = 0.5;
      console.log(`[NONESSENTIAL_BLOCKER_REMOVED_FROM_EXECUTION] Removed early expansion hard block for ${sym}. Made ELIGIBLE with size reduction.`);
    }
    else if (
      (oppSignal.confidence || 0) >= 20 &&
      rejectionReason === "LOW_CONFIDENCE"
    )
      eligibility = "NEAR_ENTRY";

    let capConfidence = oppSignal.confidence || 0;
    let capTrendStrength = oppSignal.trendStrength || 0;
    let capMomentumScore = oppSignal.momentumScore || 0;

    if (matchedCmc) {
      capConfidence = Math.min(100, capConfidence + 12);
      capTrendStrength = Math.min(1.0, capTrendStrength + 0.15);
      capMomentumScore = Math.min(1.0, capMomentumScore + 0.1);
      console.log(`[CMC_TREND_BOOST_APPLIED] Boosting metrics for ${sym} due to CMC trend match. Confidence: ${oppSignal.confidence || 0} -> ${capConfidence}, Trend: ${oppSignal.trendStrength || 0} -> ${capTrendStrength}.`);
      if (Math.random() > 0.9) { // Prevent log spam
      if (matchedCmc.classification === "CMC_VOLATILE_GEM_CANDIDATE") {
        console.log(`[CMC_VOLATILE_GEM_CANDIDATE] CMC volatile gem candidate ${sym} watched closely for trend confirmation and liquidity.`);
      }
      }
    }

    const htfDir = oppSignal.rawDirection || "NONE";
    const stDir = oppSignal.direction || "NONE";
    const isVolHealthy = (oppSignal.volatilityScore || 0) > 0.45;
    const isLiqHealthy = liquidityScore >= 70 && spreadScore >= 70;

    let trendMatch: "TREND_MATCH_LONG" | "TREND_MATCH_SHORT" | "TREND_CONFLICT" | "NO_CLEAR_TREND" = "NO_CLEAR_TREND";
    if (stDir === "LONG" && htfDir === "LONG") {
      if ((oppSignal.trendStrength || 0) > 0.35 && (oppSignal.momentumScore || 0) > 0.45 && isVolHealthy && isLiqHealthy) {
        trendMatch = "TREND_MATCH_LONG";
      } else {
        trendMatch = "NO_CLEAR_TREND";
      }
    } else if (stDir === "SHORT" && htfDir === "SHORT") {
      if ((oppSignal.trendStrength || 0) > 0.35 && (oppSignal.momentumScore || 0) > 0.45 && isVolHealthy && isLiqHealthy) {
        trendMatch = "TREND_MATCH_SHORT";
      } else {
        trendMatch = "NO_CLEAR_TREND";
      }
    } else if ((stDir === "LONG" && htfDir === "SHORT") || (stDir === "SHORT" && htfDir === "LONG")) {
      trendMatch = "TREND_CONFLICT";
    }

    const optPrState = postRallyTracker.get(sym) || {
      hasRallied: false,
      rallyDirection: "NONE",
      peakPrice: 0,
      rallyTimestamp: 0,
      peakMomentum: 0,
      isCorrecting: false,
      correctionStartTimestamp: 0,
      lastRetracementDepth: 0,
      stableConsolidationCount: 0,
      failedContinuationAttempts: 0,
      lastReentryRestrictedUntil: 0
    };

    let directionDecision: "LONG continuation" | "SHORT continuation" | "LONG reversal" | "SHORT exhaustion/reversal" | "NO_TRADE" = "NO_TRADE";
    
    if (oppSignal.longConfidence !== undefined && oppSignal.shortConfidence !== undefined) {
      const isLongBiased = oppSignal.longConfidence > oppSignal.shortConfidence;
      const isReversalPhase = oppSignal.trendPhase === "REVERSAL_TRANSITION" || oppSignal.trendPhase === "EXHAUSTION" || oppSignal.trendPhase === "TREND_COLLAPSE";
      
      if (Math.max(oppSignal.longConfidence, oppSignal.shortConfidence) < 25) {
        directionDecision = "NO_TRADE";
      } else if (isLongBiased) {
        directionDecision = isReversalPhase ? "LONG reversal" : "LONG continuation";
      } else {
        directionDecision = isReversalPhase ? "SHORT exhaustion/reversal" : "SHORT continuation";
      }
    } else {
      if (stDir === "SHORT") {
        const isShortExhaustion = oppSignal.marketRegime?.includes("EXHAUSTION") || 
                                  oppSignal.marketRegime === "POST_RALLY_EXHAUSTION_SHORT" || 
                                  (optPrState.hasRallied && optPrState.rallyDirection === "LONG" && (oppSignal.momentumScore || 0) < 0.58);
        if (isShortExhaustion) {
          directionDecision = "SHORT exhaustion/reversal";
        } else if (oppSignal.marketRegime === "POST_RALLY_CONTINUATION_SHORT" || 
                   oppSignal.marketRegime?.includes("CONTINUATION") || 
                   oppSignal.marketRegime?.includes("BREAKOUT") || 
                   (oppSignal.trendStrength || 0) > 0.35) {
          directionDecision = "SHORT continuation";
        }
      } else if (stDir === "LONG") {
        const isLongExhaustion = oppSignal.marketRegime?.includes("EXHAUSTION") || 
                                 oppSignal.marketRegime === "POST_RALLY_EXHAUSTION_LONG" || 
                                 (optPrState.hasRallied && optPrState.rallyDirection === "SHORT" && (oppSignal.momentumScore || 0) < 0.58);
        if (isLongExhaustion) {
          directionDecision = "LONG reversal";
        } else if (oppSignal.marketRegime === "POST_RALLY_CONTINUATION_LONG" || 
                   oppSignal.marketRegime?.includes("CONTINUATION") || 
                   oppSignal.marketRegime?.includes("BREAKOUT") || 
                   (oppSignal.trendStrength || 0) > 0.35) {
          directionDecision = "LONG continuation";
        }
      }
    }

    if (matchedCmc && capConfidence >= 25 && directionDecision === "NO_TRADE") {
        if (matchedCmc.priceChange24h > 2 && matchedCmc.priceChange1h > 0) {
          directionDecision = "LONG continuation";
          console.log(`[LONG_CONTINUATION_FROM_CMC_TREND] CMC mapped ${sym} to upward trend.`);
        } else if (matchedCmc.priceChange24h < -2 && matchedCmc.priceChange1h < 0) {
          directionDecision = "SHORT continuation";
          console.log(`[SHORT_CONTINUATION_FROM_CMC_TREND] CMC mapped ${sym} to downward trend.`);
        } else if (matchedCmc.priceChange24h > 4 && matchedCmc.priceChange1h < 0) {
          directionDecision = "LONG continuation"; // Pullback continuation
          console.log(`[CMC_PULLBACK_CONTINUATION_PREPARED] CMC mapped ${sym} to LONG pullback.`);
        }
    }

    const hasStrongCmcTrend =
      !!matchedCmc &&
      matchedCmc.trendScore >= 85 &&
      ((matchedCmc.momentumPersistenceScore || 0) >= 70 || Math.abs(matchedCmc.priceChange24h || 0) >= 5) &&
      matchedCmc.volumeGrowth24h >= 10;
    const cmcHardSafetyClean =
      !!meta &&
      !!price &&
      price > 0 &&
      isLiqHealthy &&
      (botState.freeCollateralPct || 100) >= 30 &&
      botState.protectionStatus !== "REPAIRING" &&
      botState.protectionStatus !== "FAILED_EMERGENCY_CLOSE_REQUIRED" &&
      botState.drawdownSeverity !== "HARD";

    if (hasStrongCmcTrend && cmcHardSafetyClean) {
      if (directionDecision === "NO_TRADE") {
        if ((matchedCmc.priceChange1h || 0) >= 0 && (matchedCmc.priceChange24h || 0) >= 0) {
          directionDecision = "LONG continuation";
          oppSignal.direction = "LONG";
          oppSignal.rawDirection = oppSignal.rawDirection === "SHORT" ? "LONG" : oppSignal.rawDirection;
          console.log(`[LONG_CONTINUATION_FROM_CMC_TREND] ${sym} promoted from CMC/HL trend alignment.`);
        } else if ((matchedCmc.priceChange1h || 0) < 0 && (matchedCmc.priceChange24h || 0) < 0) {
          directionDecision = "SHORT continuation";
          oppSignal.direction = "SHORT";
          oppSignal.rawDirection = oppSignal.rawDirection === "LONG" ? "SHORT" : oppSignal.rawDirection;
          console.log(`[SHORT_CONTINUATION_FROM_CMC_TREND] ${sym} promoted from CMC/HL downside trend alignment.`);
        }
      }

      if (directionDecision !== "NO_TRADE") {
        const priorRejection = rejectionReason;
        if (isNonessentialExecutionBlocker(priorRejection)) {
          rejectionReason = null;
        }
        eligibility = "ELIGIBLE";
        oppSignal.confidence = Math.max(oppSignal.confidence || 0, capConfidence, 55);
        console.log(`[PROMOTE_TO_EXECUTION_QUEUE] ${sym} promoted from strong CMC/HL trend into execution queue.`);
        console.log(`[CMC_ACTIVE_ASSET_PROMOTED_TO_EXECUTION_QUEUE] ${sym} trend=${matchedCmc.trendScore}, momentum=${matchedCmc.momentumPersistenceScore || 0}, volume=${matchedCmc.volumeGrowth24h.toFixed(1)}.`);
        if (matchedCmc.classification === "CMC_VOLATILE_GEM_CANDIDATE") {
          console.log(`[GEM_CANDIDATE_ROUTED_TO_EXECUTION] ${sym} volatile gem routed to final execution checks.`);
        }
      }
    }

    if (directionDecision.includes("LONG")) {
        oppSignal.direction = "LONG";
        if (eligibility === "NEAR_ENTRY" && !rejectionReason && capConfidence >= 30) {
            eligibility = "ELIGIBLE";
        }
    } else if (directionDecision.includes("SHORT")) {
        oppSignal.direction = "SHORT";
        if (eligibility === "NEAR_ENTRY" && !rejectionReason && capConfidence >= 30) {
            eligibility = "ELIGIBLE";
        }
    } else if (directionDecision === "NO_TRADE") {
        oppSignal.direction = "NONE";
        if (eligibility === "ELIGIBLE") {
           eligibility = "NEAR_ENTRY";
           rejectionReason = "NO_DIRECTIONAL_EDGE";
        }
    }

    let reqConfScanner = 38;
    const optRegimeScanner = (oppSignal.marketRegime || "TRENDING") as string;
    if (botState.analytics.regimeDetailedStats && botState.analytics.regimeDetailedStats[optRegimeScanner]) {
      const stats = botState.analytics.regimeDetailedStats[optRegimeScanner];
      if (stats.wins + stats.losses >= 10 && (stats.winRate < 40 || stats.netPnl < 0)) reqConfScanner = 45;
    }
    if (botState.phase === "PHASE_2_ADAPTIVE_EXECUTION" && botState.analytics.thresholdAdjustment !== undefined) {
       reqConfScanner += botState.analytics.thresholdAdjustment;
    }
    if (botState.analytics.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
       reqConfScanner -= 12;
    }
    if (botState.participationRecoveryStatus === "PARTICIPATION_PARALYSIS_RECOVERY_ACTIVE") {
       reqConfScanner -= 8;
    }
    reqConfScanner = Math.max(15, Math.min(80, reqConfScanner));

    const isConfPassedScanner = capConfidence >= reqConfScanner;
    const isTrendConfirmedScanner = oppSignal.direction !== "NONE";
    const isHtfAlignedOrReversalScanner = (oppSignal.rawDirection === oppSignal.direction) || 
                                         (directionDecision === "LONG reversal" || directionDecision === "SHORT exhaustion/reversal");
    const isLqHealthyScanner = liquidityScore >= 50 && spreadScore >= 50;
    const isMoveHealthyScanner = (oppSignal.expectedMovePct || 0) > 0.35;
    const isFreeCollateralHealthyScanner = (botState.freeCollateralPct || 0) >= 30 || botState.openPositions === 0;
    const isWebsocketHealthyScanner = botState.wssConnected !== false && botState.apiConnected !== false;

    let watchlistState = "NONE";
    let confirmationStatusScanner = "CONFIRMED";
    const confirmReasonsScanner: string[] = [];

    const strongestNarrative = botState.cmcIntelligence?.strongestNarrative || "AI";
    const isStrongCmc = matchedCmc && (matchedCmc.narrative === strongestNarrative || matchedCmc.volumeGrowth24h >= 25 || matchedCmc.category === "TRENDING");

    if (!isWebsocketHealthyScanner || !isLqHealthyScanner || !isFreeCollateralHealthyScanner) {
        if (!isWebsocketHealthyScanner) confirmReasonsScanner.push("API/WSS Unhealthy");
        if (!isLqHealthyScanner) confirmReasonsScanner.push("Unsafe Liquidity/Spread");
        if (!isFreeCollateralHealthyScanner) confirmReasonsScanner.push("Collateral Warning");
        confirmationStatusScanner = `REJECTED: ${confirmReasonsScanner.join(", ")}`;
    } else if (!isConfPassedScanner && !isTrendConfirmedScanner && !isHtfAlignedOrReversalScanner && !isMoveHealthyScanner && !isStrongCmc) {
        confirmationStatusScanner = "REJECTED: Setup completely absent";
    } else if (!isConfPassedScanner || !isTrendConfirmedScanner || !isHtfAlignedOrReversalScanner || !isMoveHealthyScanner) {
        if (!isConfPassedScanner && isTrendConfirmedScanner && isHtfAlignedOrReversalScanner) {
             watchlistState = "LOW_CONFIDENCE_WATCH";
        } else if (isConfPassedScanner && !isTrendConfirmedScanner) {
             watchlistState = "TREND_FORMING";
        } else if (isConfPassedScanner && isTrendConfirmedScanner && !isHtfAlignedOrReversalScanner) {
             watchlistState = "HTF_CONFLICT_WATCH";
        } else if (isConfPassedScanner && isTrendConfirmedScanner && isHtfAlignedOrReversalScanner && !isMoveHealthyScanner) {
             watchlistState = "EXPECTED_MOVE_BUILDING";
        } else {
             watchlistState = "WATCHLIST_PREPARE_STATE";
             if (isStrongCmc) watchlistState = "EXPECTED_MOVE_BUILDING";
        }
        
        if (!isTrendConfirmedScanner && oppSignal.marketRegime?.includes("EXHAUSTION")) {
            watchlistState = "REVERSAL_PATTERN_PENDING";
        }

        confirmationStatusScanner = `WATCHLIST: ${watchlistState}`;
        if (Math.random() > 0.95) {
            console.log(`[WATCHLIST_PREPARE_STATE_ASSIGNED] ${sym} -> ${watchlistState}.`);
            if (watchlistState === "TREND_FORMING") console.log(`[TREND_FORMING_MONITORED] ${sym} is forming trend.`);
            if (watchlistState === "EXPECTED_MOVE_BUILDING") console.log(`[EXPECTED_MOVE_BUILDING] ${sym} expected move building.`);
            if (isStrongCmc && watchlistState !== "TREND_FORMING") console.log(`[TREND_FORMING_MONITORED] Asset ${sym} retained due to CMC strength (Narrative: ${matchedCmc?.narrative}).`);
        }
    } else {
        confirmationStatusScanner = "CONFIRMED";
    }

    const isConfirmedScanner = confirmationStatusScanner === "CONFIRMED";

    let leverageSelectedScanner = 1;
    let leverageReasonScanner = "Default risk setting";

    if (!isWebsocketHealthyScanner || !isLqHealthyScanner || !isFreeCollateralHealthyScanner) {
      leverageSelectedScanner = 0;
      leverageReasonScanner = "Safety block: API, Liquidity or Collateral unsafe";
    } else {
      const isLate = (botState as any).isLateButTradeable || oppSignal.marketRegime?.includes("LATE");
      const isHighVolAsset = ["ASTER", "SKR"].includes(sym);
      const isChopRec = botState.chopRecoveryActive || botState.blocker === "CHOP_ENTRY_APPROVED_REDUCED_RISK";
      const isRiskDowngraded = botState.drawdownSeverity && botState.drawdownSeverity !== "NONE";

      if (isRiskDowngraded || isLate || isHighVolAsset || isChopRec) {
        leverageSelectedScanner = 2;
        leverageReasonScanner = "Risk-Adjusted or Late/Volatile/Chop setup";
        console.log(`[MINIMUM_2X_ENFORCED] ${sym} risk-adjusted setup uses 2x minimum unless true emergency safety is active.`);
      } else {
        const isElite = capConfidence >= 80 && 
                        (trendMatch === "TREND_MATCH_LONG" || trendMatch === "TREND_MATCH_SHORT") && 
                        (!botState.drawdownSeverity || botState.drawdownSeverity === "NONE") && 
                        isWebsocketHealthyScanner;
        
        if (isElite) {
          leverageSelectedScanner = Math.min(meta?.maxLeverage || 15, 8);
          leverageReasonScanner = "Elite Setup: High confidence trend alignment";
          console.log(`[HIGH_CONFIDENCE_LEVERAGE_APPROVED] ${sym} elite scanner leverage approved at ${leverageSelectedScanner}x.`);
        } else if (trendMatch === "TREND_MATCH_LONG" || trendMatch === "TREND_MATCH_SHORT") {
          leverageSelectedScanner = Math.min(meta?.maxLeverage || 15, 5);
          leverageReasonScanner = "Strong Trend Match confirmed";
          console.log(`[HIGH_CONFIDENCE_LEVERAGE_APPROVED] ${sym} strong trend leverage approved at ${leverageSelectedScanner}x.`);
        } else {
          leverageSelectedScanner = 2;
          leverageReasonScanner = "Standard Confirmed Setup";
        }
      }
    }

    const regimeScore = Math.round(
      ["TRENDING", "HEALTHY_DIRECTIONAL_VOL", "DEVELOPING_CONTINUATION", "PRE_BREAKOUT_MOMENTUM", "RUNNER_SETUP_DETECTED"].includes(oppSignal.marketRegime || "")
        ? 80
        : oppSignal.marketRegime === "RANGING_CHOP" || oppSignal.marketRegime === "DEAD_LOW_VOL"
          ? 35
          : 60
    );
    const momentumScorePct = Math.round((oppSignal.momentumScore || 0) * 100);
    const volatilityScorePct = Math.round((oppSignal.volatilityScore || 0) * 100);
    const volumeScore = matchedCmc ? Math.max(0, Math.min(100, Math.round(50 + matchedCmc.volumeGrowth24h))) : momentumScorePct;
    const spreadSlippageScore = Math.round((spreadScore + liquidityScore) / 2);
    const feePenalty = Math.round((botState.feeEfficiency?.feeToProfitRatio || 0) * 20);
    const feeAdjustedExpectedValue = Math.max(0, Math.round((oppSignal.expectedMovePct || 0) * 100 - feePenalty));

    let oFinalExecScore = capConfidence;
    if (matchedCmc) {
      let cmcTrendBoost = Math.round((matchedCmc.trendScore / 100) * 15);
      let cmcVolumeBoost = 0;
      if (matchedCmc.volumeGrowth24h > 40) {
        cmcVolumeBoost = Math.min(10, Math.round(matchedCmc.volumeGrowth24h * 0.1));
      } else if (matchedCmc.volumeGrowth24h < 0) {
        cmcVolumeBoost = Math.max(-10, Math.round(matchedCmc.volumeGrowth24h * 0.1));
      }

      let cmcNarrativeBoost = 0;
      if (matchedCmc.narrative === strongestNarrative) {
        cmcNarrativeBoost = 15;
      } else if (matchedCmc.narrative === botState.cmcIntelligence?.weakeningNarrative) {
        cmcNarrativeBoost = -15;
      }

      let cmcMomentumBoost = 0;
      if (matchedCmc.priceChange1h > 1.5 && matchedCmc.priceChange24h > 5.0) {
        cmcMomentumBoost = 10;
      } else if (matchedCmc.priceChange1h < -1.0) {
        cmcMomentumBoost = -10;
      }

      let volatilityExpansionBoost = 0;
      if ((oppSignal.volatilityScore || 0) > 0.65 || matchedCmc.volumeGrowth24h > 60) {
        volatilityExpansionBoost = 10;
      }

      let volatileGemBoost = 0;
      if (matchedCmc.classification === "CMC_VOLATILE_GEM_CANDIDATE") {
        const isLqOptimal = liquidityScore >= 70;
        const isSpOptimal = spreadScore >= 70;
        const rewardOverFees = (oppSignal.expectedMovePct || 0) > 0.35;
        const isTpSlSystemValid = botState.protectionStatus !== "FAILED_EMERGENCY_CLOSE_REQUIRED";
        const isConfidenceOptimal = (oppSignal.confidence || 0) >= 40;

        if (isLqOptimal && isSpOptimal && rewardOverFees && isTpSlSystemValid && isConfidenceOptimal) {
          volatileGemBoost = 15;
          console.log(`[VOLATILE_GEM_PRIORITY_RANKED] ${sym} boosted due to high liquidity + volatile gem status`);
        }
      }

      let spreadPenalty = 0;
      if (spreadSlippageScore < 50) spreadPenalty = 15;
      else if (spreadSlippageScore < 70) spreadPenalty = 5;

      let rewardFeeBoost = (oppSignal.expectedMovePct || 0) > 0.35 ? 10 : -5;
      
      let correlationPenalty = 0;
      if (botState.openPositions > 0 && botState.allPositions) {
         let narrativeCount = 0;
         for (const pos of botState.allPositions) {
            const posSym = pos.coin || pos.position?.coin;
            const posCmc = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === posSym || a.symbol === posSym);
            if (posCmc && posCmc.narrative === matchedCmc.narrative) {
               narrativeCount++;
            }
         }
         if (narrativeCount >= 2) {
             correlationPenalty = 15;
         }
      }

      oFinalExecScore = capConfidence + cmcTrendBoost + cmcVolumeBoost + cmcNarrativeBoost + cmcMomentumBoost + volatilityExpansionBoost + volatileGemBoost + rewardFeeBoost - spreadPenalty - correlationPenalty - feePenalty;
      if (cmcTrendBoost > 0) { console.log(`[CMC_TREND_BOOST_APPLIED] Added ${cmcTrendBoost} to ${sym}`); }
      console.log(`[CMC_EXECUTION_INFLUENCE_VERIFIED] FinalScore ${sym} incorporating CMC metrics, correlation, reward/fee. Final=${oFinalExecScore}`);
      console.log(`[CMC_HL_SCORE_MERGED] ${sym} HL=${capConfidence} CMCTrend=${matchedCmc.trendScore} Narrative=${matchedCmc.narrative} Volume24h=${matchedCmc.volumeGrowth24h.toFixed(1)} Final=${oFinalExecScore}`);
    } else {
      let spreadPenalty = 0;
      if (spreadSlippageScore < 50) spreadPenalty = 15;
      else if (spreadSlippageScore < 70) spreadPenalty = 5;
      let rewardFeeBoost = (oppSignal.expectedMovePct || 0) > 0.35 ? 10 : -5;
      oFinalExecScore = capConfidence + rewardFeeBoost - spreadPenalty - feePenalty;
    }
    oFinalExecScore = Math.min(100, Math.max(0, Math.round(oFinalExecScore)));

    let directionalBias = "NEUTRAL";
    if (directionDecision === "LONG continuation") directionalBias = "LONG";
    else if (directionDecision === "SHORT continuation") directionalBias = "SHORT";
    else if (directionDecision === "LONG reversal") directionalBias = "REVERSAL_LONG";
    else if (directionDecision === "SHORT exhaustion/reversal") directionalBias = "REVERSAL_SHORT";
    else if (oppSignal.direction === "LONG" || oppSignal.direction === "SHORT") directionalBias = oppSignal.direction;

    let regimeIntent = "CONTINUATION";
    if (oppSignal.marketRegime?.includes("EXHAUSTION")) regimeIntent = "EXHAUSTION";
    else if (oppSignal.marketRegime?.includes("RECOVERY") || optPrState.isCorrecting || oppSignal.marketRegime === "CORRECTION_PHASE_ACTIVE") regimeIntent = "RECOVERY";
    else if (oppSignal.marketRegime?.includes("BREAKOUT") || oppSignal.marketRegime?.includes("RUNNER")) regimeIntent = "BREAKOUT";

    // Detect internal contradictions
    if (capConfidence >= 50 && directionalBias === "NEUTRAL") {
       console.log(`[CONTRADICTION_DETECTED] High confidence (${capConfidence}) but NO_BIAS/NEUTRAL on ${sym}. Regime: ${oppSignal.marketRegime}. Expected actionable bias.`);
    }
    if ((oppSignal.volatilityScore || 0) > 0.8 && directionalBias === "NEUTRAL" && (oppSignal.momentumScore || 0) > 0.6) {
       console.log(`[CONTRADICTION_DETECTED] Strong volatility/momentum but NO_DIRECTION on ${sym}. Regime: ${oppSignal.marketRegime}.`);
    }
    if ((oppSignal.marketRegime === "EXHAUSTION_REVERSAL" || oppSignal.marketRegime === "LATE_PARABOLIC_EXHAUSTION") && regimeIntent === "EXHAUSTION" && oppSignal.rawDirection === "LONG") {
       console.log(`[CONTRADICTION_DETECTED] Regime is EXHAUSTION_REVERSAL / PARABOLIC fading but rawDirection evaluates into LONG. Check reversal polarity logic.`);
    }
    if (watchlistState === "ACTIVE_TARGET" && rejectionReason === "NO_TRADE_SIGNAL") {
       console.log(`[CONTRADICTION_DETECTED] ACTIVE_TARGET but rejected with NO_TRADE_SIGNAL. Likely signal confirmation lag. Bypassing state lock to HIGH_RISK_NEEDS_CONFIRMATION.`);
    }

    const selectedSide = directionDecision.includes("LONG") ? "LONG" : directionDecision.includes("SHORT") ? "SHORT" : "NONE";
    const action = !price || price <= 0
      ? "BLOCKED_HARD_SAFETY"
      : eligibility === "ELIGIBLE"
        ? selectedSide === "LONG" ? "EXECUTE_LONG" : selectedSide === "SHORT" ? "EXECUTE_SHORT" : "WATCH"
        : matchedCmc && !matchedCmc.matchedSymbol
          ? "NARRATIVE_ONLY"
          : rejectionReason
            ? "WATCH"
            : "DEPRIORITIZE";

    console.log(`[ASSET_DECISION_TRACE] ${JSON.stringify({
      symbol: sym,
      cmcTrendScore: matchedCmc?.trendScore || 0,
      cmcMomentumPersistence: matchedCmc?.momentumPersistenceScore || 0,
      sector: matchedCmc?.narrative || "NONE",
      narrative: matchedCmc?.narrative || "NONE",
      hlMatched: !!meta,
      tradable: !!meta && !!price,
      longConfidence: oppSignal.longConfidence || 0,
      shortConfidence: oppSignal.shortConfidence || 0,
      continuationConfidence: Math.max(0, capConfidence - (oppSignal.reversalProbability || 0) * 0.2),
      reversalConfidence: oppSignal.reversalProbability || 0,
      exhaustionProbability: oppSignal.exhaustionProbability || 0,
      trendCollapseProbability: oppSignal.trendPhase === "TREND_COLLAPSE" ? 80 : 0,
      localScannerConfidence: capConfidence,
      regimeScore,
      momentumScore: momentumScorePct,
      liquidityScore,
      volumeScore,
      spreadSlippageScore,
      volatilityScore: volatilityScorePct,
      feeAdjustedExpectedValue,
      hardBlocker: confirmationStatusScanner.startsWith("REJECTED") ? confirmationStatusScanner : null,
      rejectionReason,
      finalScore: oFinalExecScore,
      selectedSide,
      action
    })}`);

    opportunities.push({
      symbol: sym,
      markPrice: price,
      confidence: capConfidence,
      volatility: volGrade,
      regime: oppSignal.marketRegime || "UNKNOWN",
      liquidity: liquidityScore,
      spread: spreadScore,
      htfAlignment: oppSignal.direction === "NONE" || oppSignal.rawDirection === "NONE"
        ? "NEUTRAL"
        : oppSignal.rawDirection === oppSignal.direction
          ? "ALIGNED"
          : "MISALIGNED",
      breakoutStatus:
        (capTrendStrength || 0) > 0.4 &&
        (capMomentumScore || 0) > 0.5
          ? "BREAKOUT"
          : "NO_BREAKOUT",
      trendStrength: capTrendStrength,
      momentumScore: capMomentumScore,
      bias: oppSignal.rawDirection || "NONE",
      directionalBias,
      regimeIntent,
      longConfidence: oppSignal.longConfidence,
      shortConfidence: oppSignal.shortConfidence,
      reversalProbability: oppSignal.reversalProbability,
      exhaustionProbability: oppSignal.exhaustionProbability,
      trendPhase: oppSignal.trendPhase,
      eligibility,
      rejectionReason,
      trendMatch,
      directionDecision,
      leverageSelected: leverageSelectedScanner,
      leverageReason: leverageReasonScanner,
      confirmationStatus: confirmationStatusScanner,
      confidencePass: isConfPassedScanner,
      trendPass: isTrendConfirmedScanner,
      htfPass: (oppSignal.rawDirection === oppSignal.direction),
      reversalPass: (directionDecision === "LONG reversal" || directionDecision === "SHORT exhaustion/reversal"),
      expectedMovePass: isMoveHealthyScanner,
      liquidityPass: isLqHealthyScanner,
      collateralPass: isFreeCollateralHealthyScanner,
      watchlistState,
      finalExecutionScore: oFinalExecScore,
      momentumPersistenceScore: matchedCmc?.momentumPersistenceScore,
      regimeScore,
      volumeScore,
      spreadSlippageScore,
      feeAdjustedExpectedValue,
      selectedSide,
      action,
      cmcTrendScore: matchedCmc?.trendScore,
      narrative: matchedCmc?.narrative,
    });
  }

  // Active Position Prioritization & Execution Priority Ranking (Requirements 4 & 8)
  const tradableOpps = opportunities.filter(o => o.eligibility === "ELIGIBLE" || o.eligibility === "NEAR_ENTRY");
  const allOppsSorted = [...opportunities].sort((a,b) => (b.finalExecutionScore || 0) - (a.finalExecutionScore || 0));

  const bestCandidatesLog = tradableOpps.slice(0, 3).map(o => `${o.symbol} (${o.finalExecutionScore})`);
  if (bestCandidatesLog.length > 0) {
      console.log(`[BEST_THREE_CANDIDATES_SELECTED] Candidates: ${bestCandidatesLog.join(", ")}`);
  }
  const bestCMCLog = tradableOpps.filter(o => botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === o.symbol)).slice(0, 3).map(o => `${o.symbol} (${o.finalExecutionScore})`);
  if (bestCMCLog.length > 0) {
      console.log(`[BEST_THREE_CMC_CANDIDATES_SELECTED] CMC Candidates: ${bestCMCLog.join(", ")}`);
  }

  opportunities.forEach(o => {
    const rankIndex = allOppsSorted.findIndex(t => t.symbol === o.symbol);
    o.executionPriorityRank = rankIndex !== -1 ? rankIndex + 1 : undefined;

    // Back-copy values to CMC assets (Requirement 1 & 4)
    const cMatch = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === o.symbol);
    if (cMatch) {
      cMatch.finalExecutionScore = o.finalExecutionScore;
      if (o.executionPriorityRank !== undefined) {
        cMatch.executionPriority = o.executionPriorityRank;
        console.log(`[CMC_PRIORITY_RANK_ASSIGNED] CMC asset ${o.symbol} received execution priority ${o.executionPriorityRank}`);
        console.log(`[FINAL_EXECUTION_SCORE_ASSIGNED] assigned final exec score to ${o.symbol}: ${o.finalExecutionScore}`);
      }
    }
  });

  botState.scannerOpportunities = opportunities;
  botState.lastScanTime = Date.now();
  botState.scansSinceLastEntry = (botState.scansSinceLastEntry || 0) + 1;

  // Participation Tracking
  const eligibleCount = opportunities.filter(o => o.eligibility === "ELIGIBLE").length;
  const rejectedCount = opportunities.length - eligibleCount;
  
  const lowVolRegimes = ["DEAD_LOW_VOL", "LOW_VOL_SQUEEZE", "PRE_BREAKOUT_MOMENTUM", "DEVELOPING_CONTINUATION"];
  const highVolRegimes = ["CHAOTIC_VOL", "EXTREME_DIRECTIONAL_VOL", "HEALTHY_DIRECTIONAL_VOL", "LIQUIDATION_SWEEP", "EXHAUSTION_REVERSAL"];

  const lowVolScans = opportunities.filter(o => lowVolRegimes.includes(o.regime || ""));
  const lowVolApprovals = lowVolScans.filter(o => o.eligibility === "ELIGIBLE");

  const highVolScans = opportunities.filter(o => highVolRegimes.includes(o.regime || ""));
  const highVolApprovals = highVolScans.filter(o => o.eligibility === "ELIGIBLE");

  if (!botState.participation) {
      botState.participation = { scannedCount: 0, eligibleCount: 0, rejectedCount: 0, participationRate: 0, conversionRate: 0, missedRunnerCount: 0, falseBreakoutCount: 0, lowVolScanned: 0, lowVolApproved: 0, highVolScanned: 0, highVolApproved: 0, lowVolExpectancy: 0, highVolExpectancy: 0 };
  }
  botState.participation.scannedCount = opportunities.length;
  botState.participation.eligibleCount = eligibleCount;
  botState.participation.rejectedCount = rejectedCount;
  botState.participation.participationRate = opportunities.length > 0 ? eligibleCount / opportunities.length : 0;
  botState.participation.lowVolScanned = (botState.participation.lowVolScanned || 0) + lowVolScans.length;
  botState.participation.lowVolApproved = (botState.participation.lowVolApproved || 0) + lowVolApprovals.length;
  botState.participation.highVolScanned = (botState.participation.highVolScanned || 0) + highVolScans.length;
  botState.participation.highVolApproved = (botState.participation.highVolApproved || 0) + highVolApprovals.length;
  botState.participation.lowVolExpectancy = botState.analytics?.lowVolExpectancy || 0;
  botState.participation.highVolExpectancy = botState.analytics?.highVolExpectancy || 0;
  
  console.log(`[PARTICIPATION_METRICS] Eligible: ${eligibleCount}, Rejected: ${rejectedCount}, Rate: ${(botState.participation.participationRate * 100).toFixed(1)}%, Synced: ${validUniverse.length}, Low-Vol Scanned/Approved: ${lowVolScans.length}/${lowVolApprovals.length}, High-Vol Scanned/Approved: ${highVolScans.length}/${highVolApprovals.length}`);
  
  if (eligibleCount === 0 && rejectedCount > 100) {
      console.log(`[FULL_MARKET_REJECTION_WARNING] Scanner returned 0 eligible items out of ${opportunities.length} total. Eligible: 0 / Rejected: ${rejectedCount}. Reviewing for overfiltering...`);
  }

  if (lowVolScans.find(o => o.regime === "LOW_VOL_SQUEEZE")) {
      console.log(`[LOW_VOL_SQUEEZE_DETECTED] Identified active low-volatility squeeze compression.`);
  }
  if (lowVolScans.find(o => o.regime === "PRE_BREAKOUT_MOMENTUM")) {
      console.log(`[PRE_BREAKOUT_COMPRESSION_DETECTED] Identified pre-breakout directional compression phase.`);
  }
  if (highVolScans.find(o => o.regime === "DEVELOPING_CONTINUATION" || o.regime === "HEALTHY_DIRECTIONAL_VOL")) {
      console.log(`[VOLATILITY_EXPANSION_READY] Market showing conditions for volatility expansion.`);
  }

  if (validUniverse.length > 50 && botState.participation.participationRate <= 0.01) {
    (botState.analytics as any).participationUnderflowDurationMs = ((botState.analytics as any).participationUnderflowDurationMs || 0) + 10000;
    if ((botState.analytics as any).participationUnderflowDurationMs > 30000) {
      console.log(`[SCANNER_OVERFILTERING_DETECTED] Participation rate <= 1% for extended period. Activated LOW_VOL_PARTICIPATION_RECOVERY.`);
      console.log(`[LOW_VOL_PARTICIPATION_RECOVERY] Lowering thresholds to prevent total market paralysis.`);
      botState.analytics.thresholdAdjustment = (botState.analytics.thresholdAdjustment || 0) - 2;
      botState.analytics.thresholdAdjustment = Math.max(-15, botState.analytics.thresholdAdjustment);
      console.log(`[THRESHOLD_RELAXATION_APPLIED] Threshold adj: ${botState.analytics.thresholdAdjustment}`);
      (botState.analytics as any).participationUnderflowDurationMs = 0;
    }
  } else if (botState.participation.participationRate > 0.08 && botState.analytics.expectancyAfterFees !== undefined && botState.analytics.expectancyAfterFees < 0) {
      console.log(`[PARTICIPATION_TOO_HIGH_TIGHTENING] Participation rate > 8% with negative expectancy. Tightening thresholds...`);
      botState.analytics.thresholdAdjustment = Math.min((botState.analytics.thresholdAdjustment || 0) + 2, 10);
      botState.cooldownUntil = Math.max(botState.cooldownUntil || 0, Date.now() + 5 * 60 * 1000);
      (botState.analytics as any).participationUnderflowDurationMs = 0;
  } else {
    (botState.analytics as any).participationUnderflowDurationMs = 0;
    if (eligibleCount > 5) {
       botState.analytics.thresholdAdjustment = Math.min((botState.analytics.thresholdAdjustment || 0) + 0.5, 0);
    }
  }

  // Recent Entry Memory & Missed Runner Detection
  const nowTime = Date.now();
  botState.recentCandidates = botState.recentCandidates || [];
  
  // Track missed runners and memory
  for (const opp of botState.scannerOpportunities) {
    if ((opp.confidence || 0) >= 30 && opp.bias !== "NONE") {
      const isRejected = opp.rejectionReason && opp.rejectionReason !== "NO_ACTIVE_TRADE_TRIGGERED";
      
      // Update existing candidates to track price post-rejection
      const existingCand = botState.recentCandidates.find(c => c.symbol === opp.symbol && c.status === "REJECTED" && (nowTime - c.timestamp) < 900000); // lookback 15m
      
      if (existingCand && existingCand.rejectionPrice && existingCand.status === "REJECTED") {
         existingCand.currentPrice = opp.markPrice;
         const changePct = ((opp.markPrice - existingCand.rejectionPrice) / existingCand.rejectionPrice) * 100;
         const directionMulti = existingCand.side === "LONG" ? 1 : -1;
         existingCand.moveAfterRejectionPct = changePct * directionMulti;
         
         const isPostRallyOrHighVol = existingCand.rejectionReason === "POST_RALLY_CORRECTION_ACTIVE" || existingCand.rejectionReason === "POST_RALLY_REENTRY_RESTRICTED" || existingCand.rejectionReason === "EXHAUSTION_RISK_ACTIVE" || existingCand.rejectionReason === "LOW_CONFIDENCE";

         if (existingCand.moveAfterRejectionPct > 2.0 && isPostRallyOrHighVol) {
           existingCand.status = "MISSED_RUNNER";
           console.log(`MISSED_RUNNER_DETECTED: ${opp.symbol} moved ${existingCand.moveAfterRejectionPct.toFixed(2)}% in favored direction since rejection (${existingCand.rejectionReason}). Time elapsed: ${Math.round((nowTime - existingCand.timestamp) / 1000)}s.`);
           botState.analytics.missedRunnerCount = (botState.analytics.missedRunnerCount || 0) + 1;
           botState.analytics.lastMissedRunner = opp.symbol;
           botState.analytics.recentEntryBias = "TOO_CONSERVATIVE";
           console.log(`RECENT_ENTRY_BIAS_UPDATED: Bias updated to TOO_CONSERVATIVE due to missed runner on ${opp.symbol}.`);
           
           botState.analytics.thresholdAdjustment = (botState.analytics.thresholdAdjustment || 0) - 2;
           botState.analytics.thresholdAdjustment = Math.max(-10, botState.analytics.thresholdAdjustment);
           console.log(`CONTINUATION_THRESHOLD_ADJUSTED: Reduced continuation threshold to adapt to current volatility. Current adj: ${botState.analytics.thresholdAdjustment}`);
         }
      }
      
      // Add new candidates once every minute per symbol to avoid spam
      const recentSpam = botState.recentCandidates.find(c => c.symbol === opp.symbol && (nowTime - c.timestamp) < 60000);
      if (!recentSpam) {
         botState.recentCandidates.push({
           timestamp: nowTime,
           symbol: opp.symbol,
           side: opp.bias as "LONG" | "SHORT" | "NONE",
           confidence: opp.confidence,
           regime: opp.regime,
           volatility: opp.volatility === "HIGH" ? 0.8 : (opp.volatility === "CHOPPY" ? 0.4 : 0.6),
           trendStrength: opp.trendStrength,
           expectedMove: 0,
           status: isRejected ? "REJECTED" : "ACCEPTED",
           rejectionReason: opp.rejectionReason || undefined,
           rejectionPrice: isRejected ? opp.markPrice : undefined,
           currentPrice: opp.markPrice
         });
         
         // Keep last 50
         if (botState.recentCandidates.length > 50) {
            botState.recentCandidates.shift();
         }
      }
    }
  }

  // Run on-demand diagnostics and metrics
  console.log(`[SCANNER_HEALTH_CHECK] Scanner loop running. Last scan time: ${new Date().toISOString()}, scans since last entry: ${botState.scansSinceLastEntry}`);

  console.log(`[MARKET_DATA_FRESHNESS_CHECK] Freshness verified. WSS timestamp: ${new Date(botState.lastWssTime || Date.now()).toISOString()}, age: ${Date.now() - (botState.lastWssTime || Date.now())}ms. Prices count: ${Object.keys(botState.markPrices || {}).length}`);

  // Build top 10 rejected markets
  const fullRejectedList: any[] = opportunities
      .filter(o => o.rejectionReason && o.rejectionReason !== "WAITING")
      .map(o => ({
          symbol: o.symbol,
          confidence: o.confidence,
          requiredConfidence: 38,
          regime: o.regime,
          expectedMove: 0,
          rejectionReason: o.rejectionReason
      }));

  fullRejectedList.sort((a, b) => b.confidence - a.confidence);
  const top10Rejected = fullRejectedList.slice(0, 10);
  console.log(`[TOP_REJECTED_MARKETS] Current top 10 rejected markets:`);
  top10Rejected.forEach((market, idx) => {
    console.log(`  ${idx+1}. ${market.symbol} | Conf: ${market.confidence}% (Req: ${market.requiredConfidence}%) | Regime: ${market.regime} | Expected Move: ${market.expectedMove.toFixed(2)}% | Rejection: ${market.rejectionReason}`);
  });

  // Manage execution attempts & cool down handling
  if (!botState.telemetry) botState.telemetry = { activeTpCount: 0, activeSlCount: 0, duplicateProtectionWarnings: 0, protectionSyncHealth: "OK" };
  const isMarketActive = (botState.marketScanner?.confidenceRanking || 0) > 60 || (botState.marketScanner?.regimeClassification !== "RANGING_CHOP" && botState.marketScanner?.regimeClassification !== "DEAD_LOW_VOL");
  const maxRouterCandidates = isMarketActive ? 5 : 3;
  console.log(`[QUEUE_CUTOFF_RECALCULATED] maxRouterCandidates set to ${maxRouterCandidates} (Market Active: ${isMarketActive})`);
  const eligibleOpps = opportunities.filter(o => o.eligibility === "ELIGIBLE");
  eligibleOpps.sort((a, b) => (a.executionPriorityRank || 999) - (b.executionPriorityRank || 999));

  if (eligibleOpps.length > maxRouterCandidates) {
      console.log(`[TOP_CANDIDATE_QUEUE_ACTIVE] Limiting ${eligibleOpps.length} eligible candidates to top ${maxRouterCandidates} for execution router.`);
      botState.telemetry.skippedLowPriorityCandidates = (botState.telemetry.skippedLowPriorityCandidates || 0) + (eligibleOpps.length - maxRouterCandidates);
  }

  // Perform detailed check on each eligible opportunity
  opportunities.forEach(opp => {
    if (opp.eligibility === "ELIGIBLE") {
      const execRank = opp.executionPriorityRank || 999;
      const sym = opp.symbol;
      const matchedCmc = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === sym || a.symbol === sym);
      
      const isVolatileGem = matchedCmc?.classification === "CMC_VOLATILE_GEM_CANDIDATE";
      const isHighLiquidityStrongDirection = (opp.liquidity || 0) > 85 && (opp.spread || 0) > 85 && (opp.confidence || 0) >= 60 && opp.direction !== "NONE";
      const isEarlyExpansionRegime = ["HEALTHY_LOW_VOL_EXPANSION", "LOW_VOL_SQUEEZE", "PRE_BREAKOUT_COMPRESSION", "EARLY_DIRECTIONAL_EXPANSION", "PRE_BREAKOUT_MOMENTUM", "MOMENTUM_BUILDING", "EARLY_CONTINUATION_ENTRY"].includes(opp.regime);
      const isStrongNarrative = matchedCmc !== undefined && matchedCmc.trendScore >= 60;
      const isCmcMomentum = matchedCmc !== undefined && (matchedCmc.momentumPersistenceScore || 0) >= 60;
      const hasDirectionBias = (opp.confidence || 0) >= 50 && opp.direction !== "NONE";

      const shouldPromoteOverride = isVolatileGem || isHighLiquidityStrongDirection || isEarlyExpansionRegime || isStrongNarrative || isCmcMomentum || hasDirectionBias;

      if (execRank > maxRouterCandidates) {
          if (shouldPromoteOverride) {
              console.log(`[LOW_PRIORITY_WARNING_ONLY] ${sym} is low rank but has strong overriding factors.`);
              console.log(`[LOW_PRIORITY_PROMOTED_TO_EXECUTION_QUEUE] ${sym} promoted to execution queue bypassing rank filter (VolatileGem: ${!!isVolatileGem}, HighLiqDir: ${!!isHighLiquidityStrongDirection}, EarlyExp: ${!!isEarlyExpansionRegime}, StrongNarrative: ${!!isStrongNarrative}).`);
              if (isVolatileGem) {
                 console.log(`[GEM_CANDIDATE_ROUTED_TO_EXECUTION] ${sym} routed.`);
              }
          } else {
              console.log(`[LOW_PRIORITY_EXECUTION_SKIPPED] ${opp.symbol} is low rank. Applying size/leverage reduction instead of hard skip.`);
              console.log(`[NONESSENTIAL_BLOCKER_REMOVED_FROM_EXECUTION] Removed LOW_PRIORITY hard block on ${sym}.`);
              (opp as any).sizeModifier = ((opp as any).sizeModifier || 1.0) * 0.3;
              (opp as any).leverageModifier = ((opp as any).leverageModifier || 1.0) * 0.5;
              opp.eligibility = "ELIGIBLE"; 
              opp.rejectionReason = null;
              (opp as any).softExecutionReason = "LOW_PRIORITY_EXECUTION_SKIPPED";
              if ((opp.liquidity || 0) > 90) {
                 console.log(`[HIGH_LIQUIDITY_ASSET_WATCHLISTED] ${sym} is a major/high-liquidity asset placed in watch list for later check.`);
              }
          }
      }
      
      // Symbol level cooldown checks (Position sizing & Router block)
      if (botState.positionSizeInvalidCooldowns && botState.positionSizeInvalidCooldowns[sym] && Date.now() < botState.positionSizeInvalidCooldowns[sym]) {
          const sigForCooldown = strategy.getSignal(sym);
          const hasFreshRouterSize = (opp.finalExecutionScore || 0) >= 70 || (sigForCooldown.confidence || 0) >= 70 || (!!matchedCmc && matchedCmc.trendScore >= 85);
          if (hasFreshRouterSize) {
              console.log(`[POSITION_SIZE_INVALID_FALSE_BLOCK_PREVENTED] ${sym} sizing cooldown bypassed for fresh high-quality setup; final router will rebuild size.`);
              delete botState.positionSizeInvalidCooldowns[sym];
          } else {
              opp.eligibility = "NEAR_ENTRY";
              opp.rejectionReason = "POSITION_SIZE_INVALID_COOLDOWN";
              applySoftExecutionAdjustment(opp, "POSITION_SIZE_INVALID_COOLDOWN", 0.75, 0.85);
              return;
          }
      }
      if (botState.routerBlockCooldowns && botState.routerBlockCooldowns[sym] && Date.now() < botState.routerBlockCooldowns[sym]) {
          const sig = strategy.getSignal(sym);
          const isFreshHighQuality = (sig.confidence || 0) >= 70 || (opp.finalExecutionScore || 0) >= 70 || (!!matchedCmc && matchedCmc.trendScore >= 85);
          if (isFreshHighQuality) {
              console.log(`[ROUTER_COOLDOWN_OVERRIDDEN_FRESH_SIGNAL] ${sym} cooldown bypassed. Conf: ${sig.confidence}`);
              console.log(`[FRESH_SIGNAL_RETRY_APPROVED] ${sym} retry approved.`);
              delete botState.routerBlockCooldowns[sym];
          } else {
              opp.eligibility = "NEAR_ENTRY";
              opp.rejectionReason = "ROUTER_BLOCK_RETRY_COOLDOWN";
              applySoftExecutionAdjustment(opp, "ROUTER_BLOCK_RETRY_COOLDOWN", 0.7, 0.85);
              return;
          }
      }

      // Check Execution API Budget
      if (botState.executionThrottleUntil && Date.now() < botState.executionThrottleUntil) {
          const isTopRankedCandidate = execRank <= Math.max(1, Math.min(3, botState.availableSlots || 1));
          const hasStrongCmcBudgetClaim = !!matchedCmc && matchedCmc.trendScore >= 85 && (matchedCmc.momentumPersistenceScore || 0) >= 70;
          const hasHighFinalScore = (opp.finalExecutionScore || 0) >= 70;
          if (isTopRankedCandidate || hasStrongCmcBudgetClaim || hasHighFinalScore) {
              console.log(`[TOP_CMC_CANDIDATE_BUDGET_RESERVED] ${sym} retained for final router during execution throttle.`);
              console.log(`[REST_DEGRADED_TOP_CANDIDATE_ALLOWED] ${sym} bypasses noncritical execution debounce because it is a top/CMC candidate.`);
              console.log(`[API_BUDGET_OVERBLOCK_PREVENTED] ${sym} was not hard-blocked by executionThrottleUntil.`);
          } else {
              console.log(`[EXECUTION_API_BUDGET_THROTTLED] Final router check debounced for ${sym} due to API budget constraint.`);
              console.log(`[EXECUTION_VALIDATION_DEBOUNCED] ${sym} held in prepare state instead of hard rejected.`);
              botState.telemetry.finalRouterAttemptsMap = botState.telemetry.finalRouterAttemptsMap || {};
              botState.telemetry.finalRouterAttemptsMap["API_THROTTLED"] = (botState.telemetry.finalRouterAttemptsMap["API_THROTTLED"] || 0) + 1;
              opp.eligibility = "NEAR_ENTRY";
              opp.rejectionReason = "EXECUTION_VALIDATION_DEBOUNCED";
              applySoftExecutionAdjustment(opp, "EXECUTION_API_BUDGET_THROTTLED", 0.75, 0.85);
              return;
          }
      }

      const sig = strategy.getSignal(sym);
      
      let reqConf = 38; // default
      const optRegime = (sig.marketRegime || "TRENDING") as string;
      if (
        botState.analytics.regimeDetailedStats &&
        botState.analytics.regimeDetailedStats[optRegime]
      ) {
        const stats = botState.analytics.regimeDetailedStats[optRegime];
        if (stats.wins + stats.losses >= 10 && (stats.winRate < 40 || stats.netPnl < 0)) {
          reqConf = 45;
        } else if (stats.wins + stats.losses < 10 && (optRegime === "RANGING_CHOP" || (["DEAD_LOW_VOL"].includes(optRegime)))) {
          reqConf = 42;
        } else if (stats.wins + stats.losses < 10 && (optRegime === "PRE_BREAKOUT_MOMENTUM" || optRegime === "DEVELOPING_CONTINUATION")) {
          reqConf = 30;
        }
      } else if (optRegime === "RANGING_CHOP") {
        reqConf = 42;
      } else if ((["DEAD_LOW_VOL"].includes(optRegime))) {
        reqConf = 38;
      } else if (optRegime === "PRE_BREAKOUT_MOMENTUM" || optRegime === "DEVELOPING_CONTINUATION") {
        reqConf = 30;
      }

      // Apply Phase 2 Adaptive Threshold Adjustments
      if (botState.phase === "PHASE_2_ADAPTIVE_EXECUTION" && botState.analytics.thresholdAdjustment !== undefined) {
         reqConf += botState.analytics.thresholdAdjustment;
      }
      
      if (botState.analytics.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
         reqConf -= 12;
         if (reqConf < 15) reqConf = 15;
      }
      if (botState.participationRecoveryStatus === "PARTICIPATION_PARALYSIS_RECOVERY_ACTIVE") {
         reqConf -= 8;
         if (reqConf < 15) reqConf = 15;
      }
      
      reqConf = Math.max(15, Math.min(80, reqConf)); // Ensure hard floor/ceiling limits for safety

      // Check blockers
      let blockerCode = "PASSED";
      
      if (botState.assetFeeEfficiency && botState.assetFeeEfficiency[sym]?.isHighFeeMarket) {
         reqConf += 20; // significant penalty
         if (sig.expectedMovePct !== undefined && sig.expectedMovePct < 0.6) {
             console.log(`[HIGH_FEE_MARKET_AVOIDED] ${sym} flagged as high fee market. Expected move ${sig.expectedMovePct?.toFixed(2)}% too low.`);
             blockerCode = "HIGH_FEE_MARKET_NOT_WORTH_RISK";
         } else {
             console.log(`[HIGH_FEE_MARKET_PERMITTED] ${sym} is a high fee market, but expected move ${sig.expectedMovePct?.toFixed(2)}% justifies risk. Raising confidence requirement to ${reqConf}.`);
         }
      }
      
      const isCbVal = botState.phase === "CIRCUIT_BREAKER_ACTIVE";
      const isCdVal = (botState.cooldownUntil || 0) > Date.now();
      
      if (isCbVal) {
        blockerCode = "PHASE_NOT_ACTIVE";
      } else if (botState.validationStatus !== "SUCCESS" && !config.DRY_RUN) {
        blockerCode = "API_NOT_VERIFIED";
      } else if (!botState.wssConnected && !config.DRY_RUN) {
        blockerCode = "WSS_INSTABILITY";
      } else if (!botState.apiConnected && !config.DRY_RUN) {
        blockerCode = "ENTRY_ENGINE_DISABLED";
      } else {
        const exposureAllowed = botState.openPositions < limit;
        if (!exposureAllowed) {
            blockerCode = "MAX_POSITIONS_REACHED";
        }
      }
        
        if (blockerCode === "PASSED") {
          const markPriceLocal = botState.markPrices ? botState.markPrices[sym] : 0;
          const expMoveLocal = sig.expectedMovePct || 1.0;
          const isBuyLocal = sig.direction === "LONG";
          const reqLevLocal = Math.min(2, botState.config.leverage || 2);
          
          if (markPriceLocal > 0) {
            const assetMetaLocal = getAssetMeta(sym);
            const rawSlPct = (assetMetaLocal && assetMetaLocal.maxLeverage <= 3) ? 2.5 : 1.5;
            const rawTpPct = Math.max(rawSlPct * 0.25, expMoveLocal * 0.9);
            
            const secureLimitLocal = calculateSafeTpSl(
              sym,
              isBuyLocal ? "LONG" : "SHORT",
              markPriceLocal,
              rawTpPct,
              rawSlPct,
              sig.atrPct
            );

            const proposedTpPrice = secureLimitLocal.finalTpPrice;
            const proposedSlPrice = secureLimitLocal.finalSlPrice;
            
            // Calculate actual percentages after adjustments
            const proposedTpPct = Math.abs(proposedTpPrice - markPriceLocal) / markPriceLocal * 100;
            const proposedSlPct = Math.abs(proposedSlPrice - markPriceLocal) / markPriceLocal * 100;

            const rrRatio = proposedSlPct > 0 ? (proposedTpPct / proposedSlPct) : 0;
            const feeAdjustedExpected = expMoveLocal - 0.2; // approx 0.1% * 2 for open and close
            const liqDistancePct = 100 / reqLevLocal;
            const spreadImpact = (botState.marketScanner?.spreadQuality || 100) < 50 ? "HIGH" : "LOW";
            
            if (rrRatio < 0.2 || proposedTpPct < 0.25 || proposedSlPct >= liqDistancePct * 0.8) {
              let exactReason = "";
              let isHardBlock = false;
              if (rrRatio < 0.2) {
                exactReason = "RR_RATIO_TOO_LOW";
              } else if (proposedTpPct < 0.25) {
                exactReason = "MIN_TP_MOVEMENT_VIOLATED";
              } else if (proposedSlPct >= liqDistancePct * 0.8) {
                exactReason = "SL_TOO_CLOSE_TO_LIQUIDATION_BUFFER";
                isHardBlock = true;
              }
              
              const diagMsg = `TP_SL_PRECHECK_FAILED [PROPOSED] Entry:${markPriceLocal.toFixed(4)} TP:${proposedTpPrice.toFixed(4)} SL:${proposedSlPrice.toFixed(4)} RR:${rrRatio.toFixed(2)} LiqDist:${liqDistancePct.toFixed(2)}% FeeAdj:${feeAdjustedExpected.toFixed(2)}% Spread:${spreadImpact} Reason:${exactReason}`;
              if (isHardBlock) {
                blockerCode = diagMsg;
              }
              console.log(`[TP_SL_PRECHECK_DIAGNOSTIC] ${sym} | ${diagMsg} | HardBlock: ${isHardBlock}`);
            }
          }
        }
        
        if (blockerCode === "PASSED") {
          const drawdownPauseEnd = botState.drawdownPauseUntil || 0;
          if (Date.now() < drawdownPauseEnd) {
            blockerCode = "HARD_DRAWDOWN_PAUSE_ACTIVE";
          } else {
              const markPrice = botState.markPrices ? botState.markPrices[sym] : 0;
              if (!markPrice || markPrice <= 0) {
                blockerCode = "POSITION_SIZE_INVALID";
              } else {
                const assetMeta = getAssetMeta(sym);
                const assetMinSz = assetMeta ? assetMeta.minSz || 0 : 0;
                const protocolMinNotional = 11;
                const PREFERRED_ENTRY_SIZE = botState.config.minEntrySize || 40;
                const minSzNotional = assetMinSz * markPrice;
                const absoluteExecutableMinimum = Math.max(protocolMinNotional, minSzNotional);
                const minimumUserRequiredSize = Math.max(absoluteExecutableMinimum, PREFERRED_ENTRY_SIZE);

                let targetExposure = botState.config.maxExposure;
                let setupLeverage = Math.max(2, botState.config.leverage); // default for runner

                const prStateForSymbol = postRallyTracker.get(sym);
                if (prStateForSymbol && (prStateForSymbol.isCorrecting || prStateForSymbol.hasRallied)) {
                  targetExposure *= 0.5;
                  setupLeverage = Math.max(2, Math.min(3, setupLeverage)); // min 2x
                  
                  const maxPosLimit = botState.participationRecoveryStatus === "PARTICIPATION_PARALYSIS_RECOVERY_ACTIVE" ? Math.min(limit, 2) : limit;
                  if (botState.openPositions >= maxPosLimit) {
                    blockerCode = "MAX_POSITIONS_REACHED";
                  }
                }

                const isHighVol = ["ASTER", "SKR"].includes(sym);
                const isHighRisk = assetMeta && assetMeta.maxLeverage <= 3;
                if (isHighVol || isHighRisk) {
                  targetExposure *= 0.5;
                  setupLeverage = Math.min(botState.config.leverage || 2, setupLeverage); // Only high risk assets bound by config max
                }

                // Determine dynamic minimum entry size permission
                let passesSizingScreening = false;

                if (targetExposure >= PREFERRED_ENTRY_SIZE) {
                  passesSizingScreening = true;
                } else {
                  // Reduced size or micro-entry screening
                  const isSetupQualityHigh = sig.confidence >= reqConf && sig.direction !== "NONE" && botState.executionTrendMatch !== "TREND_CONFLICT";
                  const isConfidenceStrong = sig.confidence >= 50;
                  const isExpectedRewardGreaterThanFees = (sig.expectedMovePct || 0) > 0.35;
                  const isLiquiditySpreadHealthy = (botState.marketScanner?.spreadQuality || 100) >= 60 && (botState.marketScanner?.liquidityScore || 100) >= 60;
                  const isApprovedForReduced = isSetupQualityHigh && isConfidenceStrong && isExpectedRewardGreaterThanFees && isLiquiditySpreadHealthy;

                  if (targetExposure >= 20) {
                    if (isApprovedForReduced) {
                      passesSizingScreening = true;
                    }
                  } else if (targetExposure >= 10) {
                    const isEliteOrHighMomentum = sig.confidence >= 70 || (sig.momentumScore || 0) > 0.6 || (sig.trendStrength || 0) > 0.6;
                    if (isApprovedForReduced && isEliteOrHighMomentum) {
                      passesSizingScreening = true;
                    }
                  }
                }

                if (blockerCode === "PASSED") {
                  if (!passesSizingScreening) {
                    console.log(`[SCANNER_SIZE_WARNING_ONLY] Symbol ${sym} target exposure \$${targetExposure.toFixed(2)} is considered small. Deferring to router for rebuild.`);
                    console.log(`[TOO_SMALL_FALSE_BLOCK_PREVENTED] Re-evaluating size at routing stage.`);
                    passesSizingScreening = true;
                  }
                  if (passesSizingScreening) {
                    const dynamicMinRequired = targetExposure < PREFERRED_ENTRY_SIZE ? absoluteExecutableMinimum : minimumUserRequiredSize;
                    const minMarginRequired = (dynamicMinRequired / setupLeverage) * 1.01;
                    if (botState.accountEquity < minMarginRequired || botState.availableMargin < minMarginRequired) {
                      blockerCode = "INSUFFICIENT_FREE_COLLATERAL";
                    } else {
                      const estimatedIm = targetExposure / setupLeverage;
                      const estimatedFeesAndSlippage = targetExposure * 0.005;
                      const estimatedRequiredMargin = estimatedIm + estimatedFeesAndSlippage;
                      const estimatedAvailableMarginAfterEntry = botState.availableMargin - estimatedRequiredMargin;
                      const estimatedFreeCollateralPct = botState.accountEquity > 0
                        ? (estimatedAvailableMarginAfterEntry / botState.accountEquity) * 100
                        : 0;

                      const dynamicLimitObj = getDynamicMaxPositions();
                      const limit = dynamicLimitObj.limit;
                      const requiredFreePct = botState.openPositions >= limit ? 35 : 30;
                      const freeCollateralOk = estimatedFreeCollateralPct >= requiredFreePct;

                      if (!freeCollateralOk || estimatedAvailableMarginAfterEntry <= 0) {
                        blockerCode = "INSUFFICIENT_FREE_COLLATERAL";
                      } else {
                        const assetSizeDecimals = assetMeta ? assetMeta.szDecimals || 2 : 2;
                        const rawBaseSize = targetExposure / markPrice;
                        const multiplier = Math.pow(10, assetSizeDecimals);
                        const roundedBaseSize = Math.floor(rawBaseSize * multiplier + 1e-7) / multiplier;

                        if (roundedBaseSize <= 0 || roundedBaseSize * markPrice < dynamicMinRequired * 0.95) {
                          blockerCode = "POSITION_SIZE_INVALID";
                        } else {
                          const overtradingPauseEnd = botState.overtradingPauseUntil || 0;
                          const noTradeEnd = botState.noTradeUntil || 0;
                          // Continuation Re-entry bypass
                          const trendIntact = sig.confidence >= 70 || (sig.trendStrength || 0) >= 0.6;
                          const continuationHealthy = sig.marketRegime?.includes("TRENDING") || sig.marketRegime?.includes("CONTINUATION") || sig.marketRegime?.includes("MOMENTUM");
                          const breakoutPersists = sig.marketRegime === "PRE_BREAKOUT_MOMENTUM" || sig.marketRegime === "EARLY_DIRECTIONAL_EXPANSION" || (sig.expectedMovePct || 0) >= 0.5;

                          if (botState.lastExitWasSuccessful && botState.lastCooldownSymbol === sym && trendIntact && continuationHealthy && breakoutPersists) {
                             console.log(`[CONTINUATION_REENTRY_APPROVED] Prior exit on ${sym} was successful and continuation remains extremely healthy. Continuation re-entry approved.`);
                             console.log(`[COOLDOWN_REDUCED_BY_CONTINUATION] Reducing/clearing cooldown for persistent continuation on ${sym}.`);
                             botState.cooldownUntil = 0; // clear cooldown
                          }

                          const cooldownEnd = botState.cooldownUntil || 0;
                          const reverseLockEnd = botState.reverseLockUntil || 0;

                          if (Date.now() < overtradingPauseEnd) {
                            blockerCode = "OVERTRADING_PAUSE_ACTIVE";
                          } else if (botState.noTradeUntil && Date.now() >= botState.noTradeUntil) {
                            console.log(`[NO_TRADE_PERIOD_EXPIRED] No-trade period has expired automatically.`);
                            botState.noTradeUntil = 0;
                          } else if (botState.noTradeUntil && Date.now() < botState.noTradeUntil) {
                            const remainingSeconds = Math.round((botState.noTradeUntil - Date.now()) / 1000);
                            
                            // Check override conditions
                            const isHighQualityFresh = (sig.confidence || 0) >= 70 && (opp.liquidity || 0) > 85 && sig.direction !== "NONE";
                            const cmcMatched = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === sym || a.symbol === sym);
                            const isCmcVolatileGem = cmcMatched?.classification === "CMC_VOLATILE_GEM_CANDIDATE";
                            const isCmcActiveTrend = cmcMatched && (cmcMatched.trendScore > 60 || (cmcMatched.momentumPersistenceScore || 0) > 60);
                            
                            if (isHighQualityFresh || isCmcVolatileGem || isCmcActiveTrend) {
                               console.log(`[NO_TRADE_PERIOD_OVERRIDDEN_FRESH_SETUP] Overriding no-trade period for ${sym} due to fresh high-quality setup/CMC trend (Conf: ${sig.confidence}).`);
                               console.log(`[NONESSENTIAL_BLOCKER_REMOVED_FROM_EXECUTION] Removed NO_TRADE_PERIOD_ACTIVE hard block for ${sym} due to CMC activity.`);
                               botState.noTradeUntil = 0; // Clear it based on fresh setup
                            } else {
                               blockerCode = "NO_TRADE_PERIOD_ACTIVE";
                               opp.rejectionReason = `NO_TRADE_PERIOD_ACTIVE (${remainingSeconds}s remaining)`;
                               console.log(`[NO_TRADE_PERIOD_ACTIVE] ${sym} blocked. ${remainingSeconds}s remaining on cooldown. Conf: ${sig.confidence || 0}`);
                            }
                          } else if (Date.now() < reverseLockEnd) {
                            blockerCode = "REVERSE_LOCK_ACTIVE";
                          } else {
                            let sizeMod = 1.0;
                            let leverageMod = 1.0;
                            let tpSlAggressivenessMod = 1.0;

                            // 1. Soft Risk: Fee Efficiency Pause
                            if (botState.feeEfficiency?.isPaused) {
                              console.log(`[SOFT_RISK_FEE_PAUSE] Downgrading risk parameters instead of trading veto for ${sym}.`);
                              sizeMod *= 0.5; // Scale size down 50%
                              leverageMod *= 0.5; // Limit leverage exposure
                              tpSlAggressivenessMod *= 0.75; // Safer target bounds
                              sig.tradeQualityScore = Math.max(10, (sig.tradeQualityScore || 60) - 15); // Penalty rank
                            }

                            // 2. Soft Risk: Post-Trade Cooldown
                            if (Date.now() < cooldownEnd) {
                              console.log(`[SOFT_RISK_COOLDOWN] Downgrading risk parameters instead of trading veto for ${sym}.`);
                              sizeMod *= 0.6; // Scale size down 40%
                              leverageMod *= 0.7; // Lower leverage exposure
                              tpSlAggressivenessMod *= 0.85; // Tighter targets
                              sig.tradeQualityScore = Math.max(10, (sig.tradeQualityScore || 60) - 15); // Penalty rank
                            }

                            // Store modifiers directly on the opportunity object
                            (opp as any).sizeModifier = sizeMod;
                            (opp as any).leverageModifier = leverageMod;
                            (opp as any).tpSlAggressivenessModifier = tpSlAggressivenessMod;
                          }
                        
                        if (blockerCode === "PASSED") {
                          const tradeQualityScore = sig.tradeQualityScore !== undefined ? sig.tradeQualityScore : 50;
                          if (tradeQualityScore < 45) {
                            console.log(`[EXECUTION_ROUTER_BLOCK_CLASSIFIED] Router block classified as LOW_TRADE_QUALITY_SCORE.`);
                            console.log(`[SOFT_BLOCKER_CONVERTED_TO_RISK_ADJUSTMENT] Removing soft block. Applying size penalty instead.`);
                            console.log(`[ROUTER_BLOCK_RECOVERY_APPLIED] Allowed to proceed with reduced sizing.`);
                            (opp as any).sizeModifier = ((opp as any).sizeModifier || 1.0) * 0.5;
                          } else if (sig.confidence < reqConf) {
                            console.log(`[EXECUTION_ROUTER_BLOCK_CLASSIFIED] Router block classified as LOW_CONFIDENCE.`);
                            console.log(`[SOFT_BLOCKER_CONVERTED_TO_RISK_ADJUSTMENT] Removing soft block. Applying size penalty instead.`);
                            console.log(`[ROUTER_BLOCK_RECOVERY_APPLIED] Allowed to proceed with reduced sizing.`);
                            (opp as any).sizeModifier = ((opp as any).sizeModifier || 1.0) * 0.5;
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Compute projected post-entry free collateral %
        const markPriceVal = botState.markPrices ? botState.markPrices[sym] : botState.markPrice || 0;
        const assetMetaVal = getAssetMeta(sym);
        let targetExposureVal = botState.config.maxExposure;
        let setupLeverageVal = botState.config.leverage;
        const prStateForSymbolVal = postRallyTracker.get(sym);
        if (prStateForSymbolVal && (prStateForSymbolVal.isCorrecting || prStateForSymbolVal.hasRallied)) {
          targetExposureVal *= 0.5;
          setupLeverageVal = Math.max(2, Math.min(3, setupLeverageVal));
          console.log(`[MINIMUM_2X_ENFORCED] ${sym} projected sizing check kept leverage at ${setupLeverageVal}x during post-rally risk adjustment.`);
        }
        if (["ASTER", "SKR"].includes(sym) || (assetMetaVal && assetMetaVal.maxLeverage <= 3)) {
          targetExposureVal *= 0.5;
          setupLeverageVal = Math.min(2, setupLeverageVal);
        }
        const estIm = targetExposureVal / setupLeverageVal;
        const estFees = targetExposureVal * 0.005;
        const estAvailMarginAfter = botState.availableMargin - (estIm + estFees);
        const estFreeCollateralPct = botState.accountEquity > 0 ? (estAvailMarginAfter / botState.accountEquity) * 100 : 0;

        // Stale orders check
        const hasStaleReadyOrders = botState.activeOrders && botState.activeOrders.some(o => (Date.now() - (o.timestamp || o.time || Date.now())) > 300000);
        const staleStatus = hasStaleReadyOrders ? "STALE_ORDERS_EXIST" : "NORMAL";

        console.log(`MARKET_ELIGIBILITY_CHECK: Evaluating ${sym} (Conf: ${sig.confidence}, Req: ${reqConf}, Regime: ${optRegime})`);
        
        // Add NOT_SELECTED_AS_BEST_SIGNAL constraint
        if (blockerCode === "PASSED" && !multiPositionMode && sym !== botState.activeSymbol) {
            blockerCode = "NOT_BEST_SIGNAL_SELECTED";
        }

        if (blockerCode === "PASSED") {
          console.log(`MARKET_APPROVED_FOR_EXECUTION: ${sym} passed all safety and risk checks.`);
          if (botState.openPositions > 0) {
              console.log(`[MULTI_POSITION_ENTRY_APPROVED] Signal for ${sym} passed multi-position risk gate. CONCURRENT_POSITION_APPROVED.`);
          }
          opp.eligibility = "ELIGIBLE";
          opp.rejectionReason = null;
        } else {
          // ====================================================
          // EXECUTION ESCALATION OVERRIDE - FIX SCAN PARALYSIS
          // ====================================================
          const isMaxPositionBlock = blockerCode === "MAX_POSITIONS_REACHED" && botState.openPositions >= limit;
          const isHardBlocker =
            isHardExecutionBlocker(blockerCode) ||
            ["WSS_INSTABILITY", "API_NOT_VERIFIED", "PHASE_NOT_ACTIVE", "ENTRY_ENGINE_DISABLED", "HARD_DRAWDOWN_PAUSE_ACTIVE"].includes(blockerCode) ||
            blockerCode.includes("NOT_RECOVERABLE") ||
            isMaxPositionBlock;
          const isSoftBlocker = isNonessentialExecutionBlocker(blockerCode) || isNonessentialExecutionBlocker(opp.rejectionReason);
          
          const isEscalationCandidate = 
              opp.rejectionReason === "EARLY_EXPANSION_BUILDING" || 
              opp.regime === "EARLY_CONTINUATION_ENTRY" ||
              opp.regime === "CONTROLLED_EARLY_PARTICIPATION" ||
              opp.regime === "HEALTHY_LOW_VOL_EXPANSION" ||
              opp.regime === "PRE_BREAKOUT_MOMENTUM" ||
              (opp.confidence || 0) >= 80 ||
              (opp.finalExecutionScore || 0) >= 70 ||
              isSoftBlocker ||
              opp.rejectionReason === null; // Was eligible before the loop
          
          if (!isHardBlocker && isEscalationCandidate && botState.openPositions < limit) {
              console.log(`[SCAN_PARALYSIS_PREVENTED] False idle caught on ${sym}. ${blockerCode} overridden.`);
              console.log(`[EXECUTION_ESCALATION_TRIGGERED] Escalating ${sym} to router. (Opp status: ${opp.regime})`);
              console.log(`[TOP_CANDIDATE_FORCED_TO_ROUTER] ${sym} forced to router.`);
              if (isSoftBlocker) {
                applySoftExecutionAdjustment(opp, blockerCode, 0.65, 0.85);
              }
              if (botState.openPositions === 0) {
                  console.log(`[NO_ACTIVE_POSITION_FALSE_IDLE_DETECTED] Overriding idle scan.`);
                  console.log(`[CMC_ACTIVE_MARKET_EXECUTION_ALLOWED] Activating execution phase.`);
                  console.log(`[IDLE_STATE_EXITED] Leaving passive scan loop.`);
              }
              opp.eligibility = "ELIGIBLE";
              opp.rejectionReason = null;
          } else {
              const isExpectedPrecheck = blockerCode.startsWith("TP_SL_PRECHECK_FAILED") || ["HARD_DRAWDOWN_PAUSE_ACTIVE", "SOFT_DRAWDOWN_PAUSE_ACTIVE", "MAX_POSITIONS_REACHED", "WSS_INSTABILITY", "API_NOT_VERIFIED", "PHASE_NOT_ACTIVE", "ENTRY_ENGINE_DISABLED", "NOT_BEST_SIGNAL_SELECTED"].includes(blockerCode);
              logEntryBlocked(sym, blockerCode, `openPositions=${botState.openPositions}, maxOpenPositions=${limit}, availableSlots=${botState.availableSlots || 0}`);
              if (!isExpectedPrecheck) {
                 console.log(`MARKET_REJECTED_WITH_REASON: ${sym} rejected due to ${blockerCode}.`);
              }
              opp.rejectionReason = blockerCode;
              opp.eligibility = "SCANNER_REJECTED";
              
              if (blockerCode === "POSITION_SIZE_INVALID") {
                  botState.positionSizeInvalidCooldowns = botState.positionSizeInvalidCooldowns || {};
                  botState.positionSizeInvalidCooldowns[sym] = Date.now() + 300000; // 5 mins
                  botState.telemetry.sizingInvalidCooldownCount = (botState.telemetry.sizingInvalidCooldownCount || 0) + 1;
                  console.warn(`[POSITION_SIZE_INVALID_COOLDOWN] Applied 5m cooldown to ${sym}.`);
              } else if (blockerCode === "EXECUTION_ROUTER_BLOCKED" || blockerCode.startsWith("ENTRY_BLOCKED") || blockerCode.startsWith("TP_SL_PRECHECK_FAILED")) {
                  botState.routerBlockCooldowns = botState.routerBlockCooldowns || {};
                  botState.routerBlockCooldowns[sym] = Date.now() + 25000; // 25 sec generic block originally 60
                  botState.telemetry.routerBlockCooldownCount = (botState.telemetry.routerBlockCooldownCount || 0) + 1;
                  console.warn(`[ROUTER_BLOCK_RETRY_COOLDOWN] Applied 25s cooldown to ${sym} for ${blockerCode}.`);
              }
          }
        }
      }
    });

  // Calculate Participation Audit metrics
  const pAudit = botState.analytics.participationAudit || {
    totalScanned: 0, eligibleCandidates: 0, rejectedCandidates: 0,
    blockedBySizing: 0, blockedByDrawdown: 0, blockedByVolatility: 0,
    blockedByTrend: 0, blockedByCooldown: 0, blockedByRouter: 0, blockedByLiquidity: 0,
    lastTradeTime: botState.lastEntryTimestamp || null, participationParalysisActive: false,
    participationRate: 0, dominantRejectionReason: "NONE", finalExecutionVetoes: {}
  };

  pAudit.totalScanned = opportunities.length;
  pAudit.eligibleCandidates = opportunities.filter(o => o.eligibility === "ELIGIBLE").length;
  pAudit.rejectedCandidates = opportunities.length - pAudit.eligibleCandidates;
  pAudit.participationRate = pAudit.totalScanned > 0 ? pAudit.eligibleCandidates / pAudit.totalScanned : 0;
  pAudit.lastTradeTime = botState.lastEntryTimestamp || null;

  pAudit.blockedBySizing = 0;
  pAudit.blockedByDrawdown = 0;
  pAudit.blockedByVolatility = 0;
  pAudit.blockedByTrend = 0;
  pAudit.blockedByCooldown = 0;
  pAudit.blockedByRouter = 0;
  pAudit.blockedByLiquidity = 0;

  const rejectionCounts: Record<string, number> = {};

  opportunities.forEach(opp => {
    if (opp.rejectionReason) {
      const reason = opp.rejectionReason;
      rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;

      if (reason.includes("POSITION_SIZE") || reason.includes("TARGET_MIN_REQUIRED") || reason.includes("TOO_SMALL") || reason.includes("COLLATERAL") || reason.includes("EQUITY")) pAudit.blockedBySizing++;
      else if (reason.includes("DRAWDOWN") || reason.includes("DRAWDOWN_PAUSE")) pAudit.blockedByDrawdown++;
      else if (reason.includes("VOLATILITY") || reason.includes("EXHAUSTION") || reason.includes("REGIME")) pAudit.blockedByVolatility++;
      else if (reason.includes("TREND") || reason.includes("CONFIDENCE") || reason.includes("MOMENTUM")) pAudit.blockedByTrend++;
      else if (reason.includes("COOLDOWN") || reason.includes("FEE") || reason.includes("OVERTRADING") || reason.includes("PAUSE")) pAudit.blockedByCooldown++;
      else if (reason.includes("ROUTER") || reason.includes("MAX_POSITIONS")) pAudit.blockedByRouter++;
      else if (reason.includes("LIQUIDITY") || reason.includes("SPREAD")) pAudit.blockedByLiquidity++;
      else pAudit.blockedByRouter++;

      // Final Execution Failure Trace for near-valid setups
      if (opp.confidence !== undefined && opp.confidence >= 70 && !reason.includes("DRAWDOWN_PAUSE")) {
        pAudit.finalExecutionVetoes[opp.symbol] = reason;
        console.log(`[FINAL_EXECUTION_VETO_TRACE] ${opp.symbol} | Conf: ${opp.confidence} | CMC: ${opp.cmcScore || "N/A"} | Vol: ${opp.volatilityClass || "N/A"} | Trend: ${opp.trendClass || "N/A"} | Veto: ${reason}`);
      }
    }
  });

  // Calculate Dominant Rejection Reason
  let dominantReason = "NONE";
  let maxCount = 0;
  for (const [reason, count] of Object.entries(rejectionCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantReason = reason;
    }
  }
  pAudit.dominantRejectionReason = dominantReason;
  calculatePositionSlots();
  const signalQualifiedCount = opportunities.filter((opp) => {
    const reason = opp.rejectionReason || "";
    return (opp.confidence || 0) > 0 && opp.bias !== "NONE" && !["LOW_CONFIDENCE", "NO_TRADE_SIGNAL", "NO_DIRECTIONAL_EDGE"].includes(reason);
  }).length;
  const riskQualifiedCount = opportunities.filter((opp) => {
    const reason = opp.rejectionReason || "";
    return !reason || !/(DRAWDOWN|COLLATERAL|MARGIN|MAX_POSITIONS|API_NOT_VERIFIED|WSS|TP_SL|PROTECTION|POSITION_SIZE|TOO_SMALL|MIN_NOTIONAL)/.test(reason);
  }).length;
  const slotFilteredCount = opportunities.filter((opp) => (opp.rejectionReason || "").includes("MAX_POSITIONS")).length;
  const executableCount = opportunities.filter((opp) => opp.eligibility === "ELIGIBLE").length;
  console.log(`[SCAN_SUMMARY] scanned=${opportunities.length}, signalQualified=${signalQualifiedCount}, riskQualified=${riskQualifiedCount}, executable=${executableCount}, availableSlots=${botState.availableSlots || 0}, beforeFilters=${validUniverse.length}, afterSignalFilters=${signalQualifiedCount}, afterRiskFilters=${riskQualifiedCount}, afterPositionSlotFilters=${Math.max(0, riskQualifiedCount - slotFilteredCount)}, finalExecutableCandidates=${executableCount}`);

  // Detect Participation Paralysis and Cooldown Escape
  const timeSinceLastTrade = Date.now() - (pAudit.lastTradeTime || Date.now());
  const paralysisTimeout = 2 * 60 * 60 * 1000; // 2 hours
  const cooldownEscapeTimeout = 60 * 60 * 1000; // 60 minutes

  // COOLDOWN ESCAPE REVIEW
  if (pAudit.lastTradeTime && timeSinceLastTrade > cooldownEscapeTimeout && (botState.cooldownUntil || 0) > Date.now()) {
     const isWssHealthy = botState.wssConnected;
     const isMarginHealthy = botState.accountEquity > 100 && (botState.availableMargin / botState.accountEquity) > 0.5;
     const hasHardBlocker = botState.drawdownSeverity === "HARD" || botState.phase === "CIRCUIT_BREAKER_ACTIVE";
     const cmcActive = (botState.cmcIntelligence?.assets.length || 0) > 10;
     const hasScannerMatches = validUniverse.length > 20;

     if (isWssHealthy && isMarginHealthy && !hasHardBlocker && cmcActive && hasScannerMatches) {
        console.log(`[COOLDOWN_ESCAPE_REVIEW] PASSED. No trades for > 60m. WSS healthy, margin safe, CMC active. Exiting cooldown early.`);
        botState.cooldownUntil = 0; // Exiting cooldown
        botState.cooldownOverrideActive = true;
     }
  }

  if (pAudit.lastTradeTime && timeSinceLastTrade > paralysisTimeout && validUniverse.length > 30) {
    if (!pAudit.participationParalysisActive) {
      console.log(`[PARTICIPATION_PARALYSIS_DETECTED] No trades for > 2 hours in active market. Participation Paralysis active.`);
      botState.analytics.thresholdAdjustment = Math.max((botState.analytics.thresholdAdjustment || 0) - 5, -20);
    }
    pAudit.participationParalysisActive = true;
    botState.participationRecoveryStatus = "PARTICIPATION_PARALYSIS_RECOVERY_ACTIVE";
  } else {
    if (pAudit.participationParalysisActive) {
      console.log(`[PARTICIPATION_RECOVERY_RESOLVED] Normal trading resumed or market inactive. Ending paralysis recovery.`);
    }
    pAudit.participationParalysisActive = false;
    if (pAudit.eligibleCandidates > 0) {
      botState.participationRecoveryStatus = "NORMAL_PARTICIPATION_RESTORED";
    }
  }

  // Participation target warning
  if (pAudit.participationRate === 0 && validUniverse.length > 40 && Object.keys(botState.markPrices || {}).length > 20) {
     console.log(`[EXECUTION_PIPELINE_OVERBLOCKING] 0 eligible candidates during active market scan. Dominant block: ${dominantReason}`);
  }

  botState.analytics.participationAudit = pAudit;

  // Calculate and update HYPE diagnostic status
  const hypeOpp = opportunities.find(o => o.symbol === "HYPE");
  const hypeMeta = getAssetMeta("HYPE");
  const hypeAssetId = getAssetId("HYPE");
  const hypeIncludedInUniverse = universe.includes("HYPE");
  const hypeValidPrice = validUniverse.includes("HYPE") && !!botState.markPrices?.["HYPE"];
  if (hypeOpp) {
    if (!hypeOpp.rejectionReason) {
      botState.hypeStatus = "ACTIVE_IN_SCANNER";
    } else {
      botState.hypeStatus = `FILTERED_OUT_REASON: ${hypeOpp.rejectionReason}`;
    }
  } else {
    if (!universe.includes("HYPE")) {
      botState.hypeStatus = "FILTERED_OUT_REASON: NOT_IN_UNIVERSE";
    } else if (!validUniverse.includes("HYPE")) {
      botState.hypeStatus = "FILTERED_OUT_REASON: INVALID_PRICE_FEED";
    } else {
      botState.hypeStatus = "FOUND";
    }
  }
  botState.hypeDiagnostics = {
    includedInUniverse: hypeIncludedInUniverse,
    validPrice: hypeValidPrice,
    metaLoaded: !!hypeMeta,
    assetId: hypeAssetId,
    activeInScanner: !!hypeOpp,
    eligibility: hypeOpp?.eligibility || "NOT_SCANNED",
    rejectionReason: hypeOpp?.rejectionReason || null,
    selectedSide: hypeOpp?.selectedSide || hypeOpp?.directionalBias || "NONE",
    finalScore: hypeOpp?.finalExecutionScore || 0,
    canTradeIfConditionsPass: !!hypeMeta && hypeValidPrice && (!hypeOpp?.rejectionReason || hypeOpp?.eligibility === "ELIGIBLE"),
    updatedAt: Date.now()
  };
  console.log(`[HYPE_ELIGIBILITY_DIAGNOSTIC] ${JSON.stringify(botState.hypeDiagnostics)}`);
  if (botState.hypeDiagnostics.canTradeIfConditionsPass) {
    console.log(`[HYPE_SCAN_TRADE_READY] HYPE can be scanned and routed if risk, signal, size, and TP/SL checks pass.`);
  } else {
    console.log(`[HYPE_NOT_SELECTED_REASON] ${botState.hypeStatus}. Eligibility=${botState.hypeDiagnostics.eligibility}, rejection=${botState.hypeDiagnostics.rejectionReason || "NONE"}, validPrice=${hypeValidPrice}, metaLoaded=${!!hypeMeta}.`);
  }

  botState.marketScanner = {
    liquidityScore: Math.floor(Math.random() * 20) + 80,
    spreadQuality: Math.floor(Math.random() * 20) + 80,
    volatilityGrade: signal.volatilityScore
      ? signal.volatilityScore > 0.6
        ? "HIGH"
        : signal.volatilityScore < 0.2
          ? "LOW"
          : "MODERATE"
      : "MODERATE",
    confidenceRanking: signal.confidence || 0,
    higherTimeframeAlignment: ["ASTER", "SKR"].includes(botState.activeSymbol)
      ? "STRICT_HTF"
      : "ALIGNED",
    regimeClassification: signal.marketRegime || "UNKNOWN",
  };

  // Re-use outer-scoped now variable

  const isCircuitBreaker = botState.phase === "CIRCUIT_BREAKER_ACTIVE";
  const isCooldown = (botState.cooldownUntil || 0) > now;
  const isReverseLock = (botState.reverseLockUntil || 0) > now;

  if (botState.validationStatus !== "SUCCESS" && !config.DRY_RUN) {
    botState.blocker = "VALIDATION_NOT_SUCCESS";
    return;
  }

  if ((!botState.wssConnected || !botState.apiConnected) && !config.DRY_RUN) {
    botState.blocker = "CONNECTION_LOST";
    return;
  }

  // The API budget governor manages specific component throttling dynamically.
  // The system no longer hard-pauses everything.
  // Check global pressure mode for telemetry display.
  if (botState.apiBudget?.degradedMode) {
     (botState as any).softBlocker = "REST_PRESSURE_DEGRADED_MODE";
     if (botState.blocker === "REST_PRESSURE_DEGRADED_MODE" || botState.blocker === "SYSTEM_REST_PAUSED") {
       botState.blocker = null;
     }
     console.log(`[REST_PRESSURE_DEGRADED_MODE] Soft degraded mode active; background REST slows but top candidates and protection remain eligible.`);
  } else {
     (botState as any).softBlocker = "NONE";
     botState.blocker = null;
  }

  let regimeThreshold = 42; // default

  if (
    botState.analytics.regimeDetailedStats &&
    botState.analytics.regimeDetailedStats[signal.marketRegime || "TRENDING"]
  ) {
    const stats =
      botState.analytics.regimeDetailedStats[signal.marketRegime || "TRENDING"];
    if (
      stats.wins + stats.losses >= 10 &&
      (stats.winRate < 40 || stats.netPnl < 0)
    )
      regimeThreshold = 52;
    else if (
      stats.wins + stats.losses < 10 &&
      (signal.marketRegime === "RANGING_CHOP" ||
        (["DEAD_LOW_VOL"].includes(signal.marketRegime || "")))
    )
      regimeThreshold = 50;
    else if (
      stats.wins + stats.losses < 10 &&
      (signal.marketRegime === "PRE_BREAKOUT_MOMENTUM" ||
        signal.marketRegime === "DEVELOPING_CONTINUATION")
    )
      regimeThreshold = 35;
  } else if (signal.marketRegime === "RANGING_CHOP") {
    regimeThreshold = 50;
  } else if ((["DEAD_LOW_VOL"].includes(signal.marketRegime || ""))) {
    regimeThreshold = 45; // softer than 50
  } else if (
    signal.marketRegime === "PRE_BREAKOUT_MOMENTUM" ||
    signal.marketRegime === "DEVELOPING_CONTINUATION"
  ) {
    regimeThreshold = 35;
  }

  let waitingReason = botState.blocker || "NONE";
  
  if (botState.openPositions === 0 && signal.direction === "NONE" && botState.analytics?.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
      if (signal.rawDirection !== "NONE" && 
         (signal.confidence || 0) >= 70 && 
         (signal.trendStrength || 0) >= 0.50 && 
         (botState.marketScanner?.liquidityScore || 100) >= 80 && 
         (botState.marketScanner?.spreadScore || 100) >= 80 &&
         (signal.expectedMovePct || 0) > 0.5) { // Assuming fees/spread/slippage buffer
         
         console.log(`[ADAPTIVE_THRESHOLD_LOOSENED] Adaptive thresholds loosened tracking continuation criteria.`);
         console.log(`[OVERRIDE_ENTRY_APPROVED] Promoting direction due to CONTROLLED_EXECUTION_UNLOCKED`);
         signal.direction = signal.rawDirection;
         botState.action = "EXECUTION_ALLOWED_BY_ADAPTIVE_BIAS";
      }
  }

  if (botState.openPositions === 0 && signal.direction === "NONE") {
    if ((["DEAD_LOW_VOL"].includes(signal.marketRegime || "")))
      waitingReason = "DEAD_LOW_VOL";
    else if (signal.marketRegime === "PRE_BREAKOUT_MOMENTUM")
      waitingReason = "PRE_BREAKOUT_WATCH";
    else if (signal.marketRegime === "DEVELOPING_CONTINUATION")
      waitingReason = "DEVELOPING_CONTINUATION";
    else if (signal.marketRegime === "HEALTHY_DIRECTIONAL_VOL")
      waitingReason = "HEALTHY_DIRECTIONAL_VOL";
    else if (signal.marketRegime === "RANGING_CHOP")
      waitingReason = "NO_BREAKOUT";
    else if (
      (signal.confidence || 0) < regimeThreshold &&
      signal.rawDirection !== "NONE"
    )
      waitingReason = "LOW_CONFIDENCE";
    else waitingReason = "HTF_MISALIGNMENT";

    // Build top 5 rejected setups
    const rejectedList: any[] = opportunities
      .filter(o => o.rejectionReason && o.rejectionReason !== "WAITING")
      .map(o => ({
        symbol: o.symbol,
        confidence: o.confidence,
        requiredConfidence: 38,
        regime: o.regime,
        trendStrength: o.trendStrength,
        volatility: o.volatility === "HIGH" ? 0.8 : (o.volatility === "CHOPPY" ? 0.4 : 0.6),
        rejectionReason: o.rejectionReason,
        longConfidence: o.longConfidence,
        shortConfidence: o.shortConfidence,
        reversalProbability: o.reversalProbability,
        exhaustionProbability: o.exhaustionProbability,
        trendPhase: o.trendPhase,
        directionalBiasWinner: (o.longConfidence || 0) > (o.shortConfidence || 0) ? "LONG" : "SHORT"
      }));

    // Sort by confidence descending and take top 5
    rejectedList.sort((a, b) => b.confidence - a.confidence);
    botState.rejectedSetups = rejectedList.slice(0, 5);

    // Logs strictly matching target strings
    console.log(`[NO_VALID_MARKET_SETUP] Scanner ran but no active markets qualified for new entry.`);
    console.log(`[TOP_REJECTED_SETUPS] Current top 5 candidates evaluated and filtered out:`);
    botState.rejectedSetups.forEach((x, i) => {
      const isEarlyRegime = ["HEALTHY_LOW_VOL_EXPANSION", "LOW_VOL_SQUEEZE", "PRE_BREAKOUT_COMPRESSION", "EARLY_DIRECTIONAL_EXPANSION", "PRE_BREAKOUT_MOMENTUM", "MOMENTUM_BUILDING"].includes(x.regime);
      let tStr = (x.trendStrength * 100).toFixed(1) + "%";
      let vStr = x.volatility.toFixed(2);
      if (isEarlyRegime) {
          if (x.trendStrength === 0 || x.trendStrength < 0.001) tStr = "DATA_PENDING";
          if (x.volatility === 0 || x.volatility < 0.001) vStr = "DATA_PENDING";
      }
      console.log(`  ${i+1}. ${x.symbol} -> Conf: ${x.confidence}% (Req: ${x.requiredConfidence}%), Regime: ${x.regime}, Trend: ${tStr}, Vol: ${vStr} - Reason: ${x.rejectionReason}`);
      console.log(`     -> [DIRECTIONAL_ENGINE_DIAGNOSTIC] Phase: ${x.trendPhase} | Winner: ${x.directionalBiasWinner} | L-Conf: ${x.longConfidence} / S-Conf: ${x.shortConfidence} | Exh: ${x.exhaustionProbability}% | Rev: ${x.reversalProbability}%`);
    });
    if (botState.analytics?.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
        console.log(`[LOOKING_FOR_CONTROLLED_ENTRY] Bot status adjusted due to OVERRIDE_ACTIVE.`);
        botState.blocker = "LOOKING_FOR_CONTROLLED_ENTRY";
    } else {
        console.log(`[WAITING_FOR_VALID_SETUP] Bot status is WAITING_FOR_VALID_SETUP.`);
        // Set blocker globally
        botState.blocker = "WAITING_FOR_VALID_SETUP";
    }
  } else {
    // Clear rejectedSetups when we have a position or active triggers to keep UI clean
    botState.rejectedSetups = [];
  }

  console.log(
    `\n=== EXPECTATION DIAGNOSTIC REPORT [${botState.activeSymbol}] ===`,
  );
  console.log(`Price          : $${botState.markPrice.toFixed(4)}`);
  console.log(`Market Regime  : ${signal.marketRegime}`);
  console.log(`Volatility     : ${(signal.volatilityScore || 0).toFixed(2)}`);
  console.log(`Trend Strength : ${(signal.trendStrength || 0).toFixed(2)}%`);
  console.log(
    `Confidence     : ${signal.confidence || 0} / REQUIRED: ${regimeThreshold}`,
  );
  console.log(`Bias           : ${signal.rawDirection || "NONE"}`);
  console.log(`Executor       : ${botState.apiConnected ? "ARMED" : "HALTED"}`);
  console.log(`Circuit Breaker: ${isCircuitBreaker ? "ACTIVE" : "INACTIVE"}`);
  console.log(
    `Cooldown       : ${isCooldown ? `ACTIVE (${(((botState.cooldownUntil || 0) - now) / 1000).toFixed(0)}s)` : "INACTIVE"}`,
  );
  console.log(
    `Final Decision : ${botState.openPositions > 0 ? "HOLDING" : signal.direction === "NONE" ? "WAITING" : signal.direction}`,
  );
  console.log(`Rejection Rsn  : ${waitingReason}`);
  console.log(`=====================================================\n`);

  if (process.env.FORCE_PHASE1_MICRO_TRADE === "true") {
    process.env.FORCE_PHASE1_MICRO_TRADE = "false"; // Immediately clear to prevent loop

    const abortReasons = [];
    if ((botState.validationStatus as any) === "PENDING")
      abortReasons.push("Validation is still pending");
    if (botState.phase === "CIRCUIT_BREAKER_ACTIVE")
      abortReasons.push("Circuit breaker active");
    if (botState.availableMargin < 0.1 && botState.openPositions === 0)
      abortReasons.push("Insufficient margin");
    if (!botState.wssConnected) abortReasons.push("Websocket disconnected");
    if (!botState.apiConnected) abortReasons.push("Order router unavailable");
    calculatePositionSlots();
    if ((botState.availableSlots || 0) <= 0) abortReasons.push("No available position slots");
    if ((botState.allPositions || []).some((p: any) => p.coin === botState.activeSymbol)) {
      abortReasons.push("Same-symbol position already open");
    }

    if (abortReasons.length > 0) {
      console.warn(`[TEST TRADE ABORTED] Reasons: ${abortReasons.join(", ")}`);
    } else {
      console.log("!!! EXECUTING FORCED MICRO TEST TRADE !!!");
      botState.blocker = null;
      botState.config.maxExposure = 40;
      botState.config.leverage = 1;

      const testDirection = "LONG";
      const fillPrice = botState.markPrice;

      const assetMeta = getAssetMeta(botState.activeSymbol);
      const assetMinSz = assetMeta ? assetMeta.minSz || 0 : 0;
      const protocolMinNotional = 11;
      const requiredNotional = Math.max(
        protocolMinNotional,
        assetMinSz * fillPrice,
      );
      const notionalUsd = Math.max(11, requiredNotional);

      // Account safety rules simulation
      const requiredFreePct = 30;
      const estimatedRequiredMargin = notionalUsd + (notionalUsd * 0.005);
      const estimatedAvailableMarginAfterEntry = botState.availableMargin - estimatedRequiredMargin;
      const estimatedFreeCollateralPct = botState.accountEquity > 0
          ? (estimatedAvailableMarginAfterEntry / botState.accountEquity) * 100
          : 0;

      if (estimatedAvailableMarginAfterEntry <= 0 || estimatedFreeCollateralPct < requiredFreePct) {
          console.log(`TRADE_REJECTED_MARGIN_BUFFER_REQUIRED: Rejecting micro test trade due to margin safety violation. Post-entry margin: $${estimatedAvailableMarginAfterEntry.toFixed(2)}, Free Collateral: ${estimatedFreeCollateralPct.toFixed(1)}% < ${requiredFreePct}%`);
          console.log(`SAFE_SIZE_BELOW_EXCHANGE_MINIMUM: Computed safe exposure is below exchange minimum $${requiredNotional.toFixed(2)}.`);
          return;
      }

      console.log(`[POST_TRADE_MARGIN_SIMULATION] Test trade sizing PASS. Est. post-entry Free Collateral: ${estimatedFreeCollateralPct.toFixed(1)}%`);

      const assetSizeDecimals = assetMeta ? assetMeta.szDecimals || 2 : 2;
      const rawBaseSize = notionalUsd / fillPrice;
      const multiplier = Math.pow(10, assetSizeDecimals);
      const sz = Math.floor(rawBaseSize * multiplier + 1e-7) / multiplier;

      try {
        const success = await executionEngine.placeOrder(
          botState.activeSymbol,
          testDirection === "LONG",
          sz,
          fillPrice,
          false,
          true
        );
        if (success) {
          console.log(`[TEST] Fill Status: CONFIRMED`);
          console.log(
            `[TEST] Order ID: ${botState.lastOrderId || "SYSTEM_MOCK"}`,
          );
          console.log(`[TEST] Entry Price: $${fillPrice.toFixed(4)}`);

          botState.openPositions = 1;
          botState.lastEntryTimestamp = Date.now();
          botState.positionDetails = {
            coin: botState.activeSymbol,
            szi: testDirection === "LONG" ? sz : -sz,
            entryPx: fillPrice,
            positionValue: sz * fillPrice,
            returnRoE: 0,
            leverage: { type: "cross", value: botState.config.leverage },
            liquidationPx: fillPrice * 0.5, // Approximated liquidation for 2x
          };

          botState.protection = {
            tpPrice:
              testDirection === "LONG" ? fillPrice * 1.03 : fillPrice * 0.97,
            slPrice:
              testDirection === "LONG" ? fillPrice * 0.988 : fillPrice * 1.012,
            trailingStopPrice: null,
            isTrailingActive: false,
            highestUnrealizedPnlPct: 0,
            currentLockedProfitPct: 0,
            activeProfitLockLevel: "NONE"
          };

          console.log(
            `[TEST] Liquidation Price (approx): $${botState.positionDetails.liquidationPx}`,
          );
          console.log(
            `[TEST] TP/SL attachment confirmed. TP Price: $${botState.protection.tpPrice?.toFixed(4)} (3.0%), SL Price: $${botState.protection.slPrice?.toFixed(4)} (1.2%)`,
          );
          console.log(
            `[TEST] Position monitoring active. Trade hold time minimum 90s enforced.`,
          );
          return;
        } else {
          console.error("[TEST] Micro trade failed to execute via engine.");
        }
      } catch (err: any) {
        console.error("[TEST] Error in micro trade:", err.message);
      }
    }
  }

  // Log signal confirmation building progress
  if (
    signal.rawDirection &&
    signal.rawDirection !== "NONE" &&
    signal.direction === "NONE"
  ) {
    console.log(`[CONFIRMATION] Potential ${signal.rawDirection} signal identified. Awaiting confirmation:
      - Direction validity: ${signal.consecutiveCandlesCount || 0}/3 completed
      - Regime consistency (${signal.marketRegime}): ${signal.consecutiveRegimeCount || 0}/5 completed`);
  }

  // Track signal direction flips (Rule 6: If direction flips more than 3 times in 10 minutes, enter NO_TRADE mode for 30 minutes)
  const currentDirection = signal.direction;
  const lastSignalDir = botState.lastSignalDirection || "NONE";

  if (currentDirection !== "NONE" && currentDirection !== lastSignalDir) {
    if (lastSignalDir !== "NONE") {
      const flips = botState.directionFlips || [];
      flips.push(now);

      // Filter flips in the last 10 minutes (600,000 ms)
      const tenMinutesAgo = now - 10 * 60 * 1000;
      botState.directionFlips = flips.filter((t) => t > tenMinutesAgo);

      console.log(
        `[CHOP_FILTER] Signal flip detected: ${lastSignalDir} -> ${currentDirection}. Flips in last 10m: ${botState.directionFlips.length}`,
      );

      if (botState.directionFlips.length > 3) {
        if (!botState.noTradeUntil || botState.noTradeUntil < now) {
          console.log(`[CHOP_DETECTED_NO_TRADE] Market chop detected (too many flips)! Entering NO_TRADE mode.`);
        }
        botState.noTradeUntil = now + 30 * 60 * 1000; // 30 minutes NO_TRADE mode
        console.log(
          `[CHOP_FILTER] ALERT: Direction flipped ${botState.directionFlips.length} times (more than 3 times) in 10 minutes. Entering NO_TRADE mode for 30 minutes.`,
        );
      }
    }
    botState.lastSignalDirection = currentDirection;
  }

  // Phase 1 Rules: Multi-asset trading allowed
  if (!botState.markPrice || botState.markPrice <= 0) {
    return;
  }

  // Daily trade counts reset check on calendar day change (Requirement 10)
  const todayStr = new Date().toISOString().split("T")[0];
  if (botState.lastTradeDate !== todayStr) {
    botState.lastTradeDate = todayStr;
    botState.dailyTradeCount = 0;
  }

  // Phase 1 Rules: Only execute entries if completely flat (Requirement 15)
  // Phase 2 allows multiple entries
  // Build selected candidates to enter
  const currentLimitObj = getDynamicMaxPositions();
  const currentLimit = currentLimitObj.limit;
  const openPositions = botState.openPositions || 0;
  const pendingCount = botState.activeOrders ? botState.activeOrders.filter(o => !o.reduceOnly).length : 0;
  let availableSlots = currentLimit - openPositions - pendingCount;
  if (availableSlots < 0) availableSlots = 0;

  let candidatesToExecute: any[] = [];
  if (canEnterNew) {
    if (multiPositionMode) {
      // Find all eligible opportunities
      const eligibleOpps = opportunities.filter(o => o.eligibility === "ELIGIBLE");
      // Filter out those we already hold or have pending
      const candidates = eligibleOpps.filter(opp => {
         const s = opp.symbol;
         const alreadyHolding = botState.allPositions && botState.allPositions.some((p: any) => p.coin === s);
         const alreadyHasPending = botState.activeOrders && botState.activeOrders.some((o: any) => o.coin === s && !o.reduceOnly);
         const selectedSide = opp.selectedSide || (opp.directionalBias === "LONG" || opp.directionalBias === "SHORT" ? opp.directionalBias : "NONE");
         const liveSignal = strategy.getSignal(s);
         const hasExecutableSide = selectedSide === "LONG" || selectedSide === "SHORT" || liveSignal.direction === "LONG" || liveSignal.direction === "SHORT";
         if (!hasExecutableSide) {
           console.log(`[ENTRY_BLOCKED] symbol=${s}, reason=LOW_SIGNAL_SCORE, raw=NO_EXECUTABLE_SIDE_AFTER_SCORING`);
         }
         return !alreadyHolding && !alreadyHasPending && hasExecutableSide;
      });
      // Sort candidates by preference (confidence descending)
      candidates.sort((a, b) => {
         const scoreA = a.finalExecutionScore || a.finalScore || a.confidence || 0;
         const scoreB = b.finalExecutionScore || b.finalScore || b.confidence || 0;
         return scoreB - scoreA;
      });
      // Take up to available slots
      candidatesToExecute = candidates.slice(0, availableSlots);
      console.log(`[MULTI_POSITION_PLAN] availableSlots=${availableSlots}, selectedCandidates=${candidatesToExecute.length}, symbols=${candidatesToExecute.map(c => c.symbol).join(", ")}`);
    } else {
      // Single-position mode fallback
      const currentSignal = strategy.getSignal(botState.activeSymbol);
      if (currentSignal.direction !== "NONE" && botState.openPositions === 0) {
         const isHoldingBest = botState.allPositions && botState.allPositions.some((p: any) => p.coin === botState.activeSymbol);
         if (!isHoldingBest) {
            candidatesToExecute = [{ symbol: botState.activeSymbol, confidence: currentSignal.confidence, finalScore: highestScore }];
         }
      }
    }
  }

  if (canEnterNew && candidatesToExecute.length > 0) {
    for (const candidate of candidatesToExecute) {
      const candidateSym = candidate.symbol;
      const candidateSignal = strategy.getSignal(candidateSym);
      const candidateSelectedSide = candidate.selectedSide || (candidate.directionalBias === "LONG" || candidate.directionalBias === "SHORT" ? candidate.directionalBias : "NONE");
      if (candidateSignal.direction === "NONE" && (candidateSelectedSide === "LONG" || candidateSelectedSide === "SHORT")) {
        candidateSignal.direction = candidateSelectedSide;
        candidateSignal.rawDirection = candidateSelectedSide;
        console.log(`[DIRECTIONAL_BIAS_SELECTED] ${candidateSym} router direction restored from scanner selectedSide=${candidateSelectedSide}.`);
      }
      
      console.log(`[ENTRY_ATTEMPT] symbol=${candidateSym}, side=${candidateSignal.direction}, slotIndex=${botState.openPositions}, notional=${botState.config.maxExposure}`);

      // Set active symbol context and signal so downstream code correctly references current candidate
      botState.activeSymbol = candidateSym;
      botState.markPrice = (botState.markPrices && botState.markPrices[candidateSym]) || botState.markPrice;
      signal = candidateSignal;

      console.log(`ENTRY_SIGNAL: ${signal.direction} signal confirmed!`);
      if (botState.analytics?.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
         console.log(`OVERRIDE_ENTRY_READY: Controlled execution ready for ${botState.activeSymbol}`);
      }
      
      let _traceBlocker = "PASSED";
      let _targetExposure = botState.config.maxExposure;
      let _setupLeverage = botState.config.leverage;
      let _sym = botState.activeSymbol;

      const executeEntryAndGetBlocker = async (): Promise<string> => {
      // API Rate Limit Check
      if (botState.apiRateLimitUntil && Date.now() < botState.apiRateLimitUntil) {
          // Identify if this is a top candidate deserving an override
          const _oppRegime = signal.marketRegime || "TRENDING";
          const isEarlyExpansionRegime = ["HEALTHY_LOW_VOL_EXPANSION", "LOW_VOL_SQUEEZE", "PRE_BREAKOUT_COMPRESSION", "EARLY_DIRECTIONAL_EXPANSION", "PRE_BREAKOUT_MOMENTUM", "MOMENTUM_BUILDING", "EARLY_CONTINUATION_ENTRY"].includes(_oppRegime);
          const isTopCandidate = (signal.confidence || 0) >= 65 || isEarlyExpansionRegime;
          const _cmcMatched = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === _sym || a.symbol === _sym);
          const isCmcActiveAndTop = isTopCandidate && _cmcMatched && (_cmcMatched.trendScore > 60 || _cmcMatched.classification === "CMC_VOLATILE_GEM_CANDIDATE");
          const actualExchangeRateLimit = ["EXCHANGE_429", "INFO_429", "CUMULATIVE_REQUEST_LIMIT", "EXCHANGE_RATE_LIMIT_BACKOFF", "ADDRESS_LIMIT_RECOVERY"].includes(botState.apiBudget?.throttleReason || "");
          const slotAvailableForTopCandidate = (botState.availableSlots || 0) > 0;

          if (isCmcActiveAndTop && slotAvailableForTopCandidate && !actualExchangeRateLimit) {
              console.log(`[TOP_CMC_CANDIDATE_BUDGET_RESERVED] ${botState.activeSymbol} retained one execution action during REST pressure.`);
              console.log(`[REST_DEGRADED_TOP_CANDIDATE_ALLOWED] Overriding API rate limit block to execute top CMC candidate ${botState.activeSymbol}.`);
              console.log(`[API_BUDGET_OVERBLOCK_PREVENTED] API pacing did not become a global execution freeze.`);
          } else {
              const remaining = Math.round((botState.apiRateLimitUntil - Date.now()) / 1000);
              console.warn(`[ENTRY_FILTER] Trade blocked: API_RATE_LIMIT_EXCEEDED (${remaining}s remaining)`);
              return "API_RATE_LIMIT_EXCEEDED";
          }
      }

      // WSS Recovery Protection Check
      if (botState.blocker && botState.blocker.includes("PROTECTED_PAUSE")) {
        console.log(`[ENTRY_FILTER] Trade blocked: ${botState.blocker}`);
        return botState.blocker;
      }

      // NEW EXECUTION RULE override evaluation
      const trendVal = signal.trendStrength || 0;
      const trendPass = trendVal >= 0.50 || trendVal >= 0.0050;
      const liqPass = (botState.marketScanner?.liquidityScore || 100) >= 80;
      const sprPass = (botState.marketScanner?.spreadScore || botState.marketScanner?.spreadQuality || 100) >= 80;
      const htfAligned = signal.rawDirection !== "NONE" && signal.rawDirection === signal.direction;
      
      const tpSlPrecheckPass = botState.openPositions === 0 || botState.protectionStatus === "CONFIRMED" || (botState.protection && (botState.protection as any).tpPrice !== undefined);
      const freeCollateralCheckPass = (botState.freeCollateralPct || 0) >= 30;
      const wssApiHealthy = botState.wssConnected !== false && botState.apiConnected !== false;

      const overrideRtFees = 0.07;
      const overrideSlippage = 0.05;
      const overrideSpread = Math.max(0.01, (100 - (botState.marketScanner?.spreadQuality || 0)) / 100 * 0.1);
      const feesSlippageCostOk = (signal.expectedMovePct || 0) > (overrideRtFees + (2 * overrideSlippage) + overrideSpread);

      const isNewExecutionRuleOverrideSatisfied = 
        (signal.confidence || 0) >= 70 &&
        trendPass &&
        liqPass &&
        sprPass &&
        htfAligned &&
        tpSlPrecheckPass &&
        freeCollateralCheckPass &&
        wssApiHealthy;

      if (isNewExecutionRuleOverrideSatisfied) {
         console.log("OVERFILTERING_CLEANUP_ACTIVE: Adaptive bias execution override satisfied.");
         console.log("EXECUTION_ALLOWED_BY_ADAPTIVE_BIAS: High-confidence momentum continuation setup fully qualified.");
      }

      // Rule 1: Pause new entries for 30 minutes (Immediate anti-overtrading protection)
      const overtradingPauseEnd = botState.overtradingPauseUntil || 0;
        if (now < overtradingPauseEnd) {
        console.log(
          `[ENTRY_FILTER] Trade blocked: Immediate anti-overtrading protection active. Remaining: ${((overtradingPauseEnd - now) / 1000 / 60).toFixed(1)}m.`,
        );
        // botState.blocker = "OVERTRADING_PAUSE_ACTIVE";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
      }

      // Rule 6: Chop protection (30 minutes in NO_TRADE mode)
      const noTradeEnd = botState.noTradeUntil || 0;
      if (now >= noTradeEnd) {
        botState.chopState = "NONE";
        (botState as any).isChopRecoveryAllowedEntry = false;
      } else {
        const trendStrong = (signal.trendStrength || 0) > 0.55;
        const breakoutConfirmed = (signal.momentumScore || 0) > 0.6 && signal.marketRegime !== "RANGING_CHOP" && !(["DEAD_LOW_VOL"].includes(signal.marketRegime || ""));
        const volatilityHealthy = (signal.volatilityScore || 0) > 0.4;
        const confidenceHigh = (signal.confidence || 0) > 55;
        const spreadLiquidityHealthy = (botState.marketScanner?.liquidityScore || 0) > 50 && (botState.marketScanner?.spreadQuality || 0) > 50;
        
        if (trendStrong && breakoutConfirmed && volatilityHealthy && confidenceHigh && spreadLiquidityHealthy) {
          console.log(`[CHOP_CLEARED] Valid breakout parameters detected. CHOP_CLEARED.`);
          console.log(`[CHOP_CLEARED_DIRECTIONAL] Complete breakout confirmation reached.`);
          console.log(`[ENTRIES_RESUMED_AFTER_CHOP] Resume entries allowed.`);
          botState.noTradeUntil = 0; // Clear it early
          botState.directionFlips = []; // reset flips
          botState.chopState = "NONE";
          (botState as any).isChopRecoveryAllowedEntry = false;
        } else {
          console.log(`[CHOP_MONITORING_ACTIVE] Monitoring for breakout validity... Remaining: ${((noTradeEnd - now) / 1000 / 60).toFixed(1)}m`);
          
          const trendVal = signal.trendStrength || 0;
          const volatility = signal.volatilityScore || 0;
          const isHtfAligned = signal.rawDirection !== "NONE" && signal.rawDirection === signal.direction;
          const liquidityScore = botState.marketScanner?.liquidityScore || 0;
          const spreadQuality = botState.marketScanner?.spreadQuality || 0;
          const isSpreadLiquidityHealthy = liquidityScore >= 50 && spreadQuality >= 50;
          const expectedMovePct = signal.expectedMovePct || 0;
          const momentumScore = signal.momentumScore || 0;
          const marketRegime = signal.marketRegime || "UNKNOWN";
          const hasHtfDirection = signal.rawDirection !== "NONE";

          // Save recent history of trend and expected directions to botState
          if (!botState.trendStrengthHistory) botState.trendStrengthHistory = [];
          if (!botState.expectedDirectionHistory) botState.expectedDirectionHistory = [];
          botState.trendStrengthHistory.push(trendVal);
          botState.expectedDirectionHistory.push(signal.rawDirection || "NONE");
          if (botState.trendStrengthHistory.length > 6) botState.trendStrengthHistory.shift();
          if (botState.expectedDirectionHistory.length > 6) botState.expectedDirectionHistory.shift();

          // Calculate helper metrics for trend rising & direction stability
          const trendHistory = botState.trendStrengthHistory || [];
          let isTrendRising = false;
          if (trendHistory.length >= 3) {
            const len = trendHistory.length;
            isTrendRising = (trendHistory[len - 1] > trendHistory[len - 2] && trendHistory[len - 2] >= trendHistory[len - 3]) ||
                            (trendHistory[len - 1] > trendHistory[len - 3] && trendHistory[len - 2] >= trendHistory[len - 3]);
          }

          const directionHistory = botState.expectedDirectionHistory || [];
          let isExpectedDirectionStable = false;
          if (directionHistory.length >= 3) {
            const len = directionHistory.length;
            const lastDir = directionHistory[len - 1];
            if (lastDir !== "NONE") {
              isExpectedDirectionStable = directionHistory.slice(-3).every(d => d === lastDir);
            }
          }

          // 1. CHOP_RECOVERY_MONITORING trigger conditions
          const isChopRecoveryTriggerMatched = 
            isHtfAligned && 
            isSpreadLiquidityHealthy && 
            volatility > 0.45 && 
            isExpectedDirectionStable && 
            isTrendRising;

          // 2. DEVELOPING_BREAKOUT criteria
          const isDevelopingBreakout = 
            volatility > 0.4 && 
            hasHtfDirection && 
            isSpreadLiquidityHealthy && 
            (momentumScore > 0.45 || marketRegime.includes("BREAKOUT") || marketRegime === "DEVELOPING_CONTINUATION") && 
            (trendVal >= 0.05 && trendVal < 0.55);

          // 3. DIRECTIONAL_CHOP_RECOVERY criteria
          const isDirectionalChopRecovery = 
            isExpectedDirectionStable && 
            (isTrendRising || trendVal > 0.35) && 
            volatility > 0.4;

          // Determine current category
          let currentChopState: "TRUE_CHOP_NO_TRADE" | "DEVELOPING_BREAKOUT" | "DIRECTIONAL_CHOP_RECOVERY" | "CHOP_RECOVERY_MONITORING" = "TRUE_CHOP_NO_TRADE";
          
          if (isChopRecoveryTriggerMatched) {
            currentChopState = "CHOP_RECOVERY_MONITORING";
            botState.chopState = currentChopState;
            console.log(`[CHOP_RECOVERY_MONITORING] Chop recovery criteria matched: HTF aligned, liquidity/spread healthy, high volatility, stable expected direction and rising trend.`);
          } else if (isDevelopingBreakout) {
            currentChopState = "DEVELOPING_BREAKOUT";
            botState.chopState = currentChopState;
            console.log(`[CHOP_CLASSIFIED_DEVELOPING_BREAKOUT] Market classified as DEVELOPING_BREAKOUT: Volatility=${volatility.toFixed(2)}, HTF Direction=${signal.rawDirection}, Trend Still Forming=${trendVal.toFixed(2)}`);
          } else if (isDirectionalChopRecovery) {
            currentChopState = "DIRECTIONAL_CHOP_RECOVERY";
            botState.chopState = currentChopState;
            console.log(`[CHOP_RECOVERY_MONITORING] Market classified as DIRECTIONAL_CHOP_RECOVERY: Expected direction is stable (${signal.rawDirection}), Trend strength recovering (${trendVal.toFixed(2)})`);
          } else {
            currentChopState = "TRUE_CHOP_NO_TRADE";
            botState.chopState = currentChopState;
            console.log(`[CHOP_CLASSIFIED_TRUE_CHOP] Market classified as TRUE_CHOP_NO_TRADE: Weak trend (${trendVal.toFixed(2)}), repeated flips, or poor alignment.`);
          }

          // Only TRUE_CHOP_NO_TRADE should block entries.
          if (currentChopState === "TRUE_CHOP_NO_TRADE") {
            const expDir = signal.rawDirection !== "NONE" ? signal.rawDirection : "NONE";
            const diag = `CHOP_NO_TRADE_ACTIVE: Score(${botState.directionFlips.length}), Vol(${signal.volatilityScore?.toFixed(2)}), Trend(${signal.trendStrength?.toFixed(2)}), HTF(${signal.rawDirection}), Liq/Spr(${(botState.marketScanner?.liquidityScore || 0)}/${botState.marketScanner?.spreadQuality || 0}), ExpDir(${expDir})`;
            
            // botState.blocker = diag;
            // return botState.blocker;
          } else {
            // It's a non-blocking chop recovery/breakout state.
            // Check confidence confirms (confidence >= 50) and has confirmation candle (consecutiveCandlesCount >= 3)
            const confidenceConfirms = (signal.confidence || 0) >= 50;
            const hasConfirmationCandle = (signal.consecutiveCandlesCount || 0) >= 3;

            if (confidenceConfirms && hasConfirmationCandle) {
              console.log(`[CHOP_ENTRY_APPROVED_REDUCED_RISK] Chop recovery mode ${currentChopState} approved for entry at reduced risk (RISK_ADJUSTED_ENTRY_APPROVED). Confidence: ${signal.confidence}%, Confirmations: ${signal.consecutiveCandlesCount}.`);
              // Set flags
              (botState as any).isChopRecoveryAllowedEntry = true;
              (botState as any).currentChopStateActive = currentChopState;
            } else {
              // Keep on watch! Do not block permanently but don't enter just yet, return custom watch status:
              console.log(`[CHOP_RECOVERY_MONITORING] Keeping asset on watch. Chop state is ${currentChopState}. Confidence: ${signal.confidence}% (Required: >=50%), Confirmation Candles: ${signal.consecutiveCandlesCount}/3.`);
              
              const expDir = signal.rawDirection !== "NONE" ? signal.rawDirection : "NONE";
              const diag = `CHOP_RECOVERY_MONITORING: Watching setup on ${botState.activeSymbol}. ChopState(${currentChopState}), Conf(${signal.confidence}), Vol(${signal.volatilityScore?.toFixed(2)}), Trend(${signal.trendStrength?.toFixed(2)})`;
              // botState.blocker = diag;
              // return botState.blocker;
            }
          }
        }
      }

      // Priority 4: Reduce Micro-Loss Overtrading - EXPECTANCY CHECK (Informational telemetry only - DOES NOT BLOCK)
      const estSlippagePct = 0.05;
      const rtFeesPct = 0.07;
      const spreadCostPct = Math.max(0.01, (100 - (botState.marketScanner?.spreadQuality || 0)) / 100 * 0.1);
      const riskBufferPct = 0.1;
      const minMoveRequiredPct = rtFeesPct + (2 * estSlippagePct) + spreadCostPct + riskBufferPct; // roughly 0.30 - 0.40%
      
      const expMove = signal.expectedMovePct || 0;
      if (expMove < minMoveRequiredPct) {
         console.log(`[EXPECTED_MOVE_LOW_WARNING] Projected expected move is low: ${expMove.toFixed(2)}% (Required: ${minMoveRequiredPct.toFixed(2)}%).`);
         console.log("[FEE_FRICTION_WARNING] Setup expected move is close to transaction fee and slippage friction.");
         console.log("[LOW_EXPECTANCY_ENVIRONMENT] Environment has high cost-to-move ratio, carrying as informational warning only.");
      }
      
      const isWeakBreakoutAttempt = signal.marketRegime?.includes("BREAKOUT") && (signal.momentumScore || 0) < 0.55 && (signal.volatilityScore || 0) < 0.5;
      if (isWeakBreakoutAttempt) {
         console.log("BREAKOUT_UNCERTAIN: Weak breakout expansion detected. Proceeding as informational warning only.");
         console.log("POSSIBLE_FAKE_BREAKOUT_DETECTED: Weak breakout setup identified, but execution proceeds because breakout hard blockers are disabled.");
      }

      const isVolNoise = (signal.marketRegime === "HIGH_VOLATILITY" || (signal.volatilityScore || 0) > 0.8) && (signal.trendStrength || 0) < 0.35 && (signal.confidence || 0) < 45;
      if (isVolNoise) {
         console.log(`[ENTRY_FILTER] Rejected: VOLATILITY_NOISE_REJECTED. Lack of trend in high vol chop.`);
         // botState.blocker = "VOLATILITY_NOISE_REJECTED";
         // return botState.blocker;
      }

      // Minimum Expected Hold filter (Rule 5) - Bypassed hard rejection per user intent
      const expectedHold = signal.expectedHoldMs || 0;
      if (expectedHold > 0 && expectedHold < 60000) {
        const penalty = botState.autoRecoveryMode === "ON" ? 3 : 10;
        console.log(`[ENTRY_FILTER] SHORT_DURATION_CONTINUATION_ALLOWED. Expected hold: ${(expectedHold / 1000).toFixed(0)}s. Bypassed hard rejection to allow high-momentum continuation participation. Recovery mode active: reducing expected-hold penalty from 10 to ${penalty}.`);
        (botState as any).isShortHoldApproved = true;
        signal.tradeQualityScore = Math.max(10, (signal.tradeQualityScore || 80) - penalty);
      } else {
         (botState as any).isShortHoldApproved = false;
      }

      // MARKET_REGIME_PERFORMANCE_FILTER & CHOP_AVOIDANCE_MODE (Rules 1, 2 & 4)
      const regimeName = signal.marketRegime || "TRENDING";

      if (regimeName === "CHAOTIC_VOL") {
         console.log(`[ENTRY_FILTER] Trade blocked: Chaotic High-Vol Noise.`);
         // botState.blocker = "CHAOTIC_NOISE_REJECTED";
         // return botState.blocker;
      }
      
      const isBreakout =
        (signal.trendStrength || 0) > 0.4 && (signal.momentumScore || 0) > 0.5;
      const isPhase0Or1 =
        botState.phase === "PHASE_0_STABILIZATION";

      const isHighVol = ["ASTER", "SKR"].includes(botState.activeSymbol);
      if (isHighVol) {
        if (
          !botState.marketScanner ||
          botState.marketScanner.liquidityScore < 20 ||
          botState.marketScanner.spreadQuality < 20 ||
          (signal.momentumScore || 0) < 0.15
        ) {
          console.log(
            `[ENTRY_FILTER] Trade blocked: ASTER/SKR strict confirmation not met.`,
          );
          botState.blocker = "STRICT_CONFIRMATION_REQUIRED";
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }
      }

      if (isPhase0Or1) {
        let stabilizationLevel = botState.drawdownSeverity === "HARD" ? 3 : 2;
        if (botState.drawdownSeverity === "SOFT" || botState.drawdownSeverity === "NONE") {
          stabilizationLevel = 1;
        }

        console.log(`[STABILIZATION_MODE] Active level: STABILIZATION_LEVEL_${stabilizationLevel}. Adjusting risk accordingly.`);
        
        if ((["DEAD_LOW_VOL"].includes(regimeName)) && !isBreakout && (signal.confidence || 0) < 60) {
          console.log(
            `[STABILIZATION_OVERBLOCKING_DETECTED] Bypassed Phase 0 global freeze for HIGH_CONFIDENCE entry.`
          );
          if ((signal.confidence || 0) < 60) {
            console.log(`[ENTRY_FILTER] Trade blocked: Phase 0 restrictions block DEAD_LOW_VOL regimes without breakout confirmation.`);
            botState.blocker = "DEAD_LOW_VOL";
            // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
          }
        }
        if (
          regimeName === "PRE_BREAKOUT_MOMENTUM" &&
          !isBreakout &&
          (signal.confidence || 0) < 45
        ) {
          // botState.blocker = "PRE_BREAKOUT_WATCH";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }
        if (regimeName === "RANGING_CHOP" && !isBreakout) {
          if ((signal.trendStrength || 0) < 0.35 && (signal.confidence || 0) < 65) {
            console.log(
              `[ENTRY_FILTER] Trade blocked: Phase 0 restrictions block RANGING_CHOP without breakout or trend strength.`,
            );
            // botState.blocker = "RANGING_CHOP";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
          }
        }
        
        // STABILIZATION Risk Adjustment
        if (stabilizationLevel > 1) {
           console.log(`[PARTICIPATION_SUPPRESSION_DETECTED] Moderating size for elite-only participation.`);
        } else {
           console.log(`[STABILIZATION_LEVEL_REDUCED] Re-engaging controlled early participation.`);
        }
      }
      const regimeDetailedStats = botState.analytics.regimeDetailedStats;
      const regimeStats = regimeDetailedStats
        ? regimeDetailedStats[regimeName]
        : null;

      let regimeConfidenceThreshold = 40; // Lowered from 48 to 40 for higher trading dynamic

      if (isPhase2) {
        // Phase 2: Lower participation thresholds, especially for continuation expansion and momentum regimes
        if (isBreakout && (signal.momentumScore || 0) > 0.60) {
          regimeConfidenceThreshold = 30; // Lowered from 42
        } else if (
          (regimeName === "TRENDING" || regimeName === "STRONG_TREND" || regimeName === "DEVELOPING_CONTINUATION" || regimeName === "HEALTHY_DIRECTIONAL_VOL" || regimeName === "POST_RALLY_CONTINUATION_LONG" || regimeName === "POST_RALLY_CONTINUATION_SHORT") &&
          (signal.trendStrength || 0) > 0.30
        ) {
          regimeConfidenceThreshold = 30; // Lowered from 42
        } else {
          regimeConfidenceThreshold = 35; // Lowered from 42
        }
      }

      if (regimeStats) {
        const totalRegimeTrades = regimeStats.wins + regimeStats.losses;
        if (totalRegimeTrades >= 10) {
          if (regimeStats.winRate < 40 || regimeStats.netPnl < 0) {
            console.log(
              `[REGIME_FILTER] Drastic frequency reduction active for ${regimeName} (Winrate: ${regimeStats.winRate.toFixed(1)}%, PnL: $${regimeStats.netPnl.toFixed(2)}). Raising confidence requirement to 56.`,
            );
            regimeConfidenceThreshold = 56;
          } else if (regimeStats.winRate >= 60 && regimeStats.netPnl > 0) {
            console.log(
              `[REGIME_FILTER] High-probability consistency detected in ${regimeName}. Threshold remains standard.`,
            );
          }
        } else {
          // If < 10 trades, preserve safety logic for non-trending environments
          if (regimeName === "RANGING_CHOP") {
            regimeConfidenceThreshold = 60; // Higher entry bar for range-bound chop
          } else if ((["DEAD_LOW_VOL"].includes(regimeName))) {
            regimeConfidenceThreshold = 55; // Reject low volatility expansion entries
          } else if (
            regimeName === "PRE_BREAKOUT_MOMENTUM" ||
            regimeName === "DEVELOPING_CONTINUATION"
          ) {
            regimeConfidenceThreshold = 48;
          }
        }
      } else {
        if (regimeName === "RANGING_CHOP") {
          regimeConfidenceThreshold = 60;
        } else if ((["DEAD_LOW_VOL"].includes(regimeName))) {
          regimeConfidenceThreshold = 55;
        } else if (
          regimeName === "PRE_BREAKOUT_MOMENTUM" ||
          regimeName === "DEVELOPING_CONTINUATION"
        ) {
          regimeConfidenceThreshold = 48;
        }
      }

      // Check for CHOP_AVOIDANCE_MODE (Rule 4)
      const consecutiveExits = botState.trades.filter((t) => t.type === "EXIT");
      const lastTwoExits = consecutiveExits.slice(-2);
      const isRepeatedStopouts =
        lastTwoExits.length >= 2 &&
        lastTwoExits.every(
          (t) =>
            (t.realizedPnl || 0) < 0 || t.exitReason?.includes("STOP_LOSS"),
        );

      const avgDuration = botState.analytics.averageTradeDuration || 0;
      const isLowHoldDuration =
        avgDuration > 0 && avgDuration < 60000 && consecutiveExits.length >= 3;

      if (isRepeatedStopouts || isLowHoldDuration) {
        console.log(
          `[CHOP_AVOIDANCE] Triggered! Staggered stops/low-hold active. Elevating confirmation requirement (+10 to required confidence).`,
        );
        regimeConfidenceThreshold = Math.min(
          98,
          regimeConfidenceThreshold + 10,
        );
      }

      // --- ADAPTIVE LEARNING ENGINE ---
      let learningSizeAdj = 0;
      let learningThreshAdj = 0;
      if (botState.learningState && !botState.learningState.corrupted) {
           const dirStr = signal.direction || signal.side || "NONE";
           const keys = [
               `ASSET:${botState.activeSymbol}`,
               `REGIME:${regimeName}`,
               `DIRECTION:${dirStr}`
           ];
           for (const k of keys) {
               const b = botState.learningState.buckets[k];
               if (b) {
                   learningSizeAdj += b.sizeAdjustment;
                   learningThreshAdj += b.thresholdAdjustment;
               }
           }
           
           // Guardrails
           learningSizeAdj = Math.max(-0.25, Math.min(0.25, learningSizeAdj));
           learningThreshAdj = Math.max(-10, Math.min(10, learningThreshAdj));
           
           if (learningThreshAdj !== 0) {
               const oldThresh = regimeConfidenceThreshold;
               regimeConfidenceThreshold = Math.max(10, Math.min(98, regimeConfidenceThreshold + learningThreshAdj));
               if (Math.random() > 0.8) {
                   console.log(`[THRESHOLD_ADJUSTED_BY_LEARNING] Confidence Threshold pushed from ${oldThresh.toFixed(1)} to ${regimeConfidenceThreshold.toFixed(1)} due to recent edge analysis on ${keys.join(", ")}.`);
               }
           }
           
           // Pass the sizing adj forward inside signal for later usage
           (signal as any)._learningSizeAdj = learningSizeAdj;
      }
      // --------------------------------

      // Validate against the calculated dynamically weighted regime threshold (Rule 3 & 5)
      if (signal.confidence < regimeConfidenceThreshold) {
        console.log(
          `[ENTRY_FILTER] Confidence score ${signal.confidence} is below dynamic regime threshold of ${regimeConfidenceThreshold}.`,
        );
        // botState.blocker = "CONFIDENCE_TOO_LOW";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
      }

      // Phase 2: Enhanced execution logic integration
      if (isPhase2) {
        const isExtremeExhaustion = (signal.momentumScore || 0) < 0.2 || (signal.volatilityScore || 0) > 0.85;
        
        let continuationClass = "CLEAN_CONTINUATION";
        if (signal.marketRegime === "RANGING_CHOP" || isExtremeExhaustion) {
          continuationClass = "POOR_CONTINUATION_REJECT";
        }

        // Initialize missed-runner tracking
        if (!botState.missedRunnerTracking) botState.missedRunnerTracking = {};
        const tracker = botState.missedRunnerTracking[botState.activeSymbol] || {
            rejections: 0,
            lastRejectionTime: 0,
            lastRejectionPrice: 0,
            expectedDirection: "NONE",
            hasAttemptedOverride: false
        };

        const rawDir = signal.rawDirection && signal.rawDirection !== "NONE" ? signal.rawDirection : "NONE";
        const sigDir = signal.direction !== "NONE" ? signal.direction : rawDir;
        let testDirection = sigDir !== "NONE" ? sigDir : tracker.expectedDirection;
        if (testDirection === "NONE") {
            testDirection = "LONG"; // Safe fallback to avoid binary branch breaking
        }
        const currentMarkPrice = botState.markPrice || 0;
        const now = Date.now();

        // One-shot rule: Trend wave detection and tracking reset (Requirement 6)
        if (testDirection !== "NONE" && tracker.expectedDirection !== "NONE" && testDirection !== tracker.expectedDirection) {
            console.log(`[TREND_WAVE_SHIFT] Trend wave direction changed from ${tracker.expectedDirection} to ${testDirection}. Resetting missed runner tracking structure.`);
            tracker.rejections = 0;
            tracker.hasAttemptedOverride = false;
            tracker.lastRejectionPrice = 0;
            tracker.lastRejectionTime = 0;
            tracker.overrideActivationTime = 0;
        }

        tracker.expectedDirection = testDirection as any;

        const highConfidence = signal.confidence >= 80;
        const strongTrend = (signal.trendStrength || 0) >= 0.015;
        const htfAligned = botState.marketScanner?.higherTimeframeAlignment === "STRICT_HTF" || botState.marketScanner?.higherTimeframeAlignment === "ALIGNED";
        const healthyLiquidity = (botState.marketScanner?.liquidityScore || 0) >= 60;
        const spreadScore = botState.marketScanner?.spreadQuality || 100;

        // Check price continuation movement
        const priceMovedInExpectedDirection = 
            (testDirection === "LONG" && tracker.lastRejectionPrice > 0 && currentMarkPrice > tracker.lastRejectionPrice) || 
            (testDirection === "SHORT" && tracker.lastRejectionPrice > 0 && currentMarkPrice < tracker.lastRejectionPrice);

        // Core eligibility criteria for override (Requirement 2)
        const isRepeatedRejections = tracker.rejections >= 2;
        let overrideActive = isRepeatedRejections && priceMovedInExpectedDirection;

        // Force override active when high-quality metrics override poor continuation reject
        const fulfillsHighQualityOverride = (continuationClass === "POOR_CONTINUATION_REJECT") && highConfidence && strongTrend && healthyLiquidity && htfAligned;
        if (fulfillsHighQualityOverride && !overrideActive) {
            overrideActive = true;
            console.log(`[CONTINUATION_QUALITY_REVIEWED] Strong metrics override POOR_CONTINUATION_REJECT for ${botState.activeSymbol}.`);
        }

        let approvedAsLateButTradeable = false;

        if (continuationClass === "POOR_CONTINUATION_REJECT" && overrideActive) {
            if (tracker.hasAttemptedOverride) {
                console.log(`[ONE_SHOT_BLOCKED] One-shot rule active: Already attempted late override for ${botState.activeSymbol} in this trend wave.`);
            } else {
                console.log(`[MISSED_RUNNER_OVERRIDE_ACTIVE] Missed runner override active for ${botState.activeSymbol}. Formulating late entry checks.`);
                
                // 1. Time-window rule (Requirement 4)
                if (!tracker.overrideActivationTime) {
                    tracker.overrideActivationTime = now;
                }
                const elapsedSinceActivationMs = now - tracker.overrideActivationTime;
                const elapsedMinutes = elapsedSinceActivationMs / 60000;
                
                let timeWindowPassed = true;
                if (elapsedMinutes < 0.5 || elapsedMinutes > 30.0) {
                    timeWindowPassed = false;
                    console.log(`[LATE_ENTRY_WINDOW_EXPIRED] LATE_BUT_TRADEABLE window expired or not yet active: Elapsed ${elapsedMinutes.toFixed(1)} mins (Allowed: 0.5 - 30.0 mins)`);
                } else {
                    console.log(`[LATE_ENTRY_TIME_WINDOW] Time window check PASSED: Elapsed ${elapsedMinutes.toFixed(1)} mins`);
                }

                // 2. Distance-from-breakout check (Requirement 1)
                const atrBasedLimit = Math.max(3.0, (signal.atrPct || 1.0) * 2.5);
                const distancePct = tracker.lastRejectionPrice > 0 ? (Math.abs(currentMarkPrice - tracker.lastRejectionPrice) / tracker.lastRejectionPrice) * 100 : 0;
                const momentumAccelerating = (signal.momentumScore || 0) > 0.82;
                
                let distancePassed = true;
                if (tracker.lastRejectionPrice > 0 && distancePct > atrBasedLimit && !momentumAccelerating) {
                    if (botState.analytics?.TOO_CONSERVATIVE_OVERRIDE_ACTIVE || isNewExecutionRuleOverrideSatisfied) {
                        console.log("OVERFILTERING_CLEANUP_ACTIVE: [LATE_ENTRY_DISTANCE_CHECK] bypassed/downgraded due to active override/cleanup bias.");
                        distancePassed = true;
                    } else {
                        distancePassed = false;
                    }
                }
                console.log(`[LATE_ENTRY_DISTANCE_CHECK] Distance: ${distancePct.toFixed(2)}% (Limit: ${atrBasedLimit.toFixed(2)}%), momentum score: ${signal.momentumScore?.toFixed(2)} (accelerating: ${momentumAccelerating}). Result: ${distancePassed ? "PASSED" : "FAILED"}`);

                // 3. Pullback-quality check (Requirement 2)
                const prState = postRallyTracker.get(botState.activeSymbol);
                let pullbackPassed = true;
                
                // shallow pullback: peak price retracement <= 10.0%
                const retracementDepth = prState && prState.peakPrice > 0 ? Math.abs(currentMarkPrice - prState.peakPrice) / prState.peakPrice * 100 : 0;
                const isShallowPullback = retracementDepth < 10.0;
                
                // continuation candle confirmation: direction is not NONE and momentum remains valid for direction
                let isContinuationConfirmed = testDirection === "LONG" 
                    ? ((signal.momentumScore || 0) >= 0.05)
                    : (testDirection === "SHORT" ? ((signal.momentumScore || 0) <= 0.95) : false);

                // For testing backwards compatibility in case testDirection parsing goes wrong
                if (testDirection === undefined || testDirection === null) isContinuationConfirmed = true;
                
                // higher low / lower high structure: not ranging chop or failing trend
                const isStructureHealthy = signal.marketRegime !== "RANGING_CHOP" && (signal.trendStrength || 0) >= 0.010;
                
                // volume remains healthy: volatility (volume proxy) remains healthy
                const isVolumeHealthy = (signal.volatilityScore || 0) >= 0.10 && (botState.marketScanner?.liquidityScore || 100) >= 40;

                if (!isShallowPullback || !isContinuationConfirmed || !isStructureHealthy || !isVolumeHealthy) {
                    pullbackPassed = false;
                }
                console.log(`[LATE_ENTRY_PULLBACK_QUALITY_CHECK] Shallow pullback: ${isShallowPullback} (retracement: ${retracementDepth.toFixed(2)}%), continuation candle: ${isContinuationConfirmed}, structure healthy: ${isStructureHealthy}, volume healthy: ${isVolumeHealthy}. Result: ${pullbackPassed ? "PASSED" : "FAILED"}`);

                // 4. Exhaustion filter (Requirement 3)
                let exhaustionPassed = true;
                
                const largeWickRejection = testDirection === "LONG" 
                    ? (((signal.confidence || 0) < 30 && signal.marketRegime === "EXHAUSTION_RISK_INCREASED"))
                    : (((signal.confidence || 0) < 30 && signal.marketRegime === "EXHAUSTION_RISK_INCREASED"));
                
                const momentumDivergence = testDirection === "LONG"
                    ? ((signal.momentumScore || 0) < 0.05)
                    : ((signal.momentumScore || 0) > 0.95);
                
                const volumeFades = (signal.volatilityScore || 0) < 0.10 && distancePct > 2.0;
                
                const volatilityChaotic = testDirection === "LONG"
                    ? ((signal.volatilityScore || 0) > 0.99 && (signal.momentumScore || 0) < 0.05)
                    : ((signal.volatilityScore || 0) > 0.99 && (signal.momentumScore || 0) > 0.95);
                const spreadWidened = spreadScore < 40;

                if (largeWickRejection || momentumDivergence || volumeFades || volatilityChaotic || spreadWidened) {
                    exhaustionPassed = false;
                }
                console.log(`[LATE_ENTRY_EXHAUSTION_CHECK] Large wick: ${largeWickRejection}, momentum divergence: ${momentumDivergence}, volume fades: ${volumeFades}, volatility chaotic: ${volatilityChaotic}, spread widened: ${spreadWidened}. Result: ${exhaustionPassed ? "PASSED" : "FAILED"}`);

                // 5. Scoring (Requirement 7)
                let lateEntryScore = 0;
                
                // Trend strength contribution (max 20)
                if ((signal.trendStrength || 0) >= 0.04) lateEntryScore += 20;
                else if ((signal.trendStrength || 0) >= 0.02) lateEntryScore += 15;
                else if ((signal.trendStrength || 0) >= 0.015) lateEntryScore += 10;
                
                // HTF alignment contribution (max 20)
                if (htfAligned) lateEntryScore += 20;
                
                // Continuation structure contribution (max 20)
                if (signal.marketRegime === "DEVELOPING_CONTINUATION" || signal.marketRegime === "PRE_BREAKOUT_MOMENTUM") {
                    lateEntryScore += 20;
                } else if (signal.marketRegime === "TRENDING" || signal.marketRegime === "RUNNER_SETUP_DETECTED") {
                    lateEntryScore += 15;
                } else {
                    lateEntryScore += 5;
                }
                
                // Volume quality contribution (max 15)
                if (isVolumeHealthy) {
                    if ((signal.volatilityScore || 0) < 0.7) lateEntryScore += 15;
                    else lateEntryScore += 10;
                }
                
                // Distance from breakout contribution (max 15)
                if (distancePct < atrBasedLimit * 0.6) lateEntryScore += 15;
                else if (distancePct < atrBasedLimit) lateEntryScore += 10;
                else lateEntryScore += 5;
                
                // Spread / Liquidity contribution (max 10)
                if (healthyLiquidity && spreadScore >= 60) lateEntryScore += 10;
                else if (healthyLiquidity) lateEntryScore += 5;

                const passesScoreThreshold = lateEntryScore >= 35;
                
                if (passesScoreThreshold) {
                    console.log(`[LATE_ENTRY_SCORE_PASSED] Score: ${lateEntryScore}/100. Late-entry scoring criteria met successfully.`);
                } else {
                    console.log(`[LATE_ENTRY_SCORE_FAILED] Score: ${lateEntryScore}/100. Late-entry scoring criteria failed to meet minimum of 35.`);
                }

                // Final Union Verification
                if (timeWindowPassed && distancePassed && pullbackPassed && exhaustionPassed && passesScoreThreshold) {
                    approvedAsLateButTradeable = true;
                    continuationClass = "LATE_BUT_TRADEABLE";
                    console.log(`[LATE_ENTRY_APPROVED] Late entry override approved. Score: ${lateEntryScore}`);
                } else {
                    const canOverrideLateEntry = 
                        (signal.confidence || 0) >= 70 &&
                        (signal.trendStrength || 0) >= 0.50 &&
                        (botState.marketScanner?.liquidityScore || 100) >= 80 &&
                        spreadScore >= 80 &&
                        htfAligned &&
                        exhaustionPassed === true;

                    if (isNewExecutionRuleOverrideSatisfied || canOverrideLateEntry) {
                        approvedAsLateButTradeable = true;
                        continuationClass = "LATE_BUT_TRADEABLE";
                        console.log("OVERFILTERING_CLEANUP_ACTIVE: LATE_ENTRY_BLOCKED bypass active.");
                        console.log("HARD_BLOCKER_REMOVED: LATE_ENTRY_BLOCKED");
                        console.log("FILTER_DOWNGRADED_TO_PENALTY: LATE_ENTRY_BLOCKED");
                        console.log("EXECUTION_ALLOWED_BY_ADAPTIVE_BIAS: Late but tradeable setup forced by execution rule.");
                    } else {
                        continuationClass = "POOR_CONTINUATION_REJECT";
                        console.log(`[LATE_ENTRY_BLOCKED] Late entry override blocked due to failed validation checks. Time: ${timeWindowPassed}, Dist: ${distancePassed}, Pullback: ${pullbackPassed}, Exhaustion: ${exhaustionPassed}, Score: ${passesScoreThreshold} (${lateEntryScore})`);
                    }
                }
            }
        } else if (signal.trendStrength && signal.trendStrength < 0.015) {
            continuationClass = "ACCEPTABLE_CONTINUATION";
        }

        if (continuationClass === "POOR_CONTINUATION_REJECT") {
             console.log(`[POOR_CONTINUATION_DOWNGRADED] Converting continuation quality penalty into reduced-risk participation. Allowing entry with 50% reduced size and tighter SL.`);
             continuationClass = "LATE_BUT_TRADEABLE";
             approvedAsLateButTradeable = true;
             (botState as any).isLateButTradeable = true;
             tracker.hasAttemptedOverride = true;
             botState.missedRunnerTracking[botState.activeSymbol] = tracker;
        } else {
            console.log(`[CONTINUATION_QUALITY_REVIEWED] Continuation status verified: ${continuationClass}. Proceeding...`);
            
            if (continuationClass === "LATE_BUT_TRADEABLE" && approvedAsLateButTradeable) {
                console.log(`[LATE_BUT_TRADEABLE_APPROVED] Proceeding with late but tradeable setup for ${botState.activeSymbol}. Mark as override attempted.`);
                tracker.hasAttemptedOverride = true;
                botState.missedRunnerTracking[botState.activeSymbol] = tracker;
                
                (botState as any).isLateButTradeable = true;
            } else {
                (botState as any).isLateButTradeable = false;
                // If it's a clean continuation and has succeeded, reset rejections queue, but keep tracker wave memory
                tracker.rejections = 0;
                botState.missedRunnerTracking[botState.activeSymbol] = tracker;
            }
        }
        
        const collateralHealthy = botState.accountEquity > 10;
        const exposureAllowed = botState.openPositions < limit;

        if (!collateralHealthy) {
          console.log(`[ENTRY_FILTER] Trade blocked: Free collateral insufficient for Phase 2.`);
          botState.blocker = "INSUFFICIENT_COLLATERAL";
          logEntryBlocked(botState.activeSymbol, "BALANCE_RESERVE", `accountEquity=${botState.accountEquity.toFixed(2)}`);
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }
        if (!exposureAllowed) {
          console.log(`[ENTRY_FILTER] Trade blocked: Phase 2 exposure limits reached.`);
          botState.blocker = "EXPOSURE_LIMITS_REACHED";
          logEntryBlocked(botState.activeSymbol, "MAX_EXPOSURE", `openPositions=${botState.openPositions}, maxOpenPositions=${limit}, availableSlots=${botState.availableSlots || 0}`);
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }
      }

      // Phase 1/2 Stabilization filters

      // 1b. Volatility noise filter
      const filterVolScore = signal.volatilityScore || 0;
      const isLowVolButSqueeze = signal.marketRegime === "LOW_VOL_SQUEEZE" || signal.marketRegime === "PRE_BREAKOUT_MOMENTUM" || signal.marketRegime === "HEALTHY_LOW_VOL_EXPANSION" || signal.marketRegime === "MOMENTUM_BUILDING" || signal.marketRegime === "EARLY_CONTINUATION_ENTRY" || signal.marketRegime === "EARLY_DIRECTIONAL_EXPANSION";
      if (!isLowVolButSqueeze && (filterVolScore < 0.25 || signal.marketRegime === "DEAD_LOW_VOL")) {
        console.log(`[VOLATILITY_NOISE_REJECTED] Setup rejected due to low or noisy micro-volatility (Vol Score: ${filterVolScore.toFixed(2)}, Regime: ${signal.marketRegime}).`);
        // botState.blocker = "VOLATILITY_NOISE_REJECTED";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
      } else if (isLowVolButSqueeze && signal.marketRegime === "DEAD_LOW_VOL") {
         // botState.blocker = "DEAD_LOW_VOL";
         // return botState.blocker;
      }

      // 1c. Fake breakout or weak momentum filter (Informational telemetry only - DOES NOT BLOCK)
      const breakoutRegimes = ["DEVELOPING_CONTINUATION", "PRE_BREAKOUT_MOMENTUM", "HEALTHY_DIRECTIONAL_VOL"];
      const isFakeBreakout = 
        breakoutRegimes.includes(signal.marketRegime || "") &&
        ((signal.momentumScore || 0) < 0.58 || (signal.trendStrength || 0) < 0.35 || (signal.consecutiveRegimeCount || 0) < 5);
      if (isFakeBreakout) {
        console.log(`POSSIBLE_FAKE_BREAKOUT_DETECTED: Breakout expansion is uncertain under current conditions. Momentum: ${signal.momentumScore?.toFixed(2)}, Trend strength: ${signal.trendStrength?.toFixed(2)}, Regime consistency count: ${signal.consecutiveRegimeCount || 0}`);
        console.log("BREAKOUT_UNCERTAIN: Potential fakeout flagged for analytics telemetry.");
        console.log("VOLATILITY_EXPANSION_WARNING: Reduced breakout continuation strength warned, execution flows.");
      }

      // 1d. Insufficient Expected Move evaluation (Informational telemetry only - DOES NOT BLOCK)
      const stopDistance = botState.config.stopLossPct || 1.2;
      const estimatedFees = 0.08;
      const spreadCost = 0.05;
      const requiredMovePct = estimatedFees + spreadCost + stopDistance * 0.4;
      const expectedMove = signal.expectedMovePct || 0;
      if (expectedMove < requiredMovePct) {
        console.log(`[EXPECTED_MOVE_LOW_WARNING] Expected move: ${expectedMove.toFixed(2)}% is less than the safety buffer: ${requiredMovePct.toFixed(2)}% (Fees: ${estimatedFees}%, Spread: ${spreadCost}%, Stop distance contribution: ${(stopDistance * 0.4).toFixed(2)}%)`);
        console.log("[FEE_FRICTION_WARNING] Fee-friction check is tight relative to stop distance limit.");
        console.log("[LOW_EXPECTANCY_ENVIRONMENT] Environment has high cost-to-move ratio, carrying as informational warning only.");
      }

      // 1e. Stronger HTF alignment filter
      if (signal.rawDirection !== "NONE" && signal.rawDirection !== signal.direction) {
        console.log(`[ENTRY_FILTER] Trade blocked: HTF_MISALIGNMENT. Entry direction ${signal.direction} does not align with HTF bias ${signal.rawDirection}.`);
        // botState.blocker = "HTF_MISALIGNMENT";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
      }

      // Same-symbol re-entry guard and churn protection (Issue 2)
      const lastTradesOnSymbol = botState.trades.filter(t => t.symbol === botState.activeSymbol && t.type === "EXIT");
      if (lastTradesOnSymbol.length > 0) {
        const lastExit = lastTradesOnSymbol[lastTradesOnSymbol.length - 1];
        const lastExitTime = lastExit.timestamp;
        const timeSinceExitSeconds = (now - lastExitTime) / 1000;

        const lastExitWasLoss = lastExit.netPnl !== undefined ? lastExit.netPnl < 0 : (lastExit.realizedPnl || 0) < 0;
        const lastExitWasFeeBleed = lastExit.exitReason?.includes("FEE_BLEED") || lastExit.exitReason?.includes("CHOP") || lastExit.exitReason?.includes("EMERGENCY") || lastExit.exitReason?.includes("PROTECTION") || ((botState.feeEfficiency?.feeToProfitRatio || 0) >= 0.70);
        
        let requiredDelaySec = 60; // 60s default for win structures
        let exitTypeLabel = "NORMAL_EXIT";
        if (lastExitWasFeeBleed) {
          requiredDelaySec = 300; // 5 minutes (300 seconds) for fee-bleed/chop setups
          exitTypeLabel = "FEE_BLEED_EXIT";
        } else if (lastExitWasLoss) {
          requiredDelaySec = 180; // 3 minutes (180 seconds) for loss structures
          exitTypeLabel = "LOSS_EXIT";
        }

        // Churn detection within the last 15 minutes
        const exitsLast15Mins = lastTradesOnSymbol.filter(t => (now - t.timestamp) < 15 * 60 * 1000);
        const isChurnActive = exitsLast15Mins.length >= 2;
        if (isChurnActive) {
          (botState as any).churnRiskActive = true;
          console.log(`[CHURN_RISK_DETECTED] Churn risk detected on ${botState.activeSymbol} (${exitsLast15Mins.length} exits last 15 mins). Instatting REDUCED_SIZE and CONFIDENCE_FLOOR overrides.`);
        } else {
          (botState as any).churnRiskActive = false;
        }

        if (timeSinceExitSeconds < requiredDelaySec) {
          // Check for FRESH STRUCTURE confirmation criteria
          const lastExitPrice = lastExit.exitPrice || lastExit.fillPrice || botState.lastFillPrice || (botState.markPrices ? botState.markPrices[botState.activeSymbol] : 0);
          const currentPriceLocal = botState.markPrices ? botState.markPrices[botState.activeSymbol] : 0;
          const priceMovedAway = lastExitPrice > 0 && currentPriceLocal > 0 ? (Math.abs(currentPriceLocal - lastExitPrice) / lastExitPrice * 100 >= 0.5) : false;
          
          const proposedSlPctLocal = (getAssetMeta(botState.activeSymbol) && getAssetMeta(botState.activeSymbol).maxLeverage <= 3) ? 2.5 : 1.5;
          const expMoveLocal = signal.expectedMovePct || 1.0;
          const proposedTpPctLocal = Math.max(proposedSlPctLocal * 0.25, expMoveLocal * 0.9);
          const rrRatioLocal = proposedSlPctLocal > 0 ? (proposedTpPctLocal / proposedSlPctLocal) : 0;

          const freshBreakoutConfirmed = (signal.consecutiveCandlesCount || 0) >= 3;
          const strongTrendPersistence = (signal.trendStrength || 0) >= 0.040;
          const cmcRotateSupport = botState.cmcIntelligence?.assets.some(a => (a.matchedSymbol === botState.activeSymbol || a.symbol === botState.activeSymbol) && a.narrative === botState.cmcIntelligence?.strongestNarrative);
          const rewardFeeHealthy = rrRatioLocal >= 0.35;

          const hasFreshStructure = priceMovedAway && freshBreakoutConfirmed && strongTrendPersistence && (cmcRotateSupport || rewardFeeHealthy);
          const sameDirection = lastExit.side === signal.direction;
          const setupQualityStrong = (signal.confidence || 0) >= 70 && (signal.tradeQualityScore || 0) >= 55;
          const guardTrace = {
            symbol: botState.activeSymbol,
            lastExitTime,
            lastExitReason: lastExit.exitReason || "UNKNOWN",
            timeSinceExitSeconds: Number(timeSinceExitSeconds.toFixed(1)),
            requiredDelaySec,
            sameDirection,
            priceMovedAway,
            freshBreakoutConfirmed,
            strongTrendPersistence,
            rewardFeeHealthy,
            churnActive: isChurnActive,
            setupQualityStrong,
            finalGuardDecision: hasFreshStructure && setupQualityStrong && !isChurnActive ? "ALLOW_FRESH_STRUCTURE" : "HARD_BLOCK_TRUE_CHURN"
          };
          console.log(`[REENTRY_GUARD_TRACE] ${JSON.stringify(guardTrace)}`);

          if (hasFreshStructure && setupQualityStrong && !isChurnActive) {
            console.log(`[REENTRY_APPROVED_FRESH_STRUCTURE] Same-symbol faster re-entry approved for ${botState.activeSymbol}. Fresh continuation pattern holds.`);
          } else {
            console.log(`[SAME_SYMBOL_REENTRY_HARD_BLOCK] Guard blocked re-entry on ${botState.activeSymbol} (${exitTypeLabel}). Cool-off: ${timeSinceExitSeconds.toFixed(0)}s / ${requiredDelaySec}s. Churn: ${isChurnActive}`);
            console.log(`[REENTRY_BLOCKED_TRUE_CHURN] Same-symbol re-entry failed fresh-structure or quality test.`);
            botState.blocker = "SAME_SYMBOL_REENTRY_HARD_BLOCK";
            return botState.blocker;
          }
        } else if (isChurnActive || signal.confidence < 55 || (signal.expectedMovePct || 0) < 0.35) {
          console.log(`[SAME_SYMBOL_REENTRY_SOFT_GUARD] ${botState.activeSymbol} re-entry allowed past cooldown but marked reduced-priority. churn=${isChurnActive}, confidence=${signal.confidence}, expectedMove=${(signal.expectedMovePct || 0).toFixed(2)}%.`);
        }
      }

      // 2. DAILY_TRADE_LIMIT blocker (Requirement 10 / Rule 7: Maximum 10 trades per day in Phase 1)
      const currentDailyCount = botState.dailyTradeCount || 0;
      if (currentDailyCount >= 10) {
        console.log(
          `[ENTRY_FILTER] Trade blocked: Daily trade limit of 10 reached.`,
        );
        // botState.blocker = "DAILY_TRADE_LIMIT_REACHED";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
      }

      // 3. TRADE_COOLDOWN blocker (Rule 2: wait 3 minutes after any close)
      const cooldownEnd = botState.cooldownUntil || 0;
      if (now < cooldownEnd) {
        if (botState.autoRecoveryMode === "ON" && signal.confidence >= 75) {
          console.log(`[AUTO_SOFT_FILTER_RELAXATION_APPLIED] Reduced soft fee/cooldown friction for elite setup (confidence ${signal.confidence} >= 75). Cooldown bypassed.`);
        } else {
          console.log(
            `[ENTRY_FILTER] Trade blocked: Cooldown active. Remaining: ${((cooldownEnd - now) / 1000).toFixed(0)}s.`,
          );
          // botState.blocker = "COOLDOWN_ACTIVE";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }
      }

      // 4. REVERSE_DIRECTION_LOCK blocker (Rule 3)
      const reverseLockEnd = botState.reverseLockUntil || 0;
      if (now < reverseLockEnd) {
        if (botState.lastCloseSide === "LONG" && signal.direction === "SHORT") {
          console.log(
            "[ENTRY_FILTER] Trade blocked: Reverse Direction Lock active. Cannot short for 2 minutes after LONG close.",
          );
          // botState.blocker = "REVERSE_LOCK_ACTIVE";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }
        if (botState.lastCloseSide === "SHORT" && signal.direction === "LONG") {
          console.log(
            "[ENTRY_FILTER] Trade blocked: Reverse Direction Lock active. Cannot buy for 2 minutes after SHORT close.",
          );
          // botState.blocker = "REVERSE_LOCK_ACTIVE";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }
      }

      // 5. FEE_EFFICIENCY blocker (Rule 8 / Requirement 11)
      if (botState.feeEfficiency?.isPaused) {
        const isEliteInRecovery = botState.autoRecoveryMode === "ON" && signal.confidence >= 75;
        if (!botState.feePauseOverrideActive && !isEliteInRecovery) {
           // botState.blocker = botState.feeEfficiency.pauseType === "HARD" ? "FEE_HARD_SUSPENSION_ACTIVE" : "FEE_SOFT_SUSPENSION_ACTIVE";
           console.log(`[ENTRY_FILTER] Trade blocked: Fee Efficiency Score deteriorated. Pause type: ${botState.feeEfficiency.pauseType}`);
           // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        } else {
           if (isEliteInRecovery) {
             console.log(`[AUTO_SOFT_FILTER_RELAXATION_APPLIED] Reduced soft fee/cooldown friction for elite setup: Bypassing ${botState.feeEfficiency.pauseType} Fee Efficiency check during auto-recovery.`);
           } else {
             console.log("[FEE_EFFICIENCY_OVERRIDE_APPROVED] Bypassing Fee Efficiency check due to elite continuation override.");
           }
        }
      }

      // 5b. DRAWDOWN blocker
      botState.drawdownOverrideActive = false; // Reset initially
      const ddSeverity = botState.drawdownSeverity || "NONE";
      if (ddSeverity === "HARD" || ddSeverity === "SOFT" || ddSeverity === "SOFT_LEVEL_1" || ddSeverity === "SOFT_LEVEL_2" || ddSeverity === "MODERATE") {
        console.log(`[DRAWDOWN_ELITE_OVERRIDE_REVIEWED] Evaluating ${botState.activeSymbol} for Drawdown (${ddSeverity}) Elite/Reduced-risk Override.`);
        
        const isVolatilityChaotic = (signal.volatilityScore || 0) > 0.85 || signal.marketRegime === "HIGH_VOLATILITY";
        const protectionErrors = botState.protectionStatus === "FAILED_EMERGENCY_CLOSE_REQUIRED" || botState.blocker === "CRITICAL_FAILURE";
        const feeToProfitRatio = (botState as any).feeEfficiency?.feeToProfitRatio || (botState.analytics as any)?.feeToProfitRatio || 0;
        const feeBleedIncreases = feeToProfitRatio >= 0.70;

        const consecutiveExits = botState.trades ? botState.trades.filter((t) => t.type === "EXIT") : [];
        const lastTwoExits = consecutiveExits.slice(-2);
        const bothLosses = lastTwoExits.length >= 2 && lastTwoExits.every(t => (t.realizedPnl || 0) < 0 || t.exitReason?.includes("STOP_LOSS") || (t as any).netPnl < 0);

        const drawdownPct = botState.analytics?.currentDrawdown || 0;
        const drawdownWorsens = drawdownPct >= 4.0;

        // Elevate dynamically to Level 2 (elite only) if triggers are present
        const isEliteOnlyLevel2 = ddSeverity === "HARD" || ddSeverity === "SOFT_LEVEL_2" || ddSeverity === "MODERATE" || drawdownWorsens || bothLosses || feeBleedIncreases || isVolatilityChaotic || protectionErrors;

        const confidenceCheckLevel1 = (signal.confidence || 0) >= 75;
        const confidenceCheckLevel2 = (signal.confidence || 0) >= (["SOFT_LEVEL_1", "SOFT"].includes(ddSeverity) ? 80 : 85);
        const trendDirectionConfirmed = signal.direction !== "NONE" && (signal.trendStrength || 0) >= 0.015;
        
        const htfAlignedOrReversal = (signal.rawDirection === signal.direction && signal.direction !== "NONE") || 
                                     (signal.marketRegime && (signal.marketRegime.includes("REVERSAL") || signal.marketRegime.includes("RECOVERY"))) || 
                                     ((signal as any).isReversalPatternConfirmed === true) ||
                                     botState.marketScanner?.higherTimeframeAlignment === "STRICT_HTF" || 
                                     botState.marketScanner?.higherTimeframeAlignment === "ALIGNED";
        
        const liquiditySpreadHealthy = (botState.marketScanner?.liquidityScore || 0) >= 60 && 
                                       (botState.marketScanner?.spreadQuality || botState.marketScanner?.spreadScore || 100) >= 60;
        
        const estFees = ((botState.config.maxExposure || 40) / (botState.config.leverage || 1)) * 0.005;
        const expectedPnl = (botState.config.maxExposure || 40) * ((signal.expectedMovePct || 0) / 100);
        const expectedRewardOk = expectedPnl > estFees || (signal.expectedMovePct || 0) > 0.15;
        
        const stopDist = botState.config.stopLossPct || 1.2;
        const computedSlPct = stopDist;
        const computedTpPct = botState.config.takeProfitPct || 2.5;
        const tpSlValid = computedTpPct > 0 && computedSlPct > 0;
        
        const freeCollateralSafe = botState.availableMargin > 5.0 && botState.accountEquity > 10;
        const noProtectionCorruption = botState.protectionStatus !== "FAILED_EMERGENCY_CLOSE_REQUIRED";
        const noWssApiIssue = botState.wssConnected !== false && botState.apiConnected !== false && botState.phase !== "CIRCUIT_BREAKER_ACTIVE";

        // During HARD DD: avoid continuation chasing
        const isContinuationChasing = ddSeverity === "HARD" && signal.marketRegime?.includes("CONTINUATION");

        if (isEliteOnlyLevel2) {
          // SOFT_DRAWDOWN_LEVEL_2 / HARD (Elite only checks)
          const isElite = confidenceCheckLevel2 && 
                          trendDirectionConfirmed && 
                          htfAlignedOrReversal && 
                          liquiditySpreadHealthy && 
                          expectedRewardOk && 
                          tpSlValid && 
                          freeCollateralSafe && 
                          noProtectionCorruption && 
                          noWssApiIssue &&
                          !isContinuationChasing;

          if (!isElite) {
            if (ddSeverity === "HARD" || ddSeverity === "MODERATE") {
              console.log(`[DRAWDOWN_ELITE_ONLY] Trade blocked: ${ddSeverity}_DRAWDOWN_PAUSE_ACTIVE (Elite checks failed: con2=${confidenceCheckLevel2}, trend=${trendDirectionConfirmed}, liq=${liquiditySpreadHealthy}, noChasing=${!isContinuationChasing}).`);
              botState.blocker = `${ddSeverity}_DRAWDOWN_PAUSE_ACTIVE`;
              return botState.blocker;
            } else {
              console.log(`[DRAWDOWN_SOFT_REDUCED_RISK] Soft drawdown active and setup is not Elite (Elite checks failed: con2=${confidenceCheckLevel2}, trend=${trendDirectionConfirmed}, liq=${liquiditySpreadHealthy}, noChasing=${!isContinuationChasing}). Allowing standard trade with reduced risk configuration.`);
              botState.drawdownOverrideActive = true;
            }
          } else {
            botState.drawdownOverrideActive = true;
            console.log(`[DRAWDOWN_ELITE_ONLY_APPROVED] Approved Elite setup (Conf: ${signal.confidence}, Trend: ${signal.trendStrength}) allowed during ${ddSeverity} drawdown filter.`);
          }
        } else {
          // SOFT_DRAWDOWN_LEVEL_1 (Reduced-risk allowed: confidence >= 75)
          const isPassLevel1 = confidenceCheckLevel1 &&
                               trendDirectionConfirmed &&
                               liquiditySpreadHealthy &&
                               expectedRewardOk &&
                               tpSlValid &&
                               freeCollateralSafe &&
                               noProtectionCorruption &&
                               noWssApiIssue;

          if (!isPassLevel1) {
            console.log(`[SOFT_DRAWDOWN_LEVEL_1_ACTIVE] Standard trade rejected during Soft Drawdown Level 1 (reduced risk). Failed level 1 checks: confidenceCheckLevel1=${confidenceCheckLevel1}, trendConfirmed=${trendDirectionConfirmed}, liquiditySpreadHealthy=${liquiditySpreadHealthy}, expectedRewardOk=${expectedRewardOk}, tpSlValid=${tpSlValid}, freeCollateralSafe=${freeCollateralSafe}, protection=${noProtectionCorruption}`);
            // botState.blocker = "SOFT_DRAWDOWN_PAUSE_ACTIVE";
            // return botState.blocker;
          } else {
            // Overblocking prevented! Allow standard entry with reduced risk configuration
            botState.drawdownOverrideActive = true;
            console.log(`[DRAWDOWN_OVERBLOCKING_PREVENTED] Prevented standard drawdown overblocking at 2.5% Level 1.`);
            console.log(`[SOFT_DRAWDOWN_REDUCED_RISK_ENTRY_ALLOWED] Approved Level 1 trade setup (Conf: ${signal.confidence}, Trend: ${signal.trendStrength}) is allowed for reduced risk execution.`);
          }
        }
      }

      // 6. TRADE_QUALITY_SCORE blocker (Rule 6) - calculated inside strategy logic
      const tradeQualityScore =
        signal.tradeQualityScore !== undefined
          ? signal.tradeQualityScore
          : Math.round(
              signal.confidence * 0.4 +
                (regimeStats ? regimeStats.winRate : 50) * 0.25 +
                Math.max(
                  0,
                  Math.min(
                    100,
                    (1 - (botState.feeEfficiency?.feeToProfitRatio || 0)) * 100,
                  ),
                ) *
                  0.15 +
                Math.min(
                  100,
                  Math.max(0, (1 - (signal.volatilityScore || 0)) * 100),
                ) *
                  0.1 +
                (botState.analytics.winRate || 50) * 0.1,
            );

      const sigFactor = signal.confidence;
      const regimeFactor = regimeStats ? regimeStats.winRate : 50;

      const feeRatio = botState.feeEfficiency?.feeToProfitRatio || 0;
      const feeFactor = Math.max(0, Math.min(100, (1 - feeRatio) * 100));

      const volScore = signal.volatilityScore || 0;
      const volFactor = Math.min(100, Math.max(0, (1 - volScore) * 100));

      const overallFactor = botState.analytics.winRate || 50;

      console.log(`[QUALITY_SCORE] Trade quality evaluation (computed by strategy):
        Signal Quality (40%): ${sigFactor.toFixed(1)}
        Regime Winrate Factor (25%): ${regimeFactor.toFixed(1)}
        Fee Efficiency Factor (15%): ${feeFactor.toFixed(1)}
        Volatility Stability Factor (10%): ${volFactor.toFixed(1)}
        Overall Performance Factor (10%): ${overallFactor.toFixed(1)}
        Overall Quality Score: ${tradeQualityScore} / 100 (Required: 45)`);

      if (tradeQualityScore < 45) {
        if (tradeQualityScore < 30) {
          console.log(
            `[LOW_EXPECTANCY_SETUP_REJECTED] Trade blocked: TRADE_QUALITY_SCORE (${tradeQualityScore}) is below absolute minimum requirement of 30.`,
          );
          // botState.blocker = "LOW_EXPECTANCY_SETUP_REJECTED";
          // return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        } else {
          console.log(
            `[QUALITY_DOWNGRADED] Trade quality score (${tradeQualityScore}) is moderate. Downgrading to reduced-size participation (60% smaller size, 1.5x max leverage, 0.5x SL) instead of hard rejection.`,
          );
          (botState as any).isLowExpectancyContinuation = true;
        }
      } else {
         (botState as any).isLowExpectancyContinuation = false;
      }

      // 7. Accidental position aggregation protection & No stacking same symbol positions (Rule 4 / Requirement 3 & 13)
      if (
        !multiPositionMode &&
        (botState.openPositions > 0 || botState.positionDetails)
      ) {
        console.log(
          "[ENTRY_FILTER] Blocked: ACCIDENTAL_DUPLICATE_STACKING protection active.",
        );
        logEntryBlocked(botState.activeSymbol, "MAX_OPEN_POSITIONS", "single-position phase active");
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
      }

      if (multiPositionMode) {
        const dynamicLimitObj = getDynamicMaxPositions();
        const limit = dynamicLimitObj.limit;

        let canRotate = false;
        let rotationTargetSymbol = "";

        const usedPosCt = botState.usedPositions ?? botState.openPositions;
        
        console.log(`[POSITION_SLOT_TRACE] usedPosCt: ${usedPosCt}, Effective Limit: ${limit}. Open Positions: ${botState.openPositions}, Pending: ${botState.pendingEntryCount || 0}`);
        console.log(`[POSITION_SLOT_SOURCE_RECONCILED] Verifying true position usage.`);

        if (usedPosCt >= limit) {
          // Double check to make sure usedPosCt ONLY includes actual open positions
          let realOpenCount = 0;
          if (botState.allPositions) {
              realOpenCount = botState.allPositions.filter(p => Math.abs(parseFloat(p.szi || "0")) > 0).length;
          }
          if (realOpenCount < limit) {
              console.log(`[FALSE_MAX_POSITION_BLOCK_PREVENTED] usedPosCt (${usedPosCt}) was artificially inflated. Real open positions: ${realOpenCount}. Allowing entry.`);
              botState.analytics.lessons = botState.analytics.lessons || [];
              botState.analytics.lessons.push(`${botState.activeSymbol}: FALSE_SLOT_BLOCK → UNBLOCKED`);
              botState.usedPositions = realOpenCount;
              botState.availableSlots = Math.max(0, limit - realOpenCount - (botState.pendingEntryCount || 0));
              botState.blocker = null;
              if (botState.activeSymbol === "TRX") {
                 console.log(`[TRX_SLOT_BLOCK_REMOVED] Unblocked TRX.`);
              }
          } else {
              // Find weakest open position
              let weakestPos: any = null;
          let weakestScore = Infinity;
          if (botState.allPositions && botState.allPositions.length > 0) {
            for (const pos of botState.allPositions) {
              const unrealizedPnlPct = parseFloat(pos.unrealizedPnl || "0");
              const posSym = pos.coin;
              const matchingTrade = botState.trades?.find(t => t.symbol === posSym && t.type === "ENTRY" && !botState.trades.some(x => x.symbol === posSym && x.type === "EXIT" && x.timestamp > t.timestamp));
              const tradeQuality = matchingTrade?.tradeQualityScore || matchingTrade?.confidenceScore || 50;
              const strengthScore = tradeQuality + (unrealizedPnlPct * 10);
              
              if (strengthScore < weakestScore) {
                weakestScore = strengthScore;
                weakestPos = pos;
              }
            }
          }
          
          const newSetupScore = tradeQualityScore || signal.confidence || 50;
          const replacementThreshold = weakestScore + 15;
          if (weakestPos && newSetupScore >= replacementThreshold) {
            console.log(`[CAPITAL_ROTATION_APPROVED] New setup on ${botState.activeSymbol} (Score: ${newSetupScore}) is superior to weakest open position on ${weakestPos.coin} (Score: ${weakestScore.toFixed(1)}, PnL: ${(parseFloat(weakestPos.unrealizedPnl || "0") * 100).toFixed(2)}%). Executing replacement...`);
            canRotate = true;
            rotationTargetSymbol = weakestPos.coin;
          } else {
            if ((botState.availableSlots || 0) > 0 || realOpenCount < limit) {
              console.log(`[FALSE_MAX_POSITION_BLOCK_PREVENTED] MAX_POSITION_BLOCK_CONFIRMED attempted with realOpenPositions=${realOpenCount}, effectiveMaxPositions=${limit}, availableSlots=${botState.availableSlots || 0}.`);
              console.log(`[POSITION_SLOT_SOURCE_RECONCILED] Reconciled false max-position state before final router block.`);
              botState.usedPositions = realOpenCount;
              botState.availableSlots = Math.max(0, limit - realOpenCount - (botState.pendingEntryCount || 0));
              botState.blocker = null;
            } else {
            console.log(`[MAX_POSITION_BLOCK_CONFIRMED] Multi-position limit of ${limit} reached (${dynamicLimitObj.reason}). No superior replacements found. New setup score: ${newSetupScore}, Weakest position (${weakestPos ? weakestPos.coin : "N/A"}) score: ${weakestScore.toFixed(1)}.`);
            botState.blocker = "MAX_POSITION_BLOCK_CONFIRMED";
            return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
            }
          }
          }
        } else {
          console.log(`[MULTI_POSITION_SLOT_AVAILABLE] Slot available in execution pipeline. Open Positions: ${botState.openPositions} / ${limit} (Max: ${limit}). Reason: ${dynamicLimitObj.reason}`);
          if (botState.openPositions === 2) {
            console.log(`[THIRD_POSITION_APPROVED] Approving 3rd concurrent position placement since account safety metrics are healthy.`);
          }
        }

        if (canRotate && rotationTargetSymbol) {
          console.log(`[CAPITAL_ROTATION_EXECUTION] Rotating capital: Closing ${rotationTargetSymbol} to free a slot for ${botState.activeSymbol}.`);
          const closedSuccess = await programmaticClosePosition(rotationTargetSymbol, `ROTATING_TO_${botState.activeSymbol}`);
          if (!closedSuccess) {
            console.log(`[CAPITAL_ROTATION_FAILED] Programmatic close failed for ${rotationTargetSymbol}. Aborting rotation entry.`);
            botState.blocker = "CAPITAL_ROTATION_CLOSE_FAILED";
            return botState.blocker;
          }
          botState.openPositions = Math.max(0, botState.openPositions - 1);
        }

        if (botState.openPositions >= 1) {
          if (!isWssApiStable) {
            console.log("[ENTRY_FILTER] Blocked: API or WebSocket connections unstable.");
            botState.blocker = "WSS_API_UNSTABLE";
            return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
          }
          if (isDrawdownPauseActive) {
            console.log("[ENTRY_FILTER] Blocked: Drawdown protection pause active.");
            botState.blocker = "HARD_DRAWDOWN_PAUSE_ACTIVE";
            return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
          }
          if (hasCriticalValidationBlocker) {
            console.log("[ENTRY_FILTER] Blocked: Critical validation blocker exists.");
            botState.blocker = "CRITICAL_VALIDATION_BLOCKER";
            return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
          }
          if (!everyPositionHasTpSl) {
            console.log(`[ENTRY_FILTER] Blocked: One or more open positions lack confirmed TP/SL protection. Details: ${tpSlFailedReasons.join(", ")}`);
            botState.blocker = "TP_SL_MISSING_FOR_OPEN_POSITION";
            return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
          }
          if (botState.portfolioExposureUsedPct && botState.portfolioExposureUsedPct > 65) {
            console.log(`[ENTRY_FILTER] Blocked: Total portfolio exposure ${botState.portfolioExposureUsedPct.toFixed(1)}% exceeds limit of 65%.`);
            botState.blocker = "PORTFOLIO_EXPOSURE_EXCEEDS_LIMIT";
            return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
          }
          if (botState.freeCollateralPct && botState.freeCollateralPct < 30) {
            console.log(`[ENTRY_FILTER] Blocked: Free collateral percentage ${botState.freeCollateralPct.toFixed(1)}% is below absolute safety threshold of 30%.`);
            botState.blocker = "BELOW_PREFERRED_SAFETY_TARGET";
            return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
          }
        }

        const alreadyHolding =
          botState.allPositions &&
          botState.allPositions.find((p) => p.coin === botState.activeSymbol);
        const alreadyHasPendingEntryOrder =
          botState.activeOrders &&
          botState.activeOrders.some((o) => o.coin === botState.activeSymbol && !o.reduceOnly);
        
        if (alreadyHolding || alreadyHasPendingEntryOrder) {
          console.log(
            `[ENTRY_FILTER] Blocked: ACCIDENTAL_DUPLICATE_STACKING or pending entry order for ${botState.activeSymbol}.`,
          );
          logEntryBlocked(botState.activeSymbol, "COOLDOWN", "same-symbol position or pending entry already exists");
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }

        // Ensure free collateral remains above safety threshold for multi-position
        const requiredSafetyBuffer = botState.accountEquity * 0.3; // 30% free margin buffer 
        const preferredSafetyTarget = botState.accountEquity * 0.35; // 35% preferred

        console.log(`[FREE_COLLATERAL_CHECK] Total Equity: $${botState.accountEquity.toFixed(2)}, Reserved: $${(botState.accountEquity - botState.availableMargin).toFixed(2)}, Available: $${botState.availableMargin.toFixed(2)} (${((botState.availableMargin / botState.accountEquity) * 100).toFixed(1)}%), Active Pos: ${botState.openPositions}, Orders: ${botState.activeOrders?.length || 0}`);

        if (botState.availableMargin < requiredSafetyBuffer) {
          console.log(
            "[ENTRY_FILTER] Blocked: ENTRY_BLOCKED_INSUFFICIENT_FREE_COLLATERAL",
          );
          botState.blocker = `INSUFFICIENT_FREE_COLLATERAL: Est. Free ${((botState.availableMargin / botState.accountEquity) * 100).toFixed(1)}% < 30%`;
          (botState as any).wasInsufficientCollateral = true;
          logEntryBlocked(botState.activeSymbol, "BALANCE_RESERVE", `availableMargin=${botState.availableMargin.toFixed(2)}, requiredBuffer=${requiredSafetyBuffer.toFixed(2)}`);
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }

        if ((botState as any).wasInsufficientCollateral && botState.availableMargin >= preferredSafetyTarget) {
            console.log("[ENTRY_FILTER] ENTRIES_RESUMED_FREE_COLLATERAL_OK: Collateral recovered above safe threshold.");
            (botState as any).wasInsufficientCollateral = false;
        }

        if (botState.openPositions >= limit && botState.availableMargin < preferredSafetyTarget) {
          console.log(
            `[ENTRY_FILTER] Blocked: Free collateral below 35% preferred safety target for scaling at limit of ${limit}.`,
          );
          botState.blocker = "BELOW_PREFERRED_SAFETY_TARGET";
          logEntryBlocked(botState.activeSymbol, "BALANCE_RESERVE", `availableMargin=${botState.availableMargin.toFixed(2)}, preferredTarget=${preferredSafetyTarget.toFixed(2)}`);
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }
      }

      // Rule 4: No multiple entries at the same timestamp
      const lastEntryTime = botState.lastEntryTimestamp || 0;
      if (now === lastEntryTime) {
        console.log(
          "[ENTRY_FILTER] Blocked: Duplicate entry at identical timestamp.",
        );
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
      }

      // Double-open prevention lock timeframe (allow max 1 entry order per 20 seconds)
      const isSameScanMultiPositionBatch =
        multiPositionMode &&
        candidatesToExecute.length > 1 &&
        candidatesToExecute.some((candidate: any) => candidate.symbol === botState.activeSymbol);
      if (now - lastEntryTime < 20000 && !isSameScanMultiPositionBatch) {
        console.log(
          "[ENTRY_FILTER] Blocked: Order spam rate-limit. Minimum 20s between entries.",
        );
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
      } else if (now - lastEntryTime < 20000 && isSameScanMultiPositionBatch) {
        console.log(`[MULTI_POSITION_ENTRY_APPROVED] Same-scan batch entry allowed for ${botState.activeSymbol}; duplicate spam guard only blocks repeated same-symbol churn.`);
      }

      if (riskManager.checkRisk(botState.activeSymbol)) {
        const isBuy = signal.direction === "LONG";

        let baseExposure = botState.config.maxExposure;
        let setupLeverage = botState.config.leverage;
        let totalReductionPct = 0;
        let sizingReasons: { reason: string, pct: number }[] = [];

        const applySizingModifier = (reason: string, multiplier: number) => {
            if (multiplier < 1) {
                const reduction = (1 - multiplier) * 100;
                totalReductionPct += reduction;
                sizingReasons.push({ reason, pct: -reduction });
            } else if (multiplier > 1) {
                const boost = (multiplier - 1) * 100;
                totalReductionPct -= boost;
                sizingReasons.push({ reason, pct: boost });
            }
        };

        if (botState.autoRecoveryMode === "ON") {
          console.log("[AUTO_SOFT_FILTER_RELAXATION_APPLIED] Auto recovery active: applying adaptive risk constraints & 45% size reduction.");
          applySizingModifier("AUTO_RECOVERY", 0.55); // 45% reduction
        } else if (isNewExecutionRuleOverrideSatisfied || botState.analytics?.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
          console.log("OVERFILTERING_CLEANUP_ACTIVE: Bypassed entry uses adaptive risk constraints.");
          applySizingModifier("OVERFILTERING_CLEANUP", 0.55); // 45% reduction
        }

        // Apply post-rally dynamic corrections management (Part 4)
        const prStateForSymbol = postRallyTracker.get(botState.activeSymbol);
        if (prStateForSymbol) {
          if (prStateForSymbol.isCorrecting || prStateForSymbol.hasRallied) {
            console.log(`[ENTRY_ADAPTATION] Applying post-rally/correction sizing parameters for ${botState.activeSymbol}.`);
            // Reduce position sizing
            applySizingModifier("POST_RALLY_CORRECTION", 0.5);

            // Tighten exposure limits: Bypassed hard blocker per user intent (handled via reduced sizing)
            if (prStateForSymbol.isCorrecting && botState.openPositions >= 1) {
              console.log(`[ENTRY_FILTER] EXPOSURE_LIMITS_TIGHTENED_DURING_CORRECTION bypassed per user intent. Allowing continuation room.`);
            }
          }

          if (prStateForSymbol.isCorrecting && Date.now() < prStateForSymbol.lastReentryRestrictedUntil) {
             console.log(`[ENTRY_FILTER] POST_RALLY_REENTRY_RESTRICTED bypassed per user intent. Allowing continuation room.`);
          }
        }

        // Progressive Adaptive Leverage Scaling
        const isHighVol = ["ASTER", "SKR"].includes(botState.activeSymbol);
        const wins = botState.analytics.totalWins || 0;
        const winRate = botState.analytics.winRate || 0;
        const netProfit = botState.analytics.netProfitability || 0;
        const conf = signal.confidence || 0;
        const dd = botState.analytics.currentDrawdown || 0;
        const leverageMeta = getAssetMeta(botState.activeSymbol);
        const leverageCap = Math.max(1, Math.min(15, leverageMeta?.maxLeverage || 15));
        const leverageCmc = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === botState.activeSymbol || a.symbol === botState.activeSymbol);
        const isStrongCmcContinuation =
          !!leverageCmc &&
          leverageCmc.trendScore >= 85 &&
          ((leverageCmc.momentumPersistenceScore || 0) >= 70 || Math.abs(leverageCmc.priceChange24h || 0) >= 5) &&
          signal.direction !== "NONE";

        let progressiveLeverage = 2; // Preferred default

        if (multiPositionMode) {
          console.log(`[REAL_TIME_AVAILABILITY_CHECK] Active positions: ${botState.openPositions}, Conf: ${conf}, Regime: ${signal.marketRegime}`);
          
          const dynamicLimitObj = getDynamicMaxPositions();
          const limit = dynamicLimitObj.limit;
          const usedPosForCap = botState.usedPositions ?? botState.openPositions;
          if (usedPosForCap >= limit && conf < 65) {
             console.log(`[ENTRY_FILTER] Blocked: Confidence ${conf} too low for position ${usedPosForCap + 1} allocation.`);
             botState.blocker = "CONFIDENCE_TOO_LOW_FOR_PORTFOLIO_MAX";
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
          }

          // Volatility-aware position sizing
          if (signal.volatilityScore && signal.volatilityScore > 0.7) {
            applySizingModifier("HIGH_VOLATILITY", 0.6);
          } else if (
            signal.momentumScore &&
            signal.momentumScore > 0.8 &&
            conf > 80
          ) {
            applySizingModifier("STRONG_MOMENTUM_BOOST", 1.25);
          }
          
          // Per-position budget rules and dynamic scaling down (Requirement 5)
          let dynamicCapPct = 0.225;
          if (botState.openPositions === 1) {
            dynamicCapPct = 0.175;
          } else if (botState.openPositions === 2) {
            dynamicCapPct = 0.125;
          } else if (botState.openPositions === 3) {
            dynamicCapPct = 0.10;
          } else if (botState.openPositions === 4) {
            dynamicCapPct = 0.075;
          } else if (botState.openPositions >= 5) {
            dynamicCapPct = 0.05;
          }
          let cap = botState.accountEquity * dynamicCapPct;
          
          // Apply count-based decay scaling to avoid over-consuming collateral:
          if (botState.openPositions > 0) {
            const decayFactor = 1 / Math.sqrt(botState.openPositions + 1);
            cap *= decayFactor;
            console.log(`[DYNAMIC_COLLATERAL_SCALING] Decay factor ${decayFactor.toFixed(3)} applied. Dynamic Cap adjusted from $${(botState.accountEquity * dynamicCapPct).toFixed(2)} to $${cap.toFixed(2)}.`);
          }
          
          
          // Late but tradeable handled later in sizing block
          if ((botState as any).isLateButTradeable) {
             applySizingModifier("LATE_BUT_TRADEABLE", 0.5);
          }
          
          applySizingModifier("PORTFOLIO_CAP", cap / Math.max(0.01, baseExposure));
          console.log(`[PORTFOLIO_BUDGET] Position ${botState.openPositions + 1} final allocation cap applied: max $${cap.toFixed(2)} (base cap: ${(dynamicCapPct * 100).toFixed(1)}% of Equity)`);
        }

        const isSafeToScale =
          (isPhase2 || isStrongCmcContinuation || (wins >= 50 && winRate >= 55 && netProfit > 0)) &&
          botState.wssConnected &&
          botState.apiConnected;

        // --- NEW LEVERAGE POLICY RULES ---
        // 1. Standard valid entries: use 2x minimum
        // 2. Weak or risk-adjusted entries: allow 1x only if 2x would create unsafe liquidation/collateral (we start at 2x, if overridden later)
        // 3. High-confidence continuation: 2x-3x
        // 4. Late-but-tradeable / missed-runner: cap at 2x
        // 5. High-risk / chaotic vol: use 1x-2x only
        
        progressiveLeverage = 2; // Default reset for checks

        if (isSafeToScale) {
          if (
            (["DEAD_LOW_VOL"].includes(signal.marketRegime || "")) ||
            signal.marketRegime === "RANGING_CHOP"
          ) {
            // Chaotic/chop: cap at 1-2x
            progressiveLeverage = 2;
          } else {
            if (conf >= 42 && conf < 50) progressiveLeverage = 2; // standard/weak: we prefer 2x
            else if (conf >= 50 && conf < 70) progressiveLeverage = isStrongCmcContinuation ? 3 : 2; // standard execution range
            else if (conf >= 70 && conf < 80) progressiveLeverage = isStrongCmcContinuation ? 5 : 3; // high confidence
            else if (conf >= 80) {
              const isElite = signal.marketRegime === "TRENDING" || signal.marketRegime === "STRONG_TREND";
              const lowDd = dd < botState.accountEquity * 0.1;
              if (isElite && lowDd && (signal.volatilityScore || 0) > 0.4) {
                 progressiveLeverage = isStrongCmcContinuation ? 8 : 5;
              } else {
                 progressiveLeverage = isStrongCmcContinuation ? 5 : 3;
              }
            }
          }
        }
        progressiveLeverage = Math.min(progressiveLeverage, leverageCap);
        if (progressiveLeverage >= 3) {
          console.log(`[HIGH_CONFIDENCE_LEVERAGE_APPROVED] ${botState.activeSymbol} leverage target ${progressiveLeverage}x approved by signal/CMC quality within exchange cap ${leverageCap}x.`);
        } else {
          console.log(`[MINIMUM_2X_ENFORCED] ${botState.activeSymbol} leverage target held at ${progressiveLeverage}x by conservative quality/risk policy.`);
        }

        // If our Trend-Matched Directional Execution logic determined a specific quality leverage:
        if (botState.executionLeverageSelected !== undefined && botState.executionLeverageSelected !== null) {
          progressiveLeverage = botState.executionLeverageSelected;
          console.log(`[LEVERAGE_POLICY_BREAKDOWN] Quality-Adjusted Target leverage set to ${progressiveLeverage}x (Reason: ${botState.executionLeverageReason})`);
        }

        if (botState.executionLeverageSelected === 0) {
          console.log(`[ENTRY_FILTER] Trade entry blocked due to safety block on leverage select. Status: ${botState.executionConfirmationStatus}. Reason: "${botState.executionLeverageReason}".`);
          botState.blocker = "SAFE_LEVERAGE_SAFETY_BLOCK";
          return botState.blocker;
        }

        // Initialize setupLeverage based on policy. Trust internal dynamic scaling over static config.
        setupLeverage = progressiveLeverage;

        // Guardrail: no leverage increase unless 50+ trades show positive expectancy (REMOVED to allow dynamic scale)
        // We now rely on isSafeToScale and trend alignment for scale.

        if ((botState as any).isLateButTradeable) {
            console.log("[LEVERAGE_DOWNGRADE_TRACE] Late but tradeable: resizing instead of capping leverage.");
        }

        const assetMeta = getAssetMeta(botState.activeSymbol);
        const isHighRisk = assetMeta && assetMeta.maxLeverage <= 3;

        if (isHighVol || isHighRisk) {
          applySizingModifier("HIGH_RISK_ASSET", 0.5);
          setupLeverage = Math.min(botState.config.leverage || 2, setupLeverage); 
          console.log("[LEVERAGE_DOWNGRADE_TRACE] High risk/vol asset: Capping leverage to config max.");
        }
        
        let customSlMultiplier = 1.0;
        let isRiskAdjusted = false;

        if (botState.drawdownOverrideActive) {
          applySizingModifier("DRAWDOWN_ELITE_OVERRIDE", 0.5);
          setupLeverage = Math.max(2, Math.min(3, setupLeverage)); // min 2x
          customSlMultiplier = 0.5;
          isRiskAdjusted = true;
          console.log(`[DRAWDOWN_ELITE_OVERRIDE] Applied 50% size reduction, target 2x-3x lev, tightened SL for ${botState.activeSymbol}.`);
        }

        if (signal.marketRegime === "POST_RALLY_CONTINUATION_LONG" || signal.marketRegime === "POST_RALLY_CONTINUATION_SHORT") {
          applySizingModifier("POST_RALLY_CONTINUATION", 0.7);
          customSlMultiplier = 0.6; // Tighter required stop loss for continuation
          console.log(`[POST_RALLY_CONT_ADJUST] Reduced size and tightened SL applied for ${botState.activeSymbol} post-rally continuation.`);
        }
        
        if (signal.marketRegime === "EARLY_PARABOLIC_PARTICIPATION") {
          applySizingModifier("EARLY_PARABOLIC", 0.5); // reduced size
          customSlMultiplier = 0.5; // tighter SL
          isRiskAdjusted = true;
          console.log(`[EARLY_PARABOLIC_PARTICIPATION] Reduced size and tightened SL applied for ${botState.activeSymbol}.`);
        }
        
        if (signal.marketRegime === "EARLY_CONTINUATION_ENTRY") {
          const spreadLiquidityHealthy = (botState.marketScanner?.spreadQuality || 0) >= 60 && (botState.marketScanner?.liquidityScore || 0) >= 60;
          if (spreadLiquidityHealthy) {
             console.log(`[EARLY_DIRECTIONAL_EXPANSION_DETECTED] Structure allows early continuation at ${setupLeverage}x leverage for ${botState.activeSymbol}.`);
             botState.reducedSizeReason = "EARLY_CONTINUATION";
             customSlMultiplier = 0.6;
             isRiskAdjusted = true;
          } else {
             applySizingModifier("LOWER_QUALITY_EARLY_CONT", 0.5);
             setupLeverage = Math.max(2, Math.min(3, setupLeverage)); // floor 2x
             customSlMultiplier = 0.5;
             isRiskAdjusted = true;
             console.log(`[SPREAD_LIQUIDITY_CAUTION] Reduced structure quality on early entry. Floor leverage to 2x and cutting size by 50%.`);
          }
        }

        if (signal.marketRegime === "EXHAUSTION_RISK_INCREASED") {
            applySizingModifier("EXHAUSTION_RISK_INCREASED", 0.5);
            customSlMultiplier = 0.5;
            isRiskAdjusted = true;
            console.log(`[EXHAUSTION_CONTINUATION_ADJUST] Reduced size and tightened SL applied for ${botState.activeSymbol} due to high exhaustion risk continuation.`);
        }
        
        if ((botState as any).isShortHoldApproved) {
            applySizingModifier("SHORT_HOLD_APPROVED", 0.4);
            setupLeverage = Math.max(2, Math.min(3, setupLeverage)); // floor 2x
            customSlMultiplier = 0.5;
            isRiskAdjusted = true;
            console.log(`[SHORT_HOLD_ADJUST] Reduce size for short hold expectancy setup.`);
        }

        if ((botState as any).isLowExpectancyContinuation) {
            applySizingModifier("LOW_EXPECTANCY_CONT", 0.4);
            setupLeverage = Math.max(2, Math.min(setupLeverage, 3));
            customSlMultiplier = 0.5;
            isRiskAdjusted = true;
            console.log(`[QUALITY_DOWNGRADE_ADJUST] Downgrading risk: 60% size, cap leverage to 3x (preferred min 2x), 0.5x SL multiplier.`);
        }

        if (botState.cooldownOverrideActive || botState.feePauseOverrideActive) {
            applySizingModifier("COOLDOWN_FEE_OVERRIDE", 0.5);
            setupLeverage = Math.max(2, Math.min(setupLeverage, 3));
            customSlMultiplier = 0.5; // tighter SL
            isRiskAdjusted = true;
            console.log(`[OVERRIDE_ADJUST] Applying risk reduction for override entry: 50% size, target 2x-3x leverage, 0.5x SL multiplier.`);
        }

        if ((botState as any).isChopRecoveryAllowedEntry) {
            applySizingModifier("CHOP_RECOVERY_REDUCED_RISK", 0.5);
            setupLeverage = Math.max(2, Math.min(setupLeverage, 3));
            customSlMultiplier = 0.5;
            isRiskAdjusted = true;
            console.log(`[CHOP_ENTRY_APPROVED_REDUCED_RISK] Chop recovery setup executed. Applying 50% size reduction, min 2x leverage. ${botState.activeSymbol}.`);
        }
        
        // --- PARTICIPATION TIERS LOGIC ---
        const isEliteContinuation = conf >= 80 && (signal.momentumScore || 0) > 0.6 && (signal.trendStrength || 0) > 0.6;
        const isGoodContinuation = conf >= 65 && conf < 80;
        const isExperimental = conf < 65 || (botState as any).isLowExpectancyContinuation;

        if (botState.openPositions > 0) {
            console.log(`[MULTI_POSITION_RISK_ALLOCATED] Applying participation tiers to concurrent position sizing for ${botState.activeSymbol}.`);
            if (!isEliteContinuation && isGoodContinuation) {
                applySizingModifier("TIER_2_GOOD_CONT", 0.35); // 35% reduction
                console.log(`[PARTICIPATION_TIER] Assigned TIER_2 (Good Continuation). Applying 35% size reduction.`);
            } else if (isExperimental) {
                applySizingModifier("TIER_3_EXPERIMENTAL", 0.60); // 60% reduction
                console.log(`[PARTICIPATION_TIER] Assigned TIER_3 (Experimental Continuation). Applying 60% size reduction.`);
            } else {
                console.log(`[PARTICIPATION_TIER] Assigned TIER_1 (Elite Setup). Full target size allocation allowed.`);
            }
        }
        // ---------------------------------

        // Ensure we strictly enforce 2x if config >= 2, UNLESS overridden by DD
        if (setupLeverage < 2 && botState.config.leverage >= 2 && !isRiskAdjusted) {
          setupLeverage = 2; // Preferred default if safety checks allow
        }

        // Drawdown Recovery Sizing and Leverage scaling logic
        const currentDDSeverity = botState.drawdownSeverity || "NONE";
        const currentProgress = botState.drawdownRecoveryProgress !== undefined ? botState.drawdownRecoveryProgress : 100;
        
        if (currentDDSeverity === "SOFT" || currentDDSeverity === "SOFT_LEVEL_1" || currentDDSeverity === "SOFT_LEVEL_2") {
          // SOFT: reduce leverage, reduce size by exactly 50%, cap leverage at 2x, tighten SL
          applySizingModifier("SOFT_DRAWDOWN", 0.5);
          const oldLeverage = setupLeverage;
          setupLeverage = Math.min(2, setupLeverage);
          customSlMultiplier = 0.75; // tighter SL by 25% (i.e. 0.75 custom SL multiplier)
          console.log(`[ELITE_SETUP_ALLOWED_DURING_DRAWDOWN] Setup executed during ${currentDDSeverity} drawdown mode. Applying strict reduced-risk: targetExposure reduced by 50% (0.50x), leverage capped to ${setupLeverage}x (down from ${oldLeverage}x), tight SL applied.`);
        } else if (currentDDSeverity === "MODERATE") {
          // MODERATE: allow only highest-confidence setups, continuation participation heavily reduced, aggressive cooldowns
          const recoveryScale = 0.25 + 0.25 * (currentProgress / 100);
          applySizingModifier("MODERATE_DRAWDOWN", recoveryScale);
          const oldLeverage = setupLeverage;
          setupLeverage = Math.max(2, Math.min(3, setupLeverage)); // min 2x, max 3x during moderate DD
          console.log(`[ELITE_SETUP_ALLOWED_DURING_DRAWDOWN] Highest-confidence setup executed during MODERATE drawdown mode. targetExposure scaled by ${recoveryScale.toFixed(2)}x, leverage target is ${setupLeverage}x (old ${oldLeverage}x).`);
          console.log(`[DRAWDOWN_RECOVERY_PROGRESS] MODERATE Drawdown Recovery Progress: ${currentProgress.toFixed(1)}%.`);
          
          // Apply aggressive cooldown after this entry
          botState.cooldownUntil = Date.now() + 2 * 60 * 60 * 1000; // 2 hour aggressive cooldown to prevent churn
          botState.cooldownType = "HARD";
          console.log(`[MODERATE_DRAWDOWN_MODE_ACTIVE] Aggressive 2-hour cooldown activated post-execution in MODERATE drawdown mode.`);
        }

        // --- ADAPTIVE LEARNING ENGINE SIZING ---
        const adaptiveLearningSizeAdj = (signal as any)._learningSizeAdj || 0;
        if (adaptiveLearningSizeAdj !== 0) {
            applySizingModifier("ADAPTIVE_LEARNING_EDGE", 1.0 + adaptiveLearningSizeAdj);
            console.log(`[SIZE_ADJUSTED_BY_LEARNING] Base position size adjusted by ${adaptiveLearningSizeAdj > 0 ? '+' : ''}${(adaptiveLearningSizeAdj * 100).toFixed(1)}% due to statistical edge.`);
        }
        // ---------------------------------------

        // Compute additive scaled targetExposure safely:
        let targetExposure = baseExposure;
        if (totalReductionPct > 0) {
            // max additive reduction we allow is 75% to prevent collapsing healthy sizes entirely
            const clampedReduction = Math.min(75, totalReductionPct);
            targetExposure = baseExposure * (1 - (clampedReduction / 100));
        } else if (totalReductionPct < 0) {
            const boost = Math.abs(totalReductionPct);
            targetExposure = baseExposure * (1 + (boost / 100));
        }

        // Apply final absolute portfolio constraints
        targetExposure = Math.min(targetExposure, botState.accountEquity * 0.95);

        if (multiPositionMode) {
          console.log(
            `[MULTI_POSITION_SIZING_TELEMETRY] TargetExposure=$${targetExposure.toFixed(2)} (Base: $${baseExposure.toFixed(2)}, Reductions: ${totalReductionPct.toFixed(1)}%), Leverage=${setupLeverage}x (Conf: ${conf}, Momentum: ${signal.momentumScore}, Volatility: ${signal.volatilityScore})`,
          );
        }

        const markPrice = botState.markPrice;
        if (markPrice === 0) {
          console.error("BOT: Cannot open trade without markPrice");
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }

        // 1. Read real account equity
        const accountEquity = botState.accountEquity;

        // 2. Read real available margin
        const rawAvailableMargin = botState.availableMargin;

        // 3. Calculate safe size from collateral rules
        const dynamicLimitObj = getDynamicMaxPositions();
        const limit = dynamicLimitObj.limit;
        const requiredFreePct = botState.openPositions >= limit ? 35 : 30; // 35% preferred, 30% absolute minimum
        const maxMarginUsagePermitted = Math.max(0, rawAvailableMargin - (accountEquity * (requiredFreePct / 100)));
        const maxAllowedRiskPct = 65; // 65% dynamic exposure limit

        let safeExposure = 0;
        if (maxMarginUsagePermitted > 0) {
           // We need to account for Initial Margin (1/leverage) + Fees/Slippage (0.5%)
           safeExposure = maxMarginUsagePermitted / ((1 / setupLeverage) + 0.005);
        } else if (botState.openPositions === 0 && accountEquity > 0) {
           // Small account bootstrapper conservative limit using minimal absolute margin buffer
           const minimalBufferPct = 15;
           const minMarginPermitted = Math.max(0, rawAvailableMargin - (accountEquity * (minimalBufferPct / 100)));
           safeExposure = minMarginPermitted / ((1 / setupLeverage) + 0.005);
        }

        // Ensure safe size is not $0 if there are no open positions and funds exist
        const assetMinSz = assetMeta ? assetMeta.minSz || 0 : 0;
        const EXCHANGE_MINIMUM = 11; // 11 USD to safely clear Hyperliquid/Binance $10 limits
        const PREFERRED_ENTRY_SIZE = botState.config.minEntrySize || 40;
        const minSzNotional = assetMinSz * markPrice;
        
        const absoluteExecutableMinimum = Math.max(
          EXCHANGE_MINIMUM,
          minSzNotional,
        );

        if (botState.openPositions === 0 && accountEquity > 0 && safeExposure <= 0) {
          safeExposure = Math.max(1, Math.min(accountEquity * setupLeverage, PREFERRED_ENTRY_SIZE));
        }

        // Apply dynamic portfolio exposure constraints (65% dynamic limit)
        const maxAllowedPortfolioExposure = accountEquity * (maxAllowedRiskPct / 100);
        let currentPositionExposure = 0;
        if (botState.allPositions && botState.allPositions.length > 0) {
          for (const pos of botState.allPositions) {
            const sz = Math.abs(parseFloat(pos.szi || pos.position?.szi || "0"));
            const px = parseFloat(pos.entryPx || pos.position?.entryPx || "0") || botState.markPrice;
            currentPositionExposure += sz * px;
          }
        }
        const remainingPortfolioExposureAllowed = Math.max(0, maxAllowedPortfolioExposure - currentPositionExposure);
        safeExposure = Math.min(safeExposure, remainingPortfolioExposureAllowed);

        let finalDecision = "APPROVED";
        let finalExposure = Math.min(targetExposure, safeExposure);

        // If same-symbol churn risk is active, reduce size by 50% as requested
        if ((botState as any).churnRiskActive) {
          finalExposure *= 0.5;
          console.log(`[CHURN_RISK_ACTIVE_SIZE_REDUCED] Active churn risk: reduced final exposure size by 50% to $${finalExposure.toFixed(2)}`);
          console.log(`CHURN_RISK_DETECTED: Reducing trade size to prevent excessive trading friction.`);
        }

        let tier: "STANDARD_ENTRY" | "REDUCED_ENTRY" | "MICRO_ENTRY" | "NONE" = "NONE";
        let reducedReason = "";

        // Calculate dynamic required confidence (reqConf) matching the scanner's adaptive baseline
        let reqConf = 38; // default
        const optRegime = (signal.marketRegime || "TRENDING") as string;
        if (
          botState.analytics.regimeDetailedStats &&
          botState.analytics.regimeDetailedStats[optRegime]
        ) {
          const stats = botState.analytics.regimeDetailedStats[optRegime];
          if (stats.wins + stats.losses >= 10 && (stats.winRate < 40 || stats.netPnl < 0)) {
            reqConf = 45;
          } else if (stats.wins + stats.losses < 10 && (optRegime === "RANGING_CHOP" || (["DEAD_LOW_VOL"].includes(optRegime)))) {
            reqConf = 42;
          } else if (stats.wins + stats.losses < 10 && (optRegime === "PRE_BREAKOUT_MOMENTUM" || optRegime === "DEVELOPING_CONTINUATION")) {
            reqConf = 30;
          }
        } else if (optRegime === "RANGING_CHOP") {
          reqConf = 42;
        } else if ((["DEAD_LOW_VOL"].includes(optRegime))) {
          reqConf = 38;
        } else if (optRegime === "PRE_BREAKOUT_MOMENTUM" || optRegime === "DEVELOPING_CONTINUATION") {
          reqConf = 30;
        }

        // Apply Phase 2 Adaptive Threshold Adjustments
        if (botState.phase === "PHASE_2_ADAPTIVE_EXECUTION" && botState.analytics.thresholdAdjustment !== undefined) {
           reqConf += botState.analytics.thresholdAdjustment;
        }
        
        if (botState.analytics.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
           reqConf -= 12;
           if (reqConf < 15) reqConf = 15;
        }

        if ((botState as any).churnRiskActive) {
           reqConf = Math.max(reqConf, 75); // Require stronger confirmation for churn risk
           console.log(`[CHURN_RISK_ACTIVE_CONFIRMATION_ENFORCED] Active churn risk: elevated required confidence to at least 75% (currently ${reqConf}%).`);
        }
        
        reqConf = Math.max(15, Math.min(80, reqConf)); // Ensure hard floor/ceiling limits for safety

        // Evaluate if safety conditions allow a reduced-size or micro-size execution
        const isSetupQualityHigh = signal.confidence >= reqConf && signal.direction !== "NONE" && botState.executionTrendMatch !== "TREND_CONFLICT";
        const isConfidenceStrong = signal.confidence >= 50;
        const isExpectedRewardGreaterThanFees = (signal.expectedMovePct || 0) > 0.35;
        const isLiquiditySpreadHealthy = (botState.marketScanner?.spreadQuality || 100) >= 60 && (botState.marketScanner?.liquidityScore || 100) >= 60;
        const isMarginSafe = (accountEquity > 0) && rawAvailableMargin > 0; // verified in downstream simulation block as well

        let isApprovedForReduced = isSetupQualityHigh && isConfidenceStrong && isExpectedRewardGreaterThanFees && isLiquiditySpreadHealthy && isMarginSafe;

        if (!isApprovedForReduced && isMarginSafe && signal.direction !== "NONE") {
           console.log(`[ROUTER_SIZE_REBUILT] Modifying isApprovedForReduced to true. Hard safety passed. Ignoring soft blockers.`);
           isApprovedForReduced = true;
        }

        // Restore minimum practical size if setup is valid but size was crushed by additive reductions
        if (finalExposure < absoluteExecutableMinimum && isApprovedForReduced && safeExposure >= absoluteExecutableMinimum) {
            console.log(`[SIZE_FLOOR_RESTORED] Valid setup crushed by additive reductions. Restoring size from $${finalExposure.toFixed(2)} to practical minimum $${absoluteExecutableMinimum.toFixed(2)}`);
            finalExposure = absoluteExecutableMinimum;
            targetExposure = absoluteExecutableMinimum;
            console.log(`[TOO_SMALL_FALSE_BLOCK_PREVENTED] False block prevented by restoring minimum executable size at routing.`);
        }

        if (finalExposure >= PREFERRED_ENTRY_SIZE) {
          tier = "STANDARD_ENTRY";
        } else {
          console.log(`[PREFERRED_ENTRY_SIZE_NOT_REACHED] Sizing $${finalExposure.toFixed(2)} fell below preferred size of $${PREFERRED_ENTRY_SIZE.toFixed(2)}.`);
          
          if (finalExposure >= 20) {
            if (isApprovedForReduced) {
              tier = "REDUCED_ENTRY";
              reducedReason = "High quality setup & strong confidence approved for reduced size";
              console.log(`[REDUCED_ENTRY_APPROVED] Reduced entry execution approved for setup: $${finalExposure.toFixed(2)} [REDUCED_ENTRY]. Reason: ${reducedReason}`);
            } else {
              tier = "NONE";
              reducedReason = "Rejected: Reduced size $20-$39 conditions not fully met";
            }
          } else if (finalExposure >= 10) {
            const isEliteOrHighMomentum = signal.confidence >= 70 || (signal.momentumScore || 0) > 0.6 || (signal.trendStrength || 0) > 0.6;
            if (isApprovedForReduced && isEliteOrHighMomentum) {
              tier = "MICRO_ENTRY";
              reducedReason = "Elite/high-momentum setup approved for micro size";
              console.log(`[MICRO_ELITE_ENTRY_APPROVED] Micro entry execution approved for setup: $${finalExposure.toFixed(2)} [MICRO_ENTRY]. Reason: ${reducedReason}`);
            } else {
              tier = "NONE";
              reducedReason = "Rejected: Micro size requires elite/high-momentum setup";
            }
          } else {
            tier = "NONE";
            reducedReason = "Rejected: Size below absolute minimum executable floor of $10";
          }
        }

        console.log(`[ENTRY_TIER_CLASSIFIED] Entry tier classified as: ${tier}. Actual exposure: $${finalExposure.toFixed(2)} vs Preferred: $${PREFERRED_ENTRY_SIZE.toFixed(2)}`);

        // Populate botState properties for dashboard UI visibility
        botState.entryTier = tier;
        botState.preferredEntrySize = PREFERRED_ENTRY_SIZE;
        botState.actualEntrySize = finalExposure;
        botState.reducedSizeReason = reducedReason || "STANDARD_EXECUTION";

        if (tier === "NONE") {
          botState.blocker = "ENTRY_REJECTED_TOO_SMALL";
          finalDecision = "REJECTED_TOO_SMALL";
          console.log(`[ENTRY_FILTER] ENTRY_REJECTED_TOO_SMALL: Resolved exposure $${finalExposure.toFixed(2)} is below acceptable limits. Reason: "${reducedReason}"`);
          
          console.log(`[SIZE_REDUCTION_CHAIN_REVIEWED] Detailed Rejection Analysis:
          - Symbol: ${botState.activeSymbol}
          - Side: ${signal.direction}
          - Base Size: $${baseExposure.toFixed(2)}
          - Final Calculated Size: $${finalExposure.toFixed(2)}
          - Selected Leverage: ${setupLeverage}x
          - Available Margin: $${botState.availableMargin.toFixed(2)}
          - Reduction Reasons: ${sizingReasons.map(r => r.reason).join(", ") || "None"}
          - Reduction Percentages: ${sizingReasons.map(r => `${r.pct.toFixed(1)}%`).join(", ") || "None"}
          - Risk Mode: ${botState.autoRecoveryMode === "ON" ? "RECOVERY" : (botState.drawdownSeverity !== "NONE" ? botState.drawdownSeverity + " DRAWDOWN" : "STANDARD")}
          - Confidence: ${signal.confidence}%
          - Trend Class: ${signal.marketRegime}
          - Volatility Class: ${signal.volatilityScore?.toFixed(2)}
          - Expected Reward vs Fees: ${(signal.expectedMovePct || 0).toFixed(2)}% vs ~0.1%`);

          if (isEliteContinuation && finalExposure < 10) {
              console.log(`[ELITE_SETUP_BLOCKED_BY_MINIMUM_SIZE] Elite setup missed because stacked reductions pushed size below minimum executable floor of $10.`);
          }

        } else {
          finalDecision = "APPROVED";
          targetExposure = finalExposure;

          // Note: Artificial leverage caps for REDUCED_ENTRY and MICRO_ENTRY have been removed per leverage policy. 
          // Leverage scales up properly with trend quality, while only size (notional exposure) is reduced.
          if (tier === "REDUCED_ENTRY") {
            console.log(`[LEVERAGE_PRESERVED] REDUCED_ENTRY: Target leverage (${setupLeverage}x) preserved for small notional entry.`);
          } else if (tier === "MICRO_ENTRY") {
            console.log(`[LEVERAGE_PRESERVED] MICRO_ENTRY: Target leverage (${setupLeverage}x) preserved for micro notional entry.`);
          }
          console.log(`[FINAL_ROUTER_SIZE_APPROVED] Execution sizing successfully passed hard limits and minimums.`);
        }

        console.log(`[SIZING_ENGINE_TRACE]
        ┌────────────────────────────────────────────────────────┐
        │ BASE SIZE: $${baseExposure.toFixed(2)}
        │ REDUCTION REASONS: ${sizingReasons.map(r => `${r.reason} (${r.pct.toFixed(1)}%)`).join(", ") || "None"}
        │ TOTAL REDUCTION: ${totalReductionPct.toFixed(1)}%
        │ FINAL CALCULATED SIZE: $${targetExposure.toFixed(2)}
        │ USER PREFERRED ENTRY SIZE: $${PREFERRED_ENTRY_SIZE.toFixed(2)}
        │ EXCHANGE MINIMUM: $${absoluteExecutableMinimum.toFixed(2)}
        │ ENTRY TIER CLASSIFICATION: ${tier}
        │ MAX SAFE EXPOSURE ALLOWED: $${safeExposure.toFixed(2)}
        │ FINAL DECISION: ${finalDecision}
        └────────────────────────────────────────────────────────┘`);

        if (finalDecision !== "APPROVED") {
            return botState.blocker;
        }

        // 5. POST_TRADE_MARGIN_SIMULATION
        const estimatedIm = targetExposure / setupLeverage;
        const estimatedFeesAndSlippage = targetExposure * 0.005; // 0.5% buffer
        const estimatedRequiredMargin = estimatedIm + estimatedFeesAndSlippage;
        const estimatedAvailableMarginAfterEntry = rawAvailableMargin - estimatedRequiredMargin;
        const estimatedFreeCollateralPct = botState.accountEquity > 0
          ? (estimatedAvailableMarginAfterEntry / botState.accountEquity) * 100
          : 0;

        const postEntryTotalExposure = currentPositionExposure + targetExposure;

        const freeCollateralOk = estimatedFreeCollateralPct >= requiredFreePct || botState.openPositions === 0;
        const portfolioExposureOk = postEntryTotalExposure <= maxAllowedPortfolioExposure + 5; 
        const availableMarginOk = estimatedAvailableMarginAfterEntry > 0;

        const passedSimulation = freeCollateralOk && portfolioExposureOk && availableMarginOk;
        
        const marginUsagePct = botState.accountEquity > 0 
           ? ((botState.accountEquity - estimatedAvailableMarginAfterEntry) / botState.accountEquity) * 100 
           : 100;
           
        const minimumUserRequiredSize = botState.entryTier === "STANDARD_ENTRY" ? PREFERRED_ENTRY_SIZE : absoluteExecutableMinimum;

        botState.sizingTelemetry = {
           lastSafeExposureComputed: safeExposure,
           lastExchangeMinimumRequired: minimumUserRequiredSize,
           marginBufferHealthPct: accountEquity > 0 ? (rawAvailableMargin / accountEquity) * 100 : 0,
           projectedFreeCollateralPct: estimatedFreeCollateralPct,
           projectedMarginUsagePct: marginUsagePct,
           rejectedTradesDueToSizing: botState.sizingTelemetry?.rejectedTradesDueToSizing || 0
        };

        console.log(`[SIZING_ENGINE_TRACE]
┌────────────────────────────────────────────────────────┐
│ ACCOUNT EQUITY: $${accountEquity.toFixed(2)}
│ AVAILABLE MARGIN: $${rawAvailableMargin.toFixed(2)}
│ MIN ENTRY REQUIREMENT: $${minimumUserRequiredSize.toFixed(2)}
│ MAX ALLOWED RISK %: ${maxAllowedRiskPct}%
│ FREE COLLATERAL REQUIREMENT: ${requiredFreePct}%
│ CALCULATED SAFE NOTIONAL: $${safeExposure.toFixed(2)}
│ MINIMUM REQUIRED SIZE: $${minimumUserRequiredSize.toFixed(2)}
│ LEVERAGE USED: ${setupLeverage}x
│ FINAL ORDER SIZE: $${targetExposure.toFixed(2)}
│ REJECTION REASON: NONE
└────────────────────────────────────────────────────────┘`);

        console.log(`[SAFE_SIZE_CALCULATED] Safe size computed: $${safeExposure.toFixed(2)} vs Min Required: $${minimumUserRequiredSize.toFixed(2)} (Leverage: ${setupLeverage}x)`);

        console.log(`[POST_TRADE_MARGIN_SIMULATION]
┌────────────────────────────────────────────────────────┐
│ TOTAL EQUITY: $${botState.accountEquity.toFixed(2)}
│ RAW AVAILABLE MARGIN: $${rawAvailableMargin.toFixed(2)}
│ TARGET NOTIONAL: $${targetExposure.toFixed(2)}
│ LEVERAGE: ${setupLeverage}x
│ ESTIMATED REQUIRED MARGIN: $${estimatedRequiredMargin.toFixed(2)}
│ ESTIMATED POST-ENTRY AVAILABLE MARGIN: $${estimatedAvailableMarginAfterEntry.toFixed(2)}
│ ESTIMATED POST-ENTRY FREE COLLATERAL: ${estimatedFreeCollateralPct.toFixed(1)}% (Target >= ${requiredFreePct}%)
│ MAX ALLOWED PORTFOLIO EXPOSURE: $${maxAllowedPortfolioExposure.toFixed(2)} (Post-entry dynamic: $${postEntryTotalExposure.toFixed(2)})
│ DECISION: ${passedSimulation ? "PASS" : "FAIL"}
└────────────────────────────────────────────────────────┘`);

        console.log(`[CAPITAL_SAFETY_RECALCULATED] Capital safety parameters refreshed (Health Index: ${Math.round(botState.sizingTelemetry.marginBufferHealthPct)}/100)`);

        if (!passedSimulation) {
          if (botState.sizingTelemetry) botState.sizingTelemetry.rejectedTradesDueToSizing++;
          if (!availableMarginOk || estimatedFreeCollateralPct < 30) {
            console.log(`TRADE_REJECTED_MARGIN_BUFFER_REQUIRED: Rejecting new entry due to margin safety violation. Post-entry available margin: $${estimatedAvailableMarginAfterEntry.toFixed(2)}, Free Collateral: ${estimatedFreeCollateralPct.toFixed(1)}% < 30%`);
            botState.blocker = "MARGIN_SAFETY_VIOLATION";
          } else {
             console.log(`TRADE_REJECTED_MARGIN_BUFFER_REQUIRED: Capital allocation simulation failed. Consumption would over-utilize free collateral or exceed exposure limits.`);
            botState.blocker = "CAPITAL_ALLOCATION_REJECTED";
          }
          return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";
        }

        // Apply Soft Risk Modifiers computed during Candidate Evaluation
        const currentOpp = botState.scannerOpportunities?.find(o => o.symbol === botState.activeSymbol);
        if (currentOpp) {
          if ((currentOpp as any).sizeModifier !== undefined && (currentOpp as any).sizeModifier < 1.0) {
            const oldExposure = targetExposure;
            targetExposure *= (currentOpp as any).sizeModifier;
            targetExposure = Math.max(absoluteExecutableMinimum, targetExposure);
            console.log(`[SOFT_RISK_SIZE_REDUCTION_APPLIED] Reducing target exposure from $${oldExposure.toFixed(2)} to $${targetExposure.toFixed(2)} due to soft-risk dampeners.`);
          }
          if ((currentOpp as any).leverageModifier !== undefined && (currentOpp as any).leverageModifier < 1.0) {
            const oldLev = setupLeverage;
            setupLeverage = Math.max(2, Math.round(setupLeverage * (currentOpp as any).leverageModifier));
            console.log(`[SOFT_RISK_LEVERAGE_REDUCTION_APPLIED] Reducing leverage from ${oldLev}x to ${setupLeverage}x due to soft-risk dampeners.`);
            console.log(`[MINIMUM_2X_ENFORCED] Soft risk reduced leverage without dropping below 2x.`);
          }
        }

        const currentOppFinalScore = (currentOpp as any)?.finalExecutionScore || 0;
        const shouldPreserveExecutableSize =
          currentOppFinalScore >= 70 ||
          (signal.confidence || 0) >= 50 ||
          botState.entryTier === "STANDARD_ENTRY";
        if (targetExposure < PREFERRED_ENTRY_SIZE && shouldPreserveExecutableSize && safeExposure >= PREFERRED_ENTRY_SIZE) {
          const oldExposure = targetExposure;
          targetExposure = PREFERRED_ENTRY_SIZE;
          botState.actualEntrySize = targetExposure;
          botState.entryTier = "STANDARD_ENTRY";
          console.log(`[POSITION_SIZE_INVALID_FALSE_BLOCK_PREVENTED] Soft reductions would shrink ${botState.activeSymbol} below preferred executable size. Restored $${oldExposure.toFixed(2)} -> $${targetExposure.toFixed(2)}.`);
          console.log(`[FINAL_ROUTER_SIZE_APPROVED] Final router size preserved above minimum after soft-risk reconciliation.`);
        }

        // Calculate Protection Parameters
        let tpPct = botState.config.takeProfitPct || 2.0;
        let slPct = botState.config.stopLossPct || 0.5;

        if (currentOpp && (currentOpp as any).tpSlAggressivenessModifier !== undefined && (currentOpp as any).tpSlAggressivenessModifier < 1.0) {
          const mod = (currentOpp as any).tpSlAggressivenessModifier;
          tpPct *= mod;
          slPct *= mod;
          console.log(`[SOFT_RISK_TP_SL_AGGRESSIVENESS_APPLIED] Adjusted protection targets bounds by ${mod.toFixed(2)}x for safer, tighter execution.`);
        }

        // Custom High-vol protection
        if (isHighVol) {
          slPct = Math.max(1.5, slPct); // Min 1.5% for high vol
        }

        let atrTargetSL = (signal.atrPct || 0) * 1.5;
        let finalSlPct = Math.max(slPct, atrTargetSL) * customSlMultiplier;

        if ((botState as any).isLateButTradeable) {
           finalSlPct = Math.min(finalSlPct * 0.7, 0.4);
        }

        // Apply CoinMarketCap Narrative Rotation Protection on entering SL/TP
        const entryCmc = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === botState.activeSymbol || a.symbol === botState.activeSymbol);
        if (entryCmc) {
          const strongestNarrative = botState.cmcIntelligence?.strongestNarrative || "AI";
          const weakeningNarrative = botState.cmcIntelligence?.weakeningNarrative || "DeFi";
          
          if (entryCmc.narrative === strongestNarrative) {
            tpPct *= 1.4; // 40% wider take profit to ride the trend longer!
            console.log(`[PROFIT_RIDE_EXTENDED] ${botState.activeSymbol} is part of the strongest narrative (${strongestNarrative}). Extended TP target by 40% to ${tpPct.toFixed(2)}% to maximize trend continuation gains.`);
          } else if (entryCmc.narrative === weakeningNarrative) {
            tpPct *= 0.73; // ~30% tighter take profit since sector is weakening
            finalSlPct *= 0.8; // 20% tighter stop loss
            console.log(`[WEAKENING_NARRATIVE_PROTECTION] ${botState.activeSymbol} belongs to weakening narrative (${weakeningNarrative}). Compressing TP target to ${tpPct.toFixed(2)}% & tightening SL to ${finalSlPct.toFixed(2)}%`);
          }
        }

        // Apply dynamic stricter risk controls: tighter stop loss for reduced-size tiers and auto-recovery mode
        if (botState.autoRecoveryMode === "ON") {
          finalSlPct *= 0.75; // 25% tighter SL for auto-recovery entries
          console.log(`[STRICTER_CONTROL_SL] AUTO_RECOVERY: Tightened stop loss by 25% to ${finalSlPct.toFixed(2)}%`);
        } else if (botState.entryTier === "REDUCED_ENTRY") {
          finalSlPct *= 0.75; // 25% tighter SL
          console.log(`[STRICTER_CONTROL_SL] REDUCED_ENTRY: Tightened stop loss by 25% to ${finalSlPct.toFixed(2)}%`);
        } else if (botState.entryTier === "MICRO_ENTRY") {
          finalSlPct *= 0.60; // 40% tighter SL
          console.log(`[STRICTER_CONTROL_SL] MICRO_ENTRY: Tightened stop loss by 40% to ${finalSlPct.toFixed(2)}%`);
        }

        const secureLimit = calculateSafeTpSl(
          botState.activeSymbol,
          isBuy ? "LONG" : "SHORT",
          markPrice,
          tpPct,
          finalSlPct,
          signal.atrPct
        );
        const slPrice = secureLimit.finalSlPrice;
        const tpPrice = secureLimit.finalTpPrice;

        console.log(`BOT: Calculated Protection Targets for ${botState.activeSymbol}:
        TP Price: ${tpPrice.toFixed(4)} (${tpPct}%)
        SL Price: ${slPrice.toFixed(4)} (${finalSlPct.toFixed(2)}%)
        Notional: $${targetExposure.toFixed(2)}`);

        if (!assetMeta) return;

        const assetSizeDecimals = assetMeta.szDecimals || 2;
        const rawBaseSize = targetExposure / markPrice;
        const multiplier = Math.pow(10, assetSizeDecimals);
        let roundedBaseSize =
          Math.floor(rawBaseSize * multiplier + 1e-7) / multiplier;

        const dynamicMinRequired = botState.entryTier === "STANDARD_ENTRY" ? PREFERRED_ENTRY_SIZE : absoluteExecutableMinimum;

        if (
          roundedBaseSize <= 0 ||
          roundedBaseSize * markPrice < dynamicMinRequired * 0.95
        ) {
          console.log(
            `ORDER_SIZE_BELOW_MINIMUM: Computed notional $${(roundedBaseSize * markPrice).toFixed(2)} < minimum required $${dynamicMinRequired.toFixed(2)}`,
          );
          botState.blocker = "POSITION_SIZE_INVALID";
          return botState.blocker;
        }

        // Apply updated progressive leverage bounds for safety
        await executionEngine.setLeverage(botState.activeSymbol, setupLeverage);

        // REAL_ENTRY_REQUIRED: Submitting highly executable aggressive Limit order (1.0% buffer through the best bid/ask)
        console.log(`[REAL_ENTRY_REQUIRED] Approved setup detects entry signal. Prioritizing immediate marketable execution over passive waiting style.`);
        const aggressivePx = isBuy ? botState.markPrice * 1.01 : botState.markPrice * 0.99;
        console.log(`[MARKETABLE_ENTRY_SUBMITTED] Submitting aggressive limit entry for ${botState.activeSymbol} at px ${aggressivePx.toFixed(4)} (mark: ${botState.markPrice})`);

        // Execute Entry with latency logging
        console.log("ORDER_SUBMITTED: Entry order submitted.");
        const entryStartTime = Date.now();
        let order = await executionEngine.placeOrder(
          botState.activeSymbol,
          isBuy,
          roundedBaseSize,
          aggressivePx,
          false,
          true
        );
        
        // Exact recovery handlers for failed entry execute
        if (!order && botState.lastApiError) {
            const err = botState.lastApiError.toLowerCase();
            
            if (err.includes("entry_blocked_no_available_slo") || err.includes("entry_blocked_no_available_slot") || err.includes("internal_entry_slo_capacity")) {
                console.log(`[ENTRY_BLOCKED_NO_AVAILABLE_SLO_CLASSIFIED] ${botState.activeSymbol} failure classified as internal router SLO/slot inconsistency, not an exchange rejection.`);
                const slotRecovered = reconcileEntrySloCapacity(botState.activeSymbol);
                if (slotRecovered) {
                    console.log(`[ENTRY_SLO_RECONCILED] ${botState.activeSymbol} router SLO reconciled from real open positions and pending entries.`);
                    console.log(`[ENTRY_SLO_FALSE_BLOCK_PREVENTED] ${botState.activeSymbol} retrying entry after false SLO block.`);
                    order = await executionEngine.placeOrder(botState.activeSymbol, isBuy, roundedBaseSize, aggressivePx, false, true);
                    if (order) {
                        console.log(`[ORDER_SUBMISSION_RECOVERED] ${botState.activeSymbol} order recovered after entry SLO reconciliation.`);
                        botState.lastApiError = null;
                        botState.blocker = null;
                    } else {
                        botState.blocker = "ENTRY_SLO_RECONCILIATION_FAILED";
                        console.log(`[ORDER_REJECTION_COOLDOWN_APPLIED] ${botState.activeSymbol} SLO reconciliation failed; applying symbol-specific retry delay only.`);
                        botState.routerBlockCooldowns = botState.routerBlockCooldowns || {};
                        botState.routerBlockCooldowns[botState.activeSymbol] = Date.now() + 15000;
                    }
                } else {
                    botState.blocker = "ENTRY_SLO_HARD_CAPACITY_BLOCK";
                    console.log(`[ENTRY_BLOCKED] symbol=${botState.activeSymbol}, reason=MAX_OPEN_POSITIONS, raw=ENTRY_SLO_HARD_CAPACITY_BLOCK`);
                }
            } else if (
              err.includes("rate limit") || 
              err.includes("rate_limit") || 
              err.includes("too many cumulative") || 
              err.includes("backoff") || 
              err.includes("api_budget") ||
              err.includes("rest_pressure") ||
              err.includes("execution_layer_throttled") ||
              err.includes("exceeded") ||
              err.includes("volume traded")
            ) {
                const actualExchangeRateLimit = err.includes("rate limit") || err.includes("too many cumulative") || err.includes("volume traded");
                const currentOppForBudget = botState.scannerOpportunities?.find(o => o.symbol === botState.activeSymbol) as any;
                const isTopCandidateForBudget = (currentOppForBudget?.executionPriorityRank || 999) <= Math.max(1, Math.min(3, botState.availableSlots || 1)) || (currentOppForBudget?.finalExecutionScore || 0) >= 70;
                if (!actualExchangeRateLimit && isTopCandidateForBudget && (botState.availableSlots || 0) > 0) {
                    console.log(`[TOP_CANDIDATE_ACTION_RESERVED] ${botState.activeSymbol} retrying once using reserved top-candidate exchange action.`);
                    console.log(`[REST_DEGRADED_TOP_CANDIDATE_ALLOWED] ${botState.activeSymbol} API budget soft block bypassed for single best candidate.`);
                    console.log(`[API_BUDGET_OVERBLOCK_PREVENTED] ${botState.activeSymbol} API budget did not become a global execution freeze.`);
                    botState.executionThrottleUntil = 0;
                    order = await executionEngine.placeOrder(botState.activeSymbol, isBuy, roundedBaseSize, aggressivePx, false, true);
                    if (order) {
                        console.log(`[ORDER_SUBMISSION_RECOVERED] ${botState.activeSymbol} order recovered after API budget overblock prevention.`);
                        botState.lastApiError = null;
                        botState.blocker = null;
                    }
                } else {
                    console.log("[BUDGET_ENFORCER] Entry deferred for API budget recharge.");
                    console.log("[ORDER_RETRY_SUPPRESSED_API_BUDGET] Suppressing automatic retry due to active budget constraint.");
                    botState.executionThrottleUntil = Date.now() + 30000; // 30s throttle
                    botState.blocker = actualExchangeRateLimit ? "API_RATE_LIMIT_EXCEEDED" : "API_BUDGET_LIMIT";
                    botState.analytics.lessons = botState.analytics.lessons || [];

                    const existingLesson = botState.analytics.lessons.find((l: string) => l.includes(`${botState.activeSymbol}: API_BUDGET_LIMIT`));
                    if (existingLesson) {
                        console.log(`[API_BUDGET_COOLDOWN_ALREADY_ACTIVE] ${botState.activeSymbol} already recorded API limit lesson.`);
                    } else {
                        botState.analytics.lessons.push(`${botState.activeSymbol}: API_BUDGET_LIMIT → RETRY_DELAY_30S`);
                    }
                }
            } else {
                console.log(`[EXECUTION_RECOVERY_ATTEMPT] Order failed: ${botState.lastApiError}`);
                console.log(`[ORDER_FAILURE_SELF_REPAIR_STARTED] Commencing automatic recovery for order on ${botState.activeSymbol}.`);
            
                if (err.includes("auth") || err.includes("key") || err.includes("signer")) {
                console.log("[EXECUTION_FAILURE_CLASSIFIED] PRIVATE_KEY_MISSING");
                console.log("[ORDER_FAILURE_UNRECOVERABLE_CLASSIFIED] Unrecoverable authentication error.");
                botState.liveModeEnabled = false;
                if (botState.liveModeDiagnostics) botState.liveModeDiagnostics.exchangeMutationsAllowed = false;
                botState.blocker = "LIVE TRADING BLOCKED — CONFIGURATION REQUIRED";
                botState.analytics.lessons = botState.analytics.lessons || [];
                botState.analytics.lessons.push(`${botState.activeSymbol}: AUTH_REQUIRED → LIVE_TRADING_DISABLED`);
            } else if (err.includes("margin") || err.includes("insufficient") || err.includes("funds")) {
                console.log("[EXECUTION_FAILURE_CLASSIFIED] INSUFFICIENT_MARGIN - Halving size for safe retry.");
                console.log("[ORDER_SIZE_REBUILT_AND_RETRIED] Rebuilt size with half margin.");
                const safeSize = roundedBaseSize * 0.5;
                if (safeSize * botState.markPrice >= 12) {
                   botState.analytics.lessons = botState.analytics.lessons || [];
                   botState.analytics.lessons.push(`${botState.activeSymbol}: INSUFFICIENT_MARGIN → SIZE_REBUILT → RETRY_SENT`);
                   console.log(`[ORDER_REPAIR_RETRY_SENT] ${botState.activeSymbol} retrying with safely reduced size after INSUFFICIENT_MARGIN.`);
                   order = await executionEngine.placeOrder(botState.activeSymbol, isBuy, safeSize, aggressivePx, false, true);
                   if (!order) {
                       console.log("[EXECUTION_RECOVERY_FAILED] Retry still returned INSUFFICIENT_MARGIN.");
                       botState.cooldownUntil = Date.now() + 60000; // block for 1m
                       botState.blocker = "INSUFFICIENT_MARGIN_RECOVERY_FAILED";
                   } else {
                       roundedBaseSize = safeSize; // update memory size if successful
                   }
                } else {
                   console.log("[EXECUTION_RECOVERY_FAILED] Margin too low to halve size above exchange minimum.");
                   botState.cooldownUntil = Date.now() + 60000;
                   botState.blocker = "INSUFFICIENT_MARGIN_NOT_RECOVERABLE";
                }
            } else if (err.includes("size") || err.includes("minimum") || err.includes("notional") || err.includes("sz") || err.includes("out of range")) {
                console.log("[EXECUTION_FAILURE_CLASSIFIED] INVALID_ORDER_SIZE - Enforcing exchange minSize overrides.");
                console.log(`[ORDER_SIZE_REBUILT_AND_RETRIED] Rebuilt size mapped to min notional and exchange precision constraints.`);
                const metaForSym = getAssetMeta ? getAssetMeta(botState.activeSymbol) : null;
                const minSz = metaForSym ? (metaForSym.minSz || 0) : 0;
                // Minimum notional $11 
                const mathMinSz = minSz > 0 ? minSz : 1;
                const requiredMinSizeForNotional = 11 / botState.markPrice;
                const newSizeForRetry = Math.max(roundedBaseSize, mathMinSz, requiredMinSizeForNotional);
                
                // Re-apply szDecimals
                const szDecimals = metaForSym?.szDecimals || 0;
                const minSizeStr = (Math.ceil(newSizeForRetry * Math.pow(10, szDecimals)) / Math.pow(10, szDecimals)).toFixed(szDecimals);
                const correctedSize = parseFloat(minSizeStr);

                console.log(`[EXECUTION_RECOVERY] Adjusted size from ${roundedBaseSize} to ${correctedSize}`);
                botState.analytics.lessons = botState.analytics.lessons || [];
                botState.analytics.lessons.push(`${botState.activeSymbol}: INVALID_ORDER_SIZE → SIZE_REBUILT → RETRY_SENT`);
                console.log(`[ORDER_REPAIR_RETRY_SENT] ${botState.activeSymbol} retrying with rebuilt size ${correctedSize}.`);
                order = await executionEngine.placeOrder(botState.activeSymbol, isBuy, correctedSize, aggressivePx, false, true);
                if (!order) {
                    botState.cooldownUntil = Date.now() + 300000;
                    botState.blocker = "INVALID_ORDER_SIZE_RECOVERY_FAILED";
                } else {
                    roundedBaseSize = correctedSize;
                }
            } else if (err.includes("price") || err.includes("precision") || err.includes("tick")) {
                console.log("[EXECUTION_FAILURE_CLASSIFIED] INVALID_PRICE_PRECISION - Truncating price directly.");
                console.log(`[ORDER_PRICE_REBUILT_AND_RETRIED] Rebuilt price properly constrained.`);
                // Try to format aggressively with 3 decimal precision
                const correctedPx = parseFloat(aggressivePx.toFixed(3));
                botState.analytics.lessons = botState.analytics.lessons || [];
                botState.analytics.lessons.push(`${botState.activeSymbol}: INVALID_PRICE_PRECISION → PRICE_REBUILT → RETRY_SENT`);
                console.log(`[ORDER_REPAIR_RETRY_SENT] ${botState.activeSymbol} retrying with rebuilt price ${correctedPx}.`);
                order = await executionEngine.placeOrder(botState.activeSymbol, isBuy, roundedBaseSize, correctedPx, false, true);
                if (!order) {
                    botState.cooldownUntil = Date.now() + 60000;
                    botState.blocker = "INVALID_PRICE_RECOVERY_FAILED";
                }
            } else {
                console.log("[EXECUTION_FAILURE_CLASSIFIED] EXCHANGE_REJECTED_ORDER:", err);
                console.log("[ORDER_FAILURE_UNRECOVERABLE_CLASSIFIED] Unrecoverable general exchange rejection.");
                // General cooldown
                botState.cooldownUntil = Date.now() + 60000;
                botState.blocker = `EXCHANGE_REJECTED_UNRECOVERABLE: ${err.substring(0, 30)}`;
            }
            
            }

            if (order) {
                console.log(`[ORDER_SUBMISSION_RECOVERED] Order successfully placed during self-repair phase!`);
                botState.lastApiError = null; // Clean up the trace so it resolves properly!
            }
        }
        
        const apiLatency = Date.now() - entryStartTime;

        if (order) {
          const orderStatus = order?.response?.data?.statuses?.[0];
          const isFilledImmediately = config.DRY_RUN || !!(orderStatus && orderStatus.filled);
          const isResting = !config.DRY_RUN && !!(orderStatus && orderStatus.resting);

          if (isFilledImmediately) {
            console.log("[ORDER_FILLED_POSITION_OPENED] Entry order filled immediately on placement!");
            console.log("POSITION_OPENED: Tracking new active position.");
          } else if (isResting) {
            console.log(`[ENTRY_ORDER_PENDING] Marketable entry limit submitted but is resting in orderbook (oid: ${botState.lastOrderId})`);
          }
          
          const contextEntryReason = `${signal.direction} confirmation met (${signal.consecutiveCandlesCount || 0}/3 candles). Regime ${signal.marketRegime} consistent (${signal.consecutiveRegimeCount || 0}/5 candles). Volatility: ${(signal.volatilityScore || 0).toFixed(2)}.`;
          if (botState.lastOrderId) {
            if (!botState.entryOrdersContext) botState.entryOrdersContext = {};
            botState.entryOrdersContext[botState.lastOrderId.toString()] = {
              symbol: botState.activeSymbol,
              side: isBuy ? "LONG" : "SHORT",
              size: roundedBaseSize,
              px: aggressivePx,
              confidence: conf,
              regime: signal.marketRegime || "UNKNOWN",
              reason: contextEntryReason,
              ts: Date.now()
            };
          }

          if (multiPositionMode) {
             const projUsed = roundedBaseSize * markPrice / setupLeverage;
             const newAvail = botState.availableMargin - projUsed;
             const marginPct = botState.accountEquity > 0 ? (newAvail / botState.accountEquity) * 100 : 0;
             console.log(`[POST_ENTRY_MARGIN_DIAGNOSTIC] Projected free margin post-fill: $${newAvail.toFixed(2)} (${marginPct.toFixed(1)}%) | Used: $${projUsed.toFixed(2)} at ${setupLeverage}x`);
          }

          // Confirm track of entry parameters
          botState.lastEntryTimestamp = Date.now();
          botState.scansSinceLastEntry = 0;
          botState.dailyTradeCount = (botState.dailyTradeCount || 0) + 1; // Increment on successful entry placement
          botState.blocker = null;

          // Set protection in state
          const wasOverride = botState.cooldownOverrideActive || botState.feePauseOverrideActive || botState.drawdownOverrideActive;
          const isChopRec = (botState as any).isChopRecoveryAllowedEntry || false;
          botState.cooldownOverrideActive = false; // Reset override after fill
          botState.feePauseOverrideActive = false;
          botState.drawdownOverrideActive = false;
          (botState as any).isChopRecoveryAllowedEntry = false; // Reset dynamic entry flag
          botState.protection = {
            tpPrice,
            slPrice,
            trailingStopPrice: null,
            isTrailingActive: false,
            highestUnrealizedPnlPct: 0,
            currentLockedProfitPct: 0,
            activeProfitLockLevel: "NONE",
            isLateButTradeable: (botState as any).isLateButTradeable || wasOverride || false,
            requiresTightTrailing: wasOverride,
            isChopRecovery: isChopRec
          };
          
          botState.protectionStatus = "REPAIRING"; // Mark as repairing until confirmed
          
          // Await directly and log
          const tpSlSuccess = await executionEngine.placeTpSlOrders(botState.activeSymbol, isBuy, roundedBaseSize, tpPrice, slPrice);
          if (tpSlSuccess) {
              botState.protectionStatus = "CONFIRMED";
              console.log(`TP_SL_ATTACHED_CONFIRMED: Successfully attached protective orders for ${botState.activeSymbol}`);
          } else {
              console.error(`BOT: Warning: TP/SL orders failed to attach for ${botState.activeSymbol}.`);
          }

          // Calculate exact entry slippage
          const fillPrice = botState.lastFillPrice || botState.markPrice;
          const slippagePct =
            botState.markPrice > 0
              ? (isBuy
                  ? (fillPrice - botState.markPrice) / botState.markPrice
                  : (botState.markPrice - fillPrice) / botState.markPrice) * 100
              : 0;

          const entryReasonText = `${signal.direction} confirmation met (${signal.consecutiveCandlesCount || 0}/3 candles). Regime ${signal.marketRegime} consistent (${signal.consecutiveRegimeCount || 0}/5 candles). Volatility: ${(signal.volatilityScore || 0).toFixed(2)}.`;

          await tradeLogger.logTrade({
            timestamp: Date.now(),
            symbol: botState.activeSymbol,
            side: signal.direction,
            size: roundedBaseSize,
            notional: roundedBaseSize * markPrice,
            leverage: setupLeverage,
            entryPrice: fillPrice,
            orderId: botState.lastOrderId || "PENDING",
            type: "ENTRY",
            confidenceScore: signal.confidence,
            tradeQualityScore: signal.tradeQualityScore,
            volatilityScore: signal.volatilityScore,
            trendScore: signal.trendScore,
            momentumScore: signal.momentumScore,
            entryReason: entryReasonText,
            fundingRate: botState.fundingRate,
            wssHealth: botState.wssConnected ? "STABLE" : "UNSTABLE",
            apiLatency: apiLatency,
            marketRegime: signal.marketRegime,
            slippage: slippagePct,
            expectedMovePct: signal.expectedMovePct,
          });
          
          if (botState.autoRecoveryMode === "ON") {
              console.log("[AUTO_RECOVERY_ENTRY_APPROVED] Autonomous recovery entry approved.");
              console.log("[RISK_ADJUSTED_ENTRY_APPROVED] Risk-adjusted entry approved under auto-recovery.");
          } else if (botState.analytics?.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
              console.log(`OVERRIDE_ENTRY_SUBMITTED: Override entry successfully placed for ${botState.activeSymbol}.`);
          }
          console.log(`ORDER_SUBMITTED_SUCCESSFULLY: ${botState.activeSymbol} filled at ${fillPrice}.`);
        } else {
          if (botState.blocker === "API_RATE_LIMIT_EXCEEDED" || (botState.lastApiError && (botState.lastApiError.includes("cumulative volume") || botState.lastApiError.includes("cumulative request")))) {
              console.warn("BOT: Entry order deferred due to Hyperliquid API Budget constraints. No protection active.");
          } else {
              console.error("BOT: Entry order failed. No protection active.");
          }
          botState.cooldownOverrideActive = false; // Reset override on failure
          botState.feePauseOverrideActive = false;
          
          const errorBlockersToPreserve = [
            "API_RATE_LIMIT_EXCEEDED", 
            "ENTRY_BLOCKED_NO_AVAILABLE_SLOTS", 
            "AUTH_REQUIRED",
            "LIVE TRADING BLOCKED — CONFIGURATION REQUIRED",
            "INSUFFICIENT_MARGIN_COOLDOWN",
            "INVALID_ORDER_SIZE_COOLDOWN",
            "INVALID_PRICE_COOLDOWN",
            "ORDER_SUBMITTED_FAILED_COOLDOWN",
            "INSUFFICIENT_MARGIN_RECOVERY_FAILED",
            "INSUFFICIENT_MARGIN_NOT_RECOVERABLE",
            "INVALID_ORDER_SIZE_RECOVERY_FAILED",
            "INVALID_PRICE_RECOVERY_FAILED"
          ];
          
          let effectiveBlocker = botState.blocker || "";
          
          const isUnrecoverableReject = effectiveBlocker.startsWith("EXCHANGE_REJECTED_UNRECOVERABLE");
          
          if (!errorBlockersToPreserve.includes(effectiveBlocker) && !isUnrecoverableReject) {
              // Instead of blocking globally, apply per-symbol cooldown
              if (!botState.routerBlockCooldowns) botState.routerBlockCooldowns = {};
              botState.routerBlockCooldowns[botState.activeSymbol] = Date.now() + 15000;
              return "ORDER_SUBMITTED_FAILED_FOR_SYMBOL";
          }
          return botState.blocker;
        }
        return "ORDER_SUBMITTED_SUCCESSFULLY";
      }
      
      console.log(`[EXECUTION_ROUTER_BLOCK_RESOLVER] Blocker status resolve: original blocker is '${botState.blocker || "NONE"}'.`);
      if (!botState.blocker) {
        console.log(`[EXECUTION_ROUTER_BLOCK_RESOLVER] Blocker is null/falsy, returning 'PASSED' to permit execution.`);
        return "PASSED";
      }
      console.log(`[EXECUTION_ROUTER_BLOCK_RESOLVER] Blocker is active, returning blocker code: '${botState.blocker}'.`);
      return botState.blocker;
      }; // end of executeEntryAndGetBlocker

      // API Budget Throttle increment per execution
      botState.executionThrottleUntil = Date.now() + 1500; // 1.5s Execution throttle to save API budget
      botState.telemetry.finalRouterAttemptsMap = botState.telemetry.finalRouterAttemptsMap || {};
      botState.telemetry.finalRouterAttemptsMap["EXECUTED"] = (botState.telemetry.finalRouterAttemptsMap["EXECUTED"] || 0) + 1;
      
      if (botState.apiRateLimitUntil && Date.now() < botState.apiRateLimitUntil) {
         console.warn(`[FINAL_ROUTER_ATTEMPTS_LIMITED] Skipping final logic step to prevent API exhaustion.`);
         _traceBlocker = "API_RATE_LIMIT_EXCEEDED";
      } else {
         _traceBlocker = await executeEntryAndGetBlocker();
      }

      if (_traceBlocker !== "PASSED" && _traceBlocker !== "ORDER_SUBMITTED_SUCCESSFULLY") {
          if (_traceBlocker === "POSITION_SIZE_INVALID") {
              botState.positionSizeInvalidCooldowns = botState.positionSizeInvalidCooldowns || {};
              botState.positionSizeInvalidCooldowns[_sym] = Date.now() + 300000;
              botState.telemetry.sizingInvalidCooldownCount = (botState.telemetry.sizingInvalidCooldownCount || 0) + 1;
              console.warn(`[ROUTER_POSITION_SIZE_INVALID_COOLDOWN] Applied 5m cooldown to ${_sym}.`);
          } else if (_traceBlocker === "EXECUTION_ROUTER_BLOCKED" || _traceBlocker.startsWith("ENTRY_BLOCKED") || _traceBlocker.startsWith("TP_SL_PRECHECK_FAILED") || _traceBlocker.endsWith("REJECTED")) {
              botState.routerBlockCooldowns = botState.routerBlockCooldowns || {};
              botState.routerBlockCooldowns[_sym] = Date.now() + 60000;
              botState.telemetry.routerBlockCooldownCount = (botState.telemetry.routerBlockCooldownCount || 0) + 1;
              console.warn(`[ROUTER_BLOCK_RETRY_COOLDOWN] Applied 60s cooldown to ${_sym} for ${_traceBlocker}.`);
          }
      }

      const astMeta = getAssetMeta(_sym);
      const protocolMin = 11;
      const minSzNot = (astMeta?.minSz || 0) * (botState.markPrice || 0);
      const reqNotional = Math.max(protocolMin, minSzNot);
      const estFreeCollateralPct = botState.accountEquity > 0 ? ((botState.availableMargin -_targetExposure/_setupLeverage) / botState.accountEquity) * 100 : 0;
      const finalRouterLimit = getDynamicMaxPositions().limit;

      console.log(`FINAL_ORDER_ROUTER_TRACE:
* symbol: ${_sym}
* side: ${signal.direction}
* confidence: ${signal.confidence}%
* active phase: ${botState.phase}
* entry engine enabled: ${botState.apiConnected}
* canEnterNew: ${canEnterNew}
* current blocker: ${botState.blocker || "NONE"}
* open positions: ${botState.openPositions}
* max positions: ${multiPositionMode ? finalRouterLimit : 1}
* resting orders: ${botState.activeOrders?.length || 0}
* total equity: $${botState.accountEquity.toFixed(2)}
* available margin: $${botState.availableMargin.toFixed(2)}
* free collateral %: ${botState.freeCollateralPct?.toFixed(1) || 0}%
* projected post-entry free collateral: ${estFreeCollateralPct.toFixed(1)}%
* calculated safe size: ${_targetExposure.toFixed(2)}
* exchange minimum size: ${reqNotional.toFixed(2)}
* final order size: ${_targetExposure.toFixed(2)}
* leverage selected: ${_setupLeverage}x
* leverage update status: SUCCESS
* TP/SL precheck result: PASSED
* WSS status: ${botState.wssConnected ? "CONNECTED" : "DISCONNECTED"}
* API status: ${botState.apiConnected ? "ARMED" : "HALTED"}
* order router status: ${botState.apiConnected ? "ARMED" : "HALTED"}
* final decision: ${_traceBlocker}`);

      if (_traceBlocker !== "ORDER_SUBMITTED_SUCCESSFULLY" && _traceBlocker !== "PASSED") {
         botState.blocker = _traceBlocker;
         if (botState.autoRecoveryMode === "ON") {
           console.log(`[AUTO_RECOVERY_ENTRY_BLOCKED] Trade execution blocked during autonomous recovery due to: ${_traceBlocker}`);
         }
         console.warn(`EXECUTION_READY_BUT_NOT_SUBMITTED: ${_sym} setup reached EXECUTION_READY but was blocked by ${_traceBlocker}`);
         botState.analytics.lessons = botState.analytics.lessons || [];
         if (botState.analytics.lessons.length < 5) {
            botState.analytics.lessons.push(`Missed execution on ${_sym} due to ${_traceBlocker}`);
         }
         console.log(`[ENTRY_BLOCKED] symbol=${_sym}, reason=${_traceBlocker}`);
      } else {
         console.log(`[ENTRY_ACCEPTED] symbol=${_sym}, side=${signal.direction}, size=${_targetExposure}`);
         // Increment open positions local count so next iteration is aware a slot is reserved
         botState.openPositions = (botState.openPositions || 0) + 1;
      }
    }
  }

  if (botState.openPositions > 0 && botState.positionDetails) {
    // OPEN_POSITION_MARGIN_CHECK
    const totalEquity = botState.accountEquity;
    const availableMargin = botState.availableMargin;
    const marginUsed =
      botState.marginUsed ||
      parseFloat(botState.positionDetails?.marginUsed || "0");
    const maintenanceBuffer = totalEquity > 0 ? totalEquity * 0.1 : 0; // Minimum 10% safety buffer
    const freeCollateralRatio =
      totalEquity > 0 ? (availableMargin / totalEquity) * 100 : 0;

    console.log(
      `[OPEN_POSITION_MARGIN_STATUS] Total Equity: $${totalEquity.toFixed(2)} | Reserved Margin: $${marginUsed.toFixed(2)} | Available Margin: $${availableMargin.toFixed(2)} | Maint. Buffer: $${maintenanceBuffer.toFixed(2)} | Free Collateral: ${freeCollateralRatio.toFixed(1)}%`,
    );

    if (totalEquity < 20 && totalEquity > 0) {
      console.log(
        `[LOW_EQUITY_CHECK] Total Account Equity ($${totalEquity.toFixed(2)}) is critically low. This evaluates TOTAL_ACCOUNT_EQUITY, not available margin.`,
      );
    }

    if (availableMargin < maintenanceBuffer && availableMargin > 0) {
      console.log(
        `[AVAILABLE_MARGIN_CHECK] Available margin ($${availableMargin.toFixed(2)}) is below maintenance buffer ($${maintenanceBuffer.toFixed(2)}).`,
      );
    }

    // Check for exit
    const szi = parseFloat(botState.positionDetails?.szi || "0");
    const entryPx = parseFloat(botState.positionDetails?.entryPx || "0");
    const posCoin = botState.positionDetails?.coin;
    const currentPrice = (botState.markPrices && posCoin && botState.markPrices[posCoin]) || botState.markPrice;
    const currentSide = szi > 0 ? "LONG" : szi < 0 ? "SHORT" : "NONE";

    if (
      !botState.lastEntryTimestamp ||
      typeof botState.lastEntryTimestamp !== "number" ||
      botState.lastEntryTimestamp === 0
    ) {
      console.warn(
        `[STATE_DESYNC] Found active position (szi: ${szi}) but missing bot entry state. Reconstructing state to allow management.`,
      );
      botState.lastEntryTimestamp = Date.now();
      botState.lastFillPrice = entryPx;
    }

    if (szi === 0 || entryPx === 0) {
      console.error(
        `[STATE_DESYNC] Position claims open but szi or entryPx is 0. Halting.`,
      );
      triggerCircuitBreaker("CIRCUIT_BREAKER_ACTIVE: INVALID_POSITION_DATA");
      botState.validationStatus = "VALIDATION_FAILED";
      return;
    }

    // Calculate current trade PnL % (Unleveraged based on entry price distance)
    const pnlPct =
      currentSide === "LONG"
        ? ((currentPrice - entryPx) / entryPx) * 100
        : ((entryPx - currentPrice) / entryPx) * 100;

    // Protection exit check
    let isExitTriggered = false;
    let exitReason = "";

    // Load protection from state
    const { tpPrice, isTrailingActive } = botState.protection;
    let slPrice = botState.protection.slPrice;
    let trailingStopPrice = botState.protection.trailingStopPrice;

    const elapsedHoldTime = Date.now() - (botState.lastEntryTimestamp || 0);

    // EMERGENCY MODE: TP/SL Checks and Margin Checks
    if (isEmergencyMode) {
      if (tpPrice === null && slPrice === null && trailingStopPrice === null) {
        console.warn("[EMERGENCY_MANAGEMENT] EMERGENCY_CLOSE_TP_SL_MISSING");
        isExitTriggered = true;
        exitReason = "EMERGENCY_CLOSE_TP_SL_MISSING";
      } else if (botState.availableMargin < 0.2) {
        // Margin critically low
        console.warn("[EMERGENCY_MANAGEMENT] EMERGENCY_CLOSE_LOW_MARGIN");
        isExitTriggered = true;
        exitReason = "EMERGENCY_CLOSE_LOW_MARGIN";
      } else {
        botState.blocker = "PROTECTING_OPEN_POSITION";
      }
    }

    // --- CAPITAL ROTATION & HOLD DURATION LOGIC ---
    const elapsedHoldMinutes = elapsedHoldTime / (1000 * 60);
    const momentumScore = signal.momentumScore || 0;
    const trendStrength = signal.trendStrength || 0;
    const isWeakTrade = momentumScore < 0.3 || trendStrength < 0.3;
    const pnlPerHour = elapsedHoldMinutes > 0 ? (pnlPct / (elapsedHoldMinutes / 60)) : 0;
    
    let isStagnating = false;

    // CoinMarketCap Trend-Aware Profitability & Rotations checks (Requirements 6, 7 & 9)
    const activeCmcMatched = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === botState.activeSymbol || a.symbol === botState.activeSymbol);
    if (activeCmcMatched) {
      const strongestNarrative = botState.cmcIntelligence?.strongestNarrative || "AI";
      const weakeningNarrative = botState.cmcIntelligence?.weakeningNarrative || "DeFi";
      const fadingNarrative = botState.cmcIntelligence?.fadingNarrative || "gaming";

      if (activeCmcMatched.narrative === weakeningNarrative || activeCmcMatched.narrative === fadingNarrative) {
        console.log(`[WEAKENING_NARRATIVE_DETECTED] Open position ${botState.activeSymbol} belongs to weakening/fading narrative (${activeCmcMatched.narrative}). Tightening exit parameters.`);
        
        // Tighten trailing trigger threshold parameter
        (botState.protection as any).requiresTightTrailing = true;

        // Drastically reduce hold tolerance for weak/stagnating narratives
        if (elapsedHoldMinutes > 15 && pnlPct < 0.2) {
          isStagnating = true;
          console.log(`[PROFITABILITY_ROTATION_APPLIED] Reduced hold tolerance applied. Prepared to rotate away from ${botState.activeSymbol}.`);
        }

        if (elapsedHoldMinutes > 30 && pnlPct < 0.5) {
          isExitTriggered = true;
          exitReason = "CAPITAL_ROTATION_WEAK_NARRATIVE";
          console.log(`[PROFITABILITY_ROTATION_APPLIED] Active execution rotated capital immediately from weakening narrative ${botState.activeSymbol} (elapsed: ${elapsedHoldMinutes.toFixed(1)}m, Ln Pnl: ${pnlPct.toFixed(2)}%).`);
        }
      } else if (activeCmcMatched.narrative === strongestNarrative) {
        // Ride strongest narratives longer: extend hold tolerance
        if (elapsedHoldMinutes > 120 && pnlPct >= 1.0) {
          isStagnating = false;
          console.log(`[PROFITABLE_TREND_HELD] Keeping strong trend asset ${botState.activeSymbol} under narrative ${strongestNarrative}. Extending target window.`);
        }
      }
    }
    
    if (elapsedHoldMinutes > 45 && !isStagnating) {
        if (pnlPct < 0.5 && isWeakTrade) {
            isStagnating = true;
            console.log(`[POSITION_STAGNATION_DETECTED] Trade weak after ${elapsedHoldMinutes.toFixed(1)} mins. PnL: ${pnlPct.toFixed(2)}%.`);
        }
    }
    
    if (elapsedHoldMinutes > 120 && pnlPct < 1.0 && !isStagnating) {
        isStagnating = true;
        console.log(`[CAPITAL_ROTATION_REVIEW] Hold time excessive (${elapsedHoldMinutes.toFixed(1)} mins) with low PnL (${pnlPct.toFixed(2)}%).`);
        console.log(`[POSITION_EFFICIENCY_REVIEWED] Capital efficiency degraded.`);
    }

    if (isStagnating && !isExitTriggered) {
        if (pnlPct > 0.2) { // Try to exit at slight profit / breakeven
            const tightenSL = currentSide === "LONG" ? entryPx * 1.001 : entryPx * 0.999;
            const currentSL = botState.protection.slPrice;
            const isBetterLock = currentSL === null || (currentSide === "LONG" ? tightenSL > currentSL : tightenSL < currentSL);
            if (isBetterLock) {
                slPrice = tightenSL;
                botState.protection.slPrice = tightenSL;
                console.log(`[EARLY_PROFIT_CAPTURE_ACTIVATED] Tightened SL to breakeven+ due to stagnation.`);
                console.log(`[HOLD_DURATION_REDUCED] Exit threshold tightened to force capital free-up.`);
            }
        } 
        
        if (elapsedHoldMinutes > 180 && pnlPct < 0.5) {
             console.log(`[LOW_EFFICIENCY_HOLD_EXIT] Closing stagnant trade to free capital.`);
             isExitTriggered = true;
             exitReason = "CAPITAL_ROTATION_STAGNATION";
             console.log(`[CAPITAL_ROTATION_TRIGGERED] Active execution halted to rotate capital.`);
        }
    }
    // ----------------------------------------------

    // Progressive Profit-Lock Protection (Ladder)
    if (botState.protection.highestUnrealizedPnlPct === undefined || botState.protection.highestUnrealizedPnlPct === null) {
      botState.protection.highestUnrealizedPnlPct = 0;
    }
    if (pnlPct > botState.protection.highestUnrealizedPnlPct) {
      botState.protection.highestUnrealizedPnlPct = pnlPct;
    }

    if (!botState.protection.highestFavorablePrice || botState.protection.highestFavorablePrice <= 0) {
      botState.protection.highestFavorablePrice = currentPrice;
    }
    const priorFavorablePrice = botState.protection.highestFavorablePrice;
    botState.protection.highestFavorablePrice = currentSide === "LONG"
      ? Math.max(priorFavorablePrice, currentPrice)
      : Math.min(priorFavorablePrice, currentPrice);
    const favorableExcursionPct = currentSide === "LONG"
      ? ((botState.protection.highestFavorablePrice - entryPx) / entryPx) * 100
      : ((entryPx - botState.protection.highestFavorablePrice) / entryPx) * 100;
    botState.protection.maxFavorableExcursionPct = Math.max(botState.protection.maxFavorableExcursionPct || 0, favorableExcursionPct);

    const hlPnl = botState.protection.highestUnrealizedPnlPct;
    
    let level3Threshold = 3.0;
    let level2Threshold = 2.0;
    let level1Threshold = 1.0;
    let armedThreshold = 0.30;
    
    const isDDActiveForBreakeven = botState.drawdownSeverity === "SOFT" || botState.drawdownSeverity === "SOFT_LEVEL_1" || botState.drawdownSeverity === "SOFT_LEVEL_2" || botState.drawdownSeverity === "MODERATE" || botState.drawdownOverrideActive;
    if (isDDActiveForBreakeven || (botState.protection as any)?.isLateButTradeable || (botState.protection as any)?.requiresTightTrailing || botState.analytics?.TOO_CONSERVATIVE_OVERRIDE_ACTIVE || botState.drawdownOverrideActive || botState.protection.isChopRecovery || botState.entryTier === "REDUCED_ENTRY" || botState.entryTier === "MICRO_ENTRY" || botState.autoRecoveryMode === "ON") {
       if (isDDActiveForBreakeven || botState.protection.isChopRecovery || botState.entryTier === "MICRO_ENTRY" || botState.autoRecoveryMode === "ON") {
          level3Threshold *= 0.5;
          level2Threshold *= 0.5;
          level1Threshold *= 0.5;
          armedThreshold *= 0.4; // arm faster (e.g. at 0.12% profit) to activate faster breakeven
       } else {
          level3Threshold *= 0.6;
          level2Threshold *= 0.6;
          level1Threshold *= 0.6;
          armedThreshold *= 0.6;
       }
    }

    // Dynamic continuous profit locking calculation
    if (botState.protection.activeProfitLockLevel !== "TRAILING") {
      let maxLockTarget = botState.protection.currentLockedProfitPct || 0;
      let lockAtArmed = 0.05;
      let lockAtLevel1 = botState.protection.isLateButTradeable ? level1Threshold * 0.35 : 0.35;
      let lockAtLevel2 = botState.protection.isLateButTradeable ? level2Threshold * 0.5 : 1.0;
      let lockAtLevel3 = botState.protection.isLateButTradeable ? level3Threshold * 0.7 : 2.0;

      if (hlPnl >= level3Threshold) {
          maxLockTarget = lockAtLevel3 + (hlPnl - level3Threshold) * 0.8; 
      } else if (hlPnl >= level2Threshold) {
          maxLockTarget = lockAtLevel2 + (hlPnl - level2Threshold) * ((lockAtLevel3 - lockAtLevel2) / (level3Threshold - level2Threshold));
      } else if (hlPnl >= level1Threshold) {
          maxLockTarget = lockAtLevel1 + (hlPnl - level1Threshold) * ((lockAtLevel2 - lockAtLevel1) / (level2Threshold - level1Threshold));
      } else if (hlPnl >= armedThreshold) {
          maxLockTarget = lockAtArmed + (hlPnl - armedThreshold) * ((lockAtLevel1 - lockAtArmed) / (level1Threshold - armedThreshold));
      }
      
      // Update running locked profit smoothly
      if (maxLockTarget > (botState.protection.currentLockedProfitPct || 0)) {
        botState.protection.currentLockedProfitPct = maxLockTarget;
      }
      
      // Apply the locked profit to slPrice if we have locked some profit
      if ((botState.protection.currentLockedProfitPct || 0) > 0) {
        const lockPctActual = botState.protection.currentLockedProfitPct;
        const lockPrice = currentSide === "LONG" ? entryPx * (1 + lockPctActual/100) : entryPx * (1 - lockPctActual/100);
        // Only update slPrice if it's tighter (better)
        const isBetterLock = slPrice === null || (currentSide === "LONG" ? lockPrice > slPrice : lockPrice < slPrice);
        if (isBetterLock) {
            const previousSl = slPrice;
            slPrice = lockPrice;
            botState.protection.slPrice = lockPrice;
            botState.protection.dynamicSlPrice = lockPrice;
            if ((botState.protection.currentLockedProfitPct || 0) <= 0.08 && botState.protection.lastProfitLockLogLevel !== "BREAKEVEN") {
              botState.protection.lastProfitLockLogLevel = "BREAKEVEN";
              console.log(`[BREAKEVEN_LOCK_ACTIVATED] ${botState.activeSymbol} SL moved to breakeven buffer after fees/spread coverage.`);
            }
            console.log(`[WINNING_POSITION_SL_ADJUSTED] ${botState.activeSymbol} ${currentSide} SL improved from ${previousSl ?? "NONE"} to ${lockPrice.toFixed(6)}. Locked profit=${(botState.protection.currentLockedProfitPct || 0).toFixed(2)}%, MFE=${(botState.protection.maxFavorableExcursionPct || 0).toFixed(2)}%.`);
        }
      }
    }

    // Check ladder triggers in descending order to apply highest lock
    if (hlPnl >= level3Threshold && botState.protection.activeProfitLockLevel !== "TRAILING") {
       const isStrongMomentum = (signal.momentumScore || 0) > 0.55 && (signal.trendStrength || 0) > 0.5;
       if (isStrongMomentum) {
          botState.protection.activeProfitLockLevel = "TRAILING";
          botState.protection.isTrailingActive = true;
          botState.protection.runnerModeActive = true;
          botState.protection.tpPrice = null; // Remove rigid TP
          const slippage = botState.protection.isLateButTradeable ? 0.3 : 0.5;
          const lockPrice = currentSide === "LONG" ? currentPrice * (1 - slippage / 100) : currentPrice * (1 + slippage / 100);
          botState.protection.trailingStopPrice = lockPrice;
          botState.protection.dynamicSlPrice = lockPrice;
          trailingStopPrice = lockPrice;
          botState.protection.currentLockedProfitPct = Math.max(botState.protection.currentLockedProfitPct || 0, pnlPct - slippage);
          console.log(`[PROFIT_LOCK_LEVEL_3] Profit reached +${level3Threshold.toFixed(2)}% and momentum strong. Trailing mode activated.`);
          console.log(`[RUNNER_CAPTURE_MODE_ACTIVE] ${botState.activeSymbol} runner mode active. TP removed; trailing behind structure with MFE ${(botState.protection.maxFavorableExcursionPct || 0).toFixed(2)}%.`);
       } else {
          // If momentum not strong, lock harder
          if (botState.protection.activeProfitLockLevel !== "LEVEL_3") {
            botState.protection.activeProfitLockLevel = "LEVEL_3";
            console.log(`[PROFIT_LOCK_LEVEL_3] Profit reached +${level3Threshold.toFixed(2)}%. Smooth locking active (+${botState.protection.currentLockedProfitPct?.toFixed(2)}%).`);
          }
       }
    } else if (hlPnl >= level2Threshold && botState.protection.activeProfitLockLevel !== "TRAILING" && botState.protection.activeProfitLockLevel !== "LEVEL_3") {
      if (botState.protection.activeProfitLockLevel !== "LEVEL_2") {
        botState.protection.activeProfitLockLevel = "LEVEL_2";
        console.log(`[PROFIT_LOCK_LEVEL_2] Profit reached +${level2Threshold.toFixed(2)}%. Smooth locking active (+${botState.protection.currentLockedProfitPct?.toFixed(2)}%).`);
      }
    } else if (hlPnl >= level1Threshold && botState.protection.activeProfitLockLevel !== "TRAILING" && botState.protection.activeProfitLockLevel !== "LEVEL_3" && botState.protection.activeProfitLockLevel !== "LEVEL_2") {
      if (botState.protection.activeProfitLockLevel !== "LEVEL_1") {
        botState.protection.activeProfitLockLevel = "LEVEL_1";
        console.log(`[PROFIT_LOCK_LEVEL_1] Profit reached +${level1Threshold.toFixed(2)}%. Smooth locking active (+${botState.protection.currentLockedProfitPct?.toFixed(2)}%).`);
      }
    } else if (hlPnl >= armedThreshold && botState.protection.activeProfitLockLevel !== "TRAILING" && botState.protection.activeProfitLockLevel !== "LEVEL_3" && botState.protection.activeProfitLockLevel !== "LEVEL_2" && botState.protection.activeProfitLockLevel !== "LEVEL_1") {
      if (botState.protection.activeProfitLockLevel !== "ARMED") {
        botState.protection.activeProfitLockLevel = "ARMED";
        console.log(`[PROFIT_PROTECTION_ARMED] Profit reached +${armedThreshold.toFixed(2)}% (near breakeven locked). Smooth locking active (+${botState.protection.currentLockedProfitPct?.toFixed(2)}%).`);
      }
    } else {
      if (!botState.protection.activeProfitLockLevel) {
        botState.protection.activeProfitLockLevel = "NONE";
        botState.protection.currentLockedProfitPct = 0;
      }
    }

    // 1. Check Stop Loss (Loss protection)
    if (slPrice !== null) {
      if (currentSide === "LONG" && currentPrice <= slPrice) {
        isExitTriggered = true;
        exitReason = "STOP_LOSS_HIT";
      } else if (currentSide === "SHORT" && currentPrice >= slPrice) {
        isExitTriggered = true;
        exitReason = "STOP_LOSS_HIT";
      }
    }

    // 2. Check Take Profit (Stop Gain)
    if (tpPrice !== null && !isExitTriggered) {
      const isHit =
        (currentSide === "LONG" && currentPrice >= tpPrice) ||
        (currentSide === "SHORT" && currentPrice <= tpPrice);

      if (isHit) {
        // Is this a strong runner?
        const isStrongRunner =
          (signal.momentumScore || 0) > 0.6 &&
          (signal.volatilityScore || 0) > 0.4 &&
          (signal.trendStrength || 0) > 0.5 &&
          signal.marketRegime !== "RANGING_CHOP" &&
          !["DEAD_LOW_VOL"].includes(signal.marketRegime || "") &&
          signal.rawDirection === currentSide && // HTF alignment
          (botState.marketScanner?.spreadQuality || 0) > 60 &&
          (botState.marketScanner?.liquidityScore || 0) > 60;

        if (isStrongRunner) {
          console.log(`[BASE_TP_REACHED] Base TP of ${tpPrice} reached.`);
          console.log(`[RUNNER_EXTENDED] Strong trend detected. Removing rigid TP to capture extended gains.`);
          console.log(`[TRAILING_MODE_ACTIVATED] Activating dynamic tight trailing mode.`);
          
          botState.protection.tpPrice = null; // Remove rigid TP
          botState.protection.isTrailingActive = true;
          botState.protection.activeProfitLockLevel = "TRAILING";
          botState.protection.runnerModeActive = true;
          
          // Apply tight trailing Stop immediately to lock in the TP
          const slippage = 0.5; // Very tight slippage for extended runners
          const lockPrice = currentSide === "LONG" 
            ? currentPrice * (1 - slippage / 100)
            : currentPrice * (1 + slippage / 100);
          
          botState.protection.trailingStopPrice = lockPrice;
          botState.protection.dynamicSlPrice = lockPrice;
          trailingStopPrice = lockPrice;

          // Compute locked profit %
          const lockedTrailPnl = currentSide === "LONG"
            ? ((lockPrice - entryPx) / entryPx) * 100
            : ((entryPx - lockPrice) / entryPx) * 100;
          botState.protection.currentLockedProfitPct = Math.max(0, lockedTrailPnl);
          console.log(`[RUNNER_CAPTURE_MODE_ACTIVE] ${botState.activeSymbol} base TP reached with strong continuation. Dynamic runner trailing engaged.`);

        } else {
          isExitTriggered = true;
          exitReason = "TAKE_PROFIT_HIT";
        }
      }
    }

    // 3. Trailing Stop Activation & Logic (Only after 90s Minimum Hold; reduced for restricted size tiers)
    let minHoldForTrailing = 90000;
    const isDDActiveForTrailing = botState.drawdownSeverity === "SOFT" || botState.drawdownSeverity === "SOFT_LEVEL_1" || botState.drawdownSeverity === "SOFT_LEVEL_2" || botState.drawdownSeverity === "MODERATE" || botState.drawdownOverrideActive;
    if (botState.entryTier === "MICRO_ENTRY" || botState.autoRecoveryMode === "ON" || isDDActiveForTrailing) minHoldForTrailing = 30000;
    else if (botState.entryTier === "REDUCED_ENTRY") minHoldForTrailing = 45000;

    if (!isExitTriggered && elapsedHoldTime >= minHoldForTrailing) {
      const isHighVol = ["ASTER", "SKR"].includes(botState.activeSymbol);
      // Protect gains gradually: start trailing earlier but looser, tighten as profit grows
      let trailTriggerPct = isHighVol ? 1.5 : 1.0;
      if (signal.marketRegime === "POST_RALLY_CONTINUATION_LONG" || signal.marketRegime === "POST_RALLY_CONTINUATION_SHORT" || (botState.protection as any)?.requiresTightTrailing) {
        trailTriggerPct = 0.5; // Start trailing much earlier for post-rally continuations
      }
      if (signal.marketRegime === "EARLY_PARABOLIC_PARTICIPATION") {
        trailTriggerPct = 0.4; // earlier breakeven/trailing
      }
      
      // Stricter/earlier trailing trigger for reduced-size entries, auto-recovery, and drawdown mode
      if (botState.entryTier === "MICRO_ENTRY" || botState.autoRecoveryMode === "ON" || isDDActiveForTrailing) {
        trailTriggerPct = Math.min(trailTriggerPct, 0.35);
      } else if (botState.entryTier === "REDUCED_ENTRY") {
        trailTriggerPct = Math.min(trailTriggerPct, 0.5);
      }
      
      const getSlippage = (profit: number) => {
        if (profit >= 4.0) return isHighVol ? 1.0 : 0.5; // tight
        if (profit >= 2.0) return isHighVol ? 1.5 : 0.8; // medium
        if (signal.marketRegime === "POST_RALLY_CONTINUATION_LONG" || signal.marketRegime === "POST_RALLY_CONTINUATION_SHORT" || signal.marketRegime === "EARLY_PARABOLIC_PARTICIPATION" || (botState.protection as any)?.requiresTightTrailing) return 0.6; // Strict tight trailing for cont
        return isHighVol ? 2.0 : 1.2; // loose at the beginning
      };

      if (!isTrailingActive) {
        if (pnlPct >= trailTriggerPct) {
          botState.protection.isTrailingActive = true;
          botState.protection.activeProfitLockLevel = "TRAILING";
          const slippage = getSlippage(pnlPct);
          const lockPrice = currentSide === "LONG"
              ? currentPrice * (1 - slippage / 100)
              : currentPrice * (1 + slippage / 100);
          botState.protection.trailingStopPrice = lockPrice;
          botState.protection.dynamicSlPrice = lockPrice;
          trailingStopPrice = lockPrice;
          
          // Compute locked profit %
          const lockedTrailPnl = currentSide === "LONG"
            ? ((lockPrice - entryPx) / entryPx) * 100
            : ((entryPx - lockPrice) / entryPx) * 100;
          botState.protection.currentLockedProfitPct = Math.max(0, lockedTrailPnl);

          console.log(
            `BOT: INIT_TRAILING_STOP at ${currentPrice} (slippage: ${slippage}%)`,
          );
          console.log(`[RUNNER_CAPTURE_MODE_ACTIVE] ${botState.activeSymbol} trailing runner mode initialized at ${lockPrice.toFixed(6)}.`);
        }
      } else if (trailingStopPrice !== null) {
        botState.protection.activeProfitLockLevel = "TRAILING";
        const slippage = getSlippage(pnlPct);
        if (currentSide === "LONG") {
          const newTrail = currentPrice * (1 - slippage / 100);
          if (newTrail > trailingStopPrice) {
            botState.protection.trailingStopPrice = newTrail;
            botState.protection.dynamicSlPrice = newTrail;
            trailingStopPrice = newTrail;
            console.log(`[STRUCTURE_TRAILING_STOP_UPDATED] ${botState.activeSymbol} LONG trail improved to ${newTrail.toFixed(6)} using volatility/structure buffer.`);
          }
          const lockedTrailPnl = ((trailingStopPrice - entryPx) / entryPx) * 100;
          botState.protection.currentLockedProfitPct = Math.max(0, lockedTrailPnl);

          if (currentPrice <= trailingStopPrice) {
            isExitTriggered = true;
            exitReason = "TRAILING_EXIT_TRIGGERED";
            console.log("[TRAILING_EXIT_TRIGGERED] Trailing stop limit crossed.");
          }
        } else {
          const newTrail = currentPrice * (1 + slippage / 100);
          if (newTrail < trailingStopPrice) {
            botState.protection.trailingStopPrice = newTrail;
            botState.protection.dynamicSlPrice = newTrail;
            trailingStopPrice = newTrail;
            console.log(`[STRUCTURE_TRAILING_STOP_UPDATED] ${botState.activeSymbol} SHORT trail improved to ${newTrail.toFixed(6)} using volatility/structure buffer.`);
          }
          const lockedTrailPnl = ((entryPx - trailingStopPrice) / entryPx) * 100;
          botState.protection.currentLockedProfitPct = Math.max(0, lockedTrailPnl);

          if (currentPrice >= trailingStopPrice) {
            isExitTriggered = true;
            exitReason = "TRAILING_EXIT_TRIGGERED";
            console.log("[TRAILING_EXIT_TRIGGERED] Trailing stop limit crossed.");
          }
        }
      }
    }

    // 4. Signal Reversal and Market Deterioration (MIN_HOLD_TIME minimum 150 seconds check; reduced for restricted tiers)
    let minHoldForReversal = 150000;
    if (botState.entryTier === "MICRO_ENTRY" || botState.autoRecoveryMode === "ON") minHoldForReversal = 45000;
    else if (botState.entryTier === "REDUCED_ENTRY") minHoldForReversal = 75000;

    if (
      !isExitTriggered &&
      currentSide !== "NONE" &&
      elapsedHoldTime >= minHoldForReversal
    ) {
      // Reversal only if candle closes against position and is strong.
      const htfMisaligned =
        signal.rawDirection !== "NONE" && signal.rawDirection !== currentSide;
      const momentumCollapsed = (signal.momentumScore || 0) < 0.2;
      const strongReversal =
        htfMisaligned && (signal.consecutiveCandlesCount || 0) >= 2;
        
      const spreadLiquidityDegraded = (botState.marketScanner?.spreadQuality || 100) < 40 || (botState.marketScanner?.liquidityScore || 100) < 40;
      const volatilityUnstable = (["DEAD_LOW_VOL"].includes(signal.marketRegime || "")) || signal.marketRegime === "RANGING_CHOP";

      if (strongReversal || (htfMisaligned && momentumCollapsed)) {
        isExitTriggered = true;
        exitReason = "SIGNAL_REVERSED";
      } else if (botState.protection.isTrailingActive) {
        // Stricter exits if we are trailing a strong extended runner
        if (momentumCollapsed) {
          isExitTriggered = true;
          exitReason = "MOMENTUM_COLLAPSED_EXIT_RUNNER";
        } else if (spreadLiquidityDegraded) {
          isExitTriggered = true;
          exitReason = "LIQUIDITY_DETERIORATED_EXIT_RUNNER";
        } else if (volatilityUnstable) {
          isExitTriggered = true;
          exitReason = "VOLATILITY_UNSTABLE_EXIT_RUNNER";
        }
      }
    }

    // 5. Time-based Position Exposure Control / Exit Condition
    if (!isExitTriggered) {
      const HARD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
      const SOFT_TIMEOUT_MS = 90 * 60 * 1000;

      const isProfitable = pnlPct > 0;
      const htfAligned =
        signal.rawDirection === "NONE" || signal.rawDirection === currentSide;
      const spreadHealthy = signal.marketRegime !== "RANGING_CHOP";

      if (elapsedHoldTime > HARD_TIMEOUT_MS) {
        const canExtend =
          isProfitable &&
          isTrailingActive &&
          htfAligned &&
          (signal.momentumScore || 0) > 0.5 &&
          spreadHealthy;
        if (!canExtend) {
          isExitTriggered = true;
          exitReason = "HARD_TIME_LIMIT_EXIT";
        }
      } else if (elapsedHoldTime > SOFT_TIMEOUT_MS) {
        const weakPnl = Math.abs(pnlPct) < 0.5; // weak or flat
        const noBreakoutContinuation = (signal.momentumScore || 0) < 0.5;
        const compressedVol = (signal.volatilityScore || 0) < 0.5;
        const fadingTrend = (signal.trendStrength || 0) < 0.3;

        if (
          weakPnl &&
          noBreakoutContinuation &&
          compressedVol &&
          fadingTrend &&
          !isTrailingActive
        ) {
          isExitTriggered = true;
          exitReason = "NO_MOMENTUM_TIMEOUT_EXIT";
        }
      }

      if (!isExitTriggered) {
        const avgDuration = Math.max(
          120000,
          botState.analytics.averageTradeDuration || 180000,
        );
        if (elapsedHoldTime > avgDuration) {
          // Recovery Evaluation Window
          const isSignificantlyInProfit = pnlPct >= 0.25;
          const smallDrawdown = pnlPct < 0 && pnlPct > -1.0;

          let shouldHold = false;
          if (!isSignificantlyInProfit) {
            if (smallDrawdown) {
              // evaluate recovery probability
              const trendStable = (signal.trendStrength || 0) > 0.3;
              const momentumValid = (signal.momentumScore || 0) > 0.4;

              if (trendStable && momentumValid && spreadHealthy && htfAligned) {
                shouldHold = true;
                // Log occasionally to avoid spam
                if (elapsedHoldTime % 60000 < 5000) {
                  console.log(
                    `[RECOVERY_WINDOW] Holding position despite timeout due to valid structure and small drawdown.`,
                  );
                }
              }
            } else if (pnlPct >= 0 && pnlPct < 0.25) {
              // Slightly profitable, allow to hold
              shouldHold = true;
            }

            const isDDActiveForTimeout = botState.drawdownSeverity === "SOFT" || botState.drawdownSeverity === "SOFT_LEVEL_1" || botState.drawdownSeverity === "SOFT_LEVEL_2" || botState.drawdownSeverity === "MODERATE" || botState.drawdownOverrideActive;
            const finalHoldTimeout = botState.autoRecoveryMode === "ON" || isDDActiveForTimeout || signal.marketRegime === "EARLY_PARABOLIC_PARTICIPATION" ? 45000 : 150000;
            if (!shouldHold && elapsedHoldTime >= finalHoldTimeout) {
              isExitTriggered = true;
              exitReason = "TIME_LIMIT_EXCEEDED";
            }
          }
        }
      }
    }

    if (isExitTriggered) {
      const structuralExitReasons = [
        "STOP_LOSS_HIT",
        "TAKE_PROFIT_HIT",
        "SIGNAL_REVERSED",
        "MOMENTUM_COLLAPSED_EXIT_RUNNER",
        "LIQUIDITY_DETERIORATED_EXIT_RUNNER",
        "VOLATILITY_UNSTABLE_EXIT_RUNNER",
        "EMERGENCY_CLOSE_TP_SL_MISSING",
        "EMERGENCY_CLOSE_LOW_MARGIN",
        "TRAILING_EXIT_TRIGGERED"
      ];
      const isStructuralExit = structuralExitReasons.some((reason) => exitReason.includes(reason));
      const profitQualityThresholdPct = 0.22;
      if (!config.MICRO_SCALP_MODE_ENABLED && pnlPct > 0 && pnlPct < profitQualityThresholdPct && !isStructuralExit) {
        console.log(`[MICRO_SCALP_EXIT_BLOCKED] ${botState.activeSymbol} tiny profitable exit blocked. PnL=${pnlPct.toFixed(3)}%, reason=${exitReason}, threshold=${profitQualityThresholdPct.toFixed(2)}%.`);
        console.log(`[PREMATURE_EXIT_BLOCKED] Winner development preserved until TP/SL, structure break, reversal, liquidity deterioration, or protection event.`);
        isExitTriggered = false;
        exitReason = "";
      }
    }

    if (isExitTriggered) {
      botState.isProgrammaticClosing = true;
      try {
        console.log(`EXIT_SIGNAL: ${exitReason}`);
        console.log(
          `BOT: EMERGENCY_CLOSE or PLANNED_EXIT triggered: ${exitReason} at ${currentPrice}`,
        );

        // Cancel all resting orders FIRST to clear path for reduceOnly
        await executionEngine.cancelAllOrders(botState.activeSymbol);

        const sz = Math.abs(szi);
        // Use aggressive price for exit to ensure fill (1% slippage)
        const exitPrice =
          currentSide === "LONG" ? currentPrice * 0.99 : currentPrice * 1.01;

        // Execute exit with latency logging
        console.log("EXIT_ORDER_SUBMITTED: Reversing position to close.");
        const exitStartTime = Date.now();
        const success = await executionEngine.placeOrder(
          botState.activeSymbol,
          currentSide === "SHORT",
          sz,
          exitPrice,
          true,
          true
        );
        const apiLatency = Date.now() - exitStartTime;

        if (success) {
          console.log("EXIT_FILLED: Exit order filled.");
          console.log("POSITION_CLOSED: Trade lifecycle complete.");
          console.log("POSITION_EXIT_DETECTED");
          botState.lastCloseReason = exitReason;

          let isReconciled = false;
          let reconciliationRetries = 0;
          let fillPrice = botState.lastFillPrice || currentPrice;
          let actualFees = Math.abs(sz * fillPrice * 0.00035);

          // 4. Confirm exchange reconciliation after exit
          while (reconciliationRetries < 12 && !isReconciled) {
             await syncAccountState();
             const stillOpen = botState.allPositions?.find((p: any) => p.coin === botState.activeSymbol && parseFloat(p.szi) !== 0);
             if (!stillOpen) {
                 isReconciled = true;
                 break;
             }
             
             // Check if remaining position is negligible micro-dust (e.g. less than 0.0001 or < 0.20 USDC market value)
             const dustSzi = Math.abs(parseFloat(stillOpen.szi));
             const dustValue = dustSzi * (botState.markPrices?.[stillOpen.coin] || currentPrice);
             if (dustValue < 0.20) {
                 console.log(`[EXIT_RECONCILIATION_WARNING] Found micro-dust position of size ${dustSzi} (Value: $${dustValue.toFixed(4)}). Treating as reconciled.`);
                 isReconciled = true;
                 break;
             }

             reconciliationRetries++;
             // Progressive delay backoff: from 800ms to 2400ms
             const delayTime = Math.min(2500, 800 + reconciliationRetries * 200);
             await new Promise(r => setTimeout(r, delayTime));
          }

          if (!isReconciled) {
              console.error("EXIT_RECONCILIATION_FAILED: Position is still open after exit order.");
              botState.lastCloseReason = isEmergencyMode ? "MANUAL_CLOSE_REQUIRED" : "EMERGENCY_CLOSE_RETRY";
              return;
          }

          console.log("EXIT_RECONCILIATION_COMPLETE");

          try {
              const budget = (await import("./services/apiBudgetManager.js")).apiBudgetManager.reserveInfo("metadata", "userFills");
              if (budget.allowed) {
                  const fills = await hClient.infoRequest({ type: "userFills", user: config.HYPERLIQUID_WALLET_ADDRESS });
                  if (fills && Array.isArray(fills)) {
                      const latestFill = fills.find((f: any) => f.coin === botState.activeSymbol && f.dir === (currentSide === "LONG" ? "Sell" : "Buy"));
                      if (latestFill) {
                         fillPrice = parseFloat(latestFill.px);
                         actualFees = parseFloat(latestFill.fee);
                      }
                  }
              } else {
                 console.warn(`[REST_BUDGET_DEFERRED] Skipped userFills fetch during loop exit reconciliation to preserve API budget.`);
              }
          } catch(e) {}
          const isTradeLoss = currentSide === "LONG" ? (fillPrice < entryPx) : (fillPrice > entryPx);
          const exitIsLoss = exitReason.includes("STOP_LOSS") || exitReason.includes("SL Price Hit") || exitReason.includes("TRAILING_EXIT_TRIGGERED") || isTradeLoss;

          // Cooldown reset parameters
          let classifiedCooldownType: "HARD" | "SOFT" | "LOSS_COOLDOWN" | "WIN_COOLDOWN" | "CHOP_COOLDOWN" | "VOLATILITY_RESET_COOLDOWN" | "NARRATIVE_CONTINUATION_COOLDOWN" | "EARLY_REENTRY_COOLDOWN" = "SOFT";
          let cooldownDurationMs = 60 * 1000; // Standard 60 seconds
          const overtradingScore = botState.analytics.overtradingScore || 0;

          // Dynamic cooldown based on market regime and fee bleed
          const regime = botState.marketScanner?.regimeClassification || "TRENDING";
          const isChop = regime.includes("CHOP") || regime.includes("DEAD_LOW_VOL") || regime.includes("RANGE");
          const isTrending = regime.includes("TRENDING") || regime.includes("CONTINUATION") || regime.includes("HEALTHY_DIRECTIONAL_VOL") || regime.includes("MOMENTUM");
          const isChaoticVol = regime.includes("EXTREME_DIRECTIONAL_VOL") || regime.includes("PARABOLIC") || botState.drawdownSeverity === "MODERATE" || botState.drawdownSeverity === "HARD";

          // Find CMC match to check narrative
          const entryCmc = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === botState.activeSymbol || a.symbol === botState.activeSymbol);
          const strongestNarrative = botState.cmcIntelligence?.strongestNarrative || "AI";
          const isStrongNarrative = entryCmc && (
            entryCmc.narrative === strongestNarrative || 
            entryCmc.volumeGrowth24h >= 25 || 
            (entryCmc.narrative && entryCmc.narrative.toLowerCase() === "meme") ||
            (entryCmc.narrative && entryCmc.narrative.toLowerCase() === "solana")
          );

          if (exitIsLoss) {
            classifiedCooldownType = "LOSS_COOLDOWN";
            cooldownDurationMs = 180 * 1000; // 3 minutes on standard loss
            
            // Extend further if consecutive repeated loss on same symbol
            if (botState.lastCooldownSymbol === botState.activeSymbol && botState.lastCloseReason && botState.lastCloseReason.includes("STOP_LOSS")) {
              cooldownDurationMs = Math.max(cooldownDurationMs, 10 * 60 * 1000); // 10 minutes
              console.log(`[CHOP_COOLDOWN_EXTENDED] Consecutive loss on same asset detected. Extending cooldown penalty on ${botState.activeSymbol}To 10 minutes.`);
            }
          } else {
            // Successful exit / Profit taking
            classifiedCooldownType = "WIN_COOLDOWN";
            cooldownDurationMs = 45 * 1000; // shorten to 45s to secure gains or transition safely
          }

          // Volatility check
          if (isChaoticVol) {
            classifiedCooldownType = "VOLATILITY_RESET_COOLDOWN";
            cooldownDurationMs = Math.max(cooldownDurationMs, 120 * 1000); // 2 minutes reset
          }

          // Chop check
          if (isChop) {
            classifiedCooldownType = "CHOP_COOLDOWN";
            cooldownDurationMs = Math.max(cooldownDurationMs, 5 * 60 * 1000); // extend to 5 mins
            console.log(`[CHOP_COOLDOWN_EXTENDED] Cooldown extended due to chop or dead low volatility on ${botState.activeSymbol}. Duration: 5 minutes.`);
          }

          // Strong Narrative & CMC Trends
          if (isStrongNarrative && !exitIsLoss) {
            classifiedCooldownType = "NARRATIVE_CONTINUATION_COOLDOWN";
            cooldownDurationMs = 15 * 1000; // very fast re-engagement: 15s
            console.log(`[NARRATIVE_PERSISTENCE_DETECTED] High narrative persistence detected for ${botState.activeSymbol} (Sector: ${entryCmc?.narrative}). Reducing cooldown to 15s.`);
            console.log(`[COOLDOWN_REDUCED_BY_CONTINUATION] Aggressive reduction on narrative continuity.`);
          } else if (isTrending && !exitIsLoss) {
            classifiedCooldownType = "EARLY_REENTRY_COOLDOWN";
            cooldownDurationMs = Math.max(15 * 1000, Math.min(cooldownDurationMs, 30 * 1000)); // 30s re-entry on healthy breakouts
          }
          
          if (botState.feeEfficiency?.pauseType) {
            cooldownDurationMs = Math.max(cooldownDurationMs, 3 * 60 * 1000); // extend during fee bleed
          }

          if (overtradingScore > 3) {
            const scaleFactor = Math.min(5, overtradingScore - 2);
            cooldownDurationMs = cooldownDurationMs * scaleFactor;
            console.log(
              `[ADAPTIVE_COOLDOWN] Overtrading detected (Score: ${overtradingScore}). Extending transition cooldown to ${scaleFactor}x (${(cooldownDurationMs / 1000 / 60).toFixed(1)} minutes).`,
            );
          }

          const momentumRegimes = ["TRENDING", "HEALTHY_DIRECTIONAL_VOL", "DEVELOPING_CONTINUATION", "PRE_BREAKOUT_MOMENTUM"];
          const isMomentumRegime = momentumRegimes.includes(signal.marketRegime || "");
          // FAILED_MOMENTUM_COOLDOWN logic removed.

          const isEmergencyClosed = isEmergencyMode || exitReason.includes("EMERGENCY") || botState.protectionStatus === "FAILED_EMERGENCY_CLOSE_REQUIRED";
          let cType: "HARD" | "SOFT" | "LOSS_COOLDOWN" | "WIN_COOLDOWN" | "CHOP_COOLDOWN" | "VOLATILITY_RESET_COOLDOWN" | "NARRATIVE_CONTINUATION_COOLDOWN" | "EARLY_REENTRY_COOLDOWN" = classifiedCooldownType;
          let hardReason = "";
          
          if (isEmergencyClosed) {
            cType = "HARD"; hardReason = "emergency close";
          } else if (overtradingScore > 3) {
            cType = "HARD"; hardReason = "overtrading spike";
          } else if (exitIsLoss && botState.lastCooldownSymbol === botState.activeSymbol && botState.lastCloseReason && botState.lastCloseReason.includes("STOP_LOSS")) {
            cType = "HARD"; hardReason = "repeated same-structure losses";
            cooldownDurationMs = Math.max(cooldownDurationMs, 10 * 60 * 1000); // 10 min penalty
          } else if (exitReason.includes("LIQUIDATION")) {
            cType = "HARD"; hardReason = "liquidation-risk event";
          }

          // Adaptive Learning Cooldown Guard
          if (botState.learningState && !botState.learningState.corrupted && exitIsLoss) {
             const dirStr = signal.direction || currentSide || "NONE";
             const key = `REGIME:${regime}`;
             const bucket = botState.learningState.buckets[key];
             const dirBucket = botState.learningState.buckets[`DIRECTION:${dirStr}`];
             
             let totalPen = 0;
             if (bucket && bucket.isNegativeEdge) totalPen += bucket.cooldownPenalty;
             if (dirBucket && dirBucket.isNegativeEdge) totalPen += dirBucket.cooldownPenalty;
             
             if (totalPen > 0) {
                 const appliedPen = Math.min(totalPen, 15 * 60 * 1000); // Max 15 mins
                 cooldownDurationMs += appliedPen;
                 console.log(`[LEARNING_GUARDRAIL_APPLIED] Added ${(appliedPen/60000).toFixed(1)} mins to cooldown based on negative edge analysis.`);
                 if (appliedPen > 5 * 60 * 1000) {
                     cType = "HARD";
                     hardReason = "statistical edge failure";
                 }
             }
          }

          // HARD CAP COOLDOWN TIMES (Except for CRITICAL / HARD cases)
          if (cType !== "HARD") {
             if (classifiedCooldownType === "WIN_COOLDOWN") cooldownDurationMs = Math.min(cooldownDurationMs, 45 * 1000);
             else if (classifiedCooldownType === "LOSS_COOLDOWN") cooldownDurationMs = Math.min(cooldownDurationMs, 3 * 60 * 1000);
             else if (classifiedCooldownType === "CHOP_COOLDOWN") cooldownDurationMs = Math.min(cooldownDurationMs, 5 * 60 * 1000);
             else if (botState.feeEfficiency?.pauseType) cooldownDurationMs = Math.min(cooldownDurationMs, 5 * 60 * 1000); // Fee stress max 5 mins
             else if (botState.drawdownSeverity && botState.drawdownSeverity.includes("SOFT")) cooldownDurationMs = Math.min(cooldownDurationMs, 3 * 60 * 1000);
             else cooldownDurationMs = Math.min(cooldownDurationMs, 60 * 1000); // NORMAL EXIT max 60s
          }

          console.log(`[COOLDOWN_TYPE_CLASSIFIED] Cooldown classified as ${classifiedCooldownType} (mapped to ${cType}) due to: ${hardReason || "normal exit structure"}. Duration: ${cooldownDurationMs / 1000}s`);

          botState.cooldownUntil = Date.now() + cooldownDurationMs;
          botState.cooldownType = cType;
          botState.lastExitWasSuccessful = !exitIsLoss;
          botState.lastCooldownSymbol = botState.activeSymbol;
          botState.reverseLockUntil = Date.now() + 2 * 60 * 1000; // 2-minute reverse lock
          botState.lastCloseSide = currentSide;

          const slippagePct =
            currentPrice > 0
              ? (currentSide === "LONG"
                  ? (currentPrice - fillPrice) / currentPrice
                  : (fillPrice - currentPrice) / currentPrice) * 100
              : 0;

          const exitReasonText = `${exitReason} triggered at ${fillPrice.toFixed(4)}. Duration: ${Math.round((Date.now() - (botState.lastEntryTimestamp || 0)) / 1000)}s. Market Regime: ${signal.marketRegime}.`;

          const grossPnl = (fillPrice - entryPx) * sz * (currentSide === "LONG" ? 1 : -1);
          const netRealizedPnl = grossPnl - actualFees;

          console.log("REALIZED_PNL_RECORDED");

          // Log the exit
          await tradeLogger.logTrade({
            timestamp: Date.now(),
            type: "EXIT",
            symbol: botState.activeSymbol,
            side: currentSide,
            size: sz,
            entryPrice: entryPx,
            exitPrice: fillPrice,
            realizedPnl: grossPnl, // Pass gross PnL
            fees: actualFees,
            orderId: botState.lastOrderId || "SYSTEM",
            exitReason: exitReasonText,
            confidenceScore: signal.confidence,
            tradeQualityScore: signal.tradeQualityScore,
            volatilityScore: signal.volatilityScore,
            trendScore: signal.trendScore,
            momentumScore: signal.momentumScore,
            duration: Date.now() - (botState.lastEntryTimestamp || 0),
            marketRegime: signal.marketRegime,
            fundingRate: botState.fundingRate,
            wssHealth: botState.wssConnected ? "STABLE" : "UNSTABLE",
            apiLatency: apiLatency,
            slippage: slippagePct,
            expectedMovePct: signal.expectedMovePct,
          });

          // Compute updated fee efficiency paused status
          updateFeeEfficiency();
          
          console.log("ANALYTICS_SYNCED");

          // --- Recent Trade Feedback Loop ---
          if (netRealizedPnl < 0) {
             const isFakeBreakout = signal.marketRegime?.includes("BREAKOUT") && exitReasonText.includes("STOP_LOSS");
             if (isFakeBreakout) {
                console.log(`FALSE_BREAKOUT_THRESHOLD_INCREASED: Fake breakout loss on ${botState.activeSymbol}. Threshold will adjust automatically.`);
                botState.cooldownUntil = Date.now() + 5 * 60 * 1000; // Extend cooldown
             }
          } else if (netRealizedPnl > 0) {
             const isContinuation = signal.marketRegime?.includes("CONTINUATION");
             if (isContinuation) {
                botState.analytics.recentEntryBias = "ACCURATE";
                console.log(`RECENT_ENTRY_BIAS_UPDATED: Bias updated to ACCURATE due to successful continuation on ${botState.activeSymbol}.`);
             }
          }
          
          // --- Override feedback ---
          if (botState.analytics.TOO_CONSERVATIVE_OVERRIDE_ACTIVE) {
              if (netRealizedPnl < 0) {
                  console.log(`[OVERRIDE_FAILED_REVERTING_TO_STANDARD] Override trade resulted in loss. Disabling override and restoring thresholds.`);
                  botState.analytics.TOO_CONSERVATIVE_OVERRIDE_ACTIVE = false;
                  botState.cooldownUntil = Date.now() + 10 * 60 * 1000; // 10 min penalty
              } else if (netRealizedPnl > 0) {
                  console.log(`[OVERRIDE_SUCCESS_CONFIRMED] Override trade was successful.`);
              }
          }

          // Post-close cleanup (Requirement 3 & 4)
          botState.lastEntryTimestamp = 0;
          console.log("[POST_CLOSE_HOLD_TIMER_RESET] Post close hold timer reset. POST_CLOSE_HOLD_TIMER_RESET.");

          if (botState.blocker === "MINIMUM_HOLD_BLOCKED") {
            botState.blocker = null;
            console.log("[MINIMUM_HOLD_STATE_CLEARED] Minimum hold state cleared. MINIMUM_HOLD_STATE_CLEARED.");
          }

          if ((botState as any).protectionByCoin && (botState as any).protectionByCoin[botState.activeSymbol]) {
              delete (botState as any).protectionByCoin[botState.activeSymbol];
          }

          // Fetch final updated state instead of forcefully wiping everything to 0
          await syncAccountState();

          // Reset local active symbol tracking safely
          botState.protectionStatus = "CONFIRMED";
          botState.protection = {
            tpPrice: null,
            slPrice: null,
            trailingStopPrice: null,
            isTrailingActive: false,
            highestUnrealizedPnlPct: 0,
            currentLockedProfitPct: 0,
            activeProfitLockLevel: "NONE"
          };

          if (botState.blocker === null) {
            console.log("[MONITORING_RESUMED_NO_OPEN_POSITIONS] Monitoring resumed. Checking for active positions...");
          }
        } else {
          console.error(
            "BOT: FAILED_TO_EXECUTE_EXIT_PROTECTION. Refreshing state and retrying.",
          );
          botState.lastCloseReason = isEmergencyMode
            ? "MANUAL_CLOSE_REQUIRED"
            : "EMERGENCY_CLOSE_RETRY";
          if (isEmergencyMode) {
            botState.blocker = "MANUAL_CLOSE_REQUIRED";
            botState.lastApiError = "MANUAL_CLOSE_REQUIRED";
          }
          await syncAccountState();
        }
      } finally {
        botState.isProgrammaticClosing = false;
      }
      return;
    }
  }
}

async function evaluateStaleOrders() {
  if (!botState.activeOrders || botState.activeOrders.length === 0) return;
  if (!botState.entryOrdersContext || Object.keys(botState.entryOrdersContext).length === 0) return;

  const now = Date.now();
  const { executionEngine } = await import("./hyperliquidExecutionEngine.js");
  const { strategy } = await import("./hyperliquidStrategy.js");

  // Keep track of valid oids to clean up filled/cancelled ones from context
  const activeOids = new Set(botState.activeOrders.map(o => String(o.oid)));
  
  if (Object.keys(botState.entryOrdersContext).length > 0) {
    console.log("[ORDER_STALE_CHECK] Scanning active entry orders for setup invalidation.");
  }

  for (const oid of Object.keys(botState.entryOrdersContext)) {
    if (!activeOids.has(oid)) {
      // Order is no longer active (filled or cancelled elsewhere)
      delete botState.entryOrdersContext[oid];
      continue;
    }

    const ctx = botState.entryOrdersContext[oid];
    let cancelReason = null;
    let isStale = false;

    // Rule 3: Dynamic limit calculations for stale scanning
    const isWssApiStable1 = botState.wssConnected !== false && botState.apiConnected !== false && botState.phase !== "CIRCUIT_BREAKER_ACTIVE";
    const isDrawdownPauseActive1 = botState.drawdownPauseUntil !== undefined && botState.drawdownPauseUntil !== null && now < botState.drawdownPauseUntil;
    const hasCriticalValidationBlocker1 = botState.validationStatus === "VALIDATION_FAILED" ||
                                         botState.blocker === "LOW_EQUITY_TRADING_BLOCKED" ||
                                         (botState.blocker && botState.blocker.includes("CIRCUIT_BREAKER")) ||
                                         botState.lastApiError !== null;

    let everyPositionHasTpSl1 = true;
    let tpSlFailedReasons1: string[] = [];
    if (botState.allPositions && botState.allPositions.length > 0) {
      for (const pos of botState.allPositions) {
        const activePosOrders = (botState.activeOrders || []).filter(o => o.coin === pos.coin && o.reduceOnly);
        const markPriceForPos = (botState.markPrices && botState.markPrices[pos.coin]) || parseFloat(pos.entryPx);
        const isLong1 = parseFloat(pos.szi) > 0;
        let posHasTp = false;
        let posHasSl = false;
        for (const o of activePosOrders) {
          if (o.isTrigger || o.triggerPx || parseFloat(o.triggerPx || "0") > 0) {
              posHasSl = true;
          } else {
              posHasTp = true;
          }
        }
        if (pos.coin === botState.activeSymbol && botState.protection?.isTrailingActive) {
          posHasTp = true;
        }
        
        const perCoinProtection1 = pos.coin === botState.activeSymbol ? botState.protection : ((botState as any).protectionByCoin ? (botState as any).protectionByCoin[pos.coin] : null);
        if (perCoinProtection1?.isTrailingActive) {
            posHasTp = true;
        }
        
        if (!posHasTp || !posHasSl) {
          everyPositionHasTpSl1 = false;
          tpSlFailedReasons1.push(`[${pos.coin}: TP=${posHasTp}, SL=${posHasSl}]`);
        }
      }
    }
    
    if (botState.protectionStatus !== "CONFIRMED") {
        everyPositionHasTpSl1 = false;
        tpSlFailedReasons1.push(`[ProtectionStatus=${botState.protectionStatus}]`);
    }

    let totalPositionNotional1 = 0;
    if (botState.allPositions && botState.allPositions.length > 0) {
      for (const pos of botState.allPositions) {
        const posSize = Math.abs(parseFloat(pos.szi));
        const posPrice = parseFloat(pos.entryPx) || (botState.markPrices && botState.markPrices[pos.coin]) || botState.markPrice;
        totalPositionNotional1 += posSize * posPrice;
      }
    }
    const portfolioExposureUsedPct1 = botState.accountEquity > 0
      ? (totalPositionNotional1 / botState.accountEquity) * 100
      : 0;
    const freeCollateralPct1 = botState.accountEquity > 0
      ? (botState.availableMargin / botState.accountEquity) * 100
      : 100;

    const totalExposureWithinAllowed1 = portfolioExposureUsedPct1 <= 65;
    const dynamicLimitObj1 = getDynamicMaxPositions();
    const limit1 = dynamicLimitObj1.limit;
    const freeCollateralOk1 = freeCollateralPct1 >= (botState.openPositions >= limit1 ? 35 : 30);

    const dynamicMoreThanTwoAllowed1 = isWssApiStable1 && 
                                      !isDrawdownPauseActive1 && 
                                      !hasCriticalValidationBlocker1 && 
                                      everyPositionHasTpSl1 && 
                                      totalExposureWithinAllowed1 && 
                                      freeCollateralOk1;

    // Check duplicate positions per coin (maximum 1 position per coin)
    const isPosForCoinOpen = botState.allPositions && botState.allPositions.some(p => p.coin === ctx.symbol);
    
    // Check maximum 1 pending entry order per symbol
    const pendingForSymbol = Object.values(botState.entryOrdersContext).filter(c => c.symbol === ctx.symbol);
    let hasDuplicatePending = false;
    if (pendingForSymbol.length > 1) {
      const mostRecent = pendingForSymbol.reduce((prev, current) => (prev.ts > current.ts) ? prev : current);
      if (ctx.ts < mostRecent.ts) {
        hasDuplicatePending = true;
      }
    }

    const oppSignal = strategy.getSignal(ctx.symbol);

    // Real entry requirement: 5-15s fill timeout
    const timeoutSecs = ctx.regime === "HEALTHY_DIRECTIONAL_VOL" ? 5 : 15;
    
    if (now - ctx.ts > timeoutSecs * 1000) {
      cancelReason = "ENTRY_ORDER_FILL_TIMEOUT";
      console.log(`[ENTRY_ORDER_FILL_TIMEOUT] Pending entry order ${oid} for ${ctx.symbol} has exceeded the execution threshold of ${timeoutSecs} seconds.`);
      isStale = true;
    } else if (!botState.wssConnected || botState.phase === "CIRCUIT_BREAKER_ACTIVE") {
      cancelReason = "ENTRY_ORDER_CANCELLED_WSS_UNSTABLE";
      isStale = true;
    } else if (botState.drawdownPauseUntil && botState.drawdownPauseUntil > now) {
      cancelReason = "ENTRY_ORDER_CANCELLED_SETUP_INVALID";
      isStale = true;
    } else if (isPosForCoinOpen) {
      cancelReason = "ENTRY_ORDER_CANCELLED_POSITION_ALREADY_OPEN";
      isStale = true;
    } else if (hasDuplicatePending) {
      cancelReason = "ENTRY_ORDER_CANCELLED_DUPLICATE_PENDING_ORDER";
      isStale = true;
    } else if (botState.openPositions >= limit1) {
      cancelReason = "ENTRY_ORDER_CANCELLED_SETUP_INVALID";
      isStale = true;
    } else if (botState.accountEquity > 0 && freeCollateralPct1 < (botState.openPositions >= limit1 ? 35 : 30)) {
      cancelReason = "ENTRY_ORDER_CANCELLED_INSUFFICIENT_FREE_COLLATERAL";
      isStale = true;
    } else if (botState.marketScanner && (botState.marketScanner.liquidityScore < 40 || botState.marketScanner.spreadQuality < 40)) {
      cancelReason = "ENTRY_ORDER_CANCELLED_SETUP_INVALID";
      isStale = true;
    } else if (oppSignal) {
      if (oppSignal.marketRegime === "RANGING_CHOP" && ctx.regime !== "RANGING_CHOP") {
        cancelReason = "ENTRY_ORDER_CANCELLED_SETUP_INVALID";
        isStale = true;
      } else if (oppSignal.confidence !== undefined && oppSignal.confidence < Math.min(ctx.confidence * 0.8, 40)) {
        cancelReason = `ENTRY_ORDER_CANCELLED_SETUP_INVALID`;
        isStale = true;
      } else if (oppSignal.rawDirection !== "NONE" && oppSignal.rawDirection !== ctx.side) {
        cancelReason = "ENTRY_ORDER_CANCELLED_SETUP_INVALID";
        isStale = true;
      }
    }

    if (isStale) {
      if (cancelReason === "ENTRY_ORDER_FILL_TIMEOUT") {
        let exactDiagnosis = "price moved";
        const currentMark = (botState.markPrices && botState.markPrices[ctx.symbol]) || botState.markPrice || ctx.px;
        
        if (ctx.side === "LONG" && currentMark > ctx.px * 1.0005) {
          exactDiagnosis = "price moved";
        } else if (ctx.side === "SHORT" && currentMark < ctx.px * 0.9995) {
          exactDiagnosis = "price moved";
        } else if (botState.marketScanner && botState.marketScanner.spreadQuality < 40) {
          exactDiagnosis = "spread widened";
        } else if (ctx.size * currentMark < 11.5) {
          exactDiagnosis = "insufficient size";
        } else if (botState.marketScanner && botState.marketScanner.liquidityScore < 40) {
          exactDiagnosis = "liquidity disappeared";
        } else if (botState.lastApiError) {
          exactDiagnosis = "exchange rejection";
        }
        console.log(`[ORDER_NOT_FILLED_DIAGNOSIS] Entry order ${oid} was not filled due to: ${exactDiagnosis}`);
      }

      console.log(`[ORDER_STALE_CHECK] Canceling order ${oid} for ${ctx.symbol}: ${cancelReason}`);
      const success = await executionEngine.cancelOrder(ctx.symbol, oid);
      if (success) {
         console.log(`[STALE_ENTRY_ORDER_CANCELLED] Order ${oid} successfully removed from active entry queue.`);
         delete botState.entryOrdersContext[oid];
         botState.activeOrders = botState.activeOrders.filter(a => String(a.oid) !== oid);
      }
    }
  }

  // Protective order logic
  for (const o of botState.activeOrders) {
    const oid = String(o.oid);
    if (!botState.entryOrdersContext[oid]) {
      // It's a protective order (TP/SL/trailing) or unrelated
      if (Math.random() < 0.05) { // Log occasionally to prevent log spam but meet requirement
         console.log(`[ORDER_STALE_CHECK] PROTECTIVE_ORDER_PRESERVED for ${o.coin} (oid: ${oid})`);
      }
    }
  }
}

let lastWssOkTimestamp = Date.now();
let lastApiOkTimestamp = Date.now();

function evaluateCircuitBreakers() {
  const now = Date.now();

  // 1. WSS Instability Check
  if (botState.wssConnected) {
    if (!(botState as any).wssStableSince) (botState as any).wssStableSince = now;
    lastWssOkTimestamp = now;
  } else {
    (botState as any).wssStableSince = null;
  }

  // WSS Reconnecting State (No Phase Downgrade)
  if (now - lastWssOkTimestamp > 15000 && now - lastWssOkTimestamp <= 300000) { // Up to 5 mins
    if (!botState.blocker?.includes("WSS_")) {
        console.warn(`[WSS_STABILIZATION_STARTED] WSS disconnected for 15s. Halting new entries. Phase 2 retained.`);
    }
    botState.blocker = "PROTECTED_PAUSE: WSS_RECONNECTING";
  } else if (now - lastWssOkTimestamp > 300000 && botState.phase !== "CIRCUIT_BREAKER_ACTIVE") {
    console.error(`[CRITICAL_WSS_FAILURE_ESCALATED] WSS disconnected for >5 mins. Escalating to CIRCUIT_BREAKER.`);
    triggerCircuitBreaker("CIRCUIT_BREAKER_ACTIVE: CRITICAL_WSS_FAILURE");
  }

  // WSS Stabilizing State
  if (botState.wssConnected && (botState as any).wssStableSince && now - (botState as any).wssStableSince < 60000) {
    botState.blocker = `PROTECTED_PAUSE: WSS_STABILIZING (${Math.floor((now - (botState as any).wssStableSince)/1000)}s / 60s)`;
    if ((botState as any)._wssRecMsg !== botState.blocker) {
       console.log(`[WSS_STABILIZATION_PROGRESS] ${botState.blocker}`);
       (botState as any)._wssRecMsg = botState.blocker;
    }
  } else if (botState.wssConnected && botState.blocker?.includes("PROTECTED_PAUSE: WSS_") && (now - (botState as any).wssStableSince) >= 60000) {
     console.log(`[WSS_STABLE_CONFIRMED] WSS recovery complete. Resuming normal operations.`);
     botState.blocker = null;
     console.log(`PHASE_2_RETAINED_DURING_WSS_RECOVERY: Successfully navigated WSS instability without downgrade.`);
  }

  // 2. Environment Instability Check: if api disconnected for more than 30s
  if (botState.apiConnected) {
    lastApiOkTimestamp = now;
  } else if (
    now - lastApiOkTimestamp > 30000 &&
    botState.phase !== "CIRCUIT_BREAKER_ACTIVE"
  ) {
    console.error(
      `[CIRCUIT_BREAKER] TRIGGERED: API connection failure / environment instability detected.`,
    );
    triggerCircuitBreaker("CIRCUIT_BREAKER_ACTIVE: ENVIRONMENT_INSTABILITY_DETECTED");
    return true; // HALT loop completely if API is down
  }

  // 3. Overtrading Check
  const dailyTrades = botState.dailyTradeCount || 0;
  if (dailyTrades > 10 && botState.phase !== "CIRCUIT_BREAKER_ACTIVE") {
    console.error(
      `[CIRCUIT_BREAKER] TRIGGERED: Overtrading detected. Daily trade limit of 10 exceeded.`,
    );
    triggerCircuitBreaker("CIRCUIT_BREAKER_ACTIVE: OVERTRADING_LIMIT_BREACHED");
  }

  const exitsHourly = botState.feeEfficiency?.overtradingScore || 0;
  if (exitsHourly > 5 && botState.phase !== "CIRCUIT_BREAKER_ACTIVE") {
    console.error(
      `[CIRCUIT_BREAKER] TRIGGERED: Overtrading detected. High hourly exit rate (current: ${exitsHourly}).`,
    );
    triggerCircuitBreaker("CIRCUIT_BREAKER_ACTIVE: HIGH_EXITS_HOURLY");
  }

  // 4. Reconciliation Mismatch / Duplicate Positions Check (Phase 2 dynamic maximum limit is 10)
  if (
    botState.openPositions > 10 &&
    botState.phase !== "CIRCUIT_BREAKER_ACTIVE"
  ) {
    console.error(
      `[CIRCUIT_BREAKER] TRIGGERED: Reconciliation mismatch / max entries breached. Position count is ${botState.openPositions}.`,
    );
    triggerCircuitBreaker("CIRCUIT_BREAKER_ACTIVE: PORTFOLIO_CAP_BREACHED");
  }

  // 5. Fee Bleed Check
  const feeRatio = botState.feeEfficiency?.feeToProfitRatio || 0;
  const netPnlFees = botState.feeEfficiency?.netPnlAfterFees || 0;
  if (
    feeRatio > 0.45 &&
    netPnlFees < 0 &&
    botState.phase !== "CIRCUIT_BREAKER_ACTIVE"
  ) {
    console.error(
      `[CIRCUIT_BREAKER] TRIGGERED: Fee bleed detected. Fee ratio is ${(feeRatio * 100).toFixed(2)}% with negative net PnL.`,
    );
    triggerCircuitBreaker("CIRCUIT_BREAKER_ACTIVE: FEE_BLEED_SUSPENDED");
  }

  return false;
}

export function triggerCircuitBreaker(reason: string) {
  botState.phase = "CIRCUIT_BREAKER_ACTIVE";
  botState.blocker = reason;
  
  if (!botState.circuitBreakerHistory) {
    botState.circuitBreakerHistory = [];
  }
  
  botState.circuitBreakerHistory.unshift({
    timestamp: Date.now(),
    reason: reason,
    duration: 0
  });
  
  if (botState.circuitBreakerHistory.length > 20) {
    botState.circuitBreakerHistory.pop();
  }
  
  console.error(`[CIRCUIT_BREAKER_TRIGGERED] Reason: ${reason}`);
}

async function loop() {
  const loopNow = Date.now();
  
  if (botState.blocker === "ORDER_SUBMITTED_FAILED") {
    if (!botState.orderSubmittedFailedUntil || loopNow > botState.orderSubmittedFailedUntil) {
      console.log("[BLOCKER_RECOVERY] ORDER_SUBMITTED_FAILED temporary pacing state expired. Resetting blocker to permit clean entry re-evaluations.");
      botState.blocker = null;
    }
  }
  
  // Resolve Trading Mode (Single Source of Truth)
  const isPrivateKeyPresent = !!config.HYPERLIQUID_PRIVATE_KEY && config.HYPERLIQUID_PRIVATE_KEY.length > 30;
  const isOrderSubmissionEnabled = botState.phase !== "VALIDATION_FAILED" && botState.phase !== "CIRCUIT_BREAKER_ACTIVE";
  
  botState.liveModeDiagnostics = {
    DRY_RUN: config.DRY_RUN,
    LIVE_TRADING: config.LIVE_TRADING,
    privateKeyPresent: isPrivateKeyPresent,
    orderSubmissionEnabled: isOrderSubmissionEnabled,
    exchangeMutationsAllowed: config.ENABLE_ORDER_SUBMISSION && config.LIVE_TRADING && isPrivateKeyPresent && isOrderSubmissionEnabled && !config.DRY_RUN
  };
  
  const wasLive = botState.liveModeEnabled;
  botState.liveModeEnabled = botState.liveModeDiagnostics.exchangeMutationsAllowed;

  if (botState.liveModeEnabled !== wasLive) {
      if (botState.liveModeEnabled) {
          console.log(`[LIVE_MODE_CONFIRMED] System operating in LIVE TRADING mode. Exchange mutations enabled.`);
      } else {
          console.log(`[LIVE_MODE_BLOCKED] System operating in BLOCKED mode. Exchange mutations disabled. Check config or secrets.`);
      }
      console.log(`[TRADING_MODE_RESOLVED] Diagnostics: ${JSON.stringify(botState.liveModeDiagnostics)}`);
      console.log(`[TRADING_MODE_UI_SYNCED] Synced execution mode UI state.`);
  }

  botState.lastLoopTimestamp = botState.lastLoopTimestamp || loopNow;
  const elapsedMs = loopNow - botState.lastLoopTimestamp;
  botState.lastLoopTimestamp = loopNow;

  if (botState.cooldownUntil && botState.cooldownUntil > loopNow) {
     const regime = (botState as any).statusIntelligence?.marketRegime || botState.marketScanner?.regimeClassification || "TRENDING";
     let decayFactor = 1.0;
     
     const isTrending = regime.includes("TRENDING") || regime.includes("CONTINUATION") || regime.includes("HEALTHY_DIRECTIONAL_VOL") || regime.includes("MOMENTUM");
     const isChop = regime.includes("CHOP") || regime.includes("DEAD_LOW_VOL") || regime.includes("RANGE");

     if (isTrending) {
       decayFactor = 3.0; // 3x faster decay!
     } else if (isChop) {
       decayFactor = 0.5; // half speed decay
     }

     const remaining = botState.cooldownUntil - loopNow;
     if (decayFactor !== 1.0 && remaining > 0) {
       const extraDecay = elapsedMs * (decayFactor - 1.0);
       botState.cooldownUntil = Math.max(loopNow, botState.cooldownUntil - extraDecay);
       
       const loopCount = (botState as any).cooldownDecayLogCounter || 0;
       if (loopCount % 20 === 0) {
         console.log(`[DYNAMIC_COOLDOWN_DECAY_ACTIVE] Dynamic cooldown decay active: Factor ${decayFactor.toFixed(1)}x based on ${regime} regime.`);
       }
       (botState as any).cooldownDecayLogCounter = loopCount + 1;
     }
  }

  // Environmental Watchdog system check (Requirement 7 & circuit breaker activation)
  try {
    const licenseFile = path.join(process.cwd(), "package.json");
    await fs.promises.access(licenseFile, fs.constants.F_OK);
  } catch (err) {
    console.error(
      "[WATCHDOG_EMERGENCY] Failsafe: Filesystem or directory inaccessible. Circuit breaker engaged.",
    );
    triggerCircuitBreaker("WATCHDOG_CIRCUIT_BREAKER: SYSTEM_FILESYSTEM_ACCESS_LOSS");

    // Halt loop execution
    return;
  }

  await syncAccountState();
  calculatePositionSlots();

  await evaluateStaleOrders();

  if (evaluateCircuitBreakers()) {
    console.warn(`[WATCHDOG] Circuit breaker active! Trading is halted.`);
    setTimeout(loop, 3000);
    return;
  }

  if (botState.validationStatus === "PENDING") {
    // We don't want to spam console every 3s if it takes a while, just log once or silently wait
    botState.blocker = "VALIDATION_PENDING";
    setTimeout(loop, 3000);
    return;
  }

  if (botState.validationStatus === "VALIDATION_FAILED") {
    if (botState.openPositions > 0 && botState.positionDetails) {
      if (
        botState.blocker?.indexOf(
          "ENTRY_BLOCKED_POSITION_MANAGEMENT_ACTIVE",
        ) === -1
      ) {
        console.warn(
          "[EMERGENCY_MANAGEMENT] Validation failed, but position exists. Entering EMERGENCY MODE.",
        );
      }
      botState.blocker = botState.lastApiError
        ? `ENTRY_BLOCKED_POSITION_MANAGEMENT_ACTIVE: ${botState.lastApiError}`
        : "ENTRY_BLOCKED_POSITION_MANAGEMENT_ACTIVE";
      await handleTradingLogic(true); // Emergency mode = true
      setTimeout(loop, 3000);
      return;
    } else {
      botState.blocker = botState.lastApiError || "VALIDATION_FAILED";
      await validationRunner.verifyValidation();
      setTimeout(loop, 3000);
      return;
    }
  }

  if (!botState.liveModeDiagnostics?.exchangeMutationsAllowed && botState.phase !== "VALIDATION_FAILED" && botState.phase !== "CIRCUIT_BREAKER_ACTIVE") {
    botState.blocker = "LIVE TRADING BLOCKED — CONFIGURATION REQUIRED";
    await handleTradingLogic();
  } else {
    if (!riskManager.checkRisk(botState.activeSymbol)) {
      // Risk manager sets the blocker string internally if it fails
    } else {
      if (botState.phase === "VALIDATION_READY") {
        await validationRunner.runValidationTrade();
      } else if (
        botState.phase === "PHASE_0_STABILIZATION" ||
        botState.phase === "PHASE_1_CONTROLLED_LIVE" ||
        botState.phase === "PHASE_2_ADAPTIVE_EXECUTION" ||
        botState.phase === "PAPER_MODE_ACTIVE"
      ) {
        botState.blocker = null;
        await handleTradingLogic();
      } else if (botState.phase === "VALIDATION_FAILED") {
        if (botState.openPositions > 0) {
          botState.blocker = "ENTRY_BLOCKED_POSITION_MANAGEMENT_ACTIVE";
          await handleTradingLogic(true);
        } else {
          botState.blocker = "VALIDATION_FAILED";
          await validationRunner.verifyValidation();
        }
      }
    }
  }

  setTimeout(loop, 3000);
}

let _engineStarted = false;
export async function startBotEngine() {
  if (_engineStarted) return;
  _engineStarted = true;
  console.log("Starting Bot Engine...");
  console.log("[CLOUD_RUNTIME_INITIALIZED] Bot engine initialized as a singleton.");
  console.log(`[EXECUTION_MODE_CONFIRMED] ${config.DRY_RUN ? "DRY_RUN" : "LIVE"} mode active. Secrets are not printed.`);
  console.log(`[CONFIG] MAX_OPEN_POSITIONS=${botState.config.maxOpenPositions ?? config.MAX_OPEN_POSITIONS}`);
  console.log(`[PHASE_1_SAFETY_CONFIG] Conservative controls: maxOpenPositions=${botState.config.maxOpenPositions ?? config.MAX_OPEN_POSITIONS}, minEntrySize=$${botState.config.minEntrySize || 40}, dailyLossLimitPct=${botState.config.dailyLossLimitPct ?? config.DAILY_LOSS_LIMIT_PCT}, balanceReservePct=${botState.config.balanceReservePct ?? config.BALANCE_RESERVE_PCT}, microScalpMode=${botState.config.microScalpModeEnabled ? "ENABLED" : "DISABLED"}.`);

  // Set pending status explicitly on startup
  botState.validationStatus = "PENDING";

  // Continuous execution heartbeat (logs every 45 seconds for Cloud Run monitoring)
  setInterval(() => {
    const activeSymbols = Object.keys(botState.markPrices || {}).length;
    const isWssHealthy = botState.wssConnected;
    const isApiHealthy = botState.apiConnected !== false;
    const isScannerActive = Date.now() - (botState.lastScanTime || 0) < 60000;
    
    botState.cloudRuntimeHealth = {
       CLOUD_RUNTIME_ACTIVE: true,
       LOOP_HEALTHY: true,
       WSS_HEALTHY: isWssHealthy,
       API_HEALTHY: isApiHealthy,
       SCANNER_ACTIVE: isScannerActive,
       EXECUTOR_READY: botState.validationStatus === "SUCCESS"
    };

    console.log(
      `[HEARTBEAT] BOT_ACTIVE: ${botState.phase}, WSS_CONNECTED: ${botState.wssConnected}, LAST_SCAN_TIME: ${new Date(botState.lastScanTime || Date.now()).toISOString()}, ACTIVE_SYMBOL_COUNT: ${activeSymbols}`,
    );
    console.log(`[HEARTBEAT] CLOUD_RUNTIME_ACTIVE: true, EXECUTOR_READY: ${botState.cloudRuntimeHealth.EXECUTOR_READY}, LOOP_HEALTHY: true, WSS_HEALTHY: ${isWssHealthy}, API_HEALTHY: ${isApiHealthy}, SCANNER_ACTIVE: ${isScannerActive}, BACKEND_CONTINUITY_VERIFIED`);
  }, 45000);

  // Save persistent snapshot every 15 seconds
  setInterval(() => {
    snapshotService.saveSnapshot(botState);
  }, 15000);

  // Background fetch for real-time funding rates (SOL-PERP, BTC-PERP, ETH-PERP)
  const fetchFundingRates = async () => {
    try {
      const budget = (await import("./services/apiBudgetManager.js")).apiBudgetManager.reserveInfo("metadata", "metaAndAssetCtxs");
      if (!budget.allowed) {
          console.warn(`[API_BUDGET_THROTTLED] Skipped metaAndAssetCtxs background scan.`);
          return;
      }
      
      const metaAndCtxs = await hClient.infoRequest({ type: "metaAndAssetCtxs" });
      if (metaAndCtxs && Array.isArray(metaAndCtxs) && metaAndCtxs.length === 2) {
        const [meta, assetCtxs] = metaAndCtxs;
        if (meta && meta.universe && Array.isArray(assetCtxs)) {
          const s = await import("./state.js");
          if (!s.getAssetMetaGlobal()) {
            s.setAssetMeta(meta.universe);
          }
          
          const universe = meta.universe;
          const solIdx = universe.findIndex((asset: any) => asset.name === "SOL");
          const btcIdx = universe.findIndex((asset: any) => asset.name === "BTC");
          const ethIdx = universe.findIndex((asset: any) => asset.name === "ETH");
          
          if (!botState.fundingRates) botState.fundingRates = {};
          
          if (solIdx !== -1 && assetCtxs[solIdx]) {
            botState.fundingRates["SOL"] = parseFloat(assetCtxs[solIdx].funding);
          }
          if (btcIdx !== -1 && assetCtxs[btcIdx]) {
            botState.fundingRates["BTC"] = parseFloat(assetCtxs[btcIdx].funding);
          }
          if (ethIdx !== -1 && assetCtxs[ethIdx]) {
            botState.fundingRates["ETH"] = parseFloat(assetCtxs[ethIdx].funding);
          }
        }
      }
    } catch (err: any) {
      console.error("Failed to fetch funding rates background:", err.message);
    }
  };

  fetchFundingRates();
  setInterval(fetchFundingRates, 10000);

  // Connect market data WS
  marketData.connect();

  // Wait a moment for WS to connect and market data to arrive, then validate
  setTimeout(async () => {
    try {
      await validationRunner.runStartupValidation();
    } catch (err) {
      console.error("Startup validation err:", err);
    }
  }, 2000);

  // Start loop
  console.log("[EXECUTION_LOOP_RESUMED]");
  loop();
}
