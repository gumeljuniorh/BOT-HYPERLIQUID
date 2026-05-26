import { config } from "../config.js";
import { botState, getAssetMeta } from "../state.js";

export interface OrderValidationInput {
  symbol: string;
  isBuy: boolean;
  size: number;
  price: number;
  reduceOnly: boolean;
}

export interface OrderValidationResult {
  allowed: boolean;
  reason: string;
  roundedSize: number;
  roundedPrice: number;
  minNotional: number;
  finalNotional: number;
}

export class ExecutionValidationGuard {
  private lastAttemptBySymbol = new Map<string, number>();
  private rejectionCooldownBySymbol = new Map<string, number>();

  validateOrderIntent(input: OrderValidationInput): OrderValidationResult {
    const now = Date.now();
    const meta = getAssetMeta(input.symbol);
    const minNotional = this.getMinNotional(input.symbol, input.price);

    const baseResult = (allowed: boolean, reason: string, roundedSize = input.size, roundedPrice = input.price): OrderValidationResult => ({
      allowed,
      reason,
      roundedSize,
      roundedPrice,
      minNotional,
      finalNotional: Math.abs(roundedSize * roundedPrice)
    });

    if (!input.symbol || !meta) {
      this.cooldown(input.symbol || "UNKNOWN", now);
      return baseResult(false, "ORDER_VALIDATION_REJECTED_TRADABLE_METADATA_MISSING");
    }

    if (!Number.isFinite(input.price) || input.price <= 0) {
      this.cooldown(input.symbol, now);
      return baseResult(false, "ORDER_VALIDATION_REJECTED_INVALID_PRICE");
    }

    if (!Number.isFinite(input.size) || input.size <= 0) {
      this.cooldown(input.symbol, now);
      return baseResult(false, "ORDER_VALIDATION_REJECTED_INVALID_SIZE");
    }

    const rejectionCooldownUntil = this.rejectionCooldownBySymbol.get(input.symbol) || 0;
    if (!input.reduceOnly && rejectionCooldownUntil > now) {
      return baseResult(false, "SYMBOL_EXECUTION_COOLDOWN_ACTIVE");
    }

    const attemptKey = `${input.symbol}:${input.isBuy ? "BUY" : "SELL"}`;
    const lastAttempt = this.lastAttemptBySymbol.get(attemptKey) || 0;
    if (!input.reduceOnly && now - lastAttempt < config.EXECUTION_THROTTLE_MS) {
      return baseResult(false, "EXECUTION_VALIDATION_DEBOUNCED");
    }

    const szDecimals = typeof meta.szDecimals === "number" ? meta.szDecimals : 3;
    const sizeMultiplier = Math.pow(10, szDecimals);
    let roundedSize = Math.floor(Math.abs(input.size) * sizeMultiplier + 1e-7) / sizeMultiplier;
    const roundedPrice = input.price;
    let finalNotional = roundedSize * roundedPrice;

    if (!Number.isFinite(roundedSize) || roundedSize <= 0) {
      this.cooldown(input.symbol, now);
      return baseResult(false, "ORDER_VALIDATION_REJECTED_SIZE_ROUNDED_TO_ZERO", roundedSize, roundedPrice);
    }

    if (!input.reduceOnly && finalNotional < minNotional) {
      const minRequiredSize = Math.ceil((minNotional / roundedPrice) * sizeMultiplier) / sizeMultiplier;
      console.log(`[EXECUTION_VALIDATION_UPGRADE] Target notional $${finalNotional.toFixed(2)} is below minimum $${minNotional.toFixed(2)}. Adjusting size from ${roundedSize} to ${minRequiredSize} to clear validation.`);
      roundedSize = minRequiredSize;
      finalNotional = roundedSize * roundedPrice;
    }

    if (!input.reduceOnly) {
      this.lastAttemptBySymbol.set(attemptKey, now);
    }
    console.log(`[ORDER_VALIDATION_PASSED] ${input.symbol} ${input.isBuy ? "BUY" : "SELL"} size=${roundedSize} price=${roundedPrice} notional=$${finalNotional.toFixed(2)} min=$${minNotional.toFixed(2)} reduceOnly=${input.reduceOnly}`);
    return baseResult(true, "ORDER_VALIDATION_PASSED", roundedSize, roundedPrice);
  }

  private getMinNotional(symbol: string, price: number): number {
    const meta = getAssetMeta(symbol);
    const metaMinSz = typeof meta?.minSz === "number" ? meta.minSz : 0;
    const minFromSize = metaMinSz > 0 && Number.isFinite(price) ? metaMinSz * price : 0;
    return Math.max(config.MIN_ORDER_NOTIONAL_USD, minFromSize);
  }

  private cooldown(symbol: string, now: number) {
    if (!symbol) return;
    this.rejectionCooldownBySymbol.set(symbol, now + config.SYMBOL_EXECUTION_COOLDOWN_MS);
  }
}

export const executionValidationGuard = new ExecutionValidationGuard();
