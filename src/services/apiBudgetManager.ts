import { config } from "../config.js";

export type ApiBudgetLane = "scanner" | "execution" | "protection" | "tpsl" | "metadata" | "account";

export interface ApiBudgetDecision {
  allowed: boolean;
  lane: ApiBudgetLane;
  reason: string;
  degradedMode: boolean;
  retryAfterMs: number;
}

export interface ApiBudgetSnapshot {
  enabled: boolean;
  degradedMode: boolean;
  throttleReason: string;
  restWeightInWindow: number;
  restWeightLimit: number;
  exchangeActionsInWindow: number;
  exchangeActionsLimit: number; // dynamically estimated or fixed buffer
  addressLimitRecoveryActive: boolean;
  wsConnections: number;
  wsSubscriptions: number;
  executionRequestsPerMin: number;
  protectionRequestsPerMin: number;
  tpSlRequestsPerMin: number;
  scannerRequestsPerMin: number;
  accountRequestsPerMin: number;
  metadataRequestsPerMin: number;
  cacheHits: number;
  blockedRequests: number;
  lastUpdated: number;
}

interface BudgetEvent {
  lane: ApiBudgetLane;
  timestamp: number;
  endpoint: string;
  weight: number;
  type: "info" | "exchange";
}

export class ApiBudgetManager {
  private events: BudgetEvent[] = [];
  private cacheHits = 0;
  private blockedRequests = 0;
  private hardRateLimitUntil = 0;
  private lastThrottleReason = "NONE";
  
  // Tracking
  private wsConnections = 0;
  private wsSubscriptions = 0;
  
  // Address limit
  private addressLimitRecoveryActive = false;
  private lastAddressActionTime = 0;
  
  // Limits
  private readonly REST_WEIGHT_LIMIT = 1200;
  private readonly SAFE_REST_WEIGHT_TARGET = 800;
  private exchangeActionBudget = 10000;

  reserveInfo(lane: ApiBudgetLane, endpoint: string, isCritical = false): ApiBudgetDecision {
      let weight = 20; // default for most info requests
      if (["l2Book", "allMids", "clearinghouseState", "orderStatus", "spotClearinghouseState", "exchangeStatus"].includes(endpoint)) {
          weight = 2;
      } else if (endpoint === "userRole") {
          weight = 60;
      }
      return this.reserve(lane, endpoint, weight, "info", isCritical);
  }
  
  reserveExchange(lane: ApiBudgetLane, batchLength = 1, isCritical = false): ApiBudgetDecision {
      const weight = 1 + Math.floor(batchLength / 40);
      return this.reserve(lane, "exchange", weight, "exchange", isCritical);
  }

  private reserve(lane: ApiBudgetLane, endpoint: string, weight: number, type: "info" | "exchange", isCritical = false): ApiBudgetDecision {
    const now = Date.now();
    this.prune(now);

    if (now < this.hardRateLimitUntil) {
      this.blockedRequests++;
      const retryAfterMs = this.hardRateLimitUntil - now;
      this.lastThrottleReason = "EXCHANGE_RATE_LIMIT_BACKOFF";
      return this.decision(false, lane, "EXCHANGE_RATE_LIMIT_BACKOFF", retryAfterMs);
    }
    
    if (this.addressLimitRecoveryActive && type === "exchange") {
        if (now - this.lastAddressActionTime < 10000) {
            this.blockedRequests++;
            console.warn(`[ADDRESS_LIMIT_ONE_ACTION_PER_10S] Blocked action for ${lane}, must wait 10s between actions.`);
            return this.decision(false, lane, "ADDRESS_LIMIT_ONE_ACTION_PER_10S", 10000 - (now - this.lastAddressActionTime));
        }
    }

    const currentWeight = this.events.reduce((sum, e) => sum + e.weight, 0);
    const laneWeight = this.events.filter(e => e.lane === lane).reduce((sum, e) => sum + e.weight, 0);

    const isDegraded = currentWeight >= this.SAFE_REST_WEIGHT_TARGET;
    
    // Priorities
    // Critical (Emergency, TP/SL) always bypass degraded mode unless hitting hard limit 1200
    // lane protection/tpsl = high priority
    // lane scanner = lowest priority
    
    let isAllowed = true;
    let reason = "OK";
    
    if (currentWeight + weight >= this.REST_WEIGHT_LIMIT) {
        isAllowed = false;
        reason = "REST_WEIGHT_BUDGET_EXCEEDED";
    } else if (isDegraded && !isCritical) {
        if (lane === "scanner" || lane === "metadata" || lane === "execution") {
            isAllowed = false;
            reason = "REST_PRESSURE_DEGRADED_MODE";
        }
    }
    
    if (!isAllowed) {
        this.blockedRequests++;
        console.warn(`[HL_API_BUDGET_CHECK] Blocked ${type} ${endpoint} (Lane: ${lane}). Weight: ${weight}. Total Weight: ${currentWeight}/${this.REST_WEIGHT_LIMIT}. Reason: ${reason}`);
        if (lane === "scanner" && isDegraded) {
             console.warn(`[FULL_UNIVERSE_REST_SCAN_BLOCKED] Scanner REST requests blocked due to budget pressure.`);
        }
        if (type === "info" && isDegraded && (lane === "metadata" || lane === "account" || lane === "scanner")) {
             console.warn(`[WSS_FALLBACK_ACTIVE] Falling back to WebSockets for ${lane} state due to REST limits.`);
        }
        if (lane === "execution" && type === "exchange") {
             console.warn(`[ORDER_RETRY_SUPPRESSED_BUDGET] Suppressing execution retry loops due to budget limits.`);
        }

        if (type === "exchange") {
             console.warn(`[HL_EXCHANGE_ACTION_DEFERRED] Deferred exchange action for ${lane}`);
        } else {
             console.warn(`[HL_REST_BUDGET_DEFERRED] Deferred REST action for ${lane}`);
        }
        return this.decision(false, lane, reason, 1000);
    }

    if (currentWeight < this.REST_WEIGHT_LIMIT && this.lastThrottleReason.includes("REST_WEIGHT_BUDGET_EXCEEDED")) {
        console.log(`[HL_API_BUDGET_RECOVERED] API budget normalized.`);
        this.lastThrottleReason = "NONE";
    }

    this.record(lane, endpoint, weight, type, now);
    if (type === "exchange") {
        this.lastAddressActionTime = now;
        this.exchangeActionBudget--;
    }
    
    // Minimal log so we aren't totally blind, but avoiding spam.
    // The user requested HL_REST_WEIGHT_SPENT log.
    if (type === "info") {
         console.log(`[HL_REST_WEIGHT_SPENT] Used ${weight} weight. Total now: ${currentWeight + weight}`);
    }
    
    const decisionReason = isDegraded ? "REST_PRESSURE_DEGRADED_MODE" : "OK";
    if (isDegraded && this.lastThrottleReason !== "REST_PRESSURE_DEGRADED_MODE") {
         this.lastThrottleReason = "REST_PRESSURE_DEGRADED_MODE";
    }
    
    return this.decision(true, lane, decisionReason, 0);
  }

  markExchangeRateLimit(reason: string, backoffMs = 60000) {
    this.hardRateLimitUntil = Math.max(this.hardRateLimitUntil, Date.now() + backoffMs);
    this.lastThrottleReason = reason || "EXCHANGE_RATE_LIMIT_BACKOFF";
    console.warn(`[API_RATE_LIMIT_GLOBAL] Exchange rate limit marked. Backoff=${Math.round(backoffMs / 1000)}s. Reason=${this.lastThrottleReason}`);
    if (reason && (reason.includes("CUMULATIVE") || reason.includes("Address based"))) {
        this.enableAddressLimitRecovery();
    }
  }
  
  enableAddressLimitRecovery() {
      if (!this.addressLimitRecoveryActive) {
          this.addressLimitRecoveryActive = true;
          console.warn(`[ADDRESS_LIMIT_RECOVERY_ACTIVE] Entering strict 1 exchange action per 10s mode.`);
      }
  }

  noteCacheHit(lane: ApiBudgetLane, endpoint: string) {
    this.cacheHits++;
  }
  
  // WSS Tracking dummy integrations
  reportWsConnections(count: number) { this.wsConnections = count; }
  reportWsSubscriptions(count: number) { this.wsSubscriptions = count; }

  getSnapshot(): ApiBudgetSnapshot {
    const now = Date.now();
    this.prune(now);
    const currentWeight = this.events.reduce((sum, e) => sum + e.weight, 0);
    const degradedMode = currentWeight >= this.SAFE_REST_WEIGHT_TARGET || now < this.hardRateLimitUntil || this.addressLimitRecoveryActive;
    
    return {
      enabled: config.API_BUDGET_ENABLED,
      degradedMode,
      throttleReason: degradedMode ? (this.addressLimitRecoveryActive ? "ADDRESS_LIMIT_RECOVERY" : this.lastThrottleReason) : "NONE",
      restWeightInWindow: currentWeight,
      restWeightLimit: this.REST_WEIGHT_LIMIT,
      exchangeActionsInWindow: this.events.filter(e => e.type === "exchange").length,
      exchangeActionsLimit: this.exchangeActionBudget,
      addressLimitRecoveryActive: this.addressLimitRecoveryActive,
      wsConnections: this.wsConnections,
      wsSubscriptions: this.wsSubscriptions,
      executionRequestsPerMin: this.countLane("execution"),
      protectionRequestsPerMin: this.countLane("protection"),
      tpSlRequestsPerMin: this.countLane("tpsl"),
      scannerRequestsPerMin: this.countLane("scanner"),
      accountRequestsPerMin: this.countLane("account"),
      metadataRequestsPerMin: this.countLane("metadata"),
      cacheHits: this.cacheHits,
      blockedRequests: this.blockedRequests,
      lastUpdated: now
    };
  }

  private decision(allowed: boolean, lane: ApiBudgetLane, reason: string, retryAfterMs: number): ApiBudgetDecision {
    return {
      allowed,
      lane,
      reason,
      degradedMode: this.getSnapshot().degradedMode,
      retryAfterMs
    };
  }

  private record(lane: ApiBudgetLane, endpoint: string, weight: number, type: "info"| "exchange", timestamp: number) {
    this.events.push({ lane, endpoint, weight, type, timestamp });
  }

  private prune(now: number) {
    const windowStart = now - 60000;
    this.events = this.events.filter((event) => event.timestamp >= windowStart);
  }

  private countLane(lane: ApiBudgetLane) {
    return this.events.filter((event) => event.lane === lane).length;
  }
}

export const apiBudgetManager = new ApiBudgetManager();

