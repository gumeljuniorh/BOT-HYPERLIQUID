import { botState } from "./state.js";
import { config } from "./config.js";
import { hClient } from "./hyperliquidClient.js";

export class HyperliquidRiskManager {
  checkRisk(): boolean {
    if (!config.HYPERLIQUID_PRIVATE_KEY) {
      botState.blocker = "PRIVATE_KEY_MISSING. PLEASE ADD IT IN THE SETTINGS.";
      return false;
    }
    
    // Check if it's an address instead of PK
    const pk = config.HYPERLIQUID_PRIVATE_KEY.trim();
    const pkClean = pk.startsWith("0x") ? pk : "0x" + pk;
    if (pkClean.length === 42) {
      botState.blocker = "INVALID_PRIVATE_KEY: YOU PROVIDED A WALLET ADDRESS (42 chars) INSTEAD OF A PRIVATE KEY.";
      return false;
    }

    if (botState.accountEquity === 0) {
      if (!botState.blocker) botState.blocker = "ACCOUNT_UNFUNDED";
      return false;
    }
    
    // Check if user provided main wallet PK instead of API wallet PK
    if (hClient.walletAddress && hClient.walletAddress.toLowerCase() === config.HYPERLIQUID_WALLET_ADDRESS.toLowerCase()) {
      botState.blocker = "YOU PROVIDED YOUR MAIN WALLET PRIVATE KEY. HYPERLIQUID REQUIRES AN API WALLET PRIVATE KEY FOR AUTOMATION. PLEASE CREATE ONE IN HYPERLIQUID SETTINGS.";
      return false;
    }
    if (!botState.wssConnected || !botState.apiConnected) {
      botState.blocker = "API_OR_WSS_DISCONNECTED";
      return false;
    }

    if (botState.phase === "PHASE_0_STABILIZATION") {
      if (botState.activeSymbol !== "SOL") {
        botState.blocker = "PHASE_0: SOL ONLY";
        return false;
      }
      // max open positions 1
      if (botState.openPositions > 1) {
        botState.blocker = "PHASE_0: MAX 1 POSITION";
        return false;
      }
      
      // Leverage check (can be checked during order placement too)
      // Here we check if current position leverage exceeds configured limit
      const maxAllowedLeverage = 1;
      if (botState.positionDetails) {
        const leverage = parseFloat(botState.positionDetails.leverage.value || "0");
        if (leverage > maxAllowedLeverage) {
          // Warning or restriction
        }
      }
    }

    return true;
  }
}

export const riskManager = new HyperliquidRiskManager();
