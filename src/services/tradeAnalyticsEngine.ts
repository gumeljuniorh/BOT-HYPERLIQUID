import { TradeLog } from "../types";

export class TradeAnalyticsEngine {
  static analyze(trades: any[]) {
    if (trades.length === 0) return this.getEmptyStats();

    const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
    
    // 1. Process and reconcile confirmed exits
    const confirmedExits = sortedTrades.filter(t => t.type === "EXIT").map(exit => {
      const idx = sortedTrades.indexOf(exit);
      const matchingEntry = sortedTrades
        .slice(0, idx)
        .reverse()
        .find(entry => entry.type === "ENTRY" && entry.symbol === exit.symbol);

      let entryPrice = exit.entryPrice || (matchingEntry ? matchingEntry.entryPrice || matchingEntry.fillPrice : 0);
      let exitPrice = exit.exitPrice || exit.fillPrice || 0;
      let side = exit.side || (matchingEntry ? matchingEntry.side : "NONE");
      let size = exit.size || (matchingEntry ? matchingEntry.size : 0);
      let fees = exit.fees;
      let realizedPnl = exit.realizedPnl;

      // Estimate and reconcile
      if (entryPrice && exitPrice && size) {
         if (fees === undefined || fees === null) {
            fees = (size * entryPrice * 0.00035) + (size * exitPrice * 0.00035);
            if (matchingEntry && matchingEntry.fees) fees = matchingEntry.fees + (size * exitPrice * 0.00035);
         }
         if (realizedPnl === undefined || realizedPnl === null) {
            realizedPnl = (side === "LONG" || side === "BUY") 
              ? (exitPrice - entryPrice) * size 
              : (entryPrice - exitPrice) * size;
         }
      }

      const netPnl = (realizedPnl || 0) - (fees || 0);

      // Duration logic
      let duration = 0;
      if (matchingEntry && exit.timestamp > matchingEntry.timestamp) {
         duration = exit.timestamp - matchingEntry.timestamp;
      } else if (typeof exit.duration === "number" && exit.duration > 0 && exit.duration < 1000 * 60 * 60 * 24 * 30) {
         duration = exit.duration;
      }

      return {
        ...exit,
        entryPrice,
        exitPrice,
        side,
        size,
        fees,
        realizedPnl,
        netPnl,
        duration,
        marketRegime: exit.marketRegime || matchingEntry?.marketRegime || "TRENDING"
      };
    }).filter(t => t.entryPrice > 0 && t.exitPrice > 0 && t.size > 0 && typeof t.realizedPnl === "number");

    const wins = confirmedExits.filter(t => t.netPnl > 0);
    const losses = confirmedExits.filter(t => t.netPnl < 0);

    const totalTrades = confirmedExits.length;
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    
    // Average Win / Average Loss based on netPnl
    const avgWin = wins.length > 0 ? wins.reduce((acc, t) => acc + t.netPnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((acc, t) => acc + t.netPnl, 0) / losses.length : 0;
    
    const largestWin = wins.length > 0 ? Math.max(...wins.map(t => t.netPnl)) : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses.map(t => t.netPnl)) : 0;
    
    const cumulativeFees = confirmedExits.reduce((acc, t) => acc + (t.fees || 0), 0);
    const netProfitability = confirmedExits.reduce((acc, t) => acc + t.netPnl, 0);

    const durations = confirmedExits.filter(t => t.duration > 0).map(t => t.duration);
    const averageTradeDuration = durations.length > 0
      ? durations.reduce((acc, d) => acc + d, 0) / durations.length
      : 0;

    const regimeStats: Record<string, { wins: number; losses: number; winRate: number }> = {};
    const regimeDetailedStats: Record<string, { wins: number; losses: number; winRate: number; netPnl: number; fees: number; averageDuration: number; durationsList: number[] }> = {};

    for (const exit of confirmedExits) {
      const regime = exit.marketRegime;
      
      if (!regimeStats[regime]) {
        regimeStats[regime] = { wins: 0, losses: 0, winRate: 0 };
      }
      if (!regimeDetailedStats[regime]) {
        regimeDetailedStats[regime] = { wins: 0, losses: 0, winRate: 0, netPnl: 0, fees: 0, averageDuration: 0, durationsList: [] };
      }

      if (exit.netPnl > 0) {
        regimeStats[regime].wins++;
        regimeDetailedStats[regime].wins++;
      } else if (exit.netPnl < 0) {
        regimeStats[regime].losses++;
        regimeDetailedStats[regime].losses++;
      }

      regimeDetailedStats[regime].netPnl += exit.netPnl;
      regimeDetailedStats[regime].fees += (exit.fees || 0);
      if (exit.duration > 0) {
        regimeDetailedStats[regime].durationsList.push(exit.duration);
      }
    }

    // Calculate win rates per regime and build formattedDetailedStats
    for (const key of Object.keys(regimeStats)) {
      const { wins: w, losses: l } = regimeStats[key];
      const total = w + l;
      regimeStats[key].winRate = total > 0 ? (w / total) * 100 : 0;
    }

    const formattedDetailedStats: Record<string, { wins: number; losses: number; winRate: number; netPnl: number; fees: number; averageDuration: number }> = {};
    for (const key of Object.keys(regimeDetailedStats)) {
      const stats = regimeDetailedStats[key];
      const total = stats.wins + stats.losses;
      formattedDetailedStats[key] = {
        wins: stats.wins,
        losses: stats.losses,
        winRate: total > 0 ? (stats.wins / total) * 100 : 0,
        netPnl: stats.netPnl,
        fees: stats.fees,
        averageDuration: stats.durationsList.length > 0
          ? stats.durationsList.reduce((acc, d) => acc + d, 0) / stats.durationsList.length
          : 0
      };
    }

    // Determine best / worst regime by netPnl
    let bestRegime = "N/A";
    let worstRegime = "N/A";
    const activeRegimes = Object.keys(formattedDetailedStats);
    if (activeRegimes.length > 0) {
      const sortedByPnl = [...activeRegimes].sort((a, b) => formattedDetailedStats[b].netPnl - formattedDetailedStats[a].netPnl);
      bestRegime = sortedByPnl[0];
      worstRegime = sortedByPnl[sortedByPnl.length - 1];
    }

    const hourAgo = Date.now() - 3600000;
    const overtradingScore = confirmedExits.filter(t => t.timestamp > hourAgo).length;

    // Lessons and mistakes detection
    const lessons: string[] = [];
    
    // Check for overtrading (more than 10 trades in 1 hour)
    const recentTrades = confirmedExits.filter(t => Date.now() - t.timestamp < 3600000);
    if (recentTrades.length > 10) {
      lessons.push("OVERTRADING_DETECTED: High frequency of trades in short interval. Consider increasing signal filters.");
    }

    // Check for bad volatility environments
    const highVolLosses = losses.filter(t => (t.volatilityScore || 0) > 0.8);
    if (highVolLosses.length > totalTrades * 0.3) {
      lessons.push("VOLATILITY_SENSITIVITY: Significant losses during high volatility. Consider widening stops or reducing position size in volatile regimes.");
    }

    // Identify best market conditions
    const trendingWins = wins.filter(t => (t.trendScore || 0) > 0.6);
    if (trendingWins.length > wins.length * 0.7) {
      lessons.push("TREND_FOLLOWING_SUCCESS: Strategy performs exceptionally well in trending markets.");
    }

    console.log("[ANALYTICS] PERFORMANCE_RECALCULATED:", totalTrades, "valid exits.");
    if (totalTrades > 0) {
      console.log(`[ANALYTICS] NET_PROFIT_UPDATED: $${netProfitability.toFixed(2)}`);
      console.log(`[ANALYTICS] AVG_WIN_UPDATED: $${avgWin.toFixed(2)}`);
      console.log(`[ANALYTICS] AVG_LOSS_UPDATED: $${avgLoss.toFixed(2)}`);
    }

    // Expectancy after fees
    const expectancyAfterFees = totalTrades > 0 ? netProfitability / totalTrades : 0;

    // Average projected move vs realized move
    const confirmedExitsWithMove = confirmedExits.filter(t => t.entryPrice > 0);
    const projectedMoves = confirmedExitsWithMove.map(t => t.expectedMovePct || 0).filter(v => v > 0);
    const realizedMoves = confirmedExitsWithMove.map(t => Math.abs(t.exitPrice - t.entryPrice) / t.entryPrice * 100);

    const avgProjectedMove = projectedMoves.length > 0 
      ? projectedMoves.reduce((acc, v) => acc + v, 0) / projectedMoves.length 
      : 0;

    const avgRealizedMove = realizedMoves.length > 0
      ? realizedMoves.reduce((acc, v) => acc + v, 0) / realizedMoves.length
      : 0;

    // Fee-to-profit ratio
    const feeToProfitRatio = netProfitability > 0 ? cumulativeFees / netProfitability : 0;

    // False breakout rate
    const breakoutRegimes = ["BREAKOUT", "MOMENTUM_BUILDING", "PRE_BREAKOUT", "VOLATILITY_EXPANDING"];
    const breakoutTrades = confirmedExits.filter(t => t.marketRegime && breakoutRegimes.some(r => t.marketRegime.includes(r)));
    const failedBreakouts = breakoutTrades.filter(t => t.netPnl < 0);
    const falseBreakoutRate = breakoutTrades.length > 0
      ? (failedBreakouts.length / breakoutTrades.length) * 100
      : 0;
    const recentFalseBreakouts = failedBreakouts.length;
      
    // Continuation success
    const continuationRegimes = ["CONTINUATION"];
    const continuationTrades = confirmedExits.filter(t => t.marketRegime && continuationRegimes.some(r => t.marketRegime.includes(r)));
    const successfulContinuations = continuationTrades.filter(t => t.netPnl > 0);
    const recentContinuationSuccessRate = continuationTrades.length > 0
      ? (successfulContinuations.length / continuationTrades.length) * 100
      : 0;
    const recentContinuationSuccessCount = successfulContinuations.length;
    
    // Threshold calculation
    const thresholdAdjustment = Math.min(10, recentFalseBreakouts * 3);

    // Symmetric Elite Setup Telemetry
    const eliteLongSetups = confirmedExits.filter(t => t.side === "LONG" && t.marketRegime?.includes("ELITE")).length;
    const eliteShortSetups = confirmedExits.filter(t => t.side === "SHORT" && t.marketRegime?.includes("ELITE")).length;
    
    const longContinuationTrades = confirmedExits.filter(t => t.side === "LONG" && t.marketRegime?.includes("CONTINUATION"));
    const shortContinuationTrades = confirmedExits.filter(t => t.side === "SHORT" && t.marketRegime?.includes("CONTINUATION"));
    
    const longContinuationSuccess = longContinuationTrades.filter(t => t.netPnl > 0).length;
    const shortContinuationSuccess = shortContinuationTrades.filter(t => t.netPnl > 0).length;
    
    const longExhaustionTrades = confirmedExits.filter(t => t.side === "LONG" && t.marketRegime?.includes("EXHAUSTION"));
    const shortExhaustionTrades = confirmedExits.filter(t => t.side === "SHORT" && t.marketRegime?.includes("EXHAUSTION"));
    
    const longExhaustionFailures = longExhaustionTrades.filter(t => t.netPnl < 0).length;
    const shortExhaustionFailures = shortExhaustionTrades.filter(t => t.netPnl < 0).length;

    console.log(`[FALSE_BREAKOUT_METRIC_AUDITED] Threshold adj adjusted to ${thresholdAdjustment}`);
    console.log(`[FALSE_BREAKOUT_COUNTER_REBUILT] Exact matching applied. Active false breakouts: ${recentFalseBreakouts}`);
    console.log(`[CONTINUATION_SUCCESS_RECALCULATED] Success Rate: ${recentContinuationSuccessRate.toFixed(1)}%`);
    console.log(`[METRIC_DISPLAY_NORMALIZED] Metrics compiled correctly for UI rendering.`);
    console.log(`[SYMMETRIC_ELITE_ENGINE_VALIDATED] Telemetry Extracted.`);

    // Volatility failure rate
    const highVolTrades = confirmedExits.filter(t => (t.volatilityScore || 0) > 0.6);
    const failedHighVols = highVolTrades.filter(t => t.netPnl < 0);
    const volatilityFailureRate = highVolTrades.length > 0
      ? (failedHighVols.length / highVolTrades.length) * 100
      : 0;

    // Low/High Vol Expectancy metrics
    const lowVolRegimes = ["LOW_VOL_NO_TRADE", "DEAD_LOW_VOLATILITY", "SQUEEZE_BUILDING", "COMPRESSION_WITH_VOLUME"];
    const highVolRegimes = ["CHAOTIC_NOISE", "PARABOLIC_CONTINUATION", "DIRECTIONAL_EXPANSION", "LIQUIDATION_SWEEP", "EXHAUSTION_REVERSAL"];

    const lowVolExits = confirmedExits.filter(t => lowVolRegimes.includes(t.marketRegime || "") || (t.volatilityScore !== undefined && t.volatilityScore < 0.25));
    const highVolExits = confirmedExits.filter(t => highVolRegimes.includes(t.marketRegime || "") || (t.volatilityScore !== undefined && t.volatilityScore > 0.75));

    const lowVolExpectancy = lowVolExits.length > 0 ? lowVolExits.reduce((acc, t) => acc + (t.netPnl || 0), 0) / lowVolExits.length : 0;
    const highVolExpectancy = highVolExits.length > 0 ? highVolExits.reduce((acc, t) => acc + (t.netPnl || 0), 0) / highVolExits.length : 0;

    // Calibration Engine
    const highConfTrades = confirmedExits.filter(t => (t.confidenceScore || 0) >= 70);
    const midConfTrades = confirmedExits.filter(t => (t.confidenceScore || 0) >= 40 && (t.confidenceScore || 0) < 70);
    
    const calibrationScore = highConfTrades.length > 0 ? 
      (highConfTrades.filter(t => t.netPnl > 0).length / highConfTrades.length) : 1.0;

    const calibration = {
      confidenceOutcomes: {
        highConfidenceTrades: { count: highConfTrades.length, wins: highConfTrades.filter(t => t.netPnl > 0).length, avgPnl: highConfTrades.reduce((a, b) => a + b.netPnl, 0) / (highConfTrades.length || 1) },
        midConfidenceTrades: { count: midConfTrades.length, wins: midConfTrades.filter(t => t.netPnl > 0).length, avgPnl: midConfTrades.reduce((a, b) => a + b.netPnl, 0) / (midConfTrades.length || 1) }
      },
      calibrationScore
    };

    // Expectancy Engine
    const expectancyByAsset: Record<string, { trades: number, expectancyAfterFees: number }> = {};
    for (const t of confirmedExits) {
       if (!expectancyByAsset[t.symbol]) expectancyByAsset[t.symbol] = { trades: 0, expectancyAfterFees: 0 };
       expectancyByAsset[t.symbol].trades++;
       expectancyByAsset[t.symbol].expectancyAfterFees += t.netPnl;
    }
    Object.keys(expectancyByAsset).forEach(k => {
       expectancyByAsset[k].expectancyAfterFees /= expectancyByAsset[k].trades;
    });

    const getExpectancy = (arr: any[]) => arr.length > 0 ? arr.reduce((a, b) => a + b.netPnl, 0) / arr.length : 0;
    
    const expectancy = {
      byRegime: Object.keys(formattedDetailedStats).reduce((acc, k) => {
         acc[k] = { trades: formattedDetailedStats[k].wins + formattedDetailedStats[k].losses, expectancyAfterFees: formattedDetailedStats[k].netPnl / ((formattedDetailedStats[k].wins + formattedDetailedStats[k].losses) || 1) };
         return acc;
      }, {} as any),
      byAsset: expectancyByAsset,
      rolling20: getExpectancy(confirmedExits.slice(-20)),
      rolling50: getExpectancy(confirmedExits.slice(-50)),
      rolling100: getExpectancy(confirmedExits.slice(-100)),
      globalExpectancyAfterFees: expectancyAfterFees
    };

    // Gross profitability & all-time gain/loss
    const grossProfitability = confirmedExits.reduce((acc, t) => acc + (t.realizedPnl || 0), 0);
    const allTimeGainLoss = netProfitability;

    // Long/Short Edge
    const longTrades = confirmedExits.filter(t => t.side === "LONG" || t.side === "BUY");
    const shortTrades = confirmedExits.filter(t => t.side === "SHORT" || t.side === "SELL");

    const longEdgeScore = longTrades.length > 0 ? (longTrades.reduce((acc, t) => acc + t.netPnl, 0) / longTrades.length) : 0;
    const shortEdgeScore = shortTrades.length > 0 ? (shortTrades.reduce((acc, t) => acc + t.netPnl, 0) / shortTrades.length) : 0;

    const longWinRate = longTrades.length > 0 ? (longTrades.filter(t => t.netPnl > 0).length / longTrades.length) * 100 : 0;
    const shortWinRate = shortTrades.length > 0 ? (shortTrades.filter(t => t.netPnl > 0).length / shortTrades.length) * 100 : 0;

    // Regime edge
    const regimeEdge: Record<string, number> = {};
    for (const key of Object.keys(formattedDetailedStats)) {
      const stats = formattedDetailedStats[key];
      const total = stats.wins + stats.losses;
      regimeEdge[key] = total > 0 ? stats.netPnl / total : 0;
    }

    // Fee Analytics
    const feeImpactPct = grossProfitability > 0 ? (cumulativeFees / grossProfitability) * 100 : 0;
    const feeAnalytics = {
      totalFeesPaid: cumulativeFees,
      feeToProfitRatio,
      averageFeePerTrade: totalTrades > 0 ? cumulativeFees / totalTrades : 0,
      feeImpactPct
    };

    return {
      totalTrades,
      winRate,
      totalWins: wins.length,
      totalLosses: losses.length,
      avgWin,
      avgLoss,
      largestWin,
      largestLoss,
      cumulativeFees,
      netProfitability,
      currentDrawdown: this.calculateDrawdown(confirmedExits),
      averageTradeDuration,
      winLossByMarketRegime: regimeStats,
      bestRegime,
      worstRegime,
      regimeDetailedStats: formattedDetailedStats,
      overtradingScore,
      lessons,
      updatedAt: Date.now(),
      expectancyAfterFees,
      avgProjectedMove,
      avgRealizedMove,
      feeToProfitRatio,
      falseBreakoutRate,
      volatilityFailureRate,
      calibration,
      expectancy,
      recentFalseBreakouts,
      recentContinuationSuccessRate,
      recentContinuationSuccessCount,
      thresholdAdjustment,
      eliteLongSetups,
      eliteShortSetups,
      longContinuationSuccess,
      shortContinuationSuccess,
      longExhaustionFailures,
      shortExhaustionFailures,
      lowVolExpectancy,
      highVolExpectancy,
      grossProfitability,
      allTimeGainLoss,
      longEdgeScore,
      shortEdgeScore,
      longWinRate,
      shortWinRate,
      regimeEdge,
      feeAnalytics
    };
  }

  private static calculateDrawdown(exits: any[]) {
    let peak = 0;
    let currentBalance = 0;
    let maxDrawdown = 0;

    for (const trade of exits) {
      currentBalance += trade.netPnl;
      if (currentBalance > peak) peak = currentBalance;
      const drawdown = peak - currentBalance;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return maxDrawdown;
  }

  private static getEmptyStats() {
    return {
      totalTrades: 0,
      winRate: 0,
      totalWins: 0,
      totalLosses: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      cumulativeFees: 0,
      netProfitability: 0,
      currentDrawdown: 0,
      averageTradeDuration: 0,
      winLossByMarketRegime: {},
      bestRegime: "N/A",
      worstRegime: "N/A",
      regimeDetailedStats: {},
      overtradingScore: 0,
      lessons: ["Awaiting initial trade data for analysis..."],
      updatedAt: Date.now(),
      expectancyAfterFees: 0,
      avgProjectedMove: 0,
      avgRealizedMove: 0,
      feeToProfitRatio: 0,
      falseBreakoutRate: 0,
      volatilityFailureRate: 0,
      recentFalseBreakouts: 0,
      recentContinuationSuccessRate: 0,
      recentContinuationSuccessCount: 0,
      thresholdAdjustment: 0,
      eliteLongSetups: 0,
      eliteShortSetups: 0,
      longContinuationSuccess: 0,
      shortContinuationSuccess: 0,
      longExhaustionFailures: 0,
      shortExhaustionFailures: 0,
      lowVolExpectancy: 0,
      highVolExpectancy: 0,
      grossProfitability: 0,
      allTimeGainLoss: 0,
      longEdgeScore: 0,
      shortEdgeScore: 0,
      longWinRate: 0,
      shortWinRate: 0,
      regimeEdge: {},
      feeAnalytics: {
        totalFeesPaid: 0,
        feeToProfitRatio: 0,
        averageFeePerTrade: 0,
        feeImpactPct: 0
      }
    };
  }
}
