import { botState, getAssetId, getAssetMeta } from "./state.js";
import { config } from "./config.js";
import { hClient } from "./hyperliquidClient.js";
import { calculatePositionSlots, canOpenNewEntry, reconcileEntrySloCapacity } from "./services/positionSlotCalculator.js";
import { executionValidationGuard } from "./services/executionValidationGuard.js";
import { apiBudgetManager } from "./services/apiBudgetManager.js";

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

export function classifyExchangeRejection(error: string): string {
  const normalized = (error || "").toLowerCase();
  if (normalized.includes("entry_blocked_no_available_slo") || normalized.includes("entry_blocked_no_available_slot")) return "INTERNAL_ENTRY_SLO_CAPACITY";
  if (normalized.includes("address_action_waiting_for_next_slot") || normalized.includes("address_limit_one_action_per_10s") || normalized.includes("one_action_per_10s") || (normalized.includes("address") && normalized.includes("10s"))) return "ADDRESS_ACTION_PACING_REQUIRED";
  if (normalized.includes("auth") || normalized.includes("signer") || normalized.includes("private key") || normalized.includes("signature")) return "AUTH_FAILURE";
  if (normalized.includes("api_budget") || normalized.includes("rest_pressure") || normalized.includes("execution_layer_throttled")) return "API_BUDGET_LIMIT";
  if (normalized.includes("rate limit") || normalized.includes("too many cumulative") || normalized.includes("exceeded") || normalized.includes("volume traded")) return "API_RATE_LIMIT";
  if (normalized.includes("margin") || normalized.includes("insufficient") || normalized.includes("funds")) return "INSUFFICIENT_MARGIN";
  if (normalized.includes("ioc") || normalized.includes("not filled") || normalized.includes("would immediately")) return "IOC_NOT_FILLED";
  if (normalized.includes("trigger") || normalized.includes("tp") || normalized.includes("sl") || normalized.includes("stop")) return "TP_SL_TRIGGER_INVALID";
  if (normalized.includes("tick") || normalized.includes("price") || normalized.includes("precision")) return "INVALID_PRICE_PRECISION";
  if (normalized.includes("notional") || normalized.includes("minimum")) return "MIN_NOTIONAL_FAILED";
  if (normalized.includes("size") || normalized.includes("sz") || normalized.includes("out of range")) return "INVALID_ORDER_SIZE";
  return "UNKNOWN_EXCHANGE_REJECTION";
}

export class HyperliquidExecutionEngine {
  private leverageCache = new Map<string, { leverage: number; timestamp: number }>();

  private applyAddressActionPacing(symbol: string, raw: string, retryAfterMs?: number) {
    const waitMs = Math.max(1000, retryAfterMs || apiBudgetManager.getAddressActionRetryAfterMs() || 10000);
    const now = Date.now();
    apiBudgetManager.enableAddressLimitRecovery();
    botState.lastApiError = `ADDRESS_ACTION_PACING_REQUIRED: ${raw}`;
    botState.executionThrottleUntil = now + waitMs;
    botState.addressActionPacingUntil = now + waitMs;
    botState.blocker = "ADDRESS_ACTION_PACING_ACTIVE";
    botState.addressPacing = {
      active: true,
      status: "ACTIVE",
      reason: "one action per 10 seconds",
      nextActionAllowedAt: now + waitMs,
      retryAfterMs: waitMs,
      queuedCandidates: botState.addressPacing?.queuedCandidates || [],
      reservedCandidate: botState.addressPacing?.reservedCandidate || null,
      lastActionSentAt: apiBudgetManager.getLastAddressActionAt(),
      laneStatus: waitMs > 0 ? "WAITING" : "READY",
      updatedAt: now
    };
    console.warn(`[ADDRESS_PACING_GLOBAL_STATE_ACTIVE] Hyperliquid address action pacing active. nextAllowedIn=${Math.ceil(waitMs / 1000)}s.`);
    console.warn(`[ADDRESS_PACING_SYMBOL_SPAM_SUPPRESSED] ${symbol} deferred by global address lane; candidate should remain queued instead of rejected.`);
    console.warn(`[ADDRESS_ACTION_PACING_DETECTED] retryAfterMs=${waitMs}, raw=${raw}`);
    console.warn(`[ORDER_SUBMISSION_DEFERRED_ADDRESS_PACING] ${symbol} order deferred instead of marked unrecoverable.`);
    console.warn(`[ORDER_RETRY_SCHEDULED_AFTER_ADDRESS_PACING] ${symbol} retry eligible in ${Math.ceil(waitMs / 1000)}s.`);
  }

  async placeOrder(symbol: string, isBuy: boolean, sz: number, px: number, reduceOnly: boolean, isIoc: boolean = false) {
    const validation = executionValidationGuard.validateOrderIntent({ symbol, isBuy, size: sz, price: px, reduceOnly });
    if (!validation.allowed) {
      console.warn(`[ORDER_VALIDATION_REJECTED] ${symbol} reason=${validation.reason} size=${sz} price=${px} minNotional=${validation.minNotional.toFixed(2)} finalNotional=${validation.finalNotional.toFixed(2)}`);
      botState.lastApiError = validation.reason;
      if (!reduceOnly && validation.reason.includes("COOLDOWN")) {
        botState.blocker = validation.reason;
      }
      return null;
    }

    sz = validation.roundedSize;
    px = validation.roundedPrice;
    const side = isBuy ? 'BUY' : 'SELL';
    console.log(`[EXECUTOR] Requesting ${symbol} ${side} size=${sz.toFixed(4)} px=${px.toFixed(2)} reduceOnly=${reduceOnly} isIoc=${isIoc}`);
    
    // NEW: Add slot check for non-reduce-only orders (entry orders only)
    if (!reduceOnly) {
      if (!canOpenNewEntry(symbol)) {
        console.log(`[ENTRY_BLOCKED_NO_AVAILABLE_SLO_CLASSIFIED] Internal entry SLO capacity check failed before exchange submission for ${symbol}. Reconciliating against real position state.`);
        if (!reconcileEntrySloCapacity(symbol)) {
          console.log(`[POSITION_SLOT_BLOCKED_HARD_SAFETY] Entry order rejected: no available slots or hard safety condition active`);
          console.log(`[ENTRY_BLOCKED] symbol=${symbol}, reason=MAX_OPEN_POSITIONS, openPositions=${botState.usedPositions || botState.openPositions || 0}, pendingEntries=${botState.pendingEntryCount || 0}, maxOpenPositions=${botState.configuredMaxPositions || botState.config?.maxOpenPositions || 3}, availableSlots=${botState.availableSlots || 0}`);
          botState.lastApiError = "ENTRY_BLOCKED_NO_AVAILABLE_SLOTS";
          return null;
        }
        console.log(`[ENTRY_SLO_FALSE_BLOCK_PREVENTED] ${symbol} entry SLO reconciled successfully; continuing order submission.`);
      }
    } else {
      // Reduce-only orders (TP/SL) bypass slot restrictions
      console.log(`[REDUCE_ONLY_ORDER_BYPASS_SLOTS] Reduce-only order allowed regardless of slot state`);
    }

    if (config.DRY_RUN) {
      const oid = `MOCK-${Math.floor(Math.random() * 1000000)}`;
      botState.lastOrderId = oid;
      botState.lastFillPrice = px;
      botState.lastApiError = null;

      if (!reduceOnly) {
        const signedSize = isBuy ? Math.abs(sz) : -Math.abs(sz);
        const existing = botState.allPositions?.find((position: any) => position.coin === symbol);
        if (existing) {
          existing.szi = (parseFloat(existing.szi || "0") + signedSize).toString();
          existing.entryPx = px.toString();
          existing.unrealizedPnl = existing.unrealizedPnl || "0";
        } else {
          botState.allPositions = [
            ...(botState.allPositions || []),
            {
              coin: symbol,
              szi: signedSize.toString(),
              entryPx: px.toString(),
              unrealizedPnl: "0"
            }
          ];
        }
        botState.positionDetails = {
          coin: symbol,
          szi: signedSize.toString(),
          entryPx: px.toString(),
          unrealizedPnl: "0"
        };
        console.log(`[DRY_RUN_ORDER_FILLED] Simulated entry fill for ${symbol}. oid=${oid}, size=${sz}, price=${px}`);
        calculatePositionSlots();
        return { status: "ok", response: { data: { statuses: [{ filled: { oid, avgPx: px.toString(), totalSz: sz.toString() } }] } } };
      }

      botState.activeOrders = [
        ...(botState.activeOrders || []),
        {
          coin: symbol,
          oid,
          reduceOnly: true,
          sz: Math.abs(sz).toString(),
          limitPx: px.toString(),
          px: px.toString(),
          timestamp: Date.now()
        }
      ];
      console.log(`[DRY_RUN_REDUCE_ONLY_ORDER_PLACED] Simulated reduce-only order for ${symbol}. oid=${oid}, size=${sz}, price=${px}`);
      return { status: "ok", response: { data: { statuses: [{ resting: { oid } }] } } };
    }

    // Real exchange request
    const assetId = getAssetId(symbol);
    const assetMeta = getAssetMeta(symbol);

      let formattedSz = Number(sz.toFixed(3)).toString();
      if (assetMeta && typeof assetMeta.szDecimals === "number") {
         const multiplier = Math.pow(10, assetMeta.szDecimals);
         formattedSz = (Math.floor(sz * multiplier + 1e-7) / multiplier).toString();
      }

      const formattedPx = formatHyperliquidPrice(px);
      
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

      console.log(`[ORDER_SUBMISSION_DIAGNOSTIC] symbol=${symbol}, side=${side}, reduceOnly=${reduceOnly}, tif=${isIoc ? "Ioc" : "Gtc"}, size=${formattedSz}, price=${formattedPx}, assetId=${assetId}`);
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
            const classification = classifyExchangeRejection(status.error);
            if (classification === "ADDRESS_ACTION_PACING_REQUIRED") {
              console.warn(`[EXCHANGE_REJECTION_CLASSIFIED] symbol=${symbol}, classification=${classification}, raw=${status.error}`);
              this.applyAddressActionPacing(symbol, status.error);
              return null;
            }
            if (classification === "API_RATE_LIMIT") { console.warn("Order deferred: Rate limit exceeded (cumulative requests)."); } else { console.error(`Order returned API error: ${status.error}`); }
            console.warn(`[EXCHANGE_REJECTION_CLASSIFIED] symbol=${symbol}, classification=${classification}, raw=${status.error}`);
            botState.lastApiError = `${classification}: ${status.error}`;
            
            if (classification === "API_RATE_LIMIT" && status.error.includes("Too many cumulative requests sent")) {
               botState.apiRateLimitUntil = Date.now() + 300000;
               botState.blocker = "API_RATE_LIMIT_EXCEEDED";
               console.warn(`[API_RATE_LIMIT] Blocking execution for 300s due to cumulative rate limit.`);
               console.warn(`[ORDER_REJECTION_COOLDOWN_APPLIED] symbol=${symbol}, classification=${classification}, cooldownMs=300000`);
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
        const classification = classifyExchangeRejection(errorDetail);
        if (classification === "ADDRESS_ACTION_PACING_REQUIRED") {
          console.warn(`[EXCHANGE_REJECTION_CLASSIFIED] symbol=${symbol}, classification=${classification}, raw=${errorDetail}`);
          this.applyAddressActionPacing(symbol, errorDetail, (result as any)?.retryAfterMs);
          return null;
        }
        if (classification === "API_RATE_LIMIT") { console.warn("Order deferred: Rate limit exceeded (cumulative requests)."); } else { console.error("Order failed:", errorDetail); }
        console.warn(`[EXCHANGE_REJECTION_CLASSIFIED] symbol=${symbol}, classification=${classification}, raw=${errorDetail}`);
        botState.lastApiError = `${classification}: ${errorDetail}`;
        
        if (classification === "API_RATE_LIMIT" && errorDetail.includes("Too many cumulative requests sent")) {
           botState.apiRateLimitUntil = Date.now() + 300000;
           botState.blocker = "API_RATE_LIMIT_EXCEEDED";
           console.warn(`[API_RATE_LIMIT] Blocking execution for 300s due to cumulative rate limit.`);
           console.warn(`[ORDER_REJECTION_COOLDOWN_APPLIED] symbol=${symbol}, classification=${classification}, cooldownMs=300000`);
        }
      }
      return null;
  }

  async cancelOrder(symbol: string, oid: number | string) {
    if (config.DRY_RUN) {
      const oidStr = String(oid);
      botState.activeOrders = (botState.activeOrders || []).filter((order: any) => String(order.oid) !== oidStr);
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
         botState.apiRateLimitUntil = Date.now() + 300000;
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

    if (config.DRY_RUN) {
      botState.activeOrders = (botState.activeOrders || []).filter((order: any) => order.coin !== coin);
      console.log(`[DRY_RUN] Canceled ${ordersToCancel.length} open orders for ${coin}`);
      return true;
    }

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
         botState.apiRateLimitUntil = Date.now() + 300000;
         botState.blocker = "API_RATE_LIMIT_EXCEEDED";
      }
      return result && result.status === "ok";
    } catch (e) {
      console.error("Failed to cancel orders:", e);
      return false;
    }
  }

  async placeTpSlOrders(symbol: string, isLongPosition: boolean, sz: number, tpPrice: number | null, slPrice: number) {
    const slValidation = executionValidationGuard.validateOrderIntent({ symbol, isBuy: !isLongPosition, size: Math.abs(sz), price: slPrice, reduceOnly: true });
    if (!slValidation.allowed) {
      console.warn(`[TP_SL_VALIDATION_REJECTED] ${symbol} SL rejected: ${slValidation.reason}`);
      botState.lastApiError = slValidation.reason;
      return false;
    }
    if (tpPrice !== null && tpPrice !== undefined) {
      const tpValidation = executionValidationGuard.validateOrderIntent({ symbol, isBuy: !isLongPosition, size: Math.abs(sz), price: tpPrice, reduceOnly: true });
      if (!tpValidation.allowed) {
        console.warn(`[TP_SL_VALIDATION_REJECTED] ${symbol} TP rejected: ${tpValidation.reason}`);
        botState.lastApiError = tpValidation.reason;
        return false;
      }
    }

    if (config.DRY_RUN) {
      const now = Date.now();
      const filteredOrders = (botState.activeOrders || []).filter((order: any) => !(order.coin === symbol && order.reduceOnly));
      const mockOrders: any[] = [];
      if (tpPrice !== null && tpPrice !== undefined) {
        mockOrders.push({
          coin: symbol,
          oid: `MOCK-TP-${Math.floor(Math.random() * 1000000)}`,
          reduceOnly: true,
          sz: Math.abs(sz).toString(),
          limitPx: tpPrice.toString(),
          px: tpPrice.toString(),
          timestamp: now
        });
      }
      mockOrders.push({
        coin: symbol,
        oid: `MOCK-SL-${Math.floor(Math.random() * 1000000)}`,
        reduceOnly: true,
        isTrigger: true,
        triggerPx: slPrice.toString(),
        sz: Math.abs(sz).toString(),
        timestamp: now
      });
      botState.activeOrders = [...filteredOrders, ...mockOrders];
      botState.telemetry = {
        ...(botState.telemetry || {}),
        activeTpCount: tpPrice !== null && tpPrice !== undefined ? 1 : 0,
        activeSlCount: 1,
        duplicateProtectionWarnings: botState.telemetry?.duplicateProtectionWarnings || 0,
        protectionSyncHealth: "HEALTHY",
        currentProtectionIssue: "NONE",
        repairRequired: false,
        repairInProgress: false,
        lastRepairAction: "DRY_RUN_TP_SL_SYNC",
        lastRepairCompletedAt: now
      } as any;
      console.log(`[DRY_RUN] Placed TP/SL for ${symbol}. TP: ${tpPrice}, SL: ${slPrice}`);
      console.log(`[PROTECTION_RECONCILIATION_COMPLETED] Protection synced for ${symbol}.`);
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
               botState.apiRateLimitUntil = Date.now() + 300000;
               botState.blocker = "API_RATE_LIMIT_EXCEEDED";
               console.warn(`[API_BUDGET_THROTTLED] Deferred TP/SL cancel due to global API limits. (300s backoff)`);
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
         const classification = classifyExchangeRejection(errDetail);
         if (classification === "ADDRESS_ACTION_PACING_REQUIRED") {
             this.applyAddressActionPacing(symbol, errDetail, (result as any)?.retryAfterMs);
             console.warn(`[PROTECTION_RETRY_SCHEDULED_AFTER_ADDRESS_PACING] ${symbol} TP/SL placement deferred by address pacing and must be retried.`);
             return false;
         }
         if (errDetail.includes("Too many cumulative requests sent") || (result && result.response && typeof result.response === "string" && result.response.includes("Too many cumulative requests sent"))) {
             botState.apiRateLimitUntil = Date.now() + 300000;
             botState.blocker = "API_RATE_LIMIT_EXCEEDED";
             console.warn(`[API_RATE_LIMIT] Blocking execution for 300s due to cumulative rate limit (TP/SL trigger).`);
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
    const cached = this.leverageCache.get(symbol);
    if (cached && cached.leverage === leverage && Date.now() - cached.timestamp < 10 * 60 * 1000) {
      console.log(`[LEVERAGE_UPDATE_SKIPPED_CACHED] ${symbol} leverage ${leverage}x was recently confirmed; preserving exchange action budget.`);
      return true;
    }

    const action = {
      type: "updateLeverage",
      asset: getAssetId(symbol),
      isCross: true,
      leverage: leverage
    };
    try {
      const result = await hClient.exchangeRequest(action);
      if (result && result.status === "ok") {
        this.leverageCache.set(symbol, { leverage, timestamp: Date.now() });
        return true;
      }

      const errorDetail = result ? JSON.stringify(result).slice(0, 200) : "Empty response";
      const classification = classifyExchangeRejection(errorDetail);
      console.warn(`[LEVERAGE_UPDATE_CLASSIFIED] symbol=${symbol}, classification=${classification}, raw=${errorDetail}`);
      if (classification === "ADDRESS_ACTION_PACING_REQUIRED") {
        this.applyAddressActionPacing(symbol, errorDetail, (result as any)?.retryAfterMs);
      } else {
        botState.lastApiError = `${classification}: ${errorDetail}`;
      }
      return false;
    } catch (e) {
      console.error("Failed to set leverage:", e);
      return false;
    }
  }
}

export const executionEngine = new HyperliquidExecutionEngine();
