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

    const now = Date.now();
    const dailyLossLimit = botState.accountEquity * ((botState.config.dailyLossLimitPct ?? config.DAILY_LOSS_LIMIT_PCT) / 100);
    const realizedNet = botState.analytics?.netProfitability || botState.realizedPnl || 0;
    if (dailyLossLimit > 0 && realizedNet <= -dailyLossLimit) {
      botState.blocker = "DAILY_LOSS_LIMIT_REACHED";
      console.warn(`[PHASE_1_SAFETY_CONFIG] Daily loss limit enforced. realized=${realizedNet.toFixed(2)}, limit=-${dailyLossLimit.toFixed(2)}.`);
      return false;
    }

    const entriesLastHour = (botState.trades || []).filter((trade) => trade.type === "ENTRY" && now - trade.timestamp < 60 * 60 * 1000).length;
    if (entriesLastHour >= config.MAX_TRADES_PER_HOUR) {
      botState.blocker = "OVERTRADING_PROTECTION_ACTIVE";
      console.warn(`[PHASE_1_SAFETY_CONFIG] Overtrading protection active. entriesLastHour=${entriesLastHour}, max=${config.MAX_TRADES_PER_HOUR}.`);
      return false;
    }

    const reservePct = botState.config.balanceReservePct ?? config.BALANCE_RESERVE_PCT;
    if ((botState.freeCollateralPct || 100) < reservePct) {
      botState.blocker = "BALANCE_RESERVE_REQUIRED";
      console.warn(`[PHASE_1_SAFETY_CONFIG] Balance reserve enforced. freeCollateral=${(botState.freeCollateralPct || 0).toFixed(1)}%, reserve=${reservePct}%.`);
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
