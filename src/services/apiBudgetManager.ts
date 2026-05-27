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
  addressActionRetryAfterMs: number;
  nextAddressActionAllowedAt: number;
  lastAddressActionAt: number;
  addressActionLaneStatus: "WAITING" | "READY";
  addressActionReason: string;
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
  private lastAddressPacingLogTime = 0;
  private lastAddressSpamSuppressedLogTime = 0;
  
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
        const retryAfterMs = this.getAddressActionRetryAfterMs();
        if (retryAfterMs > 0) {
            if (isCritical) {
                console.warn(`[ADDRESS_LIMIT_CRITICAL_PROTECTION_ALLOWED] Allowing critical ${lane} exchange action despite address pacing window.`);
            } else {
                this.blockedRequests++;
                this.lastThrottleReason = "ADDRESS_ACTION_PACING_ACTIVE";
                this.logAddressPacingActive(now, retryAfterMs);
                if (now - this.lastAddressSpamSuppressedLogTime > 5000) {
                    console.warn(`[ADDRESS_PACING_SYMBOL_SPAM_SUPPRESSED] Suppressed per-symbol rejection spam; ${lane} exchange mutation is queued behind the global address lane.`);
                    this.lastAddressSpamSuppressedLogTime = now;
                }
                console.warn(`[ADDRESS_LIMIT_ONE_ACTION_PER_10S] Exchange mutation deferred for ${lane}; next action allowed in ${Math.ceil(retryAfterMs / 1000)}s.`);
                return this.decision(false, lane, "ADDRESS_ACTION_WAITING_FOR_NEXT_SLOT", retryAfterMs);
            }
        } else if (now - this.lastAddressPacingLogTime > 2000) {
            console.log(`[ADDRESS_PACING_NEXT_ACTION_READY] Global address action lane is ready for one exchange mutation.`);
            this.lastAddressPacingLogTime = now;
        }
    }

    const currentWeight = this.events.reduce((sum, e) => sum + e.weight, 0);
    const laneWeight = this.events.filter(e => e.lane === lane).reduce((sum, e) => sum + e.weight, 0);
    const laneEvents = this.events.filter(e => e.lane === lane && e.type === type).length;

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
        const isTopExecutionAction = lane === "execution" && type === "exchange";
        const executionLaneHasRoom = laneEvents < Math.max(1, config.API_EXECUTION_REQUESTS_PER_MIN);

        if (isTopExecutionAction && executionLaneHasRoom) {
            console.log(`[TOP_CANDIDATE_ACTION_RESERVED] Reserved one exchange action for the best execution candidate under REST pressure.`);
            console.log(`[TOP_CMC_CANDIDATE_BUDGET_RESERVED] Reserved degraded-mode exchange action for top execution candidate. lane=${lane}, weight=${weight}, totalWeight=${currentWeight}/${this.REST_WEIGHT_LIMIT}`);
            console.log(`[REST_DEGRADED_TOP_CANDIDATE_ALLOWED] Execution exchange action allowed while background REST is degraded.`);
            console.log(`[API_BUDGET_OVERBLOCK_PREVENTED] Degraded REST pressure converted to candidate-only pacing instead of a global freeze.`);
        } else if (lane === "scanner" || lane === "metadata" || lane === "execution") {
            isAllowed = false;
            reason = "REST_PRESSURE_DEGRADED_MODE";
        }
    }
    
    if (!isAllowed) {
        this.blockedRequests++;
        console.warn(`[HL_API_BUDGET_CHECK] Blocked ${type} ${endpoint} (Lane: ${lane}). Weight: ${weight}. Total Weight: ${currentWeight}/${this.REST_WEIGHT_LIMIT}. Reason: ${reason}`);
        if (lane === "scanner" && isDegraded) {
             console.warn(`[FULL_UNIVERSE_REST_SCAN_BLOCKED] Scanner REST requests blocked due to budget pressure.`);
             console.warn(`[BACKGROUND_SCAN_DEFERRED_FOR_TRADE_BUDGET] Background scanner REST deferred so exchange/protection budget remains available.`);
             console.warn(`[BACKGROUND_REQUESTS_DEFERRED_FOR_EXECUTION] Scanner request deferred before consuming top-candidate execution action budget.`);
        }
        if (type === "info" && isDegraded && (lane === "metadata" || lane === "account" || lane === "scanner")) {
             console.warn(`[WSS_FALLBACK_ACTIVE] Falling back to WebSockets for ${lane} state due to REST limits.`);
             console.warn(`[BACKGROUND_SCAN_DEFERRED_FOR_TRADE_BUDGET] Noncritical ${lane} info call deferred during REST pressure.`);
             console.warn(`[BACKGROUND_REQUESTS_DEFERRED_FOR_EXECUTION] ${lane} request deferred to preserve execution budget.`);
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
        if (this.addressLimitRecoveryActive) {
            console.log(`[ADDRESS_PACING_ACTION_SENT] lane=${lane}, endpoint=${endpoint}, nextAllowedAt=${new Date(this.lastAddressActionTime + 10000).toISOString()}`);
        }
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
          console.warn(`[ADDRESS_PACING_GLOBAL_STATE_ACTIVE] Hyperliquid address pacing active; exchange mutations will use one global 10s action lane.`);
      }
  }

  isAddressLimitRecoveryActive(): boolean {
      return this.addressLimitRecoveryActive;
  }

  getAddressActionRetryAfterMs(): number {
      if (!this.addressLimitRecoveryActive) return 0;
      return Math.max(0, 10000 - (Date.now() - this.lastAddressActionTime));
  }

  getAddressActionNextAllowedAt(): number {
      if (!this.addressLimitRecoveryActive) return 0;
      if (!this.lastAddressActionTime) return Date.now();
      return this.lastAddressActionTime + 10000;
  }

  getLastAddressActionAt(): number {
      return this.lastAddressActionTime;
  }

  private logAddressPacingActive(now: number, retryAfterMs: number) {
      if (now - this.lastAddressPacingLogTime < 5000) return;
      console.warn(`[ADDRESS_PACING_GLOBAL_STATE_ACTIVE] Address action lane waiting ${Math.ceil(retryAfterMs / 1000)}s before next exchange mutation.`);
      this.lastAddressPacingLogTime = now;
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
    const addressActionRetryAfterMs = this.getAddressActionRetryAfterMs();
    
    return {
      enabled: config.API_BUDGET_ENABLED,
      degradedMode,
      throttleReason: degradedMode ? (this.addressLimitRecoveryActive ? "ADDRESS_LIMIT_RECOVERY" : this.lastThrottleReason) : "NONE",
      restWeightInWindow: currentWeight,
      restWeightLimit: this.REST_WEIGHT_LIMIT,
      exchangeActionsInWindow: this.events.filter(e => e.type === "exchange").length,
      exchangeActionsLimit: this.exchangeActionBudget,
      addressLimitRecoveryActive: this.addressLimitRecoveryActive,
      addressActionRetryAfterMs,
      nextAddressActionAllowedAt: this.getAddressActionNextAllowedAt(),
      lastAddressActionAt: this.lastAddressActionTime,
      addressActionLaneStatus: this.addressLimitRecoveryActive && addressActionRetryAfterMs > 0 ? "WAITING" : "READY",
      addressActionReason: this.addressLimitRecoveryActive ? "one action per 10 seconds" : "NONE",
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
