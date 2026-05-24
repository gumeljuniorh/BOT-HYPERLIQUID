import { botState, getAssetId, getAssetMeta } from "./state.js";
import { config } from "./config.js";
import { hClient } from "./hyperliquidClient.js";
import { calculatePositionSlots, canOpenNewEntry } from "./services/positionSlotCalculator.js";

export function formatHyperliquidPrice(px: number): string {
  if (px <= 0 || isNaN(px) || !isFinite(px)) return "0";
  const log = Math.floor(Math.log10(px));
  const tickSize = Math.max(1e-6, Math.pow(10, log - 4));
  const roundedPx = Math.round(px / tickSize) * tickSize;
  let formattedPx = Number(roundedPx.toPrecision(5)).toString();
  if (formattedPx.includes("e")) {
    formattedPx = Number(formattedPx).toLocaleString('fullwide', {
      useGrouping: false,
      maximumSignificantDigits: 5
    });
  }
  return formattedPx;
}

export class HyperliquidExecutionEngine {
  async placeOrder(symbol: string, isBuy: boolean, sz: number, px: number, reduceOnly: boolean, isIoc: boolean = false) {
    const side = isBuy ? 'BUY' : 'SELL';
    console.log(`[EXECUTOR] Requesting ${symbol} ${side} size=${sz.toFixed(4)} px=${px.toFixed(2)} reduceOnly=${reduceOnly} isIoc=${isIoc}`);
    
    // NEW: Add slot check for non-reduce-only orders (entry orders only)
    if (!reduceOnly) {
      if (!canOpenNewEntry()) {
        console.log(`[POSITION_SLOT_BLOCKED_HARD_SAFETY] Entry order rejected: no available slots or hard safety condition active`);
        botState.lastApiError = "ENTRY_BLOCKED_NO_AVAILABLE_SLOTS";
        return null;
      }
    } else {
      // Reduce-only orders (TP/SL) bypass slot restrictions
      console.log(`[REDUCE_ONLY_ORDER_BYPASS_SLOTS] Reduce-only order allowed regardless of slot state`);
    }

    if (config.DRY_RUN) {
      // Simulate fill in bot state for dashboard awareness
      const oid = `MOCK-${Math.floor(Math.random() * 1000000)}`;
      botState.lastOrderId = oid;
      botState.lastFillPrice = px;
      
      // Manually adjust botState for paper mode visualization
      if (!reduceOnly) {
        botState.openPositions = (botState.openPositions || 0) + 1;
        botState.positionDetails = {
           coin: symbol,
           szi: isBuy ? sz.toString() : (-sz).toString(),
           entryPx: px.toString(),
           unrealizedPnl: "0"
        };
        // Recalculate slots after position change
        calculatePositionSlots();
      } else {
        botState.openPositions = Math.max(0, (botState.openPositions || 0) - 1);
        botState.positionDetails = null;
        // Recalculate slots after position change
        calculatePositionSlots();
      }
      return { status: "ok", oid };
    } else {
      // Real exchange request
      const assetId = getAssetId(symbol);
      const assetMeta = getAssetMeta(symbol);

      let formattedSz = Number(sz.toFixed(3)).toString();
      if (assetMeta && typeof assetMeta.szDecimals === "number") {
         const multiplier = Math.pow(10, assetMeta.szDecimals);
         formattedSz = (Math.floor(sz * multiplier + 1e-7) / multiplier).toString();
      }

      const formattedPx = formatHyperliquidPrice(px);
      
      // Hyperliquid doesn't like prices <= 0
      if (px <= 0) {
        console.error("Attempted to place order with price <= 0:", px);
        return null;
      }


      const action = {
        type: "order",
        orders: [{
          a: assetId,
          b: isBuy,
          p: formattedPx,
          s: formattedSz,
          r: reduceOnly,
          t: { limit: { tif: isIoc ? "Ioc" : "Gtc" } }
        }],
        grouping: "na"
      };

      const result = await hClient.exchangeRequest(action);
      if (result && result.status === "ok") {
        const statuses = result.response.data.statuses;
        if (statuses && statuses.length > 0) {
          const status = statuses[0];
          if (status.resting) {
            botState.lastOrderId = status.resting.oid.toString();
            botState.lastFillPrice = px;
            botState.lastApiError = null;
            // Recalculate slots after successful order
            if (!reduceOnly) {
              calculatePositionSlots();
            }
            return result;
          } else if (status.filled) {
            botState.lastOrderId = status.filled.oid.toString();
            botState.lastFillPrice = parseFloat(status.filled.avgPx);
            botState.lastApiError = null;
            // Recalculate slots after fill
            calculatePositionSlots();
            return result;
          } else if (status.error) {
            console.error(`Order returned API error: ${status.error}`);
            botState.lastApiError = status.error;
            
            if (status.error.includes("Too many cumulative requests sent")) {
               botState.apiRateLimitUntil = Date.now() + 60000;
               botState.blocker = "API_RATE_LIMIT_EXCEEDED";
               console.warn(`[API_RATE_LIMIT] Blocking execution for 60s due to cumulative rate limit.`);
            }

            // Special handling for reduceOnly errors
            if (status.error.includes("Reduce only order would increase position")) {
               console.log("REDUCE_ONLY_EXCEEDED: This usually means the position is already being closed or is smaller than requested.");
            }
          }
        }
      } else {
        let errorDetail = "Unknown error";
        try {
          errorDetail = result ? JSON.stringify(result).slice(0, 200) : "Empty response";
        } catch (e) {
          errorDetail = "Circular or too complex response object";
        }
        console.error("Order failed:", errorDetail);
        botState.lastApiError = errorDetail;
        
        if (errorDetail.includes("Too many cumulative requests sent")) {
           botState.apiRateLimitUntil = Date.now() + 60000;
           botState.blocker = "API_RATE_LIMIT_EXCEEDED";
           console.warn(`[API_RATE_LIMIT] Blocking execution for 60s due to cumulative rate limit.`);
        }
      }
      return null;
    }
  }

  async cancelOrder(symbol: string, oid: number | string) {
    if (config.DRY_RUN) {
      console.log(`[DRY_RUN] Canceled order ${oid} for ${symbol}`);
      return true;
    }

    const action = {
      type: "cancel",
      cancels: [{
        a: getAssetId(symbol),
        o: typeof oid === 'string' ? parseInt(oid) : oid
      }]
    };

    try {
      const result = await hClient.exchangeRequest(action);
      if (result && result.status === "err" && typeof result.response === "string" && result.response.includes("Too many cumulative requests sent")) {
         botState.apiRateLimitUntil = Date.now() + 60000;
         botState.blocker = "API_RATE_LIMIT_EXCEEDED";
      }
      return result && result.status === "ok";
    } catch (e) {
      console.error(`Failed to cancel order ${oid}:`, e);
      return false;
    }
  }

  async cancelAllOrders(symbol?: string) {
    const coin = symbol || botState.activeSymbol;
    console.log(`Canceling all open orders for ${coin}.`);
    
    // Find orders for this coin
    const ordersToCancel = botState.activeOrders.filter(o => o.coin === coin);
    if (ordersToCancel.length === 0) return true;

    const action = {
      type: "cancel",
      cancels: ordersToCancel.map(o => ({
        a: getAssetId(o.coin),
        o: o.oid
      }))
    };

    try {
      const result = await hClient.exchangeRequest(action);
      if (result && result.status === "err" && typeof result.response === "string" && result.response.includes("Too many cumulative requests sent")) {
         botState.apiRateLimitUntil = Date.now() + 60000;
         botState.blocker = "API_RATE_LIMIT_EXCEEDED";
      }
      return result && result.status === "ok";
    } catch (e) {
      console.error("Failed to cancel orders:", e);
      return false;
    }
  }

  async placeTpSlOrders(symbol: string, isLongPosition: boolean, sz: number, tpPrice: number | null, slPrice: number) {
    if (config.DRY_RUN) {
      console.log(`[DRY_RUN] Placed TP/SL for ${symbol}. TP: ${tpPrice}, SL: ${slPrice}`);
      return true;
    }
    
    const assetId = getAssetId(symbol);
    const assetMeta = getAssetMeta(symbol);

    let formattedSz = Number(Math.abs(sz).toFixed(3)).toString();
    if (assetMeta && typeof assetMeta.szDecimals === "number") {
       const multiplier = Math.pow(10, assetMeta.szDecimals);
       formattedSz = (Math.floor(Math.abs(sz) * multiplier + 1e-7) / multiplier).toString();
    }

    const formattedSl = formatHyperliquidPrice(slPrice);

    const formattedTp = tpPrice !== null && tpPrice !== undefined ? formatHyperliquidPrice(tpPrice) : null;
    const isBuy = !isLongPosition;
    
    // Reconciliation: check existing active reduce-only orders
    const activeReduceOrders = botState.activeOrders?.filter((o: any) => o.coin === symbol && o.reduceOnly) || [];
    const activeSlOrders = activeReduceOrders.filter((o: any) => o.isTrigger || o.triggerPx || parseFloat(o.triggerPx || "0") > 0);
    const activeTpOrders = activeReduceOrders.filter((o: any) => !activeSlOrders.includes(o));
    
    let skipSl = false;
    let skipTp = !formattedTp;
    const cancels = [];
    
    if (!botState.telemetry) {
        botState.telemetry = {
            activeTpCount: 0,
            activeSlCount: 0,
            duplicateProtectionWarnings: 0,
            protectionSyncHealth: "UNKNOWN"
        };
    }
    
    for (const o of activeSlOrders) {
        const isMatch = (parseFloat(o.triggerPx || o.limitPx || "0") === parseFloat(formattedSl)) && (parseFloat(o.sz) === parseFloat(formattedSz));
        if (isMatch && !skipSl) {
            skipSl = true;
            console.log(`[PROTECTION_ORDER_SCAN] SL_ALREADY_EXISTS for ${symbol}. Trigger: ${formattedSl}. Skipping creation.`);
        } else {
            if (isMatch) {
                botState.telemetry.duplicateProtectionWarnings++;
                console.log(`[PROTECTION_RECONCILIATION] DUPLICATE_SL_DETECTED. Canceling stale/duplicate SL for ${symbol} (oid: ${o.oid})`);
            } else {
                console.log(`[PROTECTION_RECONCILIATION] STALE_SL_CANCELLED for ${symbol} (oid: ${o.oid})`);
            }
            cancels.push({ a: assetId, o: o.oid });
        }
    }
    
    for (const o of activeTpOrders) {
        if (formattedTp) {
             const isMatch = (parseFloat(o.limitPx || o.px || "0") === parseFloat(formattedTp)) && (parseFloat(o.sz) === parseFloat(formattedSz));
             if (isMatch && !skipTp) {
                 skipTp = true;
                 console.log(`[PROTECTION_ORDER_SCAN] TP_ALREADY_EXISTS for ${symbol}. Limit: ${formattedTp}. Skipping creation.`);
             } else {
                 console.log(`[PROTECTION_RECONCILIATION] Canceling stale/duplicate TP for ${symbol} (oid: ${o.oid})`);
                 cancels.push({ a: assetId, o: o.oid });
             }
        } else {
             console.log(`[PROTECTION_RECONCILIATION] Canceling stale TP for ${symbol} (oid: ${o.oid}) because no rigid TP is needed.`);
             cancels.push({ a: assetId, o: o.oid });
        }
    }
    
    if (cancels.length > 0) {
       console.log(`[PROTECTION_RECONCILIATION] Executing ${cancels.length} cancellations for ${symbol}.`);
       try {
           const cancelResult = await hClient.exchangeRequest({ type: "cancel", cancels });
           if (cancelResult && cancelResult.status === "err" && typeof cancelResult.response === "string" && cancelResult.response.includes("Too many cumulative requests sent")) {
               botState.apiRateLimitUntil = Date.now() + 60000;
               botState.blocker = "API_RATE_LIMIT_EXCEEDED";
               console.warn(`[API_BUDGET_THROTTLED] Deferred TP/SL cancel due to global API limits.`);
               return false;
           }
           // Optimistically remove cancelled orders from local state
           const cancelOids = cancels.map(c => String(c.o));
           botState.activeOrders = botState.activeOrders.filter(o => !cancelOids.includes(String(o.oid)));
       } catch(e) {
           console.error("[PROTECTION_RECONCILIATION] Failed to cancel stale protection:", e);
           return false;
       }
    }

    const ordersToSubmit = [];
    
    if (!skipTp && formattedTp) {
      ordersToSubmit.push({
        a: assetId,
        b: isBuy,
        p: formattedTp,
        s: formattedSz,
        r: true,
        t: { limit: { tif: "Gtc" } }
      });
    }
    
    if (!skipSl) {
      ordersToSubmit.push({
        a: assetId,
        b: isBuy,
        p: formattedSl,
        s: formattedSz,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: formattedSl, tpsl: "sl" } }
      });
    }

    if (ordersToSubmit.length === 0) {
       console.log(`[DUPLICATE_PROTECTION_PREVENTED] Protection orders for ${symbol} already perfectly synced.`);
       console.log(`[PROTECTION_RECONCILIATION_COMPLETED] Protection synced for ${symbol}.`);
       return true;
    }

    const action = {
      type: "order",
      orders: ordersToSubmit,
      grouping: "na"
    };

    try {
      const result = await hClient.exchangeRequest(action);
      if (result && result.status === "ok") {
         console.log(`[EXECUTOR] TP/SL orders successfully placed/updated for ${symbol}. TP=${skipTp ? 'skipped/existing' : formattedTp}, SL=${skipSl ? 'skipped/existing' : formattedSl}`);
         console.log(`[PROTECTION_RECONCILIATION_COMPLETED] Protection synced for ${symbol}.`);
         return true;
      } else {
         const errDetail = JSON.stringify(result || {});
         console.error(`[EXECUTOR] Failed to place TP/SL orders: `, errDetail);
         if (errDetail.includes("Too many cumulative requests sent") || (result && result.response && typeof result.response === "string" && result.response.includes("Too many cumulative requests sent"))) {
             botState.apiRateLimitUntil = Date.now() + 60000;
             botState.blocker = "API_RATE_LIMIT_EXCEEDED";
             console.warn(`[API_RATE_LIMIT] Blocking execution for 60s due to cumulative rate limit (TP/SL trigger).`);
         }
         return false;
      }
    } catch (e) {
      console.error(`[EXECUTOR] API Error placing TP/SL:`, e);
      return false;
    }
  }

  async setLeverage(symbol: string, leverage: number) {
    if (config.DRY_RUN) return true;
    const action = {
      type: "updateLeverage",
      asset: getAssetId(symbol),
      isCross: true,
      leverage: leverage
    };
    try {
      const result = await hClient.exchangeRequest(action);
      return result && result.status === "ok";
    } catch (e) {
      console.error("Failed to set leverage:", e);
      return false;
    }
  }
}

export const executionEngine = new HyperliquidExecutionEngine();
