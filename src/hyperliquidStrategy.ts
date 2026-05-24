import { botState } from "./state.js";

export interface StrategySignal {
  direction: "LONG" | "SHORT" | "NONE";
  confidence: number;
  trendScore?: number;
  trendStrength?: number;
  momentumScore?: number;
  volatilityScore?: number;
  marketRegime?: string;
  expectedMovePct?: number;
  expectedHoldMs?: number;
  rawDirection?: "LONG" | "SHORT" | "NONE";
  consecutiveCandlesCount?: number;
  tradeQualityScore?: number;
  consecutiveRegimeCount?: number;
  atrPct?: number;
  longConfidence?: number;
  shortConfidence?: number;
  reversalProbability?: number;
  exhaustionProbability?: number;
  trendPhase?: string;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export class HyperliquidStrategy {
  private priceHistories = new Map<string, number[]>();
  private maxHistory = 1000;
  
  // Advanced Candle tracking
  private candlesMap = new Map<string, Candle[]>();
  private currentCandleMap = new Map<string, Candle | null>();
  private readonly candleDurationMs = 10000; // 10 second candles
  
  // Signal confirmation window state
  private lastRawSignalMap = new Map<string, "LONG" | "SHORT" | "NONE">();
  private consecutiveCandlesCountMap = new Map<string, number>();
  private lastProcessedCandleTimeMap = new Map<string, number>();

  // Market Regime consistency state
  private lastMarketRegimeMap = new Map<string, string | null>();
  private consecutiveRegimeCountMap = new Map<string, number>();

  updatePrice(symbol: string, price: number) {
    if (price <= 0) return;
    if (!this.priceHistories.has(symbol)) this.priceHistories.set(symbol, []);
    const history = this.priceHistories.get(symbol)!;
    history.push(price);
    if (history.length > this.maxHistory) history.shift();

    const now = Date.now();
    const candleStart = Math.floor(now / this.candleDurationMs) * this.candleDurationMs;

    let currentCandle = this.currentCandleMap.get(symbol) || null;
    let candles = this.candlesMap.get(symbol) || [];

    if (!currentCandle || currentCandle.timestamp !== candleStart) {
      if (currentCandle) {
        candles.push(currentCandle);
        if (candles.length > 200) candles.shift();
      }
      currentCandle = { timestamp: candleStart, open: price, high: price, low: price, close: price };
      this.candlesMap.set(symbol, candles);
    } else {
      currentCandle.high = Math.max(currentCandle.high, price);
      currentCandle.low = Math.min(currentCandle.low, price);
      currentCandle.close = price;
    }
    this.currentCandleMap.set(symbol, currentCandle);
  }

  // Helper functions
  private calculateEMA(prices: number[], period: number): number {
    if (prices.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  calculateTradeQualityScore(confidence: number, marketRegime: string, volatilityScore: number): number {
    const confidenceWeight = 0.4;
    const regimeWeight = 0.25;
    const feeEfficiencyWeight = 0.15;
    const volatilityWeight = 0.1;
    const overallPerformanceWeight = 0.1;

    const sigFactor = confidence;
    const regimeStats = botState.analytics?.regimeDetailedStats?.[marketRegime];
    const regimeFactor = regimeStats ? regimeStats.winRate : 50;

    const feeRatio = botState.feeEfficiency?.feeToProfitRatio ?? 0;
    const feeFactor = Math.max(0, Math.min(100, (1 - feeRatio) * 100));

    const volFactor = Math.min(100, Math.max(0, (1 - volatilityScore) * 100));
    const overallFactor = botState.analytics?.winRate ?? 50;

    const score = Math.round(
      (sigFactor * confidenceWeight) +
      (regimeFactor * regimeWeight) +
      (feeFactor * feeEfficiencyWeight) +
      (volFactor * volatilityWeight) +
      (overallFactor * overallPerformanceWeight)
    );

    return Math.max(0, Math.min(100, score));
  }

  getSignal(symbol: string): StrategySignal {
    const candles = this.candlesMap.get(symbol) || [];
    const currentCandle = this.currentCandleMap.get(symbol);
    const activeCandles = [...candles];
    if (currentCandle) activeCandles.push(currentCandle);

    if (activeCandles.length < 15 && symbol === "HYPE-USDC") {
      const price = (botState.markPrices && botState.markPrices["HYPE-USDC"]) || botState.markPrice || 10;
      while (activeCandles.length < 15) {
        activeCandles.unshift({
          timestamp: Date.now() - activeCandles.length * 10000,
          open: price,
          high: price,
          low: price,
          close: price
        });
      }
    }

    if (activeCandles.length < 15) {
      return { 
        direction: "NONE", 
        confidence: 0, 
        trendScore: 0.5, 
        momentumScore: 0.5, 
        volatilityScore: 0, 
        marketRegime: "DEAD_LOW_VOL", 
        expectedMovePct: 0,
        expectedHoldMs: 0,
        tradeQualityScore: 0
      };
    }

    const currentPrice = activeCandles[activeCandles.length - 1].close;
    const closes = activeCandles.map(c => c.close);

    
    // 1. EMA Trend Filter (Requirement 4: EMA alignment)
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const trendScore = ema9 > ema21 ? 1 : (ema9 < ema21 ? 0 : 0.5);
    const trendStrength = (Math.abs(ema9 - ema21) / currentPrice) * 100;
    const isEmaBullish = ema9 > ema21;

    // 2. Momentum Filter (Requirement 4: RSI and momentum persistence)
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= 14; i++) {
      const diff = closes[closes.length - i] - closes[closes.length - i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    gains /= 14;
    losses /= 14;
    const rs = losses === 0 ? 100 : gains / losses;
    const rsi14 = losses === 0 ? 100 : 100 - (100 / (1 + rs));
    const momentumScore = rsi14 / 100;

    // 3. Volatility Score (Standard deviation over last 15 candles)
    const last15Closes = closes.slice(-15);
    const mean = last15Closes.reduce((a, b) => a + b, 0) / 15;
    const variance = last15Closes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 15;
    const stdDev = Math.sqrt(variance);
    const stdDevPct = (stdDev / currentPrice) * 100;
    const volatilityScore = Math.min(1.0, stdDevPct * 5); // Normalized between 0 and 1

    // 4. Expected Move Filter (Requirement 5)
    // Estimate expected move based on standard deviation percentage
    const expectedMovePct = stdDevPct * 2; // ~2 std dev move
    const minRequiredMovePct = 0.35; // Lower movement threshold to 0.35% as per user request

    const isExpectedMoveValid = expectedMovePct >= minRequiredMovePct;

    // 5. Chop Detection & Market Regime Blocker (Requirement 7 & 14)
    // Check for ranging chop of indicators
    // We can count SMA9 crossing SMA21 events or flips in direction in recent 12 candles
    let flips = 0;
    let lastDir: "LONG" | "SHORT" | null = null;
    for (let i = 12; i > 0; i--) {
      const cEma9 = this.calculateEMA(closes.slice(0, closes.length - i), 9);
      const cEma21 = this.calculateEMA(closes.slice(0, closes.length - i), 21);
      if (cEma9 > cEma21) {
        if (lastDir === "SHORT") flips++;
        lastDir = "LONG";
      } else if (cEma9 < cEma21) {
        if (lastDir === "LONG") flips++;
        lastDir = "SHORT";
      }
    }

    let marketRegime: string = "TRENDING";

    const isHighVol = stdDevPct > 0.08 || volatilityScore > 0.75;
    const isLowVol = stdDevPct < 0.035;

    if (isLowVol) {
      if (momentumScore < 0.4 && stdDevPct < 0.015) {
        marketRegime = "DEAD_LOW_VOL";
      } else if (momentumScore > 0.65 && trendStrength > 0.2) {
        marketRegime = "PRE_BREAKOUT_MOMENTUM";
      } else if (momentumScore > 0.5) {
        marketRegime = "HEALTHY_LOW_VOL_EXPANSION";
      } else if (stdDevPct > 0.02 && trendStrength > 0.1) {
        marketRegime = "MOMENTUM_BUILDING";
      } else {
        marketRegime = "LOW_VOL_SQUEEZE";
      }
    } else if (isHighVol) {
      if (flips >= 3 || (rsi14 > 45 && rsi14 < 55)) {
        marketRegime = "CHAOTIC_VOL";
      } else if (momentumScore > 0.8 && trendStrength > 0.4) {
        marketRegime = "EXTREME_DIRECTIONAL_VOL";
      } else if (momentumScore > 0.7 && trendStrength > 0.3) {
        marketRegime = "EARLY_PARABOLIC_EXPANSION";
      } else if (trendStrength > 0.3) {
        marketRegime = "HEALTHY_DIRECTIONAL_VOL";
      } else if (expectedMovePct > minRequiredMovePct * 2 && momentumScore > 0.6) {
        marketRegime = "LIQUIDATION_SWEEP";
      } else {
        marketRegime = "EXHAUSTION_REVERSAL";
      }
    } else if (flips >= 3) { // Repeatedly crossed EMAs
      marketRegime = "RANGING_CHOP";
    } else if (stdDevPct >= 0.035 && stdDevPct < 0.06 && momentumScore > 0.65 && trendStrength > 0.15) {
      marketRegime = "EARLY_DIRECTIONAL_EXPANSION";
    } else if (stdDevPct >= 0.035 && stdDevPct < 0.06 && momentumScore > 0.55 && trendStrength > 0.1) {
      marketRegime = "DEVELOPING_CONTINUATION";
    } else if (stdDevPct >= 0.06 && expectedMovePct > minRequiredMovePct) {
      marketRegime = "HEALTHY_DIRECTIONAL_VOL";
    } else if (trendStrength > 0.25) {
      marketRegime = "TRENDING";
    } else {
      marketRegime = "RANGING_CHOP";
    }

    // Estimate expected hold based on price volatility/noise
    const expectedHoldMs = stdDevPct > 0 ? Math.max(30000, Math.floor(120000 / (stdDevPct * 5))) : 180000;

    let longConfidence = 0;
    let shortConfidence = 0;
    let reversalProbability = 0;
    let exhaustionProbability = 0;
    let trendPhase = "DEVELOPING_TREND";

    // 1. Establish exhaustion and reversal probabilities
    if (rsi14 > 70) exhaustionProbability = Math.round(rsi14);
    else if (rsi14 < 30) exhaustionProbability = Math.round(100 - rsi14);
    else exhaustionProbability = 20;

    if (marketRegime === "EXHAUSTION_REVERSAL" || marketRegime === "CHAOTIC_VOL" || marketRegime === "LIQUIDATION_SWEEP") {
      reversalProbability = 80;
    } else if (marketRegime === "EXTREME_DIRECTIONAL_VOL") {
      reversalProbability = 35;
    }

    // 2. Trend Phase Engine: map regimes 1-to-1 to custom 8 phases
    if (marketRegime === "CHAOTIC_VOL" || marketRegime === "RANGING_CHOP") {
      trendPhase = "TREND_COLLAPSE";
    } else if (marketRegime === "EXHAUSTION_REVERSAL" || rsi14 > 78 || rsi14 < 22) {
      trendPhase = "EXHAUSTION";
    } else if (marketRegime === "LIQUIDATION_SWEEP") {
      trendPhase = "REVERSAL_TRANSITION";
    } else if (marketRegime === "EARLY_PARABOLIC_EXPANSION" || marketRegime === "EXTREME_DIRECTIONAL_VOL") {
      trendPhase = "PARABOLIC_EXTENSION";
    } else if (
      marketRegime === "POST_RALLY_CONTINUATION_LONG" || 
      marketRegime === "POST_RALLY_CONTINUATION_SHORT" || 
      marketRegime?.includes("LATE")
    ) {
      trendPhase = "LATE_CONTINUATION";
    } else if (marketRegime === "TRENDING" || marketRegime === "HEALTHY_DIRECTIONAL_VOL") {
      trendPhase = "HEALTHY_CONTINUATION";
    } else if (marketRegime === "DEVELOPING_CONTINUATION" || marketRegime === "EARLY_DIRECTIONAL_EXPANSION") {
      trendPhase = "DEVELOPING_TREND";
    } else {
      trendPhase = "EARLY_TREND";
    }

    // 3. Compute distinct LONG and SHORT confidence scores
    if (isEmaBullish) {
       longConfidence = Math.min(100, Math.round(40 + (rsi14 > 50 ? 20 : 0) + (trendStrength * 100)));
       shortConfidence = Math.max(10, Math.round(40 - (rsi14 - 50)));
    } else {
       shortConfidence = Math.min(100, Math.round(40 + (rsi14 < 50 ? 20 : 0) + (trendStrength * 100)));
       longConfidence = Math.max(10, Math.round(40 - (50 - rsi14)));
    }

    if (isExpectedMoveValid) {
       longConfidence += (isEmaBullish ? 10 : 0);
       shortConfidence += (!isEmaBullish ? 10 : 0);
    }

    // 4. Counter-Trend Reversal / Exhaustion Engine
    const isReversalZone = trendPhase === "EXHAUSTION" || trendPhase === "REVERSAL_TRANSITION" || trendPhase === "TREND_COLLAPSE";
    if (isReversalZone) {
      // If trend was bullish but exhausting, we evaluate a SHORT reversal
      if (isEmaBullish) {
         shortConfidence = Math.max(shortConfidence, Math.round(62 + (rsi14 - 70) * 1.5 + (stdDevPct * 50)));
         longConfidence = Math.min(longConfidence, Math.max(10, Math.round(25 - (rsi14 - 70))));
         reversalProbability = Math.max(reversalProbability, 75);
      } else {
         // If trend was bearish but exhausting, we evaluate a LONG reversal
         longConfidence = Math.max(longConfidence, Math.round(62 + (30 - rsi14) * 1.5 + (stdDevPct * 50)));
         shortConfidence = Math.min(shortConfidence, Math.max(10, Math.round(25 - (30 - rsi14))));
         reversalProbability = Math.max(reversalProbability, 75);
      }
    }

    // 5. Confidence Score / Setup Quality
    let rawDirection: "LONG" | "SHORT" | "NONE" = "NONE";
    let confidence = 0;
    
    // Track active confidence penalties to apply diminishing returns scaling later
    const activePenalties: { name: string; value: number }[] = [];

    // Partial scoring base
    let baseScore = 0;
    baseScore += 5; // spread quality
    baseScore += 5; // liquidity quality
    baseScore += (momentumScore > 0.5 ? 5 : 0); // volume/momentum proxy

    if (isExpectedMoveValid || marketRegime === "PRE_BREAKOUT_MOMENTUM" || marketRegime === "MOMENTUM_BUILDING") {
      const isReversalRegime = (marketRegime === "EXHAUSTION_REVERSAL" || marketRegime === "LIQUIDATION_SWEEP");

      if (isEmaBullish && rsi14 > 50) {
        if (isReversalRegime) {
           rawDirection = "SHORT"; // Exhaustion of LONG trend gives SHORT reversal signal
           baseScore += (rsi14 > 70 ? 15 : 5);
           baseScore += (stdDevPct > 0.08 ? 10 : 0);
        } else {
           rawDirection = "LONG";
           baseScore += (rsi14 > 55 ? 15 : 5); // trend acceleration
           baseScore += (stdDevPct > 0.05 ? 10 : 0); // breakout pressure
        }
        baseScore += (isExpectedMoveValid ? 10 : 0);
        baseScore += 10; // HTF alignment placeholder
        confidence = 10 + baseScore;
      } else if (!isEmaBullish && rsi14 < 50) {
        if (isReversalRegime) {
           rawDirection = "LONG"; // Exhaustion of SHORT trend gives LONG reversal signal
           baseScore += (rsi14 < 30 ? 15 : 5);
           baseScore += (stdDevPct > 0.08 ? 10 : 0);
        } else {
           rawDirection = "SHORT";
           baseScore += (rsi14 < 45 ? 15 : 5); // trend acceleration
           baseScore += (stdDevPct > 0.05 ? 10 : 0); // breakout pressure
        }
        baseScore += (isExpectedMoveValid ? 10 : 0);
        baseScore += 10; // HTF alignment placeholder
        confidence = 10 + baseScore;
      }

      // 3. Dynamic confidence weighting based on market regime and real-time volatility
      if (rawDirection !== "NONE") {
        if (marketRegime === "TRENDING" || marketRegime === "HEALTHY_DIRECTIONAL_VOL") {
          const volBoost = Math.floor(10 + (volatilityScore * 10));
          confidence += volBoost;
        } else if (["MOMENTUM_BUILDING", "PRE_BREAKOUT_MOMENTUM", "EARLY_DIRECTIONAL_EXPANSION", "DEVELOPING_CONTINUATION", "HEALTHY_LOW_VOL_EXPANSION"].includes(marketRegime)) {
          confidence += 15;
        } else if (marketRegime === "RANGING_CHOP" || marketRegime === "CHAOTIC_VOL") {
          const chopPenalty = Math.min(40, Math.floor(15 + (flips * 2) + (volatilityScore * 5)));
          activePenalties.push({ name: "RANGING_CHOP", value: chopPenalty });
        } else if (marketRegime === "DEAD_LOW_VOL") {
          const lowVolPenalty = Math.max(0, Math.min(25, Math.floor(10 - (stdDevPct * 50))));
          activePenalties.push({ name: "DEAD_LOW_VOL", value: lowVolPenalty });
        } else if (marketRegime === "LOW_VOL_SQUEEZE" || marketRegime === "PRE_BREAKOUT_MOMENTUM" || marketRegime === "HEALTHY_LOW_VOL_EXPANSION") {
            let sqzPenalty = Math.max(0, Math.min(15, Math.floor(5 - (stdDevPct * 20))));
            const matchedCmc = botState.cmcIntelligence?.assets.find(a => a.matchedSymbol === symbol || a.symbol === symbol);
            if (matchedCmc) {
                const strongestNarrative = botState.cmcIntelligence?.strongestNarrative || "AI";
                if (matchedCmc.narrative === strongestNarrative && matchedCmc.volumeGrowth24h > 10) {
                    sqzPenalty = 0; // Narrative strength removes compression penalties
                }
            }
            if (sqzPenalty > 0) activePenalties.push({ name: marketRegime, value: sqzPenalty });
        }
      }
    }

    // Ensure confidence doesn't exceed 100 or drop below 0
    let baseConfidenceCap = Math.max(0, Math.min(100, confidence));
    confidence = baseConfidenceCap;

    let consecutiveCandlesCount = this.consecutiveCandlesCountMap.get(symbol) || 0;
    let lastRawSignal = this.lastRawSignalMap.get(symbol) || "NONE";
    let lastProcessedCandleTime = this.lastProcessedCandleTimeMap.get(symbol) || 0;
    let lastMarketRegime = this.lastMarketRegimeMap.get(symbol) || null;
    let consecutiveRegimeCount = this.consecutiveRegimeCountMap.get(symbol) || 0;

    // 7. Signal Confirmation Window (Requirement 2 with refined Real-time Validity Tracking)
    // Track validity continuously across ticks and candle completions
    if (rawDirection === "NONE") {
      consecutiveCandlesCount = 0;
      lastRawSignal = "NONE";
    } else if (rawDirection !== lastRawSignal) {
      lastRawSignal = rawDirection;
      consecutiveCandlesCount = 1; // Start at 1 on fresh direction signal
    }

    // Market regime consistency tracking
    if (lastMarketRegime === null) {
      lastMarketRegime = marketRegime;
      consecutiveRegimeCount = 1;
    } else if (marketRegime !== lastMarketRegime) {
      lastMarketRegime = marketRegime;
      consecutiveRegimeCount = 1;
    }

    const currentCompletedCount = candles.length;
    if (currentCompletedCount !== lastProcessedCandleTime) {
      lastProcessedCandleTime = currentCompletedCount;
      
      // Increment signal direction counter if valid and matching
      if (rawDirection !== "NONE" && rawDirection === lastRawSignal) {
        consecutiveCandlesCount++;
      }

      // Increment regime consistency counter if matching
      if (marketRegime === lastMarketRegime) {
        consecutiveRegimeCount++;
      }
    }

    // Relaxed confirmation logic for crypto markets
    let confirmedDirection: "LONG" | "SHORT" | "NONE" = "NONE";
    const isOverrideActive = botState.analytics?.TOO_CONSERVATIVE_OVERRIDE_ACTIVE === true;
    const isSuddenReversal = marketRegime === "EXHAUSTION_REVERSAL" || marketRegime === "LIQUIDATION_SWEEP";
    
    if (isSuddenReversal) {
      if (lastRawSignal !== "NONE") {
         confirmedDirection = lastRawSignal;
         if (Math.random() > 0.95) console.log(`[EARLY_REVERSAL_CONFIRMATION] Immediate signal confirmation for ${symbol} due to sudden reversal regime.`);
      }
    } else if (consecutiveCandlesCount >= (isOverrideActive ? 1 : 2)) { 
      if (consecutiveRegimeCount >= (isOverrideActive ? 1 : 2)) { 
        confirmedDirection = lastRawSignal;
      }
    }

    this.consecutiveCandlesCountMap.set(symbol, consecutiveCandlesCount);
    this.lastRawSignalMap.set(symbol, lastRawSignal);
    this.lastProcessedCandleTimeMap.set(symbol, lastProcessedCandleTime);
    this.lastMarketRegimeMap.set(symbol, lastMarketRegime);
    this.consecutiveRegimeCountMap.set(symbol, consecutiveRegimeCount);

    // Diminishing penalty scaling: Combine all penalties smoothly and limit total stack
    let finalConfidence = confidence;
    let penaltyStackReason: string[] = [];
    
    if (confirmedDirection === "NONE") {
       const isExplosive = marketRegime === "PARABOLIC_CONTINUATION" || marketRegime === "DEVELOPING_PARABOLIC_CONTINUATION" || marketRegime === "EARLY_MOMENTUM_EXPANSION";
       let freshSignalPenalty = consecutiveCandlesCount === 1 ? (isExplosive ? 10 : 20) : (consecutiveCandlesCount === 0 ? (isExplosive ? 15 : 30) : (isExplosive ? 0 : 10));
       
       if (isExplosive && freshSignalPenalty < 20) {
         console.log(`[HIGH_RISK_CONFIRMATION_REDUCED] Hesitation penalty relaxed for ${symbol} due to explosive transition: ${marketRegime}`);
         if (marketRegime === "EARLY_MOMENTUM_EXPANSION" || marketRegime === "DEVELOPING_PARABOLIC_CONTINUATION") {
             console.log(`[TRANSITIONAL_MOMENTUM_CLASSIFIED] Setup classified as developing transitional continuation. Escalating execution priority.`);
         }
       }

       if (isOverrideActive) {
           freshSignalPenalty = Math.max(0, freshSignalPenalty - 15); // Reduce penalty
       }
       if (freshSignalPenalty > 0) {
         activePenalties.push({ name: "FRESH_SIGNAL", value: freshSignalPenalty });
       }
    } else {
       // Confirmation Escalation: if momentum persists over multiple scans, progressively increase execution confidence
       if (consecutiveCandlesCount >= 2 && momentumScore > 0.6) {
          const escalationBonus = Math.min(15, (consecutiveCandlesCount - 1) * 3);
          confidence += escalationBonus;
          console.log(`[MOMENTUM_PERSISTENCE_ESCALATED] Appending +${escalationBonus.toFixed(1)} to confidence for ${symbol} due to persistent momentum and consecutive sweeps.`);
          if (consecutiveCandlesCount > 3) {
            console.log(`[PARABOLIC_CONTINUATION_CONFIRMED] Multi-scan momentum confirms directional drive on ${symbol}.`);
          }
       }
    }

    // Sort penalties descending (highest first)
    activePenalties.sort((a, b) => b.value - a.value);
    
    let totalPenalty = 0;
    let scalingFactor = 1.0;
    for (const penalty of activePenalties) {
      totalPenalty += penalty.value * scalingFactor;
      penaltyStackReason.push(`${penalty.name}(-${(penalty.value * scalingFactor).toFixed(1)})`);
      scalingFactor *= 0.4; // diminishing returns: 100% of primary, 40% of secondary, 16% of tertiary, etc.
    }
    
    // Cap total cumulative confidence penalty to at most 22 points
    totalPenalty = Math.min(22, totalPenalty);
    
    finalConfidence = Math.max(10, confidence - totalPenalty);

    // Log if penalty stack collapse detected
    if (baseConfidenceCap >= 50 && finalConfidence < 35 && symbol === "HYPE-USDC") {
       console.log(`[PENALTY_STACK_COLLAPSE_DETECTED] ${symbol} | Base Conf: ${baseConfidenceCap} | Final Conf: ${finalConfidence} | Penalties: ${penaltyStackReason.join(", ")}`);
    }

    // Calculate quality score
    const tradeQualityScore = this.calculateTradeQualityScore(finalConfidence, marketRegime, volatilityScore);

    // Calculate ATR (14 period)
    let atrPct = 0;
    if (activeCandles.length >= 15) {
      let trSum = 0;
      for (let i = activeCandles.length - 14; i < activeCandles.length; i++) {
        const c = activeCandles[i];
        const pc = activeCandles[i - 1].close;
        const tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
        trSum += tr;
      }
      const atr = trSum / 14;
      atrPct = (atr / currentPrice) * 100;
    }

    return {
      direction: confirmedDirection as "LONG" | "SHORT" | "NONE",
      confidence: finalConfidence,
      trendScore,
      trendStrength,
      momentumScore,
      volatilityScore,
      marketRegime: marketRegime as any,
      expectedMovePct,
      expectedHoldMs,
      rawDirection: rawDirection as "LONG" | "SHORT" | "NONE",
      consecutiveCandlesCount,
      tradeQualityScore,
      consecutiveRegimeCount,
      atrPct,
      longConfidence,
      shortConfidence,
      reversalProbability,
      exhaustionProbability,
      trendPhase
    };
  }
}

export const strategy = new HyperliquidStrategy();
