import "dotenv/config";

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  HYPERLIQUID_PRIVATE_KEY: process.env.HYPERLIQUID_PRIVATE_KEY || "",
  HYPERLIQUID_WALLET_ADDRESS: process.env.HYPERLIQUID_WALLET_ADDRESS || "0x2807Ea3275EF4f865DFea59e18eDBA5B812C0079",
  HYPERLIQUID_API_WALLET: process.env.HYPERLIQUID_API_WALLET || "0xdaae5d2bffa4b090db68950c1d5f3245cb786711",
  HYPERLIQUID_API_URL: process.env.HYPERLIQUID_API_URL && process.env.HYPERLIQUID_API_URL.startsWith('http') ? process.env.HYPERLIQUID_API_URL : "https://api.hyperliquid.xyz",
  HYPERLIQUID_WS_URL: process.env.HYPERLIQUID_WS_URL && process.env.HYPERLIQUID_WS_URL.startsWith('ws') ? process.env.HYPERLIQUID_WS_URL : "wss://api.hyperliquid.xyz/ws",
  DRY_RUN: boolEnv("DRY_RUN", true),
  MIN_SIGNAL_CONFIDENCE: numberEnv("MIN_SIGNAL_CONFIDENCE", 70),
  MIN_TRADE_QUALITY_SCORE: numberEnv("MIN_TRADE_QUALITY_SCORE", 55),
  MIN_EXPECTED_MOVE_PCT: numberEnv("MIN_EXPECTED_MOVE_PCT", 0.45),
  MAX_FEE_TO_EXPECTED_REWARD_RATIO: numberEnv("MAX_FEE_TO_EXPECTED_REWARD_RATIO", 0.45),
  MAX_OPEN_POSITIONS: numberEnv("MAX_OPEN_POSITIONS", 3),
};
