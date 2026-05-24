import { TradeLog } from "./types.js";
import { botState } from "./state.js";
import { TradeAnalyticsEngine } from "./services/tradeAnalyticsEngine.js";
import { AdaptiveLearningEngine } from "./services/adaptiveLearningEngine.js";
import fs from "fs";
import path from "path";

// Attempt to load firebase-admin for true persistence
let db: any = null;
let firebaseInitialized = false;

async function getFirestoreDb() {
  if (firebaseInitialized) return db;
  firebaseInitialized = true;
  try {
    const { initializeApp, getApps } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    
    if (getApps().length === 0) {
      initializeApp();
    }
    db = getFirestore();
    console.log("[DB] Firestore initialized via firebase-admin (lazy)");
  } catch (e) {
    console.warn("[DB] Firestore initialization failed, falling back to local storage:", e);
  }
  return db;
}

const LOCAL_STORAGE_PATH = path.join(process.cwd(), "trades_history.json");

export class TradeLogger {
  constructor() {
    this.loadHistory();
  }

  private loadHistory() {
    try {
      if (fs.existsSync(LOCAL_STORAGE_PATH)) {
        const data = fs.readFileSync(LOCAL_STORAGE_PATH, "utf8");
        let parsedTrades = JSON.parse(data);
        
        // Filter out invalid phantom EXITS that have massive duration
        parsedTrades = parsedTrades.filter((t: any) => !(t.type === "EXIT" && t.duration > 1000 * 60 * 60 * 24 * 30)); 
        
        botState.trades = parsedTrades;
        console.log(`[STORAGE] Loaded ${botState.trades.length} valid trades from local disk`);
        this.saveLocally(); // overwrite with clean data
        this.refreshAnalytics();
      }
    } catch (e) {
      console.error("[STORAGE] Failed to load local history:", e);
    }
  }

  private saveLocally() {
    try {
      fs.writeFileSync(LOCAL_STORAGE_PATH, JSON.stringify(botState.trades, null, 2));
    } catch (e) {
      console.error("[STORAGE] Failed to save local history:", e);
    }
  }

  async logTrade(trade: TradeLog) {
    if (trade.type === "EXIT") {
      // 1. Rebuild trade lifecycle matching & deduplication
      const sortedTrades = [...botState.trades].sort((a, b) => a.timestamp - b.timestamp);
      const matchingEntry = sortedTrades
        .slice()
        .reverse()
        .find(entry => entry.type === "ENTRY" && entry.symbol === trade.symbol);

      if (matchingEntry) {
        // Prevent duplicate exit logging: only one final exit record per closed trade
        // If there exists any EXIT for this coin after the latest ENTRY timestamp, it means this ENTRY is already closed!
        const alreadyClosed = botState.trades.some(t => t.type === "EXIT" && t.symbol === trade.symbol && t.timestamp > matchingEntry.timestamp);
        if (alreadyClosed || (botState.openPositions === 0 && trade.orderId === "EXTERNAL_CLOSE" && botState.trades.some(t => t.type === "EXIT" && t.symbol === trade.symbol && Date.now() - t.timestamp < 10000))) {
          console.log("DUPLICATE_EXIT_IGNORED");
          return;
        }

        trade.entryPrice = trade.entryPrice || matchingEntry.entryPrice || matchingEntry.fillPrice || 0;
        trade.size = trade.size || matchingEntry.size || 0;
        trade.side = trade.side || matchingEntry.side || "NONE";
        
        // Propagate metadata for adaptive learning engine
        trade.entryReason = trade.entryReason || matchingEntry.entryReason;
        trade.confidenceScore = trade.confidenceScore || matchingEntry.confidenceScore;
        trade.marketRegime = trade.marketRegime || matchingEntry.marketRegime;
        trade.volatilityScore = trade.volatilityScore || matchingEntry.volatilityScore;
        trade.trendScore = trade.trendScore || matchingEntry.trendScore;
        trade.trendStrength = trade.trendStrength || matchingEntry.trendStrength;
        trade.htfAlignment = trade.htfAlignment !== undefined ? trade.htfAlignment : matchingEntry.htfAlignment;
        trade.duration = trade.duration || (trade.timestamp - matchingEntry.timestamp);
        trade.maxFavorableMove = trade.maxFavorableMove || trade.unrealizedMaxGain || matchingEntry.unrealizedMaxGain;
        trade.maxAdverseMove = trade.maxAdverseMove || trade.unrealizedMaxDrawdown || matchingEntry.unrealizedMaxDrawdown;

        console.log("TRADE_LIFECYCLE_MATCHED");
      }

      // 2. If exit price or size is missing: run exchange fill reconciliation
      if (!trade.exitPrice || !trade.size) {
        console.log("EXIT_RECONCILIATION_REQUIRED");
        try {
          const { hClient } = await import("./hyperliquidClient.js");
          const { config } = await import("./config.js");
          // run reconciliation
          const fills = await hClient.infoRequest({
            type: "userFills",
            user: config.HYPERLIQUID_WALLET_ADDRESS
          });
          if (fills && Array.isArray(fills)) {
            const targetDir = trade.side === "LONG" ? "Sell" : "Buy";
            const latestFill = fills.find((f: any) => f.coin === trade.symbol && f.dir === targetDir);
            if (latestFill) {
              trade.exitPrice = parseFloat(latestFill.px);
              trade.size = parseFloat(latestFill.sz);
              trade.fees = parseFloat(latestFill.fee);
              console.log("EXIT_RECONCILIATION_COMPLETE");
            }
          }
        } catch (e: any) {
          console.error("[RECONCILIATION] Failed to fetch user fills during logger check:", e.message);
        }
      }

      // 3. Calculate PnL for BOTH wins and losses
      if (trade.entryPrice && trade.exitPrice && trade.size) {
        const entryPx = trade.entryPrice;
        const exitPx = trade.exitPrice;
        const size = trade.size;
        const fees = trade.fees || 0;

        const grossPnl = trade.side === "LONG"
          ? (exitPx - entryPx) * size
          : (entryPx - exitPx) * size;

        trade.grossPnl = grossPnl;
        trade.realizedPnl = grossPnl;
        trade.netPnl = grossPnl - fees;

        const isWinning = trade.netPnl >= 0;
        if (isWinning) {
          console.log("WINNING_PNL_RECORDED");
        } else {
          console.log("LOSING_PNL_RECORDED");
        }
      }
    }

    // Memory update
    botState.trades.push(trade);
    
    // 2. Local disk backup
    this.saveLocally();

    // 3. Analytics refresh
    this.refreshAnalytics();

    // 4. Persistence to Firestore (if available)
    try {
      const dbRef = await getFirestoreDb();
      if (dbRef) {
        const docId = `${trade.timestamp}_${trade.symbol}_${trade.type}`;
        // Sanitize object to remove undefined values for Firestore compatibility
        const sanitizedTrade = JSON.parse(JSON.stringify(trade, (key, value) => value === undefined ? null : value));
        await dbRef.collection("trades").doc(docId).set(sanitizedTrade);
        
        // Sanitize analytics
        const sanitizedAnalytics = JSON.parse(JSON.stringify(botState.analytics, (key, value) => value === undefined ? null : value));
        await dbRef.collection("analytics").doc("global").set(sanitizedAnalytics);
        
        // console.log(`[DB] Trade ${docId} persisted to Firestore (sanitized)`);
      }
    } catch (e: any) {
      if (e.code === 7 || e.message?.includes('PERMISSION_DENIED')) {
        console.warn("[DB] Firestore API is disabled or permission denied. Disabling Firestore persistence.");
        db = null; // Disable further attempts
      } else {
        console.error("[DB] Failed to persist to Firestore:", e.message);
      }
    }

    let pnlStr = trade.realizedPnl !== undefined ? ` PnL: $${trade.realizedPnl.toFixed(2)}` : '';
    console.log(`TRADE_LOGGED [${trade.type}]: ${trade.symbol} ${trade.side} Size: ${trade.size || 'N/A'} @ ${trade.entryPrice || trade.exitPrice || trade.fillPrice}${pnlStr}`);
  }

  refreshAnalytics() {
    const stats: any = TradeAnalyticsEngine.analyze(botState.trades);
    if (stats.calibration) { botState.calibration = stats.calibration; delete stats.calibration; }
    if (stats.expectancy) { botState.expectancy = stats.expectancy; delete stats.expectancy; }
    botState.analytics = { ...(botState.analytics || {}), ...stats };
    
    // Adaptive Learning update
    try {
      const learningStats = AdaptiveLearningEngine.buildLearningState(botState.trades);
      botState.learningState = learningStats;
      // Emit learning events safely based on positive or negative edge found
      if (learningStats.bestBuckets.length > 0) {
         console.log(`[LEARNING_BUCKET_POSITIVE] Identified positive edge: ${learningStats.bestBuckets[0] || 'NONE'}`);
      }
      if (learningStats.worstBuckets.length > 0) {
         console.log(`[LEARNING_BUCKET_NEGATIVE] Identified negative edge: ${learningStats.worstBuckets[0] || 'NONE'}`);
      }
    } catch(e) {
      console.error("[ADAPTIVE_LEARNING_FAILED]", e);
    }

    // Keep realizedPnl on botState synced with net profitability
    botState.realizedPnl = stats.netProfitability;
    console.log("PNL_ACCOUNTING_REBUILT");
  }

  getLogs() {
    return botState.trades;
  }
}

export const tradeLogger = new TradeLogger();
