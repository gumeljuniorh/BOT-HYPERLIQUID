import "dotenv/config";

export const config = {
  HYPERLIQUID_PRIVATE_KEY: process.env.HYPERLIQUID_PRIVATE_KEY || "",
  HYPERLIQUID_WALLET_ADDRESS: process.env.HYPERLIQUID_WALLET_ADDRESS || "0x2807Ea3275EF4f865DFea59e18eDBA5B812C0079",
  HYPERLIQUID_API_WALLET: process.env.HYPERLIQUID_API_WALLET || "0xdaae5d2bffa4b090db68950c1d5f3245cb786711",
  HYPERLIQUID_API_URL: process.env.HYPERLIQUID_API_URL && process.env.HYPERLIQUID_API_URL.startsWith('http') ? process.env.HYPERLIQUID_API_URL : "https://api.hyperliquid.xyz",
  HYPERLIQUID_WS_URL: process.env.HYPERLIQUID_WS_URL && process.env.HYPERLIQUID_WS_URL.startsWith('ws') ? process.env.HYPERLIQUID_WS_URL : "wss://api.hyperliquid.xyz/ws",
  DRY_RUN: false, // Force Live mode as requested
};
