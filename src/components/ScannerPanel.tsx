import React, { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, Activity, Target, Zap, AlertTriangle, Radio } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { motion, AnimatePresence } from "motion/react";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const ScannerPanel = React.memo(function ScannerPanel({ opportunities, activeSymbol, scansSinceLastEntry = 0, isAdvancedMode = false, usedPositions = 0, configuredMaxPositions = 1, availableSlots = 0 }: { opportunities: any[], activeSymbol: string, scansSinceLastEntry?: number, isAdvancedMode?: boolean, usedPositions?: number, configuredMaxPositions?: number, availableSlots?: number }) {
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: "asc" | "desc" }>({ key: "confidence", direction: "desc" });

  const sortedData = useMemo(() => {
    if (!opportunities || opportunities.length === 0) return [];
    
    // Sort array
    return [...opportunities].sort((a, b) => {
      const aVal = a[sortConfig.key];
      const bVal = b[sortConfig.key];
      
      if (aVal < bVal) {
        return sortConfig.direction === "asc" ? -1 : 1;
      }
      if (aVal > bVal) {
        return sortConfig.direction === "asc" ? 1 : -1;
      }
      return 0;
    });
  }, [opportunities, sortConfig]);

  const requestSort = (key: string) => {
    let direction: "asc" | "desc" = "desc";
    if (sortConfig.key === key && sortConfig.direction === "desc") {
      direction = "asc";
    }
    setSortConfig({ key, direction });
  };

  const getSortIcon = (columnName: string) => {
    if (sortConfig.key !== columnName) return null;
    return sortConfig.direction === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };

  const getEligibilityStyle = (opt: any) => {
    if (opt.symbol === activeSymbol) {
      return "bg-[#8A4FFF]/20 text-[#8A4FFF] border border-[#8A4FFF]/30 font-black animate-pulse shadow-[0_0_10px_rgba(138,79,255,0.2)]";
    }
    switch (opt.eligibility) {
      case "ELIGIBLE":
        // It's technically active if it's eligible but we might not be trading it yet
        return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
      case "NEAR_ENTRY":
        return "bg-amber-500/10 text-amber-500 border border-amber-500/20";
      case "WAITING":
      default:
        return "bg-slate-800/30 text-slate-500 border border-slate-700/50";
    }
  };

  const getEligibilityLabel = (opt: any) => {
    if (opt.symbol === activeSymbol) return "ACTIVE TARGET";
    if (opt.eligibility === "ELIGIBLE") return "SCANNER_CLEARED";
    if (opt.eligibility === "NEAR_ENTRY") return "NEAR_ENTRY";
    if (opt.breakoutStatus === "BREAKOUT" && opt.rejectionReason !== "WAITING_FOR_DATA") return "MOMENTUM_BUILDING";
    if (opt.bias === "NONE" || !opt.bias) return "WATCHING";
    return "SCANNER_REJECTED";
  };

  const getRegimeStyle = (regime: string) => {
    switch (regime) {
      case "TRENDING": return "text-emerald-400";
      case "LOW_VOLATILITY": return "text-slate-500";
      case "LOW_VOL_NO_TRADE": return "text-slate-500";
      case "DEAD_LOW_VOLATILITY": return "text-slate-600";
      case "SQUEEZE_BUILDING": return "text-indigo-400";
      case "COMPRESSION_WITH_VOLUME": return "text-blue-400";
      case "DIRECTIONAL_EXPANSION": return "text-emerald-500";
      case "PARABOLIC_CONTINUATION": return "text-green-400 font-bold";
      case "LIQUIDATION_SWEEP": return "text-fuchsia-400";
      case "EXHAUSTION_REVERSAL": return "text-violet-400";
      case "CHAOTIC_NOISE": return "text-orange-500";
      case "RANGING_CHOP": return "text-amber-500";
      default: return "text-slate-400";
    }
  };

  const [isOpen, setIsOpen] = useState(false);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

  const renderedData = useMemo(() => {
    return isAdvancedMode ? sortedData : sortedData.slice(0, 25);
  }, [sortedData, isAdvancedMode]);

  const hiddenCount = sortedData.length - renderedData.length;

  if (!opportunities || opportunities.length === 0) {
    return (
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="h-48 shrink-0 border-t border-slate-800 bg-[#0C0E12] flex items-center justify-center text-slate-500"
      >
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
          className="mr-2.5"
        >
          <Activity className="w-5 h-5 text-[#8A4FFF]" />
        </motion.div>
        <motion.span 
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
          className="text-[10px] font-mono uppercase tracking-widest text-slate-400"
        >
          Initializing full market sync...
        </motion.span>
      </motion.div>
    );
  }

  const totalScanned = opportunities.length;
  const eligibleCount = opportunities.filter(o => o.eligibility === "ELIGIBLE").length;
  const rejectedCount = opportunities.filter(o => o.rejectionReason && o.rejectionReason !== "WAITING_FOR_CONFIRMATION" && o.rejectionReason !== "CLEARED").length;

  return (
    <div className={cn("shrink-0 flex flex-col border-t border-slate-800 bg-[#0A0B0D]", isOpen ? "h-64 md:h-64" : "h-10 md:h-64")}>
      <div 
        className="flex items-center justify-between px-4 md:px-6 py-2 border-b border-slate-800/60 bg-[#0F1115] cursor-pointer md:cursor-default"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-2 text-slate-400">
          <Radio className="w-4 h-4 text-[#8A4FFF]" />
          <span className="text-[10px] font-black uppercase tracking-[0.2em] flex items-center gap-2">
            Full Hyperliquid Market Scanner
            <span className="md:hidden">
              {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
            </span>
          </span>
        </div>
        <div className="flex gap-4 items-center">
          <div className="text-[10px] uppercase font-mono tracking-widest text-[#8A4FFF] border border-[#8A4FFF]/20 px-2 py-0.5 rounded bg-[#8A4FFF]/5 hidden md:block">
            Slots: <span className="font-bold text-white">{usedPositions}</span> / {configuredMaxPositions} ({availableSlots} OPEN) {configuredMaxPositions >= 3 ? " [MULTI: ON]" : ""}
          </div>
          <div className="text-[10px] uppercase font-mono tracking-widest text-slate-500 hidden md:block">
            Eligible: <span className="text-emerald-400">{eligibleCount}</span> | Rejected: <span className="text-rose-400">{rejectedCount}</span>
          </div>
          <div className="text-[10px] uppercase font-mono tracking-widest text-indigo-400 hidden xl:block">
            Scans: {scansSinceLastEntry}
          </div>
          <div className="text-[10px] uppercase font-mono tracking-widest text-[#8A4FFF]">
            {totalScanned} Synced Universe
          </div>
        </div>
      </div>

      <div className={cn("flex-1 overflow-auto overflow-x-hidden p-2", !isOpen && "hidden md:block")}>
        {/* Desktop Header */}
        <div className="min-w-max hidden md:block">
          <div className="grid grid-cols-[100px_80px_100px_100px_100px_100px_120px_100px_1fr] gap-4 px-4 py-2 border-b border-slate-800 text-[9px] uppercase font-bold text-slate-600 tracking-widest sticky top-0 bg-[#0A0B0D] z-10">
            <div className="cursor-pointer hover:text-white flex items-center gap-1" onClick={() => requestSort("symbol")}>Symbol {getSortIcon("symbol")}</div>
            <div className="cursor-pointer hover:text-white flex items-center gap-1" onClick={() => requestSort("confidence")}>Conf {getSortIcon("confidence")}</div>
            <div className="cursor-pointer hover:text-white flex items-center gap-1" onClick={() => requestSort("liquidity")}>Liquidity {getSortIcon("liquidity")}</div>
            <div className="cursor-pointer hover:text-white flex items-center gap-1" onClick={() => requestSort("spread")}>Spread {getSortIcon("spread")}</div>
            <div className="cursor-pointer hover:text-white flex items-center gap-1" onClick={() => requestSort("volatility")}>Volatility {getSortIcon("volatility")}</div>
            <div className="cursor-pointer hover:text-white flex items-center gap-1" onClick={() => requestSort("trendStrength")}>Trend {getSortIcon("trendStrength")}</div>
            <div>Regime Intent / Bias</div>
            <div>Status</div>
            <div>Reason</div>
          </div>
        </div>

        {/* Mobile Sort Menu */}
        <div className="md:hidden flex flex-wrap gap-2 px-2 py-2 mb-2 border-b border-slate-800 text-[9px] uppercase font-bold text-slate-600">
           <span className="opacity-50 mt-1">Sort by:</span>
           {["confidence", "spread", "liquidity", "trendStrength"].map((key) => (
             <button key={key} onClick={() => requestSort(key)} className={cn("px-2 py-1 rounded bg-slate-800/50 flex items-center gap-1", sortConfig.key === key ? "text-white bg-slate-700" : "")}>
               {key} {getSortIcon(key)}
             </button>
           ))}
        </div>

        <div className="flex flex-col gap-2 md:gap-[2px] p-2 md:p-0 md:min-w-max pb-8">
          <AnimatePresence>
            {renderedData.map((opt: any) => (
              <motion.div 
                key={opt.symbol} 
                layoutId={`scanner-row-${opt.symbol}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                whileHover={{ backgroundColor: "rgba(255, 255, 255, 0.02)", scale: 1.002 }}
                onClick={() => setExpandedSymbol(expandedSymbol === opt.symbol ? null : opt.symbol)}
                transition={{ type: "spring", stiffness: 350, damping: 25 }}
                className={cn(
                  "flex flex-col md:grid md:grid-cols-[100px_80px_100px_100px_100px_100px_120px_100px_1fr] gap-3 md:gap-4 p-3 md:px-2 md:py-1.5 md:items-center rounded-lg md:rounded border md:border-transparent font-mono text-[11px] md:text-[10px] cursor-pointer hover:border-slate-700/60 transition-all",
                  opt.symbol === activeSymbol ? "bg-slate-800/40 border-slate-700/50" : "bg-slate-900/40 border-slate-800"
                )}
              >
              <div className="flex justify-between items-center md:contents">
                <div className="font-bold text-white flex items-center gap-2 text-sm md:text-[10px]">
                  {opt.symbol === activeSymbol && <Target className="w-4 h-4 md:w-3 md:h-3 text-[#8A4FFF]" />}
                  {opt.symbol}
                </div>
                
                <div className={cn(
                  "font-bold text-sm md:text-[10px]",
                  opt.confidence > 50 ? "text-emerald-400" : opt.confidence > 25 ? "text-amber-400" : "text-slate-500"
                )}>
                  {opt.confidence}%
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-1 md:mt-0 md:contents">
                <div className="md:hidden text-[9px] text-slate-500 uppercase tracking-widest">Liq / Spread</div>
                <div className="md:hidden text-[9px] text-slate-500 uppercase tracking-widest text-right md:text-left">Vol / Trend</div>
                
                <div className="text-slate-300 md:text-slate-400">
                  <span className="md:hidden">L: </span>{opt.liquidity}<span className="text-slate-600 hidden md:inline">/100</span>
                  <span className="md:hidden text-slate-600"> | S: </span><span className="hidden md:inline contents text-slate-400">{opt.spread}/100</span><span className="md:hidden text-slate-300">{opt.spread}</span>
                </div>
                
                <div className="text-right md:text-left">
                  <div className={cn(
                    "inline md:block",
                    opt.volatility === "HIGH" ? "text-rose-400" : opt.volatility === "LOW" ? "text-slate-500" : "text-slate-300"
                  )}>
                    {opt.volatility}
                  </div>
                  <span className="md:hidden text-slate-600"> | </span>
                  <div className="inline md:block text-slate-300 md:text-slate-400">
                    {opt.trendStrength === 0 && ["HEALTHY_LOW_VOL_EXPANSION", "LOW_VOL_SQUEEZE", "PRE_BREAKOUT_COMPRESSION", "EARLY_DIRECTIONAL_EXPANSION", "PRE_BREAKOUT_MOMENTUM", "MOMENTUM_BUILDING"].includes(opt.regime) ? "DATA_PENDING" : (opt.trendStrength * 100).toFixed(1) + "%"}
                  </div>
                </div>
              </div>

              <div className="flex justify-between md:flex-col md:gap-0.5 mt-1 md:mt-0 pt-2 border-t border-slate-800/50 md:border-0 md:pt-0">
                <span className={cn(getRegimeStyle(opt.regime), "truncate")}>{opt.regimeIntent || "UNKNOWN"} <span className="opacity-50 inline-block md:hidden">({opt.regime})</span></span>
                <span className={cn(
                  "text-[10px] md:text-[8px] font-bold tracking-wider",
                  opt.directionalBias?.includes("LONG") ? "text-emerald-500" : opt.directionalBias?.includes("SHORT") ? "text-rose-500" : "text-slate-600"
                )}>{opt.directionalBias || "NEUTRAL"}</span>
              </div>

              <div className="mt-1 md:mt-0">
                <span className={cn(
                  "px-1.5 py-0.5 rounded-[3px] text-[9px] md:text-[8px] uppercase font-bold tracking-widest whitespace-nowrap",
                  getEligibilityStyle(opt)
                )}>
                  {getEligibilityLabel(opt)}
                </span>
              </div>

              <div className="text-slate-500 text-[10px] md:text-[9px] md:truncate mt-1 md:mt-0 md:border-none border-t border-slate-800/50 pt-2 md:pt-0 flex items-center justify-between">
                <div>
                  <span className="md:hidden font-bold mr-1">Rsn:</span>
                  {opt.rejectionReason || (opt.eligibility === "ELIGIBLE" ? "EXECUTION_READY" : "NO_BIAS")}
                </div>
                <div className="text-[9px] text-[#8A4FFF] uppercase hidden md:block opacity-60 hover:opacity-100">
                  {expandedSymbol === opt.symbol ? "Hide Details" : "View Details"}
                </div>
              </div>

              {expandedSymbol === opt.symbol && (
                <div className="col-span-full w-full bg-[#050608] border border-slate-800/80 rounded-lg p-3 grid grid-cols-2 md:grid-cols-5 gap-3 mt-2 text-[10px] md:text-[9px] tracking-wider animate-fadeIn font-mono text-left" onClick={(e) => e.stopPropagation()}>
                  <div className="space-y-1">
                    <span className="text-slate-500 block text-[8px] uppercase font-bold">Trend Match</span>
                    <span className={cn(
                      "font-bold uppercase text-[8px] px-1.5 py-0.5 rounded border inline-block leading-none",
                      opt.trendMatch === "TREND_MATCH_LONG" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                      opt.trendMatch === "TREND_MATCH_SHORT" ? "bg-rose-500/10 text-rose-400 border-rose-500/20" :
                      opt.trendMatch === "TREND_CONFLICT" ? "bg-amber-500/10 text-amber-500 border-amber-500/20" : 
                      "bg-slate-800/40 text-slate-400 border-slate-700/30"
                    )}>
                      {(opt.trendMatch || "NO_CLEAR_TREND").replace(/_/, " ")}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <span className="text-slate-500 block text-[8px] uppercase font-bold">Direction Decision</span>
                    <span className={cn(
                      "font-bold uppercase text-[9px]",
                      opt.directionDecision?.includes("LONG") ? "text-emerald-400" :
                      opt.directionDecision?.includes("SHORT") ? "text-rose-400" : "text-slate-400"
                    )}>
                      {opt.directionDecision || "NO_TRADE"}
                    </span>
                  </div>
                  <div className="space-y-1 col-span-1">
                    <span className="text-slate-500 block text-[8px] uppercase font-bold">Leverage Selected</span>
                    <span className="text-indigo-400 font-bold block text-[10px]">{opt.leverageSelected !== undefined ? `${opt.leverageSelected}x` : "1x"}</span>
                  </div>
                  <div className="space-y-1 col-span-2 md:col-span-1">
                    <span className="text-slate-500 block text-[8px] uppercase font-bold">Leverage Reason</span>
                    <span className="text-slate-300 font-bold block leading-relaxed">{opt.leverageReason || "Default Settings"}</span>
                  </div>
                  <div className="space-y-1 col-span-2 md:col-span-1">
                    <span className="text-slate-500 block text-[8px] uppercase font-bold">Confirmation Status</span>
                    <span className={cn(
                      "font-bold block leading-relaxed text-[9px]",
                      opt.confirmationStatus?.includes("CONFIRMED") ? "text-emerald-400 font-black animate-pulse" : 
                      opt.confirmationStatus?.includes("WATCHLIST") ? "text-amber-400 font-bold" : "text-rose-400/80"
                    )}>
                      {opt.confirmationStatus || "N/A"}
                    </span>
                    {opt.watchlistState && opt.watchlistState !== "NONE" && (
                        <div className="bg-amber-500/10 text-amber-500 border border-amber-500/30 font-bold uppercase text-[8px] px-1 py-0.5 rounded mt-1 text-center truncate">
                            {opt.watchlistState.replace(/_/g, " ")}
                        </div>
                    )}
                  </div>
                  
                  {opt.finalExecutionScore !== undefined && (
                      <div className="col-span-full mt-2 pt-2 border-t border-slate-800/60 grid grid-cols-2 md:grid-cols-5 gap-2 text-[8px] uppercase font-bold text-center">
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             Priority Rank: <span className="text-teal-400 font-bold text-sm tracking-tighter">{opt.executionPriorityRank ? `#${opt.executionPriorityRank}` : "N/A"}</span>
                          </div>
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             Final Exec Score: <span className="text-[#8A4FFF] font-black text-sm tracking-tighter">{opt.finalExecutionScore}</span>
                          </div>
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             HL Local Score: <span className="text-emerald-400 font-bold">{opt.confidence}</span>
                          </div>
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             CMC Trend: <span className="text-amber-400 font-bold">{opt.cmcTrendScore !== undefined ? opt.cmcTrendScore : "N/A"}</span>
                          </div>
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             Narrative: <span className="text-rose-400 font-bold">{opt.narrative || "N/A"}</span>
                          </div>
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             Long / Short: <span className="text-emerald-400 font-bold">{opt.longScore ?? opt.longConfidence ?? "N/A"}</span>
                             <span className="text-slate-600 mx-1">/</span>
                             <span className="text-rose-400 font-bold">{opt.shortScore ?? opt.shortConfidence ?? "N/A"}</span>
                          </div>
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             Selected Side: <span className={cn("font-black", opt.selectedSide === "LONG" ? "text-emerald-400" : opt.selectedSide === "SHORT" ? "text-rose-400" : "text-slate-400")}>{opt.selectedSide || "NONE"}</span>
                          </div>
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             Setup: <span className="text-indigo-400 font-bold">{opt.setupType || "N/A"}</span>
                          </div>
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             CMC Bias: <span className="text-amber-400 font-bold">{opt.cmcDirectionalBias || "NEUTRAL"}</span>
                          </div>
                          <div className={cn("p-1.5 rounded border bg-slate-900/60 text-slate-300 border-slate-800/80")}>
                             HL Confirm: <span className="text-sky-400 font-bold">{opt.hlDirectionalConfirmation || "N/A"}</span>
                          </div>
                      </div>
                  )}

                  {opt.rejectionReason === "LOW_PRIORITY_EXECUTION_SKIPPED" && (
                      <div className="col-span-full mt-2 p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[9px] leading-relaxed">
                          <strong className="text-amber-400 uppercase mr-1">Skip Status:</strong> Delayed due to Low Priority Filter (Rank #{opt.executionPriorityRank} / {configuredMaxPositions} Max).<br/>
                          <strong className="text-amber-400 uppercase mr-1">Next Re-evaluation:</strong> Next Active Market Cycle.<br/>
                          <strong className="text-amber-400 uppercase mr-1">Promotion Triggers Needed:</strong> Confidence &gt;= 60, CMC Volatile Gem status, or Early Breakout expansion structure.
                      </div>
                  )}
                  
                  {/* Separate confirmation components */}
                  {opt.confidencePass !== undefined && (
                      <div className="col-span-full mt-2 pt-2 border-t border-slate-800/60 grid grid-cols-2 md:grid-cols-6 gap-2 text-[8px] uppercase font-bold text-center">
                          <div className={cn("p-1.5 rounded border", opt.confidencePass ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20")}>
                             Confidence: {opt.confidencePass ? "PASS" : "FAIL"}
                          </div>
                          <div className={cn("p-1.5 rounded border", opt.trendPass ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20")}>
                             Trend: {opt.trendPass ? "PASS" : "FAIL"}
                          </div>
                          <div className={cn("p-1.5 rounded border", opt.htfPass ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20")}>
                             HTF Align: {opt.htfPass ? "PASS" : "FAIL"}
                          </div>
                          <div className={cn("p-1.5 rounded border", opt.reversalPass ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20")}>
                             Reversal: {opt.reversalPass ? "PASS" : "FAIL"}
                          </div>
                          <div className={cn("p-1.5 rounded border", opt.expectedMovePass ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20")}>
                             Exp. Move: {opt.expectedMovePass ? "PASS" : "FAIL"}
                          </div>
                          <div className={cn("p-1.5 rounded border", opt.liquidityPass && opt.collateralPass ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20")}>
                             Safe: {opt.liquidityPass && opt.collateralPass ? "PASS" : "FAIL"}
                          </div>
                      </div>
                  )}
                </div>
              )}
            </motion.div>
          ))}
          </AnimatePresence>
          {hiddenCount > 0 && (
              <div className="text-center py-4 text-[10px] text-slate-500 font-mono uppercase bg-slate-900/40 rounded border border-slate-800">
                  + {hiddenCount} more target{hiddenCount > 1 ? 's' : ''} hidden. Enable Advanced Mode to view full list.
              </div>
          )}
        </div>
      </div>
    </div>
  );
}, (prev, next) => {
  if (prev.activeSymbol !== next.activeSymbol) return false;
  if (prev.scansSinceLastEntry !== next.scansSinceLastEntry) return false;
  if (prev.isAdvancedMode !== next.isAdvancedMode) return false;
  // If array length changes, re-render
  if (prev.opportunities?.length !== next.opportunities?.length) return false;
  
  // Quick deep enough check for top 5 to catch changes but avoid deep comparison of 200 items
  for (let i = 0; i < Math.min(5, prev.opportunities.length); i++) {
    if (prev.opportunities[i].symbol !== next.opportunities[i].symbol) return false;
    if (prev.opportunities[i].eligibility !== next.opportunities[i].eligibility) return false;
  }
  return true;
});
// Using Radio instead of Activity because Radio isn't imported normally but lucide has it
// Wait I will adjust the imports as needed.
