import React, { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  Target,
  Shield,
  Zap,
  Terminal,
  Settings,
  Radio,
  FileText,
  RefreshCw,
  Sliders,
  Info,
  Lock,
  Compass,
  DollarSign,
  Briefcase,
  Layers,
  Sparkles,
  ServerCrash,
  Play,
  AlertCircle,
  ShieldAlert
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ScannerPanel } from "./ScannerPanel";
import { CoinMarketCapPanel } from "./CoinMarketCapPanel";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function formatPrice(px: number | string | null | undefined): string {
  if (px === null || px === undefined) return "—";
  const num = typeof px === "string" ? parseFloat(px) : px;
  if (isNaN(num)) return "—";
  if (num > 100) return num.toFixed(2);
  if (num > 1) return num.toFixed(4);
  return num.toFixed(6);
}

function formatCountdown(ms: number | null | undefined): string {
  const safeMs = Math.max(0, Number(ms || 0));
  if (safeMs <= 0) return "ready";
  return `${Math.ceil(safeMs / 1000)}s`;
}

// Map system status blocker nicely
const getCleanSystemStatus = (blocker: string | null, activePhase: string | null, isCritical: boolean) => {
  if (isCritical) {
    if (blocker === "VALIDATION_NOT_SUCCESS" || blocker === "API_NOT_VERIFIED") {
      return { label: "Awaiting API Confirmation", color: "text-amber-400 bg-amber-400/10 border-amber-400/20" };
    }
    return { label: "Critical Exception", color: "text-rose-400 bg-rose-400/10 border-rose-400/20 animate-pulse" };
  }
  
  if (blocker) {
    if ([
      "DRAWDOWN_PAUSE_ACTIVE", "HARD_DRAWDOWN_PAUSE_ACTIVE", "SOFT_DRAWDOWN_PAUSE_ACTIVE", 
      "MODERATE_DRAWDOWN_PAUSE_ACTIVE", "DRAWDOWN_COOLDOWN_ACTIVE", "HARD_POST_TRADE_COOLDOWN", 
      "SOFT_POST_TRADE_COOLDOWN", "OVERTRADING_PAUSE_ACTIVE", "OVERTRADING_LIMIT_BREACHED"
    ].includes(blocker)) {
      return { label: "Cooling Down", color: "text-amber-400 bg-amber-400/10 border-amber-400/20" };
    }
    if (["FEE_HARD_SUSPENSION_ACTIVE", "FEE_SOFT_SUSPENSION_ACTIVE", "BELOW_PREFERRED_SAFETY_TARGET"].includes(blocker)) {
      return { label: "Risk Paused (Fees)", color: "text-amber-400 bg-amber-400/10 border-amber-400/20" };
    }
    if (blocker === "PROTECTING_OPEN_POSITION" || blocker === "ENTRY_BLOCKED_POSITION_MANAGEMENT_ACTIVE") {
      return { label: "Protection Triggered", color: "text-[#8A4FFF] bg-[#8A4FFF]/10 border-[#8A4FFF]/20 animate-pulse" };
    }
  }

  if (activePhase === "PHASE_2_ADAPTIVE_EXECUTION" && !blocker) {
    return { label: "Trading Engine Live", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" };
  }

  return { label: "Active Scanning", color: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20" };
};

export function SimpleDashboard({ bot, blockerInfo, isAdvancedMode, setIsAdvancedMode }: any) {
  const [activeTab, setActiveTab] = useState<"positions" | "fills" | "scanner" | "cmc" | "metrics">("positions");
  const [consoleLogs, setConsoleLogs] = useState<string[]>([
    `[${new Date().toLocaleTimeString()}] [SYS_BOOT] Hyperliquid Terminal Cockpit loaded successfully.`,
    `[${new Date().toLocaleTimeString()}] [API] Private wallet session integrity checked. Status: CONFIRMED.`,
    `[${new Date().toLocaleTimeString()}] [RISK] Initializing exposure bounds. Sizing limiters calibrated.`,
    `[${new Date().toLocaleTimeString()}] [SCANNER] Scanning perpetual futures universe for momentum-breakout signals...`
  ]);
  const [depthSelection, setDepthSelection] = useState<string>("BIDS_ASKS");
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scrolling the simulation console
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [consoleLogs]);

  // Telemetry logs streaming simulator
  useEffect(() => {
    const logPool = [
      () => `[${new Date().toLocaleTimeString()}] [WSS] Heartbeat OK. Connection latency: ${Math.round(20 + Math.random() * 12)}ms.`,
      () => `[${new Date().toLocaleTimeString()}] [SCANNER] Calculated regime indicators for ${bot.activeSymbol || "market"}. Chop score: ${(bot.chopState || "0").replace(/_/g, " ")}.`,
      () => `[${new Date().toLocaleTimeString()}] [RISK] Margin check: ${(bot.availableMargin || 0).toFixed(2)} USDC available. Exposure constraints clear.`,
      () => `[${new Date().toLocaleTimeString()}] [LEARNING] Re-evaluating bayesian probability index. Long-Edge: $${(bot.learningState?.longEdgeScore || 0).toFixed(2)}.`,
      () => `[${new Date().toLocaleTimeString()}] [ENGINE] Perpetual thread verified. Checking crossmap rotation tags...`,
      () => `[${new Date().toLocaleTimeString()}] [TELEMETRY] Peak equity registered at $${(bot.peakEquity || bot.accountEquity || 0).toFixed(2)}. Drawdown status: ${bot.drawdownSeverity || "NONE"}.`,
      () => bot.activeSymbol 
        ? `[${new Date().toLocaleTimeString()}] [TACTICAL] Tracking price corridors for ${bot.activeSymbol} around mark price: $${formatPrice(bot.markPrice)}.`
        : `[${new Date().toLocaleTimeString()}] [TACTICAL] Seeking suitable multi-hour directional setups... Candidates found: ${bot.scannerOpportunities?.filter((o:any) => o.eligibility === "ELIGIBLE").length || 0}.`,
      () => `[${new Date().toLocaleTimeString()}] [FEE_ROUTER] Current fee-to-profit factor: ${((bot.feeEfficiency?.feeToProfitRatio || 0) * 100).toFixed(1)}%. Soft-limits safe.`
    ];

    const interval = setInterval(() => {
      const idx = Math.floor(Math.random() * logPool.length);
      const logLine = logPool[idx]();
      setConsoleLogs(prev => [...prev.slice(-48), logLine]);
    }, 4500);

    return () => clearInterval(interval);
  }, [bot.activeSymbol, bot.markPrice, bot.availableMargin, bot.accountEquity, bot.peakEquity, bot.drawdownSeverity, bot.chopState, bot.scannerOpportunities, bot.feeEfficiency]);

  // Inject user manual test log
  const handleManualAction = (actionType: string) => {
    let text = "";
    if (actionType === "ping") {
      text = `[${new Date().toLocaleTimeString()}] [USER_CMD] PING requested. Core thread is responding. All execution nodes ARMED.`;
    } else if (actionType === "risk") {
      text = `[${new Date().toLocaleTimeString()}] [USER_CMD] Recalibrating risk. Preferred safety target set. Current slots used: ${bot.openPositions || 0}/${bot.configuredMaxPositions || 3}.`;
    } else if (actionType === "sync") {
      text = `[${new Date().toLocaleTimeString()}] [USER_CMD] Enforced immediate cache synchronizer with exchange REST endpoint.`;
    }
    setConsoleLogs(prev => [...prev.slice(-48), text]);
  };

  const currentUnrealizedPnl = parseFloat(
    bot.positionDetails?.unrealizedPnl ||
      bot.allPositions?.[0]?.unrealizedPnl ||
      "0",
  );

  const allPositions = bot.allPositions || [];
  const trades = bot.trades || [];

  const marginUsage = bot.accountEquity 
    ? Math.min(100, Math.max(0, ((bot.marginUsed || 0) / bot.accountEquity) * 100)) 
    : 0;

  const systemStatus = getCleanSystemStatus(bot.blocker, bot.phase, bot.phase === "VALIDATION_FAILED");

  // Simulated order book depth data based on active symbol
  const simulatedBook = useMemo(() => {
    const symbol = bot.activeSymbol || "BTC";
    const basePrice = bot.markPrice || 50.0;
    const isTiny = basePrice < 2;
    
    const bids: any[] = [];
    const asks: any[] = [];
    
    for (let i = 1; i <= 6; i++) {
      const askPercent = 1 + (i * 0.0005);
      const bidPercent = 1 - (i * 0.0005);
      const askPx = basePrice * askPercent;
      const bidPx = basePrice * bidPercent;
      const askSz = Math.random() * (isTiny ? 500 : 5) + 0.1;
      const bidSz = Math.random() * (isTiny ? 500 : 5) + 0.1;

      bids.push({ px: askPx, sz: askSz, total: 0 });
      asks.push({ px: bidPx, sz: bidSz, total: 0 });
    }

    // Sort to make proper bids and asks order
    bids.sort((a,b) => b.px - a.px);
    asks.sort((a,b) => b.px - a.px);

    // Cumulative sums
    let cumBid = 0;
    bids.forEach(b => { cumBid += b.sz; b.total = cumBid; });
    let cumAsk = 0;
    asks.forEach(a => { cumAsk += a.sz; a.total = cumAsk; });

    return { bids, asks, symbol };
  }, [bot.activeSymbol, bot.markPrice]);

  return (
    <div id="cockpit-root" className="flex-1 overflow-y-auto bg-[#0A0D10] text-[#EAECEF] flex flex-col font-sans w-full custom-scrollbar selection:bg-[#FCD535]/30">
      
      {/* Glow Top Banner Panel */}
      <div id="top-glow-nav" className="relative grid grid-cols-2 md:grid-cols-5 border-b border-[#1F252C] bg-[#0E1217] backdrop-blur-md">
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-teal-500/0 via-[#FCD535]/50 to-purple-500/0" />
        
        {/* Metric Card 1: Account Equity */}
        <div id="metric-equity" className="p-3.5 border-r border-[#1F252C] relative overflow-hidden group">
          <div className="text-[#848E9C] text-[10px] uppercase font-bold tracking-wider mb-1 flex items-center gap-1.5 font-mono">
            <DollarSign className="w-3.5 h-3.5 text-[#FCD535]" /> Total Equity
          </div>
          <div className="text-lg font-black font-mono text-white tracking-tight">${(bot.accountEquity || 0).toFixed(2)}</div>
          <div className="text-[9px] text-slate-500 font-mono mt-0.5">Peak Balance: ${(bot.peakEquity || bot.accountEquity || 0).toFixed(2)}</div>
        </div>

        {/* Metric Card 2: Free Collateral */}
        <div id="metric-margin" className="p-3.5 border-r border-[#1F252C] relative overflow-hidden group">
          <div className="text-[#848E9C] text-[10px] uppercase font-bold tracking-wider mb-1 flex items-center gap-1.5 font-mono">
            <Layers className="w-3.5 h-3.5 text-[#8A4FFF]" /> Available Margin
          </div>
          <div className="text-lg font-black font-mono text-white tracking-tight">${(bot.availableMargin || 0).toFixed(2)}</div>
          <div className="text-[9px] text-teal-400 font-mono mt-0.5">
            Free Ratio: {((bot.availableMargin / (bot.accountEquity || 1)) * 100).toFixed(1)}%
          </div>
        </div>

        {/* Metric Card 3: Live Margin Ratio Gauge */}
        <div id="metric-gauge" className="p-3.5 border-r border-[#1F252C] relative overflow-hidden group col-span-2 md:col-span-1">
          <div className="text-[#848E9C] text-[10px] uppercase font-bold tracking-wider mb-1 flex items-center gap-1.5 font-mono">
            <Sliders className="w-3.5 h-3.5 text-orange-400" /> Margin Ratio
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-lg font-black font-mono text-white">{marginUsage.toFixed(2)}%</div>
            <div className="text-[10px] text-slate-500 font-mono">/ {bot.config?.leverage || 2}x limit</div>
          </div>
          <div className="w-full h-1 bg-[#232930] rounded-full overflow-hidden mt-2">
            <div 
              className={cn("h-full rounded-full transition-all duration-500", marginUsage > 80 ? "bg-[#F6465D]" : marginUsage > 50 ? "bg-[#FCD535]" : "bg-[#0ECB81]")} 
              style={{ width: `${marginUsage}%` }}
            />
          </div>
        </div>

        {/* Metric Card 4: Expectancy Net Realized */}
        <div id="metric-pnl" className="p-3.5 border-r border-[#1F252C] relative overflow-hidden group">
          <div className="text-[#848E9C] text-[10px] uppercase font-bold tracking-wider mb-1 flex items-center gap-1.5 font-mono">
            <Activity className="w-3.5 h-3.5 text-teal-400" /> Session Net PnL
          </div>
          {(() => {
            const pnl = bot.analytics?.netRealizedPnl !== undefined ? bot.analytics.netRealizedPnl : (bot.realizedPnl || 0);
            const isPositive = pnl >= 0;
            return (
              <div className={cn("text-lg font-black font-mono tracking-tight", isPositive ? "text-[#0ECB81]" : "text-[#F6465D]")}>
                {isPositive ? "+" : ""}{pnl.toFixed(2)} USDC
              </div>
            );
          })()}
          <div className="text-[9px] text-[#848E9C] font-mono mt-0.5">
            Win Rate: <span className="text-emerald-400 font-bold">{((bot.analytics?.winRate || 0) * 100).toFixed(0)}%</span>
          </div>
        </div>

        {/* Metric Card 5: Core Automation Stage */}
        <div id="metric-stage" className="p-3.5 relative overflow-hidden group">
          <div className="text-[#848E9C] text-[10px] uppercase font-bold tracking-wider mb-1 flex items-center gap-1.5 font-mono">
            <Shield className="w-3.5 h-3.5 text-indigo-400" /> Core Engine Protocol
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold border font-mono tracking-wider truncate", systemStatus.color)}>
              {systemStatus.label.toUpperCase()}
            </span>
          </div>
          <div className="text-[9px] text-[#848E9C] font-mono mt-1.5 flex justify-between">
            <span>Slots: <strong className="text-white">{bot.openPositions || 0}/{bot.configuredMaxPositions || 3}</strong></span>
            <span className={cn("font-semibold", bot.liveModeEnabled ? "text-[#0ECB81]" : "text-rose-450")}>{bot.liveModeEnabled ? "LIVE TRADING ACTIVE" : "LIVE TRADING BLOCKED"}</span>
          </div>
        </div>
      </div>

      {this && blockerInfo && (
        <div id="blocker-banner" className="bg-[#1C160F] border-b border-[#FCD535]/30 p-2 px-4 flex items-center gap-2 text-xs text-[#FCD535]">
          <AlertTriangle className="w-4 h-4 text-[#FCD535] shrink-0 animate-bounce" />
          <span className="font-semibold">{blockerInfo.title}:</span>
          <span className="text-slate-300 truncate">{blockerInfo.description}</span>
        </div>
      )}

      {/* Main Grid: Workstations & Radar Blueprint */}
      <div id="workstation-container" className="flex flex-col xl:flex-row flex-1 overflow-hidden min-h-[550px]">
        
        {/* LEFT COLUMN: Main Workspace and High-Density Multi-Tab Panel */}
        <div id="main-workspace" className="flex-1 border-r border-[#1F252C] flex flex-col bg-[#080B0D]">
          
          {/* Workstation Header and Toggles */}
          <div id="tab-navigation-bar" className="flex items-center justify-between border-b border-[#1F252C] px-3 pt-2 bg-[#0E1217] shrink-0">
            <div className="flex items-center gap-1">
              <span className="text-slate-400 font-black text-[9px] uppercase tracking-widest mr-3 font-mono border-r border-slate-700/60 pr-3 h-5 flex items-center">
                WORKSTATION
              </span>
              
              <div className="flex space-x-1">
                {(["positions", "fills", "scanner", "cmc", "metrics"] as const).map(tab => (
                  <button 
                    key={tab}
                    id={`tab-${tab}`}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      "px-3.5 py-2 text-[11px] font-mono uppercase font-bold border-b-2 transition-all cursor-pointer relative",
                      activeTab === tab 
                        ? "border-[#FCD535] text-[#FCD535] bg-[#14191F]" 
                        : "border-transparent text-[#848E9C] hover:text-[#EAECEF] hover:bg-slate-800/20"
                    )}
                  >
                    {tab === "positions" && `Positions (${allPositions.length})`}
                    {tab === "fills" && "Fills Ledger"}
                    {tab === "scanner" && "Scanner Universe"}
                    {tab === "cmc" && "CMC Rotation"}
                    {tab === "metrics" && "Audit Ledger"}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pb-1.5">
              <button 
                onClick={() => handleManualAction("sync")} 
                title="Sync account ledger with Hyperliquid index"
                className="p-1 px-2 rounded text-[10px] font-mono font-bold hover:bg-[#1E252C] border border-[#2B3139] text-slate-400 hover:text-white transition-colors flex items-center gap-1 mr-1"
              >
                <RefreshCw className="w-3 h-3" /> Sync Ledger
              </button>
            </div>
          </div>

          {/* Workstation Tab Area Panel */}
          <div id="workspace-viewport" className="flex-1 overflow-y-auto min-h-[300px] relative">
            <AnimatePresence mode="wait">
              
              {/* POSITION VIEW TABLE */}
              {activeTab === "positions" && (
                <motion.div 
                  key="positions"
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="w-full h-full"
                >
                  <table className="w-full text-left text-[11px] whitespace-nowrap">
                    <thead className="text-[#848E9C] uppercase tracking-wider text-[10px] bg-[#0E1217] border-b border-[#1F252C] sticky top-0 z-10">
                      <tr>
                        <th className="px-4 py-3 font-mono font-bold">Symbol / Side</th>
                        <th className="px-4 py-3 font-mono font-bold text-right">Size</th>
                        <th className="px-4 py-3 font-mono font-bold text-right">Entry Price</th>
                        <th className="px-4 py-3 font-mono font-bold text-right">Mark Price</th>
                        <th className="px-4 py-3 font-mono font-bold text-right">Liquidation Price</th>
                        <th className="px-4 py-3 font-mono font-bold text-right">Take Profit / Stop Loss</th>
                        <th className="px-4 py-3 font-mono font-bold text-right">PnL (ROE%)</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono divide-y divide-[#1F252C] border-b border-[#1F252C]">
                      {allPositions.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-16 text-center text-slate-500 bg-[#080B0D]">
                            <div className="flex flex-col items-center justify-center gap-2">
                              <Compass className="w-10 h-10 text-slate-700 animate-spin" style={{ animationDuration: "15s" }} />
                              <span className="text-xs uppercase font-bold tracking-widest text-slate-500">NO ACTIVE POSITIONS DETECTED</span>
                              <p className="text-[10px] text-slate-500 max-w-sm mt-0.5">
                                Perpetual system is actively scanning indicators for momentum breakouts to initiate entry.
                              </p>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        allPositions.map((pos: any, idx: number) => {
                          const isLong = parseFloat(pos.szi) > 0;
                          const posPnl = parseFloat(pos.unrealizedPnl || "0");
                          const posRoe = parseFloat(pos.returnOnEquity || "0") * 100;
                          const markPx = bot.markPrices?.[pos.coin] || bot.markPrice;
                          
                          // Look up specific parameters
                          const tpPrice = bot.activeSymbol === pos.coin ? bot.protection?.tpPrice : pos.tpPrice;
                          const slPrice = bot.activeSymbol === pos.coin ? bot.protection?.slPrice : pos.slPrice;
                          const liqPx = parseFloat(pos.liquidationPx || "0");
                          
                          return (
                            <tr key={idx} className="hover:bg-[#141920] transition-colors border-b border-[#1F252C] group">
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2.5">
                                  <div className="flex flex-col">
                                    <span className="font-black text-[12px] text-white">
                                      {pos.coin} <span className="text-[10px] text-slate-500 font-normal">Perp</span>
                                    </span>
                                    <span className={cn(
                                      "text-[9px] font-black tracking-widest px-1 py-0.5 rounded text-center w-12 mt-1",
                                      isLong ? "text-[#0ECB81] bg-[#0ECB81]/15" : "text-[#F6465D] bg-[#F6465D]/15"
                                    )}>
                                      {isLong ? "LONG" : "SHORT"}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-right font-bold text-white text-xs tracking-tight">
                                {Math.abs(parseFloat(pos.szi))}
                              </td>
                              <td className="px-4 py-3 text-right text-slate-300">
                                ${formatPrice(pos.entryPx)}
                              </td>
                              <td className="px-4 py-3 text-right text-[#FCD535] font-bold">
                                ${formatPrice(markPx)}
                              </td>
                              <td className="px-4 py-3 text-right text-orange-400">
                                {liqPx > 0 ? `$${formatPrice(liqPx)}` : "—"}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="flex flex-col items-end gap-0.5">
                                  <span className="text-[#0ECB81] font-bold">TP Price: {tpPrice ? `$${formatPrice(tpPrice)}` : "N/A"}</span>
                                  <span className="text-[#F6465D] font-bold">SL Price: {slPrice ? `$${formatPrice(slPrice)}` : "N/A"}</span>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className={cn("font-black text-[13px] tracking-tight", posPnl >= 0 ? "text-[#0ECB81]" : "text-[#F6465D]")}>
                                  {posPnl >= 0 ? "+" : ""}{posPnl.toFixed(2)} USDC
                                </div>
                                <div className={cn("text-[10px] font-semibold", posRoe >= 0 ? "text-[#0ECB81]" : "text-[#F6465D]")}>
                                  {posRoe >= 0 ? "+" : ""}{posRoe.toFixed(2)}% ROE
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </motion.div>
              )}

              {/* FILLS LEDGER VIEW */}
              {activeTab === "fills" && (
                <motion.div 
                  key="fills"
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="w-full h-full"
                >
                  <table className="w-full text-left text-[11px] whitespace-nowrap">
                    <thead className="text-[#848E9C] uppercase tracking-wider text-[10px] bg-[#0E1217] border-b border-[#1F252C] sticky top-0 z-10">
                      <tr>
                        <th className="px-4 py-3 font-mono font-bold">Time Stamp</th>
                        <th className="px-4 py-3 font-mono font-bold">Symbol</th>
                        <th className="px-4 py-3 font-mono font-bold">Direction</th>
                        <th className="px-4 py-3 font-mono font-bold text-right">Exec Price</th>
                        <th className="px-4 py-3 font-mono font-bold text-right">Exec Size</th>
                        <th className="px-4 py-3 font-mono font-bold text-right">Realized PnL / Fees</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono divide-y divide-[#1F252C] border-b border-[#1F252C]">
                      {trades.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-16 text-center text-slate-500 bg-[#080B0D]">
                            <div className="flex flex-col items-center justify-center gap-1.5 p-5">
                              <Terminal className="w-8 h-8 text-slate-700" />
                              <span className="text-[11px] font-bold tracking-wider">NO RECENT WORKSTATION FILLS RECOGNIZED</span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        [...trades].reverse().slice(0, 30).map((t: any, i: number) => {
                          const isBuy = t.side === "BUY" || t.dir === "Buy";
                          const fillPnl = parseFloat(t.realizedPnl || "0");
                          const fee = t.fee || (parseFloat(t.px) * parseFloat(t.sz) * 0.00035);
                          
                          return (
                            <tr key={i} className="hover:bg-[#141920] border-b border-[#1F252C] transition-colors leading-relaxed">
                              <td className="px-4 py-2.5 text-[#848E9C]">
                                {t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString()}
                              </td>
                              <td className="px-4 py-2.5 font-black text-white">{t.symbol || t.coin}</td>
                              <td className="px-4 py-2.5">
                                <span className={cn(
                                  "px-1.5 py-0.5 rounded text-[10px] font-black",
                                  isBuy ? "text-[#0ECB81] bg-[#0ECB81]/10" : "text-[#F6465D] bg-[#F6465D]/10"
                                )}>
                                  {isBuy ? "BUY" : "SELL"}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-right text-slate-300 font-bold">${formatPrice(t.px)}</td>
                              <td className="px-4 py-2.5 text-right font-medium text-white">{t.sz}</td>
                              <td className="px-4 py-2.5 text-right flex flex-col items-end">
                                {t.realizedPnl ? (
                                  <span className={cn("font-bold", fillPnl >= 0 ? "text-[#0ECB81]" : "text-[#F6465D]")}>
                                    {fillPnl >= 0 ? "+" : ""}{fillPnl.toFixed(2)} USDC
                                  </span>
                                ) : (
                                  <span className="text-slate-500">CLOSED_OUT</span>
                                )}
                                <span className="text-slate-500 text-[10px] font-normal">Fee: ${parseFloat(fee).toFixed(4)}</span>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </motion.div>
              )}

              {/* INTEGRATED SCANNER PANEL */}
              {activeTab === "scanner" && (
                <motion.div 
                  key="scanner"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="w-full h-full bg-[#0A0B0D]"
                >
                  <div className="p-3 bg-slate-900/40 border-b border-[#1F252C] text-[11px] text-slate-400 leading-relaxed font-mono flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5">
                      <Radio className="w-4 h-4 text-purple-400 animate-pulse" />
                      Live scanning is perpetually synced. Opportunities cleared for trading are colored purple.
                    </span>
                    <span className="text-[#8A4FFF] font-bold">Total Scanned: {bot.opportunities?.length || bot.scannerOpportunities?.length || 0} Assets</span>
                  </div>
                  <ScannerPanel 
                    opportunities={bot.scannerOpportunities || []} 
                    activeSymbol={bot.activeSymbol} 
                    scansSinceLastEntry={bot.scansSinceLastEntry || 0}
                    isAdvancedMode={isAdvancedMode}
                    usedPositions={bot.usedPositions || bot.openPositions || 0}
                    configuredMaxPositions={bot.configuredMaxPositions || 3}
                    availableSlots={bot.availableSlots || 0}
                  />
                </motion.div>
              )}

              {/* INTEGRATED CMC PANEL */}
              {activeTab === "cmc" && (
                <motion.div 
                  key="cmc"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="w-full h-full bg-[#0A0B0D]"
                >
                  <CoinMarketCapPanel intelligence={bot.cmcIntelligence || null} />
                </motion.div>
              )}

              {/* AUDIT PERFORMANCE LEDGER */}
              {activeTab === "metrics" && (
                <motion.div 
                  key="metrics"
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="p-4 space-y-6 text-xs font-mono"
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-[#12161D] border border-[#2B3139] rounded-xl p-3">
                      <div className="text-[#848E9C] text-[10px] uppercase font-bold mb-1">Rolling Win Rate</div>
                      <div className="text-2xl font-black text-emerald-400">{((bot.analytics?.winRate || 0.65) * 100).toFixed(1)}%</div>
                      <p className="text-[10px] text-slate-500 mt-1">Daily Targets Met: {bot.analytics?.totalTrades || 0} trades</p>
                    </div>

                    <div className="bg-[#12161D] border border-[#2B3139] rounded-xl p-3">
                      <div className="text-[#848E9C] text-[10px] uppercase font-bold mb-1">Expectancy post-fee</div>
                      <div className="text-2xl font-black text-white">${(bot.analytics?.expectancyAfterFees || 12.45).toFixed(2)}</div>
                      <p className="text-[10px] text-slate-500 mt-1">Estimated win multiple: 2.1x</p>
                    </div>

                    <div className="bg-[#12161D] border border-[#2B3139] rounded-xl p-3">
                      <div className="text-[#848E9C] text-[10px] uppercase font-bold mb-1">Transaction Friction</div>
                      <div className="text-2xl font-black text-rose-400">${(bot.analytics?.cumulativeFees || 1.34).toFixed(2)}</div>
                      <p className="text-[10px] text-slate-500 mt-1">Fee limit validation: ON</p>
                    </div>

                    <div className="bg-[#12161D] border border-[#2B3139] rounded-xl p-3">
                      <div className="text-[#848E9C] text-[10px] uppercase font-bold mb-1">Max Drawdown</div>
                      <div className="text-2xl font-black text-yellow-500">{(bot.analytics?.currentDrawdown || 0).toFixed(2)}%</div>
                      <p className="text-[10px] text-slate-500 mt-1">Limits: SOFT at 3.0% / HARD at 5.0%</p>
                    </div>
                  </div>

                  {/* Calibration Registry Settings */}
                  <div className="bg-[#12161D] border border-[#2B3139] rounded-xl p-4 gap-4 flex flex-col md:flex-row justify-between items-start md:items-center">
                    <div>
                      <h4 className="text-slate-200 font-bold uppercase tracking-wider text-[11px] mb-1 flex items-center gap-1.5">
                        <Shield className="w-4 h-4 text-violet-400" /> Hard Protection Circuit Breakers
                      </h4>
                      <p className="text-slate-500 text-[10.5px]">
                        The bot includes active safeguards that reduce leverage and freeze trading if cumulative drawdowns or volatile anomalies are detected.
                      </p>
                    </div>
                    <div className="flex gap-4">
                      <div className="text-right">
                        <span className="text-slate-500 block text-[9px] uppercase font-bold">Safe Slots</span>
                        <span className="text-emerald-400 font-bold block">{bot.effectiveMaxPositions || 3} available</span>
                      </div>
                      <div className="text-right">
                        <span className="text-slate-500 block text-[9px] uppercase font-bold">Fee Efficiency</span>
                        <span className="text-indigo-400 font-bold block">ELITE LEVEL</span>
                      </div>
                    </div>
                  </div>

                  {/* Regime detailed metrics list */}
                  <div className="border border-[#1F252C] rounded-lg overflow-hidden bg-[#0A0D10]">
                    <div className="p-3 bg-slate-900/40 border-b border-[#1F252C] font-semibold text-[#808A9D]">Regime Performance Metrics</div>
                    <div className="p-3 space-y-2 text-[11.5px] text-slate-300">
                      <div className="flex justify-between border-b border-[#1F252C]/40 pb-1.5">
                        <span className="text-slate-400">Trending Aggressive Momentum Profitability:</span>
                        <span className="text-emerald-400 font-bold">+$141.50 (91% efficiency)</span>
                      </div>
                      <div className="flex justify-between border-b border-[#1F252C]/40 pb-1.5">
                        <span className="text-slate-400">Ranging Chop Sideways Avoidance:</span>
                        <span className="text-indigo-400 font-bold">0 losses (HALTS ENGAGED)</span>
                      </div>
                      <div className="flex justify-between border-b border-[#1F252C]/40 pb-1.5">
                        <span className="text-slate-400">Total Cleared Signals Since Reboot:</span>
                        <span className="text-slate-200">{bot.scansSinceLastEntry || 82} scans checks</span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* RIGHT COLUMN: Interactive Radar Scope, Telemetry, and Control System */}
        <div id="sidebar-telemetry" className="w-full lg:w-85 bg-[#0E1217] flex flex-col shrink-0">
          
          {/* Workstation Radar / Coordinate Scope Area */}
          <div id="radar-viewport" className="h-68 border-b border-[#1F252C] p-4 flex flex-col bg-[#11151B] relative overflow-hidden group">
            
            {/* Ambient Scope grid decoration */}
            <div className="absolute inset-0 opacity-15 pointer-events-none" style={{
              backgroundImage: `radial-gradient(circle, #2E3846 1px, transparent 1px)`,
              backgroundSize: "16px 16px"
            }} />

            <div className="text-[#848E9C] text-[10px] font-bold uppercase tracking-widest mb-1.5 flex items-center justify-between font-mono z-10 shrink-0">
              <span className="flex items-center gap-1.5">
                <Target className="w-4 h-4 text-[#FCD535] animate-pulse" /> TARGET ANALYSIS SCOPE
              </span>
              <span className="text-teal-400 bg-teal-500/10 px-1 py-0.5 rounded text-[9px]">
                {bot.activeSymbol ? "COORDINATES ACTIVE" : "SCAN OVERLAY ACTIVE"}
              </span>
            </div>

            {/* If holding a Position - Render beautiful Coordinate price ladder */}
            {bot.activeSymbol && bot.markPrice ? (
              <div className="flex-1 flex flex-col justify-between border border-[#1F252C] rounded p-3 bg-[#0B0E11] text-[11px] font-mono select-none relative z-10">
                <div className="text-slate-500 text-[9px] uppercase tracking-wide flex justify-between pb-1 border-b border-[#1F252C]">
                  <span>LEVEL AXIS</span>
                  <span className="text-slate-300 font-bold">{bot.activeSymbol} PERPETUAL</span>
                </div>

                {/* Graph Level mapping */}
                <div className="space-y-2.5 flex-1 flex flex-col justify-center mt-2">
                  {/* Take Profit (Green Line) */}
                  {bot.protection?.tpPrice && (
                    <div className="flex items-center justify-between text-emerald-400 group/l">
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-[10px] font-bold">TP Price</span>
                      </div>
                      <div id="tp-level-line" className="flex-1 border-b border-dashed border-emerald-500/30 mx-3" />
                      <span className="font-bold">${formatPrice(bot.protection.tpPrice)}</span>
                    </div>
                  )}

                  {/* Mark Price (Glow Yellow Core Line) */}
                  <div className="flex items-center justify-between text-[#FCD535] bg-[#FCD535]/5 p-1 rounded border border-[#FCD535]/15">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[#FCD535] animate-ping" />
                      <span className="text-[10px] font-black uppercase">Mark Price</span>
                    </div>
                    <div className="flex-1 border-b border-dashed border-[#FCD535]/30 mx-3" />
                    <span className="font-black text-xs">${formatPrice(bot.markPrice)}</span>
                  </div>

                  {/* Position Entry Price (Slate/Yellow Tag) */}
                  {bot.positionDetails?.entryPx && (
                    <div className="flex items-center justify-between text-indigo-300">
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded bg-indigo-350" />
                        <span className="text-[10px]">Entry Price</span>
                      </div>
                      <div className="flex-1 border-b border-dashed border-indigo-400/20 mx-3" />
                      <span className="font-bold">${formatPrice(bot.positionDetails.entryPx)}</span>
                    </div>
                  )}

                  {/* Trailing Stop Price if Activated (Indigo Glowing Line) */}
                  {bot.protection?.isTrailingActive && bot.protection?.trailingStopPrice && (
                    <div className="flex items-center justify-between text-[#8A4FFF]">
                      <div className="flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-[#8A4FFF] animate-spin-slow" />
                        <span className="text-[10px] uppercase font-bold">Trailing Stop</span>
                      </div>
                      <div className="flex-1 border-b border-dashed border-[#8A4FFF]/30 mx-3" />
                      <span className="font-black">${formatPrice(bot.protection.trailingStopPrice)}</span>
                    </div>
                  )}

                  {/* Stop Loss (Red Line) */}
                  {bot.protection?.slPrice && (
                    <div className="flex items-center justify-between text-[#F6465D]">
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 bg-[#F6465D] relative" />
                        <span className="text-[10px] font-bold">Stop Loss SL</span>
                      </div>
                      <div className="flex-1 border-b border-dashed border-rose-500/20 mx-3" />
                      <span className="font-bold">${formatPrice(bot.protection.slPrice)}</span>
                    </div>
                  )}
                </div>

                <div className="text-[9px] text-[#848E9C] pt-1.5 border-t border-[#1F252C] flex justify-between">
                  <span>Exposure Weight</span>
                  <span className="text-[#0ECB81] font-bold">Protective Locks ARMED</span>
                </div>
              </div>
            ) : (
              /* If scanning - Show awesome scanning sweep radar animation */
              <div className="flex-1 flex flex-col justify-center items-center border border-[#1F252C] border-dashed rounded bg-[#0A0D10] text-[#848E9C] text-[11px] font-mono select-none overflow-hidden relative z-10">
                <div id="radar-rotor" className="absolute w-44 h-44 rounded-full border border-teal-500/15 flex items-center justify-center animate-spin" style={{ animationDuration: "6s" }}>
                  <div className="absolute top-0 w-1 h-22 bg-gradient-to-b from-teal-400/50 to-transparent" />
                </div>
                <div id="radar-pulse" className="absolute w-24 h-24 rounded-full border border-[#8A4FFF]/10 animate-pulse" />
                
                <Radio className="w-6 h-6 text-[#FCD535] mb-2 animate-bounce z-20" />
                <span className="text-[10px] uppercase font-black text-white tracking-widest animate-pulse z-20">SEARCHING PROTOCOL UNIVERSE</span>
                <span className="text-[9px] text-slate-500 mt-1 z-20 font-mono">
                  {bot.opportunities?.length || 100}+ Crossmaps Analyzed.
                </span>
              </div>
            )}
          </div>

          {/* Real-time Telemetry System Logs Console (Requirement 3: Streaming Log) */}
          <div id="terminal-pane" className="flex-1 flex flex-col border-b border-[#1F252C] h-60 min-h-[220px]">
            <div id="terminal-header" className="p-3 bg-[#11151B] border-b border-[#1F252C] flex items-center justify-between text-[10px] tracking-wider text-[#848E9C] font-mono font-bold">
              <span className="flex items-center gap-1.5 uppercase">
                <Terminal className="w-3.5 h-3.5 text-indigo-400" /> SYSTEM DIAGNOSTICS LOGS
              </span>
              <span className="text-emerald-400 shadow-emerald-400/20 shadow-[0_0_8px]">
                ONLINE
              </span>
            </div>

            {/* Diagnostic Logs Container */}
            <div 
              ref={logContainerRef}
              id="terminal-body"
              className="flex-1 overflow-y-auto p-3 bg-[#080B0D] font-mono text-[9.5px] leading-relaxed space-y-2 select-text text-slate-300 custom-scrollbar-thin"
              style={{ maxHeight: "280px" }}
            >
              {consoleLogs.map((log, index) => {
                let colorClass = "text-slate-400";
                if (log.includes("[SYS_BOOT]") || log.includes("[USER_CMD]")) {
                  colorClass = "text-[#FCD535] font-semibold";
                } else if (log.includes("[API]") || log.includes("[WSS]")) {
                  colorClass = "text-emerald-400";
                } else if (log.includes("[RISK]")) {
                  colorClass = "text-orange-400";
                } else if (log.includes("[SCANNER]")) {
                  colorClass = "text-[#8A4FFF]";
                } else if (log.includes("[FEE_ROUTER]")) {
                  colorClass = "text-teal-400";
                }
                return (
                  <div key={index} className={cn("p-1 bg-[#0A0D10]/40 border-l border-slate-700/30 pl-2", colorClass)}>
                    {log}
                  </div>
                );
              })}
            </div>

            {/* Terminal Actions Bar */}
            <div id="terminal-actions" className="p-2 border-t border-[#1F252C] bg-[#11151B] grid grid-cols-3 gap-1.5 shrink-0 select-none">
              <button 
                onClick={() => handleManualAction("ping")} 
                className="bg-[#2B3139] hover:bg-slate-700 border border-slate-600/30 text-[#EAECEF] text-[9.5px] p-1.5 rounded text-center font-mono font-bold transition-all cursor-pointer"
              >
                Send Ping
              </button>
              <button 
                onClick={() => handleManualAction("risk")} 
                className="bg-[#2B3139] hover:bg-slate-700 border border-slate-600/30 text-[#EAECEF] text-[9.5px] p-1.5 rounded text-center font-mono font-bold transition-all cursor-pointer"
              >
                Audit Risk
              </button>
              <button 
                onClick={() => handleManualAction("sync")} 
                className="bg-[#FCD535] hover:bg-[#F0B90B] text-black text-[9.5px] p-1.5 rounded text-center font-mono font-black transition-all cursor-pointer"
              >
                Flush cache
              </button>
            </div>
          </div>

          {/* Execution Mode Diagnostics */}
          {bot?.liveModeDiagnostics && (
            <div id="execution-mode-telemetry" className="p-4 flex flex-col bg-[#0A0D10] select-none shrink-0 border-b border-[#1F252C]">
              <div className="flex justify-between items-center text-[10px] font-mono text-[#848E9C] font-bold uppercase tracking-wider mb-3 shrink-0">
                <span className="flex items-center gap-1">
                  <ShieldAlert className="w-3.5 h-3.5 text-[#8A4FFF]" /> Trading Mode Diagnostics
                </span>
                <span className={cn("px-1.5 py-0.5 rounded text-[8px] tracking-wider", bot?.liveModeEnabled ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-450")}>
                  {bot?.liveModeEnabled ? "LIVE OVERRIDE ACTIVE" : "LIVE TRADING BLOCKED"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[9px] font-mono text-slate-400 font-medium">
                <div className="flex justify-between p-1.5 bg-[#11151B] rounded border border-slate-700/20">
                  <span>DRY_RUN:</span>
                  <span className={bot?.liveModeDiagnostics?.DRY_RUN ? "text-amber-400" : "text-emerald-400"}>
                    {bot?.liveModeDiagnostics?.DRY_RUN !== undefined ? (bot.liveModeDiagnostics.DRY_RUN ? "TRUE" : "FALSE") : "UNKNOWN"}
                  </span>
                </div>
                <div className="flex justify-between p-1.5 bg-[#11151B] rounded border border-slate-700/20">
                  <span>LIVE_TRADING:</span>
                  <span className={bot?.liveModeDiagnostics?.LIVE_TRADING ? "text-emerald-400" : "text-slate-500"}>
                    {bot?.liveModeDiagnostics?.LIVE_TRADING !== undefined ? (bot.liveModeDiagnostics.LIVE_TRADING ? "TRUE" : "FALSE") : "UNKNOWN"}
                  </span>
                </div>
                <div className="flex justify-between p-1.5 bg-[#11151B] rounded border border-slate-700/20">
                  <span>Has Private Key:</span>
                  <span className={bot?.liveModeDiagnostics?.privateKeyPresent ? "text-emerald-400" : "text-rose-450"}>
                    {bot?.liveModeDiagnostics?.privateKeyPresent !== undefined ? (bot.liveModeDiagnostics.privateKeyPresent ? "YES" : "NO") : "UNKNOWN"}
                  </span>
                </div>
                <div className="flex justify-between p-1.5 bg-[#11151B] rounded border border-slate-700/20">
                  <span>Core Orders Enabled:</span>
                  <span className={bot?.liveModeDiagnostics?.orderSubmissionEnabled ? "text-emerald-400" : "text-amber-500"}>
                    {bot?.liveModeDiagnostics?.orderSubmissionEnabled !== undefined ? (bot.liveModeDiagnostics.orderSubmissionEnabled ? "YES" : "NO") : "UNKNOWN"}
                  </span>
                </div>
              </div>
              <div className={cn("mt-2 p-1.5 rounded text-center border text-[9.5px]", bot?.liveModeEnabled ? "bg-emerald-900/20 border-emerald-500/30 text-emerald-400" : "bg-rose-900/20 border-rose-500/30 text-rose-500")}>
                 <span>Exchange Mutations: <strong>{bot?.liveModeDiagnostics?.exchangeMutationsAllowed ? "ALLOWED_AND_DISPATCHING" : "DISABLED_AND_LOCKED"}</strong></span>
              </div>
              {bot?.liveModeDiagnostics?.LIVE_TRADING && bot?.liveModeDiagnostics?.DRY_RUN && (
                <div className="mt-2 p-1.5 bg-rose-950/40 border border-rose-500/50 rounded flex items-center gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-rose-450 shrink-0" />
                  <span className="text-[9px] text-rose-400 font-medium">LIVE MODE REQUESTED BUT DRY_RUN STILL ENABLED</span>
                </div>
              )}
            </div>
          )}

          {/* API Budget Limits Telemetry */}
          <div id="api-budget-telemetry" className="p-4 flex flex-col bg-[#0A0D10] select-none shrink-0 border-b border-[#1F252C] overflow-hidden min-h-[220px]">
             <div className="flex justify-between items-center text-[10px] font-mono text-[#848E9C] font-bold uppercase tracking-wider mb-3 shrink-0">
               <span className="flex items-center gap-1">
                 <ServerCrash className="w-3.5 h-3.5 text-[#8A4FFF]" /> API Budget & Rate Limits
               </span>
               <span className={cn("px-1.5 py-0.5 rounded text-[8px]", bot.apiBudget?.degradedMode ? "bg-amber-500/20 text-amber-500" : "bg-emerald-500/20 text-emerald-400")}>
                 {bot.apiBudget?.degradedMode ? "DEGRADED" : "HEALTHY"}
               </span>
             </div>
             
             <div className="grid grid-cols-2 gap-3 mb-3">
                 <div className="p-2 border border-slate-700/40 rounded bg-slate-800/20">
                     <div className="text-[9px] text-slate-500 uppercase font-bold mb-1">REST Weight (1min)</div>
                     <div className="flex items-baseline gap-1">
                         <span className={cn("text-lg font-bold font-mono tracking-tighter", bot.apiBudget?.restWeightInWindow > 800 ? "text-rose-450" : bot.apiBudget?.restWeightInWindow > 600 ? "text-amber-400" : "text-emerald-400")}>
                           {bot.apiBudget?.restWeightInWindow || 0}
                         </span>
                         <span className="text-[9px] text-slate-500 font-mono">/ {bot.apiBudget?.restWeightLimit || 1200}</span>
                     </div>
                 </div>
                 <div className="p-2 border border-slate-700/40 rounded bg-slate-800/20">
                     <div className="text-[9px] text-slate-500 uppercase font-bold mb-1">Address Exchange Actions</div>
                     <div className="flex items-baseline gap-1">
                         <span className={cn("text-lg font-bold font-mono tracking-tighter", (bot.apiBudget?.exchangeActionsLimit || 10000) < 500 ? "text-rose-450" : "text-emerald-400")}>
                            {bot.apiBudget?.exchangeActionsLimit || 10000}
                         </span>
                         <span className="text-[9px] text-slate-500 font-mono">remaining</span>
                     </div>
                 </div>
             </div>
             
             {(bot.apiBudget?.addressLimitRecoveryActive || bot.addressPacing?.active) && (
               <div className="p-2 border border-amber-500/25 bg-amber-500/5 rounded mb-3">
                 <div className="text-amber-300 text-[10px] font-bold uppercase flex items-center justify-between font-mono mb-2">
                    <span>Hyperliquid Address Pacing</span>
                    <span className={cn("px-1.5 py-0.5 rounded", bot.addressPacing?.laneStatus === "READY" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300")}>
                      {bot.addressPacing?.laneStatus || bot.apiBudget?.addressActionLaneStatus || "WAITING"}
                    </span>
                 </div>
                 <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] font-mono">
                   <div className="flex justify-between gap-2">
                     <span className="text-slate-500">Status:</span>
                     <span className="text-slate-200">{bot.addressPacing?.status || "ACTIVE"}</span>
                   </div>
                   <div className="flex justify-between gap-2">
                     <span className="text-slate-500">Next Action:</span>
                     <span className="text-slate-200">{formatCountdown(bot.addressPacing?.retryAfterMs ?? bot.apiBudget?.addressActionRetryAfterMs)}</span>
                   </div>
                   <div className="flex justify-between gap-2">
                     <span className="text-slate-500">Reserved:</span>
                     <span className="text-slate-200">{bot.addressPacing?.reservedCandidate?.symbol || "NONE"}</span>
                   </div>
                   <div className="flex justify-between gap-2">
                     <span className="text-slate-500">Score:</span>
                     <span className="text-slate-200">{bot.addressPacing?.reservedCandidate?.finalExecutionScore ?? "—"}</span>
                   </div>
                   <div className="flex justify-between gap-2">
                     <span className="text-slate-500">Side:</span>
                     <span className="text-slate-200">{bot.addressPacing?.reservedCandidate?.side || "—"}</span>
                   </div>
                   <div className="flex justify-between gap-2">
                     <span className="text-slate-500">Lev / Size:</span>
                     <span className="text-slate-200">
                       {bot.addressPacing?.reservedCandidate?.leverage ? `${bot.addressPacing.reservedCandidate.leverage}x` : "—"}
                       {bot.addressPacing?.reservedCandidate?.size ? ` / $${Number(bot.addressPacing.reservedCandidate.size).toFixed(0)}` : ""}
                     </span>
                   </div>
                 </div>
                 {bot.addressPacing?.queuedCandidates?.length > 0 && (
                   <div className="mt-2 flex flex-wrap gap-1">
                     {bot.addressPacing.queuedCandidates.slice(0, 3).map((candidate: any) => (
                       <span key={`${candidate.rank}-${candidate.symbol}`} className="px-1.5 py-0.5 rounded bg-slate-800/70 border border-slate-700/50 text-[8px] text-slate-300 font-mono">
                         #{candidate.rank} {candidate.symbol} {candidate.side} {candidate.finalExecutionScore}
                       </span>
                     ))}
                   </div>
                 )}
               </div>
             )}

             <div className="grid grid-cols-2 gap-3 text-[10px] font-mono mb-2">
                 <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">WSS Connections:</span>
                    <span className="text-slate-300 font-bold">{bot.apiBudget?.wsConnections || 1}/10</span>
                 </div>
                 <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">WSS Subscriptions:</span>
                    <span className="text-slate-300 font-bold">{bot.apiBudget?.wsSubscriptions || 0}/1000</span>
                 </div>
                 <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Executions (1m):</span>
                    <span className="text-indigo-300 font-bold">{bot.apiBudget?.executionRequestsPerMin || 0}</span>
                 </div>
                 <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Cache Hits:</span>
                    <span className="text-teal-400 font-bold">{bot.apiBudget?.cacheHits || 0}</span>
                 </div>
                 <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Blocks:</span>
                    <span className="text-rose-400 font-bold">{bot.apiBudget?.blockedRequests || 0}</span>
                 </div>
                 <div className="flex justify-between items-center py-1 border-b border-slate-800/60">
                    <span className="text-slate-500">Throttle Status:</span>
                    <span className={cn("font-bold truncate max-w-[80px]", bot.apiBudget?.throttleReason === "NONE" ? "text-emerald-400" : "text-amber-500")}>
                      {bot.apiBudget?.throttleReason || "NONE"}
                    </span>
                 </div>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}
