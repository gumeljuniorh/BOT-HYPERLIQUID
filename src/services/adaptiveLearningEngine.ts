import { TradeLog, LearningState, LearningBucket } from "../types";

export class AdaptiveLearningEngine {
  private static readonly MAX_THRESHOLD_ADJUST = 10;
  private static readonly MAX_SIZE_ADJUST = 0.25;

  public static buildLearningState(trades: TradeLog[]): LearningState {
    const completedExits = trades.filter(t => t.type === "EXIT");
    
    // Sort by recent first
    const sortedTrades = [...completedExits].sort((a, b) => b.timestamp - a.timestamp);
    
    // Default empty state
    const learningState: LearningState = {
      buckets: {},
      bestBuckets: [],
      worstBuckets: [],
      longEdgeScore: 0,
      shortEdgeScore: 0,
      bestRegime: null,
      worstRegime: null,
      globalLearningConfidence: 0,
      corrupted: false,
      lastUpdateTimestamp: Date.now()
    };

    // Corruption and bad data detection
    let isCorrupted = false;
    for (const t of trades) {
      if (
        !t.timestamp ||
        isNaN(t.timestamp) ||
        (t.netPnl !== undefined && isNaN(t.netPnl)) ||
        (t.size !== undefined && (t.size <= 0 || isNaN(t.size))) ||
        (t.entryPrice !== undefined && (t.entryPrice !== null && (t.entryPrice < 0 || isNaN(t.entryPrice)))) ||
        (t.exitPrice !== undefined && (t.exitPrice !== null && (t.exitPrice < 0 || isNaN(t.exitPrice))))
      ) {
         isCorrupted = true;
         break;
      }
    }

    if (isCorrupted) {
       console.log("[LEARNING_GUARDRAIL_APPLIED] Corruption or bad/invalid data detected in trade logs! Resetting and disabling adaptive learning state entirely.");
       learningState.corrupted = true;
       return learningState;
    }

    if (sortedTrades.length < 5) return learningState; // Not enough data to start

    // Windows to process: max 100 trades, but we will chunk them in to recent trades
    const last100 = sortedTrades.slice(0, 100);

    const bucketGroups: Record<string, TradeLog[]> = {};

    last100.forEach(t => {
      // Build keys
      const keys: {type: string, category: string}[] = [];
      
      if (t.symbol) keys.push({ type: "ASSET", category: t.symbol });
      if (t.marketRegime) keys.push({ type: "REGIME", category: t.marketRegime });
      if (t.entryReason) keys.push({ type: "ENTRY_TYPE", category: t.entryReason });
      if (t.side && t.side !== "NONE") keys.push({ type: "DIRECTION", category: t.side });
      
      if (t.volatilityScore !== undefined) {
         const volLevel = t.volatilityScore > 0.8 ? "HIGH" : (t.volatilityScore > 0.4 ? "MED" : "LOW");
         keys.push({ type: "VOLATILITY", category: volLevel });
      }

      if (t.confidenceScore !== undefined) {
         const confRange = t.confidenceScore >= 80 ? "80+" : (t.confidenceScore >= 60 ? "60-79" : "<60");
         keys.push({ type: "CONFIDENCE", category: confRange });
      }

      if (t.duration !== undefined) {
         const durMins = t.duration / 60000;
         const durCategory = durMins < 5 ? "SCALP" : (durMins < 60 ? "INTRA" : "SWING");
         keys.push({ type: "DURATION", category: durCategory });
      }

      for (const k of keys) {
         const id = `${k.type}:${k.category}`;
         if (!bucketGroups[id]) bucketGroups[id] = [];
         bucketGroups[id].push(t);
      }
    });

    // Evaluate buckets
    Object.keys(bucketGroups).forEach(id => {
       const bTrades = bucketGroups[id];
       if (bTrades.length < 5) return; // Only learn from buckets with at least 5 trades
       
       const wins = bTrades.filter(t => (t.netPnl || 0) > 0).length;
       const winRate = (wins / bTrades.length) * 100;
       const netPnl = bTrades.reduce((acc, t) => acc + (t.netPnl || 0), 0);
       const avgHold = bTrades.reduce((acc, t) => acc + (t.duration || 0), 0) / (bTrades.length * 60000);

       // Base computations
       let sizeAdj = 0;
       let threshAdj = 0;
       let cdPenalty = 0;
       let posEdge = false;
       let negEdge = false;

       // Adaptive logic based on statistical performance
       // This uses recent outcomes (up to 100) to nudge execution parameters
       if (winRate > 65 && netPnl > 0) {
           posEdge = true;
           // Cap scale based on number of trades
           const confidenceMult = Math.min(1.0, bTrades.length / 20); // Reach full scale at 20 trades
           sizeAdj = 0.10 * confidenceMult; 
           threshAdj = -3 * confidenceMult; // lower threshold
       } else if (winRate < 40 || netPnl < 0) {
           negEdge = true;
           const confidenceMult = Math.min(1.0, bTrades.length / 10); // penalize faster
           sizeAdj = -0.15 * confidenceMult;
           threshAdj = 5 * confidenceMult; // raise threshold
           cdPenalty = 10 * 60 * 1000 * confidenceMult; // 10 min penalty
       }

       // Clamp values to guardrails
       sizeAdj = Math.max(-this.MAX_SIZE_ADJUST, Math.min(this.MAX_SIZE_ADJUST, sizeAdj));
       threshAdj = Math.max(-this.MAX_THRESHOLD_ADJUST, Math.min(this.MAX_THRESHOLD_ADJUST, threshAdj));

       const parts = id.split(":");
       
       learningState.buckets[id] = {
           id,
           type: parts[0] as any,
           category: parts[1],
           recentTrades: bTrades.length,
           recentWinRate: winRate,
           recentNetPnl: netPnl,
           recentAvgHold: avgHold,
           sizeAdjustment: sizeAdj,
           thresholdAdjustment: threshAdj,
           cooldownPenalty: cdPenalty,
           isPositiveEdge: posEdge,
           isNegativeEdge: negEdge
       };
    });

    // Populate dashboard highlights
    const allB = Object.values(learningState.buckets);
    if (allB.length > 0) {
        // Sort for best
        const best = [...allB].filter(b => b.isPositiveEdge).sort((a, b) => b.recentNetPnl - a.recentNetPnl);
        const worst = [...allB].filter(b => b.isNegativeEdge).sort((a, b) => a.recentNetPnl - b.recentNetPnl);
        
        learningState.bestBuckets = best.slice(0, 5).map(b => b.id);
        learningState.worstBuckets = worst.slice(0, 5).map(b => b.id);
        
        const longB = learningState.buckets["DIRECTION:LONG"];
        const shortB = learningState.buckets["DIRECTION:SHORT"];
        learningState.longEdgeScore = longB ? longB.recentNetPnl : 0;
        learningState.shortEdgeScore = shortB ? shortB.recentNetPnl : 0;
        
        const regimes = allB.filter(b => b.type === "REGIME");
        if (regimes.length > 0) {
           regimes.sort((a, b) => b.recentNetPnl - a.recentNetPnl);
           learningState.bestRegime = regimes[0].category;
           learningState.worstRegime = regimes[regimes.length - 1].category;
        }

        learningState.globalLearningConfidence = Math.min(100, (last100.length / 50) * 100);
    }
    
    console.log(`[ADAPTIVE_LEARNING_UPDATED] Computed learning state. Best Regimes: ${learningState.bestRegime}, Worst Regimes: ${learningState.worstRegime}`);

    return learningState;
  }
}
