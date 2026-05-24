import React, { useState, useMemo } from "react";
import { Compass, TrendingUp, Cpu, Eye, Hourglass, HelpCircle, Activity, LayoutGrid, CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { CMCTrendAsset, CMCTrendIntelligence } from "../types.js";

export const CoinMarketCapPanel = React.memo(function CoinMarketCapPanel({ intelligence }: { intelligence: CMCTrendIntelligence | null }) {
  const [activeTab, setActiveTab] = useState<"trends" | "watchlist" | "logs">("trends");
  const [selectedNarrative, setSelectedNarrative] = useState<string>("ALL");

  const assets = intelligence?.assets || [];
  const logs = intelligence?.logs || [];
  const watchlist = intelligence?.watchlist || [];
  const lastScanTime = intelligence?.lastScanTime || 0;

  // Track unique narrative sectors
  const narratives = useMemo(() => {
    const list = new Set<string>();
    assets.forEach(a => {
      if (a.narrative) list.add(a.narrative);
    });
    return ["ALL", ...Array.from(list)];
  }, [assets]);

  // Filter assets based on sector selection
  const filteredAssets = useMemo(() => {
    if (selectedNarrative === "ALL") return assets;
    return assets.filter(a => a.narrative === selectedNarrative);
  }, [assets, selectedNarrative]);

  // Derive counts for summary
  const totalTrendCount = assets.length;
  const matchCount = assets.filter(a => a.status === "CMC_TREND_MATCHED_HYPERLIQUID").length;
  const candidateCount = assets.filter(a => a.classification === "CMC_VOLATILE_GEM_CANDIDATE").length;
  const uncertainCount = assets.filter(a => a.status === "SYMBOL_MAPPING_UNCERTAIN").length;

  const getStatusBadge = (status: CMCTrendAsset["status"]) => {
    switch (status) {
      case "CMC_TREND_MATCHED_HYPERLIQUID":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-2.5 h-2.5" />
            MATCHED
          </span>
        );
      case "SYMBOL_MAPPING_UNCERTAIN":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20">
            <AlertTriangle className="w-2.5 h-2.5" />
            UNCERTAIN
          </span>
        );
      case "CMC_TREND_NOT_TRADABLE":
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-semibold bg-slate-800/50 text-slate-500 border border-slate-800">
            <XCircle className="w-2.5 h-2.5" />
            NOT TRADABLE
          </span>
        );
    }
  };

  const getActionBadge = (asset: CMCTrendAsset) => {
    if (asset.classification === "CMC_VOLATILE_GEM_CANDIDATE") {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px] font-black bg-purple-500/15 text-purple-300 border border-purple-500/30 animate-pulse uppercase shadow-[0_0_8px_rgba(168,85,247,0.2)]">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-ping" />
          GEM CANDIDATE
        </span>
      );
    }
    
    switch (asset.action) {
      case "matched":
        return <span className="text-[10px] uppercase font-mono tracking-wider text-emerald-400 font-semibold">Matched Asset</span>;
      case "watching":
        return <span className="text-[10px] uppercase font-mono tracking-wider text-amber-400 font-medium">Watching Crossmap</span>;
      case "not tradable":
      default:
        return <span className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Unmapped</span>;
    }
  };

  const getTrendScoreStyle = (score: number) => {
    if (score >= 80) return "text-purple-400 font-bold";
    if (score >= 60) return "text-emerald-400 font-semibold";
    if (score >= 40) return "text-amber-400";
    return "text-slate-500";
  };

  const getPriceChangeStyle = (change: number) => {
    if (change > 0) return "text-emerald-400 font-mono";
    if (change < 0) return "text-rose-400 font-mono";
    return "text-slate-400 font-mono";
  };

  const getLogLineStyle = (line: string) => {
    if (line.includes("CMC_VOLATILE_GEM_CANDIDATE") || line.includes("candidate")) {
      return "text-purple-400 font-semibold border-l-2 border-purple-500 pl-2 my-0.5";
    }
    if (line.includes("CMC_TREND_MATCHED_HYPERLIQUID")) {
      return "text-emerald-400 font-medium pl-2";
    }
    if (line.includes("CMC_TREND_BOOST_APPLIED") || line.includes("boost")) {
      return "text-indigo-400 font-medium pl-2";
    }
    if (line.includes("SYMBOL_MAPPING_UNCERTAIN")) {
      return "text-amber-400 pl-2";
    }
    if (line.includes("CMC_TREND_NOT_TRADABLE")) {
      return "text-slate-500 pl-2";
    }
    return "text-slate-400 pl-2";
  };

  return (
    <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-2xl flex flex-col gap-4 h-[35rem] shrink-0">
      {/* Panel Header */}
      <div className="flex flex-col md:flex-row justify-between md:items-center gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-400">
            <Compass className="w-4.5 h-4.5 animate-spin" style={{ animationDuration: "12s" }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-wide text-slate-100 flex items-center gap-2">
              CoinMarketCap Trend Intelligence
            </h3>
            <p className="text-[10px] text-slate-500 font-mono">
              Market discovery, trend rotation monitoring, & Hyperliquid perp integration checks.
            </p>
          </div>
        </div>
        
        {/* Navigation Tabs */}
        <div className="flex items-center bg-[#07080a] border border-slate-800/80 rounded-lg p-1 text-xs font-mono">
          <button 
            type="button"
            onClick={() => setActiveTab("trends")}
            className={`px-3 py-1 rounded-md transition-colors ${activeTab === "trends" ? "bg-slate-800 text-slate-200" : "text-slate-400 hover:text-slate-200"}`}
          >
            Trends Scanner ({filteredAssets.length})
          </button>
          <button 
            type="button"
            onClick={() => setActiveTab("watchlist")}
            className={`px-3 py-1 rounded-md transition-colors ${activeTab === "watchlist" ? "bg-slate-800 text-slate-200" : "text-[#14b8a6] hover:text-[#2dd4bf]"}`}
          >
            Watchlist & Prep ({watchlist.length})
          </button>
          <button 
            type="button"
            onClick={() => setActiveTab("logs")}
            className={`px-3 py-1 rounded-md transition-colors ${activeTab === "logs" ? "bg-slate-800 text-slate-200" : "text-slate-400 hover:text-slate-200"}`}
          >
            Discovery Logs ({logs.length})
          </button>
        </div>
      </div>

      {/* Narrative Analysis Banner (Requirement 8) */}
      {intelligence?.strongestNarrative && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 bg-[#090B0E] border border-slate-800/60 p-3 rounded-xl">
          <div className="flex flex-col">
            <span className="text-[9.5px] font-mono text-indigo-400 font-semibold uppercase tracking-wider flex items-center gap-1">⚡ STRONGEST NARRATIVE</span>
            <span className="text-xs font-bold text-slate-200 font-mono mt-0.5">#{intelligence.strongestNarrative.toUpperCase()}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9.5px] font-mono text-emerald-400 font-semibold uppercase tracking-wider flex items-center gap-1">🌱 EMERGING SECTOR</span>
            <span className="text-xs font-bold text-slate-200 font-mono mt-0.5">#{intelligence.emergingNarrative?.toUpperCase() || "SOLANA MEMES"}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9.5px] font-mono text-rose-500 font-semibold uppercase tracking-wider flex items-center gap-1">❄️ WEAKENING NARRATIVE</span>
            <span className="text-xs font-bold text-slate-200 font-mono mt-0.5">#{intelligence.weakeningNarrative?.toUpperCase() || "DEFI SEC"}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9.5px] font-mono text-slate-500 font-semibold uppercase tracking-wider flex items-center gap-1">💨 FADING SECTOR</span>
            <span className="text-xs font-bold text-slate-200 font-mono mt-0.5">#{intelligence.fadingNarrative?.toUpperCase() || "GAMING FINANCE"}</span>
          </div>
        </div>
      )}

      {/* Meta Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-[#090B0E] border border-slate-800/60 rounded-xl p-2.5 flex flex-col justify-between">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Latest Scan Pulse</span>
          <span className="text-xs font-mono text-slate-300 font-semibold">
            {lastScanTime > 0 ? `${Math.round((Date.now() - lastScanTime) / 1000)}s ago` : "Waiting pulse..."}
          </span>
        </div>
        <div className="bg-[#090B0E] border border-slate-800/60 rounded-xl p-2.5 flex flex-col justify-between">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Matched Universe</span>
          <span className="text-xs font-mono text-emerald-400 font-semibold">{matchCount} / {totalTrendCount} matched</span>
        </div>
        <div className="bg-[#090B0E] border border-slate-800/60 rounded-xl p-2.5 flex flex-col justify-between">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Volatile Gems Found</span>
          <span className="text-xs font-mono text-purple-400 font-semibold">{candidateCount} candidates</span>
        </div>
        <div className="bg-[#090B0E] border border-slate-800/60 rounded-xl p-2.5 flex flex-col justify-between">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block mb-1">Uncertain Labels</span>
          <span className="text-xs font-mono text-amber-400 font-semibold">{uncertainCount} watchlists</span>
        </div>
      </div>

      {/* Narrative Tab Filter */}
      {activeTab === "trends" && (
        <div className="flex items-center gap-1.5 flex-wrap border-b border-slate-800/30 pb-2 overflow-x-auto text-[9px] font-mono whitespace-nowrap scrollbar-none">
          <span className="text-slate-500 font-semibold mr-1.5">NARRATIVE / SECTOR:</span>
          {narratives.map(sec => (
            <button
              key={sec}
              type="button"
              onClick={() => setSelectedNarrative(sec)}
              className={`px-2 py-0.5 rounded-full border transition-all ${selectedNarrative === sec ? "bg-teal-500/10 text-teal-400 border-teal-500/30" : "bg-slate-800/30 text-slate-400 border-slate-800 hover:bg-slate-800 hover:text-slate-200"}`}
            >
              #{sec.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {/* Main Container Content */}
      <div className="flex-1 overflow-hidden min-h-0 bg-[#090B0E] border border-slate-800/60 rounded-xl p-2 flex flex-col">
        {activeTab === "trends" ? (
          assets.length === 0 ? (
            <div className="flex-grow flex flex-col items-center justify-center text-slate-500 gap-2 p-5">
              <Activity className="w-8 h-8 text-slate-600 animate-pulse" />
              <span className="text-xs font-mono uppercase tracking-widest text-slate-500 animate-pulse">Initializing CMC discovery loop ...</span>
            </div>
          ) : (
            <div className="flex-1 overflow-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="text-[10px] uppercase text-slate-500 tracking-wider font-bold border-b border-slate-800/60 sticky top-0 bg-[#090B0E] z-10">
                  <tr>
                    <th className="py-2.5 px-3">Asset</th>
                    <th className="py-2.5 px-2">Sector</th>
                    <th className="py-2.5 px-2 text-right">Trend Score</th>
                    <th className="py-2.5 px-2 text-right">Mom Pers</th>
                    <th className="py-2.5 px-2 text-right">Priority</th>
                    <th className="py-2.5 px-2 text-right">Volume 24h</th>
                    <th className="py-2.5 px-2 text-right">Price 1h / 24h</th>
                    <th className="py-2.5 px-2 text-center">HL Integration</th>
                    <th className="py-2.5 px-3 text-right">Action Gate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40">
                  <AnimatePresence initial={false}>
                    {filteredAssets.map((asset) => (
                      <motion.tr 
                        key={asset.symbol}
                        layout
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className={`hover:bg-slate-800/20 transition-all ${
                          asset.classification === "CMC_VOLATILE_GEM_CANDIDATE" 
                            ? "bg-purple-500/[0.02]" 
                            : ""
                        }`}
                      >
                        <td className="py-2 px-3">
                          <div className="flex flex-col">
                            <span className="font-bold text-slate-200 tracking-wide font-mono flex items-center gap-1.5">
                              {asset.symbol}
                              {asset.classification === "CMC_VOLATILE_GEM_CANDIDATE" && (
                                <span className="w-1.5 h-1.5 rounded-full bg-purple-400 inline-block animate-ping" />
                              )}
                            </span>
                            <span className="text-[10px] text-slate-500 truncate max-w-[110px]">{asset.name}</span>
                          </div>
                        </td>
                        <td className="py-2 px-2">
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-800/40 text-slate-400">
                            #{asset.narrative}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right font-mono">
                          <span className={`font-bold ${getTrendScoreStyle(asset.trendScore)}`}>
                            {asset.trendScore}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-slate-300">
                          {asset.momentumPersistenceScore !== undefined ? `${Math.round(asset.momentumPersistenceScore)}/100` : "—"}
                        </td>
                        <td className="py-2 px-2 text-right font-mono">
                          {asset.executionPriority !== undefined ? (
                            <span className="text-violet-400 font-bold bg-violet-500/10 px-1.5 py-0.5 rounded text-[10px] border border-violet-500/20">
                              #{asset.executionPriority} <span className="text-[9px] text-slate-500 font-normal">({asset.finalExecutionScore || 0})</span>
                            </span>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-slate-300">
                          <span className={asset.volumeGrowth24h >= 45 ? "text-purple-400 font-bold" : ""}>
                            {asset.volumeGrowth24h >= 0 ? "+" : ""}{asset.volumeGrowth24h.toFixed(1)}%
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right">
                          <div className="flex flex-col items-end">
                            <span className={getPriceChangeStyle(asset.priceChange1h)}>
                              {asset.priceChange1h >= 0 ? "+" : ""}{asset.priceChange1h.toFixed(1)}% (1h)
                            </span>
                            <span className={getPriceChangeStyle(asset.priceChange24h)}>
                              {asset.priceChange24h >= 0 ? "+" : ""}{asset.priceChange24h.toFixed(1)}% (24h)
                            </span>
                          </div>
                        </td>
                        <td className="py-2 px-2 text-center">
                          <div className="flex flex-col items-center gap-1">
                            {getStatusBadge(asset.status)}
                            {asset.matchedSymbol && (
                              <span className="text-[9px] font-mono text-slate-400 px-1 rounded bg-slate-800/30">
                                HL: {asset.matchedSymbol}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 px-3 text-right">
                          {getActionBadge(asset)}
                        </td>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          )
        ) : activeTab === "watchlist" ? (
          watchlist.length === 0 ? (
            <div className="flex-grow flex flex-col items-center justify-center text-slate-500 gap-2 p-5 text-center">
              <Hourglass className="w-8 h-8 text-teal-500 animate-pulse" />
              <span className="text-xs font-mono uppercase tracking-widest text-[#14b8a6] animate-pulse">No assets in watchlist yet.</span>
              <p className="text-[10px] text-slate-500 max-w-sm mt-1">
                Assets with strong CMC trend scores, strengthening sectors, and accelerating volume expansion will trigger the prepare monitor.
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="text-[10px] uppercase text-slate-500 tracking-wider font-bold border-b border-slate-800/60 sticky top-0 bg-[#090B0E] z-10">
                  <tr>
                    <th className="py-2.5 px-3">Asset Rank</th>
                    <th className="py-2.5 px-2">Narrative</th>
                    <th className="py-2.5 px-2 text-center">State Indicator</th>
                    <th className="py-2.5 px-2 text-right">Trend</th>
                    <th className="py-2.5 px-2 text-right">Priority</th>
                    <th className="py-2.5 px-2 text-right">Spread / Liq</th>
                    <th className="py-2.5 px-2 text-right">Breakout Pressure</th>
                    <th className="py-2.5 px-2 text-right">Monitoring Structure</th>
                    <th className="py-2.5 px-2 text-right font-mono">Est Payout Ratio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40">
                  <AnimatePresence initial={false}>
                    {watchlist.map((item) => (
                      <motion.tr 
                        key={item.symbol}
                        layout
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className={`hover:bg-slate-800/20 transition-all ${
                          item.state === "EXECUTED" ? "bg-emerald-500/[0.02]" : ""
                        }`}
                      >
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-teal-400 bg-teal-500/10 px-1 py-0.5 rounded font-bold border border-teal-500/20">
                              #{item.rank}
                            </span>
                            <div className="flex flex-col">
                              <span className="font-bold text-slate-200 tracking-wide font-mono flex items-center gap-1">
                                {item.symbol}
                                {item.state === "PREPARE" && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-teal-400 inline-block animate-ping" />
                                )}
                              </span>
                              <span className="text-[9px] text-slate-500 font-mono">HL: {item.matchedSymbol}</span>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-2">
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-800/40 text-slate-400">
                            #{item.narrative}
                          </span>
                        </td>
                        <td className="py-2.5 px-2 text-center">
                          {item.state === "WATCHLIST_PREPARE_STATE" && (
                            <span className="px-2 py-0.5 rounded text-[9px] bg-amber-500/10 text-amber-500 font-mono uppercase tracking-wider font-semibold border border-amber-500/20">
                              WATCHLIST
                            </span>
                          )}
                          {item.state === "PREPARE" && (
                            <span className="px-2 py-0.5 rounded text-[9px] bg-teal-500/10 text-teal-400 font-mono uppercase tracking-wider font-extrabold border border-teal-500/20 animate-pulse">
                              PREP ACTIVE
                            </span>
                          )}
                          {item.state === "EXECUTED" && (
                            <span className="px-2 py-0.5 rounded text-[9px] bg-emerald-500/15 text-emerald-400 font-mono uppercase tracking-wider font-black border border-emerald-500/30">
                              EXECUTED
                            </span>
                          )}
                          {item.state === "REJECTED" && (
                            <span className="px-2 py-0.5 rounded text-[9px] bg-slate-800 text-slate-500 font-mono uppercase tracking-wider border border-slate-700">
                              REJECTED
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono text-slate-300">
                          {item.trendScore}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono">
                          <span className="text-violet-400 font-bold bg-violet-500/10 px-1.5 py-0.5 rounded text-[10px] border border-violet-500/20">
                            {item.priorityScore}
                          </span>
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono">
                          <div className="flex flex-col items-end">
                            <span className={item.metrics.spreadDegraded ? "text-rose-400" : "text-emerald-400"}>
                              Spread: {item.metrics.spreadQuality}%
                            </span>
                            <span className={item.metrics.liquidityDegraded ? "text-rose-400" : "text-emerald-400"}>
                              Liquidity: {item.metrics.liquidityQuality}%
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono">
                          <span className={item.metrics.breakoutPressure >= 70 ? "text-amber-400 font-bold" : "text-indigo-400"}>
                            {item.metrics.breakoutPressure}%
                          </span>
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono">
                          <div className="flex flex-col items-end">
                            <span className="text-violet-300 text-[10px] font-semibold">{item.metrics.continuationStructure}</span>
                            <span className="text-slate-500 text-[9px]">Hist: {item.metrics.continuationResult}</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono text-teal-400 font-bold">
                          {item.rewardFeeRatio ? `${item.rewardFeeRatio.toFixed(1)}x` : "—"}
                        </td>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          )
        ) : (
          <div className="flex-grow flex flex-col overflow-hidden">
            <div className="flex items-center justify-between text-[10px] text-slate-500 uppercase tracking-widest px-2.5 pb-2 border-b border-slate-800/60 font-mono">
              <span>Time / Message Context</span>
              <span>Source: Scanner System</span>
            </div>
            <div className="flex-1 overflow-auto p-2 font-mono text-[10px] flex flex-col-reverse gap-1.5 scrollbar-thin">
              {logs.length === 0 ? (
                <div className="text-slate-600 text-center py-10 italic">No scanner actions registered in log stack yet.</div>
              ) : (
                [...logs].reverse().map((log, idx) => (
                  <div key={idx} className={`p-1.5 rounded bg-slate-900/30 border border-slate-800/25 ${getLogLineStyle(log)}`}>
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer Info Gate */}
      <div className="flex items-center justify-between text-[9px] text-slate-500 font-mono px-1">
        <span className="flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5 text-teal-500/80" />
          Execution Guarantee: CoinMarketCap metrics boost rankings but never bypass hard security blocks.
        </span>
        <span className="text-slate-600">
          V1.1 Active Discovery Engine
        </span>
      </div>
    </div>
  );
}, (prev, next) => {
  return prev.intelligence?.lastScanTime === next.intelligence?.lastScanTime && prev.intelligence?.logs?.length === next.intelligence?.logs?.length;
});
