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
  restRequestsInWindow: number;
  restBudgetLimit: number;
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
}

export class ApiBudgetManager {
  private events: BudgetEvent[] = [];
  private cacheHits = 0;
  private blockedRequests = 0;
  private hardRateLimitUntil = 0;
  private lastThrottleReason = "NONE";

  reserve(lane: ApiBudgetLane, endpoint: string, isCritical = false): ApiBudgetDecision {
    const now = Date.now();
    this.prune(now);

    if (!config.API_BUDGET_ENABLED) {
      this.record(lane, endpoint, now);
      return this.decision(true, lane, "DISABLED", 0);
    }

    if (now < this.hardRateLimitUntil) {
      this.blockedRequests++;
      const retryAfterMs = this.hardRateLimitUntil - now;
      this.lastThrottleReason = "EXCHANGE_RATE_LIMIT_BACKOFF";
      console.warn(`[REST_PRESSURE_DEGRADED_MODE] API budget is in exchange backoff for ${Math.ceil(retryAfterMs / 1000)}s. Lane=${lane}, endpoint=${endpoint}`);
      return this.decision(false, lane, "EXCHANGE_RATE_LIMIT_BACKOFF", retryAfterMs);
    }

    const laneCount = this.countLane(lane);
    const totalCount = this.events.length;
    const laneLimit = this.getLaneLimit(lane);
    const pressureRatio = config.API_MAX_REST_PER_MIN > 0 ? totalCount / config.API_MAX_REST_PER_MIN : 0;
    const lanePressureRatio = laneLimit > 0 ? laneCount / laneLimit : 0;

    const degraded = pressureRatio >= config.API_DEGRADED_PRESSURE_RATIO || lanePressureRatio >= config.API_DEGRADED_PRESSURE_RATIO;
    if (degraded && !isCritical && (lane === "execution" || lane === "scanner")) {
      const debounceMs = lane === "execution" ? config.EXECUTION_THROTTLE_MS : config.SCAN_THROTTLE_MS;
      const lastSameLane = [...this.events].reverse().find((event) => event.lane === lane);
      if (lastSameLane && now - lastSameLane.timestamp < debounceMs) {
        this.blockedRequests++;
        this.lastThrottleReason = `${lane.toUpperCase()}_DEBOUNCED_UNDER_REST_PRESSURE`;
        console.warn(`[EXECUTION_LAYER_THROTTLED] ${lane} request debounced for ${endpoint}. REST pressure=${totalCount}/${config.API_MAX_REST_PER_MIN}, lane=${laneCount}/${laneLimit}.`);
        return this.decision(false, lane, this.lastThrottleReason, Math.max(250, debounceMs - (now - lastSameLane.timestamp)));
      }
    }

    if (totalCount >= config.API_MAX_REST_PER_MIN || laneCount >= laneLimit) {
      this.blockedRequests++;
      this.lastThrottleReason = lane === "execution" ? "EXECUTION_BUDGET_EXCEEDED" : `${lane.toUpperCase()}_BUDGET_EXCEEDED`;
      console.warn(`[${this.lastThrottleReason}] REST request blocked. lane=${lane}, endpoint=${endpoint}, total=${totalCount}/${config.API_MAX_REST_PER_MIN}, lane=${laneCount}/${laneLimit}`);
      return this.decision(false, lane, this.lastThrottleReason, 1000);
    }

    this.record(lane, endpoint, now);
    if (degraded) {
      this.lastThrottleReason = "REST_PRESSURE_DEGRADED_MODE";
      console.warn(`[REST_PRESSURE_DEGRADED_MODE] Request allowed with reduced refresh depth. lane=${lane}, endpoint=${endpoint}, total=${totalCount + 1}/${config.API_MAX_REST_PER_MIN}`);
    }
    return this.decision(true, lane, degraded ? "REST_PRESSURE_DEGRADED_MODE" : "OK", 0);
  }

  markExchangeRateLimit(reason: string, backoffMs = config.API_HARD_BACKOFF_MS) {
    this.hardRateLimitUntil = Math.max(this.hardRateLimitUntil, Date.now() + backoffMs);
    this.lastThrottleReason = reason || "EXCHANGE_RATE_LIMIT_BACKOFF";
    console.warn(`[API_RATE_LIMIT_GLOBAL] Exchange rate limit marked. Backoff=${Math.round(backoffMs / 1000)}s. Reason=${this.lastThrottleReason}`);
  }

  noteCacheHit(lane: ApiBudgetLane, endpoint: string) {
    this.cacheHits++;
    if (lane === "execution" || lane === "protection" || lane === "tpsl") {
      console.log(`[EXECUTION_VALIDATION_CACHED] ${lane} ${endpoint} served from short cache.`);
    }
  }

  getSnapshot(): ApiBudgetSnapshot {
    const now = Date.now();
    this.prune(now);
    const degradedMode = this.events.length >= config.API_MAX_REST_PER_MIN * config.API_DEGRADED_PRESSURE_RATIO || now < this.hardRateLimitUntil;
    return {
      enabled: config.API_BUDGET_ENABLED,
      degradedMode,
      throttleReason: degradedMode ? this.lastThrottleReason : "NONE",
      restRequestsInWindow: this.events.length,
      restBudgetLimit: config.API_MAX_REST_PER_MIN,
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

  private record(lane: ApiBudgetLane, endpoint: string, timestamp: number) {
    this.events.push({ lane, endpoint, timestamp });
  }

  private prune(now: number) {
    const windowStart = now - config.API_BUDGET_WINDOW_MS;
    this.events = this.events.filter((event) => event.timestamp >= windowStart);
  }

  private countLane(lane: ApiBudgetLane) {
    return this.events.filter((event) => event.lane === lane).length;
  }

  private getLaneLimit(lane: ApiBudgetLane) {
    switch (lane) {
      case "execution":
        return config.API_EXECUTION_REQUESTS_PER_MIN;
      case "protection":
        return config.API_PROTECTION_REQUESTS_PER_MIN;
      case "tpsl":
        return config.API_TPSL_REQUESTS_PER_MIN;
      case "metadata":
        return config.API_METADATA_REQUESTS_PER_MIN;
      case "account":
        return config.API_ACCOUNT_REQUESTS_PER_MIN;
      case "scanner":
      default:
        return config.API_SCANNER_REQUESTS_PER_MIN;
    }
  }
}

export const apiBudgetManager = new ApiBudgetManager();
