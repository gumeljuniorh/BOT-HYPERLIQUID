import { botState } from "./state.js";
import { config } from "./config.js";
import { hClient } from "./hyperliquidClient.js";

export class HyperliquidRiskManager {
  checkRisk(symbol: string = botState.activeSymbol): boolean {
    if (!config.HYPERLIQUID_PRIVATE_KEY) {
      if (config.DRY_RUN) {
        console.warn(`[DRY_RUN_RISK_CHECK] symbol=${symbol}, private key missing but dry-run mode allows simulated execution only.`);
        return true;
      }
      botState.blocker = "PRIVATE_KEY_MISSING. PLEASE ADD IT IN THE SETTINGS.";
      console.warn(`[ENTRY_BLOCKED] symbol=${symbol}, reason=EXECUTION_VALIDATION, detail=PRIVATE_KEY_MISSING`);
      return false;
    }
    
    // Check if it's an address instead of PK
    const pk = config.HYPERLIQUID_PRIVATE_KEY.trim();
    const pkClean = pk.startsWith("0x") ? pk : "0x" + pk;
    if (pkClean.length === 42) {
      botState.blocker = "INVALID_PRIVATE_KEY: YOU PROVIDED A WALLET ADDRESS (42 chars) INSTEAD OF A PRIVATE KEY.";
      console.warn(`[ENTRY_BLOCKED] symbol=${symbol}, reason=EXECUTION_VALIDATION, detail=INVALID_PRIVATE_KEY_ADDRESS_PROVIDED`);
      return false;
    }

    if (botState.accountEquity === 0) {
      if (!botState.blocker) botState.blocker = "ACCOUNT_UNFUNDED";
      console.warn(`[ENTRY_BLOCKED] symbol=${symbol}, reason=BALANCE_RESERVE, detail=ACCOUNT_UNFUNDED`);
      return false;
    }
    
    // Check if user provided main wallet PK instead of API wallet PK
    if (hClient.walletAddress && hClient.walletAddress.toLowerCase() === config.HYPERLIQUID_WALLET_ADDRESS.toLowerCase()) {
      botState.blocker = "YOU PROVIDED YOUR MAIN WALLET PRIVATE KEY. HYPERLIQUID REQUIRES AN API WALLET PRIVATE KEY FOR AUTOMATION. PLEASE CREATE ONE IN HYPERLIQUID SETTINGS.";
      console.warn(`[ENTRY_BLOCKED] symbol=${symbol}, reason=EXECUTION_VALIDATION, detail=MAIN_WALLET_KEY_REJECTED`);
      return false;
    }
    if (!botState.wssConnected || !botState.apiConnected) {
      botState.blocker = "API_OR_WSS_DISCONNECTED";
      console.warn(`[ENTRY_BLOCKED] symbol=${symbol}, reason=API_BUDGET, detail=API_OR_WSS_DISCONNECTED`);
      return false;
    }

    const now = Date.now();
    const dailyLossLimit = botState.accountEquity * ((botState.config.dailyLossLimitPct ?? config.DAILY_LOSS_LIMIT_PCT) / 100);
    
    // Use true equity difference if available, separating mock and live
    let currentDailyLoss = 0;
    if (!config.DRY_RUN && botState.dailyNetEquityChange !== undefined) {
      currentDailyLoss = botState.dailyNetEquityChange;
      if (Math.random() < 0.05) {
         console.log("[LIVE_PNL_ACCOUNTING_ACTIVE] Live exchange equity used for daily loss tracking.");
         console.log("[MOCK_PNL_EXCLUDED_FROM_LIVE_RISK] Mock trades strictly bypassed.");
      }
    } else {
      currentDailyLoss = botState.analytics?.netProfitability || botState.realizedPnl || 0;
    }

    const currentDateString = new Date().toISOString().split('T')[0];
    if (botState.dailyLossBypassDate === currentDateString) {
      if (Math.random() < 0.05) {
        console.log(`[DAILY_LOSS_BYPASSED] User explicitly bypassed daily loss limit for today: ${currentDateString}`);
      }
    } else if (dailyLossLimit > 0 && currentDailyLoss <= -dailyLossLimit) {
      botState.blocker = "DAILY_LOSS_LIMIT_REACHED";
      console.warn(`[PHASE_1_SAFETY_CONFIG] Daily loss limit enforced. NetEqChange/Realized=${currentDailyLoss.toFixed(2)}, limit=-${dailyLossLimit.toFixed(2)}.`);
      console.warn(`[ENTRY_BLOCKED] symbol=${symbol}, reason=DAILY_LOSS_LIMIT, realized=${currentDailyLoss.toFixed(2)}, limit=-${dailyLossLimit.toFixed(2)}`);
      return false;
    }

    // Overtrading protection removed per user request
    const reservePct = botState.config.balanceReservePct ?? config.BALANCE_RESERVE_PCT;
    if ((botState.freeCollateralPct || 100) < reservePct) {
      botState.blocker = "BALANCE_RESERVE_REQUIRED";
      console.warn(`[PHASE_1_SAFETY_CONFIG] Balance reserve enforced. freeCollateral=${(botState.freeCollateralPct || 0).toFixed(1)}%, reserve=${reservePct}%.`);
      console.warn(`[ENTRY_BLOCKED] symbol=${symbol}, reason=BALANCE_RESERVE, freeCollateralPct=${(botState.freeCollateralPct || 0).toFixed(1)}, reservePct=${reservePct}`);
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
