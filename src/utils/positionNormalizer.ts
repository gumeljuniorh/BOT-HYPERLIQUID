export interface NormalizedPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  notional: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  roe: number; // in percent, e.g. 15.5
  leverage: string | number;
  takeProfit: number | null;
  stopLoss: number | null;
  dynamicSl: number | null;
  trailingStatus: string;
  runnerStatus: string;
  timeInTrade: string;
  liquidationPrice: number | null;
  lastUpdated: number;
}

/**
 * Normalizes open positions from all conceivable backend data sources.
 * Looks into activePositions, positions, perpPositions, openPositions, accountState, and botState.
 */
export function normalizePositions(statusData: any): NormalizedPosition[] {
  if (!statusData) return [];

  const botStateVal = statusData.bot || {};
  const candidates: any[] = [];

  const addSource = (src: any) => {
    if (!src) return;
    if (Array.isArray(src)) {
      candidates.push(...src);
    } else if (typeof src === "object") {
      candidates.push(src);
    }
  };

  // Inspect all possible sources
  addSource(statusData.activePositions);
  addSource(statusData.positions);
  addSource(statusData.perpPositions);
  if (Array.isArray(statusData.openPositions)) {
    addSource(statusData.openPositions);
  }
  if (statusData.accountState?.assetPositions) {
    statusData.accountState.assetPositions.forEach((ap: any) => {
      if (ap?.position) {
        addSource(ap.position);
      } else if (ap) {
        addSource(ap);
      }
    });
  }
  if (statusData.bot) {
    addSource(statusData.bot.allPositions);
    addSource(statusData.bot.positionDetails);
  }

  const normalizedMap = new Map<string, NormalizedPosition>();

  for (const raw of candidates) {
    if (!raw) continue;

    // Resolve name of symbol safely
    const coin = (raw.coin || raw.symbol || raw.asset || botStateVal.activeSymbol || "SOL").toUpperCase().trim();
    if (!coin || coin === "USDC") continue;

    // Resolve size/quantity
    const sizeStr = raw.szi || raw.size || raw.positionSize || raw.quantity || "0";
    const sizeVal = parseFloat(sizeStr);
    if (Number.isNaN(sizeVal) || Math.abs(sizeVal) === 0) continue;

    const side: "LONG" | "SHORT" = sizeVal > 0 ? "LONG" : "SHORT";
    const uniqueKey = `${coin}-${side}`;

    const entryPrice = parseFloat(raw.entryPx || raw.entryPrice || raw.entry_price || raw.entryPxPos || "0");
    const unrealizedPnl = parseFloat(raw.unrealizedPnl || raw.pnl || raw.unrealizedPnlVal || "0");
    const roe = parseFloat(raw.returnOnEquity || raw.roe || "0") * 100;

    const leverage = raw.leverage?.value || raw.leverage || botStateVal.config?.leverage || "N/A";
    const markPrice = parseFloat(
      raw.markPx ||
      raw.markPrice ||
      botStateVal.markPrices?.[coin] ||
      botStateVal.markPrice ||
      "0"
    );

    const liquidationPrice = parseFloat(raw.liquidationPx || raw.liquidationPrice || "0");

    // Protection parameters
    const isBotActiveSym = botStateVal.activeSymbol === coin;
    const tpPrice = isBotActiveSym && botStateVal.protection?.tpPrice ? botStateVal.protection.tpPrice : (raw.tpPrice || null);
    const slPrice = isBotActiveSym && botStateVal.protection?.slPrice ? botStateVal.protection.slPrice : (raw.slPrice || null);
    const dynamicSl = isBotActiveSym && botStateVal.protection?.trailingStopPrice ? botStateVal.protection.trailingStopPrice : (raw.trailingStopPrice || null);
    
    let trailingStatus = "INACTIVE";
    if (isBotActiveSym && botStateVal.protection?.isTrailingActive) {
      trailingStatus = "ACTIVE";
    } else if (raw.isTrailingActive || raw.trailingStatus === "ACTIVE") {
      trailingStatus = "ACTIVE";
    }

    const runnerStatus = botStateVal.operationalState || "NORMAL";

    // Build human-friendly hold time from trades ledger if available
    let holdTimeFormatted = "—";
    const trades = botStateVal.trades || [];
    const entryTrade = [...trades].reverse().find((t: any) => {
      const tCoin = (t.symbol || t.coin || "").toUpperCase().trim();
      return tCoin === coin && (t.type === "ENTRY" || t.type?.toUpperCase() === "ENTRY");
    });
    if (entryTrade && entryTrade.timestamp) {
      const holdTimeMs = Date.now() - entryTrade.timestamp;
      if (holdTimeMs > 0) {
        const sec = Math.floor(holdTimeMs / 1000) % 60;
        const min = Math.floor(holdTimeMs / 60000) % 60;
        const hrs = Math.floor(holdTimeMs / 3600000);
        if (hrs > 0) {
          holdTimeFormatted = `${hrs}h ${min}m`;
        } else if (min > 0) {
          holdTimeFormatted = `${min}m ${sec}s`;
        } else {
          holdTimeFormatted = `${sec}s`;
        }
      }
    }

    const normalizedPos: NormalizedPosition = {
      symbol: coin,
      side,
      size: Math.abs(sizeVal),
      notional: Math.abs(sizeVal) * (markPrice || entryPrice),
      entryPrice,
      markPrice: markPrice || entryPrice,
      unrealizedPnl,
      roe,
      leverage,
      takeProfit: tpPrice,
      stopLoss: slPrice,
      dynamicSl,
      trailingStatus,
      runnerStatus,
      timeInTrade: holdTimeFormatted,
      liquidationPrice: liquidationPrice > 0 ? liquidationPrice : null,
      lastUpdated: Date.now()
    };

    // If duplicate candidate, only replace if size is larger to ensure we represent the fully aggregated size
    const existing = normalizedMap.get(uniqueKey);
    if (!existing || normalizedPos.size > existing.size) {
      normalizedMap.set(uniqueKey, normalizedPos);
    }
  }

  return Array.from(normalizedMap.values());
}
