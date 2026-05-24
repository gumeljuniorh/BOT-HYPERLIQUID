import "dotenv/config";

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  HYPERLIQUID_PRIVATE_KEY: process.env.HYPERLIQUID_PRIVATE_KEY || "",
  HYPERLIQUID_WALLET_ADDRESS: process.env.HYPERLIQUID_WALLET_ADDRESS || "0x2807Ea3275EF4f865DFea59e18eDBA5B812C0079",
  HYPERLIQUID_API_WALLET: process.env.HYPERLIQUID_API_WALLET || "0xdaae5d2bffa4b090db68950c1d5f3245cb786711",
  HYPERLIQUID_API_URL: process.env.HYPERLIQUID_API_URL && process.env.HYPERLIQUID_API_URL.startsWith('http') ? process.env.HYPERLIQUID_API_URL : "https://api.hyperliquid.xyz",
  HYPERLIQUID_WS_URL: process.env.HYPERLIQUID_WS_URL && process.env.HYPERLIQUID_WS_URL.startsWith('ws') ? process.env.HYPERLIQUID_WS_URL : "wss://api.hyperliquid.xyz/ws",
  DRY_RUN: false, // Force Live mode as requested
  PHASE_ONE_CONSERVATIVE: boolFromEnv("PHASE_ONE_CONSERVATIVE", true),
  API_BUDGET_ENABLED: boolFromEnv("API_BUDGET_ENABLED", true),
  REST_PRESSURE_DEGRADED_MODE: boolFromEnv("REST_PRESSURE_DEGRADED_MODE", true),
  API_BUDGET_WINDOW_MS: numFromEnv("API_BUDGET_WINDOW_MS", 60_000),
  API_MAX_REST_PER_MIN: numFromEnv("API_MAX_REST_PER_MIN", 70),
  API_SCANNER_REQUESTS_PER_MIN: numFromEnv("API_SCANNER_REQUESTS_PER_MIN", 18),
  API_EXECUTION_REQUESTS_PER_MIN: numFromEnv("API_EXECUTION_REQUESTS_PER_MIN", 12),
  API_PROTECTION_REQUESTS_PER_MIN: numFromEnv("API_PROTECTION_REQUESTS_PER_MIN", 10),
  API_TPSL_REQUESTS_PER_MIN: numFromEnv("API_TPSL_REQUESTS_PER_MIN", 8),
  API_METADATA_REQUESTS_PER_MIN: numFromEnv("API_METADATA_REQUESTS_PER_MIN", 4),
  API_ACCOUNT_REQUESTS_PER_MIN: numFromEnv("API_ACCOUNT_REQUESTS_PER_MIN", 16),
  API_DEGRADED_PRESSURE_RATIO: numFromEnv("API_DEGRADED_PRESSURE_RATIO", 0.72),
  API_HARD_BACKOFF_MS: numFromEnv("API_HARD_BACKOFF_MS", 60_000),
  SCAN_THROTTLE_MS: numFromEnv("SCAN_THROTTLE_MS", 5_000),
  EXECUTION_THROTTLE_MS: numFromEnv("EXECUTION_THROTTLE_MS", 3_000),
  SYMBOL_EXECUTION_COOLDOWN_MS: numFromEnv("SYMBOL_EXECUTION_COOLDOWN_MS", 20_000),
  MAX_TRADES_PER_HOUR: numFromEnv("MAX_TRADES_PER_HOUR", 8),
  DAILY_LOSS_LIMIT_PCT: numFromEnv("DAILY_LOSS_LIMIT_PCT", 3),
  BALANCE_RESERVE_PCT: numFromEnv("BALANCE_RESERVE_PCT", 30),
  MIN_ORDER_NOTIONAL_USD: numFromEnv("MIN_ORDER_NOTIONAL_USD", 11),
  MICRO_SCALP_MODE_ENABLED: boolFromEnv("MICRO_SCALP_MODE_ENABLED", false)
};
