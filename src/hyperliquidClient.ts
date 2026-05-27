import { config } from "./config.js";
import { ethers } from "ethers";
import { signL1Action } from "hyperliquid";
import { botState } from "./state.js";
import { apiBudgetManager, type ApiBudgetLane } from "./services/apiBudgetManager.js";

function infoLaneForType(type: string | undefined): ApiBudgetLane {
  if (type === "meta" || type === "metaAndAssetCtxs") return "metadata";
  if (type === "clearinghouseState" || type === "spotClearinghouseState" || type === "userState" || type === "openOrders" || type === "userFills") return "account";
  return "scanner";
}

function exchangeLaneForAction(action: any): ApiBudgetLane {
  if (action?.type === "cancel") return "protection";
  const orders = Array.isArray(action?.orders) ? action.orders : [];
  if (orders.length > 0 && orders.every((order: any) => order.r === true)) {
    const hasTrigger = orders.some((order: any) => !!order.t?.trigger);
    return hasTrigger ? "tpsl" : "protection";
  }
  return "execution";
}

export class HyperliquidClient {
  private wallet: ethers.Wallet | null = null;
  public isValidSigner: boolean = false;
  
  public get walletAddress(): string | null {
    return this.wallet?.address || null;
  }

  constructor() {
    this.initializeWallet();
  }

  private initializeWallet() {
    if (config.HYPERLIQUID_PRIVATE_KEY) {
      try {
        // Ensure private key has 0x prefix if it doesn't
        let pk = config.HYPERLIQUID_PRIVATE_KEY.trim();
        if (pk && !pk.startsWith("0x")) pk = "0x" + pk;
        
        if (pk.length === 42) {
          throw new Error("Private key looks like a wallet address (42 chars). Please use the actual 64-char private key.");
        }
        
        this.wallet = new ethers.Wallet(pk);
        console.log(`[CLIENT] Wallet loaded: ${this.wallet.address}`);
        this.isValidSigner = true;
        
        if (this.wallet.address.toLowerCase() !== config.HYPERLIQUID_API_WALLET.toLowerCase()) {
           console.warn(`[CLIENT] Signer address mismatch: expected ${config.HYPERLIQUID_API_WALLET}, got ${this.wallet.address}`);
        }
      } catch (e: any) {
        // Silently handle to prevent console error spam since RiskManager sets a blocker
        this.wallet = null;
        this.isValidSigner = false;
      }
    } else {
      console.warn("[CLIENT] No private key found during initialization.");
    }
  }

  private requestCache = new Map<string, { timestamp: number; data: any }>();
  private CACHE_DURATION_MS = 60000; // Cache meta requests longer, other high freq requests we can throttle

  async infoRequest(payload: any, retries = 3, delay = 1000, cacheTimeMs = 5000): Promise<any> {
    const cacheKey = JSON.stringify(payload);
    const now = Date.now();
    const cached = this.requestCache.get(cacheKey);
    const lane = infoLaneForType(payload?.type);

    // Apply different cache times based on payload type
    let effectiveCacheTime = cacheTimeMs;
    if (payload.type === "meta" || payload.type === "metaAndAssetCtxs") {
      effectiveCacheTime = 60000; // 1 min for static/heavy meta
    } else if (payload.type === "clearinghouseState" || payload.type === "spotClearinghouseState" || payload.type === "userState" || payload.type === "openOrders" || payload.type === "userFills") {
      effectiveCacheTime = 12000; // 12 seconds for states during normal loops (WSS covers live)
    }

    // If globally rate-limited, extend cache heavily
    if (botState.apiRateLimitUntil && Date.now() < botState.apiRateLimitUntil) {
       effectiveCacheTime = 60000; // 60s minimum backoff for everything
       console.log(`[REST_BACKOFF_ACTIVE] Throttling infoRequest (${payload.type}) due to API budget constraint.`);
    }

    if (cached && now - cached.timestamp < effectiveCacheTime) {
      apiBudgetManager.noteCacheHit(lane, payload?.type || "unknown");
      botState.apiBudget = apiBudgetManager.getSnapshot();
      return cached.data; // deduplicate/cache return
    }

    const isCritical = lane === "metadata" || lane === "account" || lane === "protection" || lane === "tpsl";
    const budget = apiBudgetManager.reserveInfo(lane, payload?.type || "info", isCritical);
    botState.apiBudget = apiBudgetManager.getSnapshot();
    if (!budget.allowed) {
      if (cached) {
        console.log(`[EXECUTION_VALIDATION_CACHED] Returning stale cached ${payload?.type || "info"} due to ${budget.reason}.`);
        return cached.data;
      }
      if (budget.reason === "EXECUTION_BUDGET_EXCEEDED") {
        botState.blocker = "EXECUTION_LAYER_THROTTLED";
      }
      return null;
    }

    for (let i = 0; i < retries; i++) {
        try {
          const res = await fetch(`${config.HYPERLIQUID_API_URL}/info`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.status === 429) {
             const waitTime = delay * Math.pow(2, i);
             apiBudgetManager.markExchangeRateLimit("INFO_429", Math.max(waitTime, config.API_HARD_BACKOFF_MS));
             botState.apiBudget = apiBudgetManager.getSnapshot();
             botState.apiRateLimitUntil = Date.now() + Math.max(waitTime, config.API_HARD_BACKOFF_MS);
             console.log(`[RATE_LIMIT] 429 on infoRequest, backing off ${waitTime}ms...`);
             await new Promise(resolve => setTimeout(resolve, waitTime));
             continue;
          }
          if (!res.ok && res.status >= 500) {
              throw new Error(`Server error: ${res.status}`);
          }
          const data = await res.json();
          this.requestCache.set(cacheKey, { timestamp: now, data });
          return data;
        } catch (err: any) {
          if (i === retries - 1) {
             console.error("infoRequest failed after retries", err);
             return null;
          }
          if (err.message?.includes('ECONNRESET') || err.message?.includes('fetch failed')) {
              const waitTime = delay * Math.pow(2, i);
              await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
              // If it's another kind of error (like parsing error), just try again?
              const waitTime = delay * Math.pow(2, i);
              await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
    }
    return null;
  }

  async exchangeRequest(action: any, retries = 3, delay = 1000): Promise<any> {
    if (!this.wallet) {
      // Try initializing again in case it was set later (though config should be static usually)
      this.initializeWallet();
    }

    if (!this.wallet) {
      console.error("Exchange request attempted without a valid wallet/private key.");
      return { status: "error", response: "No valid private key provided. Check logs for wallet init errors." };
    }

    const lane = exchangeLaneForAction(action);
    const isCriticalProtection = lane === "protection" || lane === "tpsl";
    let batchLength = 1;
    if (action?.type === "order" && action.orders) batchLength = action.orders.length;
    if (action?.type === "cancel" && action.cancels) batchLength = action.cancels.length;

    const budget = apiBudgetManager.reserveExchange(lane, batchLength, isCriticalProtection);
    botState.apiBudget = apiBudgetManager.getSnapshot();
    if (!budget.allowed) {
      console.warn(`[EXECUTION_BUDGET_EXCEEDED] Exchange request suppressed. lane=${lane}, action=${action?.type || "unknown"}, reason=${budget.reason}`);
      if (lane === "execution") botState.blocker = "EXECUTION_LAYER_THROTTLED";
      return {
        status: "error",
        response: budget.reason,
        internalBudgetBlock: true,
        retryAfterMs: budget.retryAfterMs,
        lane,
        action: action?.type || "unknown"
      };
    }

    for (let i = 0; i < retries; i++) {
        try {
          const nonce = Date.now();
          const isMainnet = true; // Use mainnet config
          const signature = await signL1Action(this.wallet, action, null, nonce, isMainnet);

          const payload = {
            action,
            nonce,
            signature,
          };

          const orderCount = Array.isArray(action?.orders) ? action.orders.length : 0;
          const cancelCount = Array.isArray(action?.cancels) ? action.cancels.length : 0;
          if (i === 0) {
            console.log(`[CLIENT] Sending exchange request: action=${action?.type || "unknown"} lane=${lane} orders=${orderCount} cancels=${cancelCount}`);
          } else {
            console.log(`[CLIENT] Retrying exchange request attempt=${i + 1}: action=${action?.type || "unknown"} lane=${lane} orders=${orderCount} cancels=${cancelCount}`);
          }

          const res = await fetch(`${config.HYPERLIQUID_API_URL}/exchange`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (res.status === 429) {
             const waitTime = delay * Math.pow(2, i);
             apiBudgetManager.markExchangeRateLimit("EXCHANGE_429", Math.max(waitTime, config.API_HARD_BACKOFF_MS));
             botState.apiBudget = apiBudgetManager.getSnapshot();
             botState.apiRateLimitUntil = Date.now() + Math.max(waitTime, config.API_HARD_BACKOFF_MS);
             console.log(`[RATE_LIMIT] 429 on exchangeRequest, backing off ${waitTime}ms...`);
             await new Promise(resolve => setTimeout(resolve, waitTime));
             continue;
          }

          if (!res.ok && res.status >= 500) {
             throw new Error(`Server error: ${res.status}`);
          }

          const responseText = await res.text();
          let parsed;
          try {
            parsed = JSON.parse(responseText);
          } catch (err) {
            console.error("exchangeRequest returned non-JSON:", responseText, "Payload was:", JSON.stringify(payload));
            return { status: "error", response: responseText };
          }
          
          if (parsed && parsed.status === "err") {
             const strResp = JSON.stringify(parsed);
             if (strResp.toLowerCase().includes("address") && strResp.toLowerCase().includes("10s")) {
                 console.warn(`[ADDRESS_LIMIT_RECOVERY_ACTIVE] Hyperliquid address pacing response detected.`);
                 apiBudgetManager.enableAddressLimitRecovery();
                 botState.apiBudget = apiBudgetManager.getSnapshot();
                 return parsed;
             }
             if (strResp.includes("Too many cumulative requests sent")) {
                 console.error(`[API_RATE_LIMIT_GLOBAL] Hyperliquid cumulative request rate limit hit!`);
                 apiBudgetManager.markExchangeRateLimit("CUMULATIVE_REQUEST_LIMIT", config.API_HARD_BACKOFF_MS);
                 botState.apiBudget = apiBudgetManager.getSnapshot();
                 return parsed;
             }
          }
          
          return parsed;
        } catch (err: any) {
          if (i === retries - 1) {
            console.error("exchangeRequest failed after retries", err);
            return null;
          }
          const waitTime = delay * Math.pow(2, i);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    return null;
  }
}

export const hClient = new HyperliquidClient();
