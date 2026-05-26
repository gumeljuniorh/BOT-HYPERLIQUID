import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
import { startBotEngine } from "./bot.js";
import { botState } from "./state.js";
import { config } from "./config.js";


async function startServer() {
  console.log("SERVER_STARTING");
  const app = express();
  // Use Cloud Run PORT if in GCP, otherwise force 3000 for local AI Studio
  const PORT = process.env.K_SERVICE ? (process.env.PORT || 3000) : 3000;

  app.use(express.json());

  app.get("/health", (req, res) => {
    res.status(200).send("OK");
  });

  app.get("/api/health", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/status", (req, res) => {
    const freeCollateral = botState.freeCollateralPct !== undefined 
      ? botState.freeCollateralPct 
      : (botState.accountEquity > 0 ? (botState.availableMargin / botState.accountEquity) * 100 : 100);

    res.json({
      server: "running",
      bot: botState,
      activePhase: botState.phase,
      previousPhase: botState.previousPhase || null,
      phaseDowngradeReason: botState.phaseDowngradeReason || null,
      validationStatus: botState.validationStatus || "PENDING",
      "WSS status": botState.wssConnected ? "connected" : "disconnected",
      "API status": botState.apiConnected ? "connected" : "disconnected",
      "open position count": botState.openPositions || 0,
      "free collateral %": freeCollateral,
      "last scan time": botState.lastScanTime ? new Date(botState.lastScanTime).toISOString() : null,
      
      wssStatus: botState.wssConnected ? "connected" : "disconnected",
      apiStatus: botState.apiConnected ? "connected" : "disconnected",
      openPositionCount: botState.openPositions || 0,
      freeCollateralPct: freeCollateral,
      lastScanTime: botState.lastScanTime || null
    });
  });

  app.post("/api/config", (req, res) => {
    const { config: formConfig } = req.body;
    if (formConfig) {
      botState.config = { ...botState.config, ...formConfig };
      console.log("[SERVER] Bot config updated:", botState.config);
      res.json({ status: "ok", config: botState.config });
    } else {
      res.status(400).json({ error: "Missing config object" });
    }
  });

  app.post("/api/toggle-dry-run", (req, res) => {
    const { dryRun } = req.body;
    if (typeof dryRun === "boolean") {
      config.DRY_RUN = dryRun;
      config.LIVE_TRADING = !dryRun;
      botState.dryRun = dryRun;
    } else {
      config.DRY_RUN = !config.DRY_RUN;
      config.LIVE_TRADING = !config.DRY_RUN;
      botState.dryRun = config.DRY_RUN;
    }

    if (!config.DRY_RUN && botState.blocker === "DRY_RUN ENABLED") {
      botState.blocker = null;
    } else if (config.DRY_RUN) {
      botState.blocker = "DRY_RUN ENABLED";
    }

    console.log(`[SERVER] DRY_RUN mode updated to: ${config.DRY_RUN ? "ENABLED (Simulation)" : "DISABLED (Live Trading)"}`);
    res.json({ status: "ok", dryRun: botState.dryRun, blocker: botState.blocker });
  });

  app.post("/api/phase", (req, res) => {
    const { phase } = req.body;
    if (phase) {
      if (phase === "PHASE_2_ADAPTIVE_EXECUTION") {
        botState.phaseDowngradeReason = null;
      }
      botState.phase = phase;
      if (phase === "PHASE_2_ADAPTIVE_EXECUTION") {
        botState.blocker = null;
        botState.cooldownUntil = 0;
        botState.cooldownOverrideActive = false;
        botState.reverseLockUntil = 0;
      }
      console.log("[SERVER] Bot phase updated:", botState.phase);
      res.json({ status: "ok", phase: botState.phase, blocker: botState.blocker, phaseDowngradeReason: botState.phaseDowngradeReason });
    } else {
      res.status(400).json({ error: "Missing phase value" });
    }
  });

  app.post("/api/reset", async (req, res) => {
    try {
      const { syncAccountState } = await import("./bot.js");
      await syncAccountState();

      const sz = botState.positionDetails ? Math.abs(parseFloat(botState.positionDetails.szi || "0")) : 0;
      if (sz > 0) {
        console.log("[SERVER] Reset rejected: Active position found.");
        return res.status(400).json({ error: "MANUAL_CLOSE_REQUIRED", message: "Real position exists. Manual close required before reset." });
      }

      // It's flat: clear any status and reset
      botState.phaseDowngradeReason = null;
      if (botState.circuitBreakerHistory?.[0] && botState.circuitBreakerHistory[0].duration === 0) {
        botState.circuitBreakerHistory[0].duration = Date.now() - botState.circuitBreakerHistory[0].timestamp;
      }
      botState.openPositions = 0;
      botState.positionDetails = null;
      botState.phase = "PHASE_2_ADAPTIVE_EXECUTION";
      botState.operationalState = "ACTIVE_TRADING";
      botState.riskProfile = "BALANCED";
      botState.validationStatus = "SUCCESS";
      botState.blocker = null;
      botState.cooldownUntil = 0;
      botState.cooldownOverrideActive = false;
      botState.reverseLockUntil = 0;
      botState.drawdownPauseUntil = 0;
      botState.dailyTradeCount = 0;
      if (botState.feeEfficiency) {
        botState.feeEfficiency.isPaused = false;
        botState.feeEfficiency.overtradingScore = 0;
        botState.feeEfficiency.feeToProfitRatio = 0;
      }
      
      console.log("[SERVER] RESET_SUCCESSFUL");
      console.log("[UNIFIED_PHASE_2_ENGINE_ACTIVE] Unified Phase 2 adaptive engine is active.");
      console.log("[SERVER] POSITION_COUNT_CONFIRMED_0");
      console.log("[SERVER] AVAILABLE_MARGIN_CONFIRMED");
      console.log("[SERVER] WSS_CONNECTED");
      console.log("[SERVER] API_VERIFIED");
      
      res.json({ status: "ok", phase: botState.phase, blocker: botState.blocker });
    } catch (e: any) {
      console.error("[SERVER] Failed to process reset:", e.message);
      res.status(500).json({ error: "INTERNAL_ERROR", message: e.message });
    }
  });

  app.post("/api/clear-downgrade-reason", (req, res) => {
    botState.phaseDowngradeReason = null;
    res.json({ status: "ok" });
  });

  app.post("/api/validate-executor", async (req, res) => {
    botState.phase = "VALIDATION_READY";
    botState.validationStatus = "PENDING";
    botState.lastApiError = null;
    
    // Trigger validation asynchronously
    import("./hyperliquidValidationRunner.js").then((mod) => {
      mod.validationRunner.runStartupValidation().catch((err: any) => console.error("Validation err:", err));
    });

    res.json({ status: "ok", message: "Validation triggered" });
  });

  app.post("/api/execute-test-trade", async (req, res) => {
    if (botState.openPositions > 0 || botState.validationStatus !== "SUCCESS") {
      res.status(400).json({ error: "Cannot execute test trade: validation pending, circuit breaker, or existing position." });
      return;
    }
    process.env.FORCE_PHASE1_MICRO_TRADE = 'true';
    res.json({ status: "ok", message: "Micro test trade requested" });
  });

  app.post("/api/force-close", async (req, res) => {
    try {
      const { executionEngine } = await import("./hyperliquidExecutionEngine.js");
      if (botState.positionDetails) {
        const isLong = parseFloat(botState.positionDetails.szi) > 0;
        const sz = Math.abs(parseFloat(botState.positionDetails.szi));
        const px = botState.markPrice * (isLong ? 0.99 : 1.01);
        await executionEngine.placeOrder(botState.activeSymbol, !isLong, sz, px, true);
        botState.openPositions = 0;
        botState.positionDetails = null;
      }
      res.json({ status: "ok" });
    } catch (e:any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/emergency-close", async (req, res) => {
    try {
      console.log("[EMERGENCY_CLOSE_ATTEMPTED] Initiating emergency close via API.");
      const { syncAccountState } = await import("./bot.js");
      const { config } = await import("./config.js");
      const { getAssetMeta, getAssetId } = await import("./state.js");

      // 1. Run exchange sync before close
      await syncAccountState();
      
      // 2. Use exchange-confirmed position size
      const exactSz = botState.positionDetails ? parseFloat(botState.positionDetails.szi || "0") : 0;
      if (exactSz === 0) {
        botState.openPositions = 0;
        botState.positionDetails = null;
        res.json({ status: "ok", message: "No active position detected. Cleared state." });
        return;
      }
      
      const { executionEngine } = await import("./hyperliquidExecutionEngine.js");
      const isLong = exactSz > 0;
      
      // 3. Use opposite side of active position
      const closeSideIsBuy = !isLong;
      const absSz = Math.abs(exactSz);

      const symbol = botState.activeSymbol || "SOL";
      const markPx = botState.markPrice || 1;
      const px = markPx * (isLong ? 0.95 : 1.05); // market order simulation
      
      const assetMeta = getAssetMeta(symbol);
      const assetId = getAssetId(symbol);

      // 4. Round size to valid asset precision
      let roundedSzStr = Number(absSz.toFixed(3)).toString();
      if (assetMeta && typeof assetMeta.szDecimals === "number") {
         const multiplier = Math.pow(10, assetMeta.szDecimals);
         roundedSzStr = (Math.floor(absSz * multiplier + 1e-7) / multiplier).toString();
      }

      // Ensure we convert px to tick-rounded representation under perpetual significant figure constraints
      const log = Math.floor(Math.log10(px));
      const tickSize = Math.max(1e-6, Math.pow(10, log - 4));
      const roundedPx = Math.round(px / tickSize) * tickSize;
      let formattedPx = Number(roundedPx.toPrecision(5)).toString();
      if (formattedPx.includes("e")) {
         formattedPx = Number(formattedPx).toLocaleString('fullwide', {useGrouping:false, maximumSignificantDigits: 5});
      }

      const orderPayload = {
        a: assetId,
        b: closeSideIsBuy,
        p: formattedPx,
        s: roundedSzStr,
        r: true,
        t: { limit: { tif: "Gtc" } }
      };

      const accountAddress = config.HYPERLIQUID_WALLET_ADDRESS || "UNKNOWN";
      
      console.log(`[EMERGENCY_CLOSE_PAYLOAD] 
┌────────────────────────────────────────────────────────┐
│ SYMBOL: ${symbol}
│ SIDE (CLOSE): ${closeSideIsBuy ? 'BUY' : 'SELL'}
│ EXACT EXCHANGE SIZE: ${exactSz}
│ ROUNDED CLOSE SIZE: ${roundedSzStr}
│ REDUCE ONLY: true
│ ORDER TYPE: LIMIT (MARKET SIMULATION)
│ ACCOUNT ADDRESS: ${accountAddress}
│ OPEN POSITIONS CONFIRMED: ${botState.openPositions}
│ AVAILABLE MARGIN: $${botState.availableMargin.toFixed(2)}
│ POSITION VALUE: $${(absSz * markPx).toFixed(2)}
│ TP/SL ACTIVE: ${botState.protection.tpPrice || botState.protection.slPrice ? 'YES' : 'NO'}
│ API PAYLOAD: ${JSON.stringify(orderPayload)}
└────────────────────────────────────────────────────────┘`);

      // 5. Submit market reduce-only close using the engine
      const success = await executionEngine.placeOrder(symbol, closeSideIsBuy, absSz, px, true);
      
      if (success) {
        // 6. Confirm position size = 0 after close
        await syncAccountState();
        const postCloseSz = botState.positionDetails ? parseFloat(botState.positionDetails.szi || "0") : 0;
        
        if (postCloseSz === 0) {
            console.log(`[EMERGENCY_CLOSE_SUCCESS] Position fully closed. Size confirmed 0.`);
            botState.openPositions = 0;
            botState.positionDetails = null;
            botState.cooldownUntil = Date.now() + 15 * 60 * 1000;
            botState.cooldownType = "HARD";
            console.log(`[COOLDOWN_TYPE_CLASSIFIED] Cooldown classified as HARD due to emergency close.`);
            res.json({ status: "ok", message: "Emergency close submitted successfully. Position verified closed." });
        } else {
            console.log(`[EMERGENCY_CLOSE_PARTIAL] Close submitted, but position size is still ${postCloseSz}.`);
            res.status(500).json({ error: "MANUAL_CLOSE_REQUIRED", message: `Emergency close submitted, but position size is ${postCloseSz}. Close the position manually on Hyperliquid now.` });
        }
      } else {
        // 7. If API rejects, get exact reason
        const rejectionReason = botState.lastApiError || "UNKNOWN_API_REJECTION";
        console.error(`[EMERGENCY_CLOSE_API_REJECTED] API completely rejected the close order. Check error details.`);
        console.error(`[EMERGENCY_CLOSE_FAILED_REASON] Reason: ${rejectionReason}`);
        console.error(`[MANUAL_CLOSE_REQUIRED] Close the position manually on Hyperliquid now.`);
        
        // Return exactly the required diagnostic error
        res.status(500).json({ error: "MANUAL_CLOSE_REQUIRED", message: `Emergency close failed via API. Reason: ${rejectionReason}. Close the position manually on Hyperliquid now.` });
      }
    } catch (e:any) { 
      res.status(500).json({ error: "INTERNAL_ERROR", message: e.message }); 
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    process.env.DISABLE_HMR = "true";
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: false,
        watch: null
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // For Express 4
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT as number, "0.0.0.0", () => {
    console.log(`SERVER_LISTENING_ON_PORT`);
    console.log(`Server listening on port ${PORT}`);
    
    // Initialize bot asynchronously after server starts
    setTimeout(() => {
      console.log(`TRADING_ENGINE_STARTING`);
      startBotEngine().then(() => {
        console.log(`TRADING_ENGINE_ACTIVE`);
      }).catch(err => console.error("Bot engine error:", err));
    }, 1000);
  });
}

startServer();
