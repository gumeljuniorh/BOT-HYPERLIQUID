import React, { useEffect, useState, useMemo, useRef } from "react";
import { 
  Activity, 
  AlertTriangle,
  ShieldAlert, 
  Wallet, 
  Settings as SettingsIcon, 
  TrendingUp, 
  BarChart3, 
  ChevronRight, 
  Save,
  X,
  RefreshCcw,
  Zap,
  BrainCircuit,
  Target,
  Radio,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  Filter,
  Crosshair,
  Compass
} from "lucide-react";
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ReferenceLine,
  CartesianGrid,
  LineChart,
  Line
} from "recharts";
import { motion, AnimatePresence } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ScannerPanel } from "./components/ScannerPanel";
import { CoinMarketCapPanel } from "./components/CoinMarketCapPanel";
import { SimpleDashboard } from "./components/SimpleDashboard";

function formatPrice(px: number | string | null | undefined): string {
  if (px === null || px === undefined) return "N/A";
  const num = typeof px === "string" ? parseFloat(px) : px;
  if (isNaN(num)) return "N/A";
  if (num === 0) return "0.00";
  if (num < 0.1) return num.toFixed(5);
  if (num < 1.0) return num.toFixed(4);
  if (num < 10.0) return num.toFixed(3);
  return num.toFixed(2);
}

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean, error: Error | null}> {
  public state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#07090b] text-white p-8 font-mono flex flex-col items-center justify-center">
          <div className="max-w-2xl w-full bg-rose-500/10 border border-rose-500/20 p-6 rounded-lg text-rose-400">
            <h1 className="text-xl font-bold mb-4 flex items-center gap-2"><ShieldAlert /> Application Error</h1>
            <pre className="text-xs whitespace-pre-wrap overflow-auto max-h-96">{this.state.error?.stack || this.state.error?.message || "Unknown error"}</pre>
            <button 
              className="mt-6 px-4 py-2 bg-rose-500 text-white rounded font-bold hover:bg-rose-400"
              onClick={() => window.location.reload()}
            >
              Reload Sandbox
            </button>
          </div>
        </div>
      );
    }

    return (this as any).props.children;
  }
}

function cn(...inputs: ClassValue[]) {

  return twMerge(clsx(inputs));
}

function formatDuration(ms: number) {
  if (!ms || ms <= 0) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

function CollapsibleSection({ title, icon, defaultOpen = false, children, badge, storageKey }: { title: React.ReactNode, icon?: React.ReactNode, defaultOpen?: boolean, children: React.ReactNode, badge?: React.ReactNode, storageKey?: string }) {
  const [isOpen, setIsOpen] = useState(() => {
    if (storageKey) {
      try {
        const saved = localStorage.getItem(`collapse_${storageKey}`);
        if (saved !== null) {
          return saved === "true";
        }
      } catch (err) {}
    }
    return defaultOpen;
  });

  const handleToggle = () => {
    const nextState = !isOpen;
    setIsOpen(nextState);
    if (storageKey) {
      try {
        localStorage.setItem(`collapse_${storageKey}`, String(nextState));
      } catch (err) {}
    }
  };

  return (
    <motion.div 
      layout="position"
      className="bg-[#0C0E12] border border-slate-800 rounded-lg overflow-hidden flex flex-col"
    >
      <div 
        className="px-4 md:px-5 py-3 md:py-4 border-b border-slate-800 flex items-center justify-between cursor-pointer" 
        onClick={handleToggle}
      >
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-[10px] uppercase font-bold text-slate-500 tracking-widest">{title}</h3>
        </div>
        <div className="flex items-center gap-3">
          {badge}
          <motion.span 
            animate={{ rotate: isOpen ? 0 : 180 }}
            transition={{ duration: 0.2 }}
            className="text-slate-500"
          >
            <ChevronDown className="w-3 h-3" />
          </motion.span>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="p-4 md:p-5">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function formatFundingRate(rate: number | undefined) {
  if (rate === undefined || Number.isNaN(rate)) return "0.0000%/hr (0.0% APR)";
  const hourlyPct = rate * 100;
  const aprPct = rate * 24 * 365 * 100;
  
  const sign = rate >= 0 ? "+" : "";
  return `${sign}${hourlyPct.toFixed(4)}%/hr (${sign}${aprPct.toFixed(1)}% APR)`;
}

function AppContent() {
  const [status, setStatus] = useState<any>(null);
  const [secondsSinceLastUpdate, setSecondsSinceLastUpdate] = useState<number>(0);

  useEffect(() => {
    const timer = setInterval(() => {
      const lastWss = status?.bot?.lastWssTime;
      if (lastWss) {
        setSecondsSinceLastUpdate(Math.max(0, Math.round((Date.now() - lastWss) / 1000)));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [status?.bot?.lastWssTime]);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAdvancedMode, setIsAdvancedMode] = useState(() => {
    try {
      const saved = localStorage.getItem("isAdvancedMode");
      return saved === "true";
    } catch {
      return false;
    }
  });

  const [uiUpdateCount, setUiUpdateCount] = useState({ count: 0, time: Date.now(), isSafeMode: false });

  const checkUiPerformance = () => {
    const now = Date.now();
    setUiUpdateCount(prev => {
      if (now - prev.time > 5000) {
        if (prev.count > 15 && !prev.isSafeMode) {
           console.log("[UI_FREEZE_DETECTED] High update frequency detected.");
           console.log("[UI_PERFORMANCE_SAFE_MODE_ACTIVE] Safemode enabled to ensure responsiveness.");
           console.log("[SCANNER_RENDER_THROTTLED] Restricted to top 25 items.");
           console.log("[LOG_RENDER_LIMIT_APPLIED] UI action logs constrained to 50 items max.");
           console.log("[HEAVY_COMPONENT_MEMOIZED] Analytics and CMC panels using React.memo overrides.");
           return { count: 1, time: now, isSafeMode: true };
        } else if (prev.count < 5 && prev.isSafeMode) {
           return { count: 1, time: now, isSafeMode: false };
        }
        return { count: 1, time: now, isSafeMode: prev.isSafeMode };
      }
      return { count: prev.count + 1, time: prev.time, isSafeMode: prev.isSafeMode };
    });
  };

  const [uiActionLogs, setUiActionLogs] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("uiActionLogs");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const appendUiLog = (eventName: string) => {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + "." + String(Date.now() % 1000).padStart(3, "0");
    const formatted = `${timeStr} [${eventName}]`;
    setUiActionLogs(prev => {
      const updated = [formatted, ...prev].slice(0, 50);
      try {
        localStorage.setItem("uiActionLogs", JSON.stringify(updated));
      } catch (err) {}
      return updated;
    });
  };

  const handleSetAdvancedMode = (advanced: boolean) => {
    setIsAdvancedMode(advanced);
    try {
      localStorage.setItem("isAdvancedMode", String(advanced));
    } catch (err) {}
    const eventName = advanced ? "UI_MODE_SWITCHED_ADVANCED" : "UI_MODE_SWITCHED_SIMPLE";
    console.log(eventName);
    appendUiLog(eventName);
  };

  useEffect(() => {
    if (isAdvancedMode) {
      console.log("ADVANCED_TELEMETRY_RENDERED");
      appendUiLog("ADVANCED_TELEMETRY_RENDERED");
    } else {
      console.log("SIMPLE_LAYOUT_RENDERED");
      appendUiLog("SIMPLE_LAYOUT_RENDERED");
    }
  }, [isAdvancedMode]);

  const [configForm, setConfigForm] = useState({
    maxExposure: 40,
    leverage: 2,
    stopLossPct: 0.5,
    takeProfitPct: 1.5,
    minEntrySize: 40
  });
  const [lastSavedConfig, setLastSavedConfig] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);

  // States to facilitate brief visual feedback animations & banners
  const [recentlyCanceled, setRecentlyCanceled] = useState<any[]>([]);
  const [recentlyFilled, setRecentlyFilled] = useState<any[]>([]);
  const [newlyPlaced, setNewlyPlaced] = useState<string[]>([]);
  const [recentTrades, setRecentTrades] = useState<string[]>([]);

  const prevActiveOrdersRef = useRef<any[]>([]);
  const prevTradesRef = useRef<any[]>([]);
  
  const configFormRef = useRef(configForm);
  const lastSavedConfigRef = useRef<any>(null);

  useEffect(() => {
    configFormRef.current = configForm;
  }, [configForm]);

  useEffect(() => {
    const handler = setTimeout(async () => {
      const isValid = 
        configForm &&
        typeof configForm.maxExposure === "number" && !Number.isNaN(configForm.maxExposure) && configForm.maxExposure >= 40 &&
        typeof configForm.leverage === "number" && !Number.isNaN(configForm.leverage) && configForm.leverage >= 1 &&
        typeof configForm.stopLossPct === "number" && !Number.isNaN(configForm.stopLossPct) && configForm.stopLossPct >= 0.01 &&
        typeof configForm.takeProfitPct === "number" && !Number.isNaN(configForm.takeProfitPct) && configForm.takeProfitPct >= 0.01 &&
        typeof configForm.minEntrySize === "number" && !Number.isNaN(configForm.minEntrySize) && configForm.minEntrySize >= 11;

      if (!isValid) {
        return;
      }

      if (lastSavedConfigRef.current && JSON.stringify(configForm) !== JSON.stringify(lastSavedConfigRef.current)) {
        setIsSaving(true);
        try {
          const res = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: configForm })
          });
          if (res.ok) {
            lastSavedConfigRef.current = configForm;
            setLastSavedConfig(configForm);
          }
        } catch (e) {
          console.error("Failed to auto-save config", e);
        } finally {
          setIsSaving(false);
        }
      }
    }, 1000);
    return () => clearTimeout(handler);
  }, [configForm]);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/status");
        if (res.ok) {
          const data = await res.json();
          
          if (data && data.bot) {
            const newActiveOrders = data.bot.activeOrders || [];
            const newTrades = data.bot.trades || [];
            const prevActiveOrders = prevActiveOrdersRef.current;
            const prevTrades = prevTradesRef.current;

            // Only analyze changes if we already had a previous state (prevents first poll mass-highlights)
            if (prevActiveOrders && prevActiveOrders.length > 0) {
              const now = Date.now();

              // 1. Detect newly PLACED orders
              const placed = newActiveOrders.filter((no: any) => !prevActiveOrders.some((po: any) => po.oid === no.oid));
              if (placed.length > 0) {
                const placedOids = placed.map((o: any) => String(o.oid));
                setNewlyPlaced(p => [...p, ...placedOids]);
                setTimeout(() => {
                  setNewlyPlaced(p => p.filter(oid => !placedOids.includes(oid)));
                }, 10000);
              }

              // 2. Detect FILLED and CANCELED orders from missing active orders
              const missingOrders = prevActiveOrders.filter((po: any) => !newActiveOrders.some((no: any) => no.oid === po.oid));
              missingOrders.forEach((o: any) => {
                // Determine if filled or canceled
                const isTradeFilled = newTrades.some((t: any) => 
                  String(t.oid) === String(o.oid) || 
                  (!prevTrades.some((pt: any) => pt.timestamp === t.timestamp) && 
                   t.symbol === o.coin && 
                   Math.abs(t.notional - parseFloat(o.sz) * (t.entryPrice || t.fillPrice || parseFloat(o.limitPx))) < 5)
                );

                if (isTradeFilled) {
                  const filledItem = { ...o, status: "FILLED", timestamp: now };
                  setRecentlyFilled(prev => [...prev.filter(x => x.oid !== o.oid), filledItem]);
                  setTimeout(() => {
                    setRecentlyFilled(prev => prev.filter(x => x.oid !== o.oid));
                  }, 12000);
                } else {
                  const canceledItem = { ...o, status: "CANCELED", timestamp: now };
                  setRecentlyCanceled(prev => [...prev.filter(x => x.oid !== o.oid), canceledItem]);
                  setTimeout(() => {
                    setRecentlyCanceled(prev => prev.filter(x => x.oid !== o.oid));
                  }, 12000);
                }
              });
            }

            // 3. Detect new trades (whether standard fills or immediate market executions)
            if (prevTrades && prevTrades.length > 0) {
              const addedTrades = newTrades.filter((nt: any) => !prevTrades.some((pt: any) => pt.timestamp === nt.timestamp && pt.oid === nt.oid));
              if (addedTrades.length > 0) {
                const tradeIds = addedTrades.map((t: any) => `${t.timestamp}-${t.oid || ''}`);
                setRecentTrades(prev => [...prev, ...tradeIds]);
                setTimeout(() => {
                  setRecentTrades(prev => prev.filter(id => !tradeIds.includes(id)));
                }, 10000);
              }
            }

            // Keep reference state synced for next comparison
            prevActiveOrdersRef.current = newActiveOrders;
            prevTradesRef.current = newTrades;
          }

          setStatus(data);
          checkUiPerformance();
          if (data.bot?.config) {
            if (!lastSavedConfigRef.current || JSON.stringify(lastSavedConfigRef.current) === JSON.stringify(configFormRef.current)) {
              setConfigForm(data.bot.config);
              lastSavedConfigRef.current = data.bot.config;
              setLastSavedConfig(data.bot.config);
            }
          }
        }
      } catch (e) {
        // Silently catch fetch errors while server is starting
      }
    };
    
    fetchStatus();
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const bot = status?.bot || {};
  const isFunded = (bot.accountEquity || 0) > 0;
  
  const calculatedRisk = useMemo(() => {
    const exp = parseFloat(configForm.maxExposure as any) || 0;
    const lev = parseFloat(configForm.leverage as any) || 1;
    const sl = parseFloat(configForm.stopLossPct as any) || 0;
    const tp = parseFloat(configForm.takeProfitPct as any) || 0;
    const eq = parseFloat(bot.accountEquity as any) || 100;
    const avail = parseFloat(bot.availableMargin as any) || eq;

    const maxLossUsd = exp * (sl / 100);
    const maxProfitUsd = exp * (tp / 100);
    const lossPctOfEquity = eq > 0 ? (maxLossUsd / eq) * 100 : 0;
    const profitPctOfEquity = eq > 0 ? (maxProfitUsd / eq) * 100 : 0;
    const rrRatio = sl > 0 ? tp / sl : 0;
    const reqMargin = lev > 0 ? exp / lev : 0;
    const marginPctOfAvail = avail > 0 ? (reqMargin / avail) * 100 : 0;
    const liqDistance = lev > 0 ? 100 / lev : 100;

    let equityRiskClass = "text-emerald-400";
    let equityRiskLabel = "Green Guard-rail";
    let equityRiskDesc = "Single loss is within safe 1.5% institutional boundary.";
    let equityRiskBadgeColor = "text-emerald-500 bg-emerald-500/10 border-emerald-500/20";
    if (lossPctOfEquity > 5.0) {
      equityRiskClass = "text-rose-400";
      equityRiskLabel = "Aggressive Risk";
      equityRiskDesc = "Single stop-loss wipes out >5% of account balance.";
      equityRiskBadgeColor = "text-rose-500 bg-rose-500/10 border-rose-500/20 animate-pulse";
    } else if (lossPctOfEquity > 1.5) {
      equityRiskClass = "text-amber-400";
      equityRiskLabel = "Moderate Risk";
      equityRiskDesc = "Acceptable leverage risk; monitor aggregate core drawdowns.";
      equityRiskBadgeColor = "text-amber-500 bg-amber-500/10 border-amber-500/20";
    }

    let rrClass = "text-[#8A4FFF]";
    let rrLabel = "Positive Edge (Optimal)";
    let rrDesc = "Reward target exceeds risk by more than 2x. Robust mathematical advantage.";
    let rrBadgeColor = "text-[#8A4FFF] bg-[#8A4FFF]/10 border-[#8A4FFF]/20";
    if (rrRatio < 1.0) {
      rrClass = "text-rose-400";
      rrLabel = "Negative Edge (Suboptimal)";
      rrDesc = "Risk is larger than reward per trade. Requires extreme win-rates.";
      rrBadgeColor = "text-rose-500 bg-rose-500/10 border-rose-500/20";
    } else if (rrRatio < 2.0) {
      rrClass = "text-amber-400";
      rrLabel = "Standard Edge (Balanced)";
      rrDesc = "Fair ratio; target win rate must exceed 50% to stay positive.";
      rrBadgeColor = "text-amber-500 bg-amber-500/10 border-amber-500/20";
    }

    let levClass = "text-emerald-400";
    let levLabel = "Stable Ratio";
    let levDesc = "Conservative borrowing scale. Massive asset cushion.";
    let levBadgeColor = "text-emerald-500 bg-emerald-500/10 border-emerald-500/20";
    if (lev > 15) {
      levClass = "text-rose-400";
      levLabel = "Ultra Leverage (Aggressive)";
      levDesc = "Caution: Minor opposite price moves trigger liquidation.";
      levBadgeColor = "text-rose-500 bg-rose-500/10 border-rose-500/20";
    } else if (lev > 5) {
      levClass = "text-amber-400";
      levLabel = "Active Leverage (Moderate)";
      levDesc = "Standard perp multiplier. Buffer handles medium day-to-day noise.";
      levBadgeColor = "text-amber-500 bg-amber-500/10 border-amber-500/20";
    }

    return {
      maxLossUsd,
      maxProfitUsd,
      lossPctOfEquity,
      profitPctOfEquity,
      rrRatio,
      reqMargin,
      marginPctOfAvail,
      liqDistance,
      equityRiskClass,
      equityRiskLabel,
      equityRiskDesc,
      equityRiskBadgeColor,
      rrClass,
      rrLabel,
      rrDesc,
      rrBadgeColor,
      levClass,
      levLabel,
      levDesc,
      levBadgeColor
    };
  }, [configForm, bot.accountEquity, bot.availableMargin]);

  const analytics = bot.analytics || {
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    netProfitability: 0,
    maxDrawdown: 0
  };

  const blockerInfo = useMemo(() => {
    const b = bot.blocker;

    // 1. CRITICAL FAILURES
    const criticalBlockers = [
      "VALIDATION_FAILED",
      "STATE_DESYNC",
      "API_NOT_VERIFIED",
      "WSS_FATAL_DISCONNECT",
      "REAL_POSITION_OPEN_UNMANAGED",
      "FAILED_EMERGENCY_CLOSE_REQUIRED",
      "VALIDATION_NOT_SUCCESS",
      "CONNECTION_LOST",
      "MANUAL_CLOSE_REQUIRED"
    ];

    const isCritical = 
      (b && (
        criticalBlockers.includes(b) ||
        b.startsWith("CIRCUIT_BREAKER_ACTIVE") ||
        b.includes("VALIDATION_FAILED") ||
        b.includes("PRIVATE_KEY") ||
        b.includes("YOU PROVIDED YOUR MAIN")
      )) || 
      bot.phase === "VALIDATION_FAILED";

    if (isCritical) {
      let title = "System Failure Halted Execution";
      let desc = "Execution cycle terminated due to safety validation failure or critical error.";
      if (b) {
        if (b === "VALIDATION_FAILED") { title = "Validation Failure"; desc = "Execution cycle terminated due to safety validation failure."; }
        else if (b === "STATE_DESYNC") { title = "State Desync Detected"; desc = "Discrepancy detected between internal tracking and exchange state."; }
        else if (b === "API_NOT_VERIFIED") { title = "API Credentials Unverified"; desc = "Hyperliquid API key and validation checks are unverified."; }
        else if (b === "WSS_FATAL_DISCONNECT") { title = "WSS Fatal Disconnect"; desc = "Persistent WebSocket disconnection. Automatic reconnection attempts fully exhausted."; }
        else if (b === "REAL_POSITION_OPEN_UNMANAGED") { title = "Unmanaged Real Position Detected"; desc = "An active position was detected on exchange without a recorded database ticket."; }
        else if (b === "FAILED_EMERGENCY_CLOSE_REQUIRED") { title = "Emergency Close Failed"; desc = "Automatic risk remediation failed to close target positions. Manual action needed."; }
        else if (b === "VALIDATION_NOT_SUCCESS") { title = "System Validation Missing"; desc = "System validation status is incomplete. Refusing to place entry orders."; }
        else if (b === "CONNECTION_LOST") { title = "Connection Lost"; desc = "Loss of telemetry connection. Entries halted for safety."; }
        else if (b === "MANUAL_CLOSE_REQUIRED") { title = "Manual Position Close Required"; desc = "Unmanaged position detected on exchange. Manual close is required."; }
        else if (b.includes("MULTIPLE_POSITIONS_DETECTED")) { title = "Circuit Breaker: Multiple Positions"; desc = "Tripped circuit breaker: Multiple concurrent open positions detected."; }
        else if (b.includes("INVALID_POSITION_DATA")) { title = "Circuit Breaker: Invalid Position Data"; desc = "Tripped circuit breaker: Invalid or fragmented trade data received."; }
        else if (b.includes("WSS_INSTABILITY")) { title = "Circuit Breaker: WebSocket Instability"; desc = "Tripped circuit breaker: WebSocket variance detected. Entries paused to prevent desync."; }
        else if (b.includes("OVERTRADING_LIMIT")) { title = "Circuit Breaker: Overtrading Breach"; desc = "Tripped circuit breaker: Trade velocity capped due to excessive short-term entries."; }
        else if (b.includes("HIGH_EXITS")) { title = "Circuit Breaker: High Exits Rate"; desc = "Tripped circuit breaker: Exits per hour limit exceeded."; }
        else if (b.includes("PORTFOLIO_CAP")) { title = "Circuit Breaker: Portfolio Cap"; desc = "Tripped circuit breaker: Portfolio maximum exposure limit has been breached."; }
        else if (b.includes("FEE_BLEED")) { title = "Circuit Breaker: Fee Bleed Suspended"; desc = "Tripped circuit breaker: High transaction fees have suspended entries for optimization."; }
        else if (b.includes("PRIVATE_KEY_MISSING")) { title = "Private Key Missing"; desc = "Hyperliquid Private Key is missing from settings."; }
        else if (b.includes("INVALID_PRIVATE_KEY")) { title = "Invalid Private Key Format"; desc = "Provided Private Key is invalid (looks like a wallet address)."; }
        else if (b.includes("YOU PROVIDED YOUR MAIN")) { title = "Forbidden Main Wallet Key"; desc = "API Automation requires an API Agent Wallet, not your main account wallet key."; }
        else { title = "Execution Interrupted"; desc = b; }
      }
      return {
        category: "CRITICAL_FAILURE" as const,
        badgeLabel: "CRITICAL FAILURE",
        title,
        description: desc,
        colorClass: "bg-rose-500/5 border-rose-500/20 text-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.1)]",
        badgeClass: "bg-rose-500/10 text-rose-400 border border-rose-500/20"
      };
    }

    // 2. ACTIVE (Has open positions and not critical)
    if (bot.openPositions > 0) {
      return {
        category: "ACTIVE" as const,
        badgeLabel: "ACTIVE",
        title: "Active Trading Mode",
        description: `Active trade position in progress for ${bot.activeSymbol || "N/A"}. Trailing stops automated.`,
        colorClass: "bg-emerald-500/5 border-emerald-500/20 text-emerald-400 font-sans",
        badgeClass: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
      };
    }

    // 3. PROTECTED PAUSE
    const pauseBlockers = [
      "DRAWDOWN_PAUSE_ACTIVE",
      "DRAWDOWN_COOLDOWN_ACTIVE",
      "HARD_POST_TRADE_COOLDOWN",
      "SOFT_POST_TRADE_COOLDOWN",
      "REVERSE_LOCK_ACTIVE",
      "DAILY_TRADE_LIMIT_REACHED",
      "FEE_HARD_SUSPENSION_ACTIVE",
      "FEE_SOFT_SUSPENSION_ACTIVE",
      "OVERTRADING_PAUSE_ACTIVE",
      "OVERTRADING_LIMIT_BREACHED",
      "BELOW_PREFERRED_SAFETY_TARGET",
      "ACCOUNT_UNFUNDED",
      "ENTRY_BLOCKED_POSITION_MANAGEMENT_ACTIVE",
      "PROTECTING_OPEN_POSITION"
    ];

    const isPaused = b && (pauseBlockers.includes(b) || b.includes("PAUSE") || b.includes("COOLDOWN") || b.includes("LOCK") || b.includes("LIMIT") || b.includes("SUSPENDED"));

    if (isPaused) {
      let title = "Protected Pause Active";
      let desc = "Trading rules have briefly paused execution for risk protection.";
      if (b) {
        if (b === "HARD_DRAWDOWN_PAUSE_ACTIVE") { title = "Hard Drawdown Lock Active"; desc = "Execution locked due to >= 10% peak-to-trough drawdown limit breach."; }
        else if (b === "SOFT_DRAWDOWN_PAUSE_ACTIVE") { title = "Soft Drawdown Mode Active"; desc = "Soft drawdown active (>= 2.5%): Standard entries restricted, allowing only elite setups with reduced risk."; }
        else if (b === "MODERATE_DRAWDOWN_PAUSE_ACTIVE") { title = "Moderate Drawdown Mode Active"; desc = "Moderate drawdown active (>= 5%): Standard entries locked, allowing highest-confidence setups with heavy size reduction."; }
        else if (b === "HARD_POST_TRADE_COOLDOWN") { title = "Hard Cooldown Active"; desc = "Execution temporarily locked for structural stabilization post-close or emergency exit."; }
        else if (b === "SOFT_POST_TRADE_COOLDOWN") { title = "Soft Cooldown Active"; desc = "Standard execution paused post-close. Allowing only elite continuation entries to override."; }
        else if (b === "REVERSE_LOCK_ACTIVE") { title = "Reverse Direction locked"; desc = "Reverse flip lock active. Opposite position setups are restricted for 2 minutes."; }
        else if (b === "DAILY_TRADE_LIMIT_REACHED") { title = "Daily Allocation Limit Met"; desc = "Execution paused: Daily maximum 10 trades per day rule limit has been fully met."; }
        else if (b === "FEE_HARD_SUSPENSION_ACTIVE") { title = "Hard Fee Suspension Active"; desc = "Trading restricted: Severe fee bleed detected. Only monitoring until efficiency clears."; }
        else if (b === "FEE_SOFT_SUSPENSION_ACTIVE") { title = "Soft Fee Suspension Active"; desc = "Standard entries restricted: Historical fee bleed is high. Allowing only elite setups."; }
        else if (b === "OVERTRADING_PAUSE_ACTIVE") { title = "Overtrading Cooldown Paused"; desc = "Adaptive velocity check active. Preventing prompt direction whipsawing."; }
        else if (b === "BELOW_PREFERRED_SAFETY_TARGET") { title = "Below Minimum Safety Equity"; desc = "Trade entries paused because account equity did not clear the minimum risk baseline."; }
        else if (b === "ACCOUNT_UNFUNDED") { title = "No Base Balance Detected"; desc = "Protocol is empty. Please deposit USDC on your Base/Hyperliquid account to start."; }
        else if (b === "ENTRY_BLOCKED_POSITION_MANAGEMENT_ACTIVE") { title = "Position Management Active"; desc = "Protecting and tracking current trade cycle modifications. Entry is paused."; }
        else if (b === "PROTECTING_OPEN_POSITION") { title = "Protecting Open Position"; desc = "System is fully monitoring active protection parameters. Secondary entries are restricted."; }
        else { title = "Protected Pause Active"; desc = b; }
      }
      return {
        category: "PROTECTED_PAUSE" as const,
        badgeLabel: "PROTECTED PAUSE",
        title,
        description: desc,
        colorClass: "bg-amber-500/5 border-amber-500/20 text-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.05)]",
        badgeClass: "bg-amber-500/10 text-amber-500 border border-amber-500/20"
      };
    }

    // 4. MONITORING
    let title = "Monitoring Market Conditions";
    let desc = "Market Scanner is fully active. Scanning and searching approved assets for compliant setups.";

    if (b) {
      if (bot.chopState === "TRUE_CHOP_NO_TRADE" || b === "CHOP_NO_TRADE_ACTIVE" || b === "RANGING_CHOP") { 
        title = "True Chop — No Trade"; 
        desc = "Whipsaw protection active. Chop filter is preventing entry setups in ranging blocks."; 
      }
      else if (bot.chopState === "DEVELOPING_BREAKOUT" || b.startsWith("CHOP_CLASSIFIED_DEVELOPING_BREAKOUT")) {
        title = "Breakout Developing";
        desc = "Compression breakdown in progress. High volatility with trend strength building.";
      }
      else if (bot.chopState === "DIRECTIONAL_CHOP_RECOVERY" || b.startsWith("DIRECTIONAL_CHOP_RECOVERY")) {
        title = "Trend Recovering";
        desc = "Trend strength improving with stable expected direction.";
      }
      else if (bot.chopState === "CHOP_RECOVERY_MONITORING" || b.startsWith("CHOP_RECOVERY_MONITORING")) {
        title = "Monitoring Direction";
        desc = "Chop condition resolving. Tracking confirmation triggers to authorize entries.";
      }
      else if (b === "NO_VALID_MARKET_SETUP" || b === "WAITING_FOR_VALID_SETUP") { title = "Waiting for Valid Setup"; desc = "Restfully waiting for clear technical structural breakouts or trend alignments."; }
      else if (b === "LOW_EXPECTANCY_MARKET") { title = "Monitoring Market Conditions"; desc = "Overall market expectancy rating is currently negative. Entries paused."; }
      else if (b === "HIGH_FEE_MARKET_NOT_WORTH_RISK") { title = "Monitoring Market Conditions"; desc = "Market flagged for high fee friction. Standard expectation models are insufficient to justify entry."; }
      else if (b === "LOW_EXPECTANCY_SETUP_REJECTED") { title = "Trend Quality Insufficient"; desc = "Recent trade setups fell below the minimum trend and quality expectations."; }
      else if (b === "VOLATILITY_NOISE_REJECTED") { title = "Monitoring Market Conditions"; desc = "Noisy volatility or compressed range detected. Entries rejected for quality safety."; }
      else if (b === "FAKE_BREAKOUT_FILTERED") { title = "Monitoring Market Conditions"; desc = "Fake breakout or weak breakout expansion successfully identified and filtered."; }
      else if (b === "INSUFFICIENT_EXPECTED_MOVE") { title = "Monitoring Market Conditions"; desc = "Expected move is insufficient to clear fee friction relative to the stop loss distance."; }
      else if (b === "INSUFFICIENT_EXPECTED_HOLD") { title = "Expected Hold Time Too Short"; desc = "Setup expected hold duration is below the minimum required limit to prevent high-velocity fee drift."; }
      else if (b === "HTF_MISALIGNMENT") { title = "Trend Quality Insufficient"; desc = "Blocked setup: Entry signals conflict with the higher timeframe technical bias."; }
      else if (b === "REPEATED_ENTRY_ON_SAME_WEAK_STRUCTURE") { title = "Monitoring Market Conditions"; desc = "Entry blocked on same weak structure following a historical asset loss."; }
      else if (b === "CONFIDENCE_TOO_LOW" || b === "CONFIDENCE_TOO_LOW_FOR_PORTFOLIO_MAX") { title = "Trend Quality Insufficient"; desc = "Setup confidence is below the high-probability benchmark limit required for live trades."; }
      else if (b === "STRICT_CONFIRMATION_REQUIRED") { title = "Waiting for Valid Setup"; desc = "Awaiting strict 3-candle momentum confirmation before committing entry order."; }
      else if (b === "LOW_VOLATILITY") { title = "Chop Detected — Entries Paused"; desc = "Low volatility noise filter active. Restfully waiting for volatility expansion blocks."; }
      else if (b === "PRE_BREAKOUT_WATCH") { title = "Waiting for Valid Setup"; desc = "Awaiting pre-breakout setup validation to enter on momentum velocity close."; }
      else if (b === "DRY_RUN ENABLED") { title = "Monitoring Market Conditions"; desc = "Simulated execution active. Scanning and tracking virtual contracts."; }
      else { title = "Monitoring Market Conditions"; desc = b; }
    }

    return {
      category: "MONITORING" as const,
      badgeLabel: "MONITORING",
      title,
      description: desc,
      colorClass: "bg-indigo-500/5 border-indigo-500/20 text-indigo-400 shadow-[0_0_20px_rgba(99,102,241,0.05)]",
      badgeClass: "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
    };
  }, [bot.blocker, bot.openPositions, bot.phase, bot.activeSymbol]);

  if (!status) {
    return (
      <div className="min-h-screen bg-[#0A0B0D] text-slate-500 font-mono flex items-center justify-center uppercase tracking-widest text-[10px] font-bold">
        <motion.div
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        >
          Initializing Executor System...
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0E11] text-[#EAECEF] font-sans flex flex-col overflow-hidden pb-[120px] xl:pb-0">
      {/* Header Section */}
      <header className="h-14 shrink-0 border-b border-[#2B3139] bg-[#181A20] px-4 md:px-6 flex items-center justify-between z-20">
        <div className="flex items-center space-x-3 md:space-x-4">
          <div className="w-6 h-6 md:w-7 md:h-7 bg-[#FCD535] rounded-sm flex items-center justify-center font-bold text-[#181A20]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 0l4.33 7.5L25 12l-8.67 4.5L12 24l-4.33-7.5L-1 12l8.67-4.5L12 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-[13px] md:text-[15px] font-bold tracking-wide text-[#EAECEF] flex items-center gap-2">
              Zepoul Bot Perps
              <span className="text-[10px] font-medium bg-[#2B3139] text-[#848E9C] px-1.5 py-0.5 rounded">BETA</span>
            </h1>
            <div className="hidden md:flex items-center space-x-3 mt-0.5">
              <StatusIndicator 
                active={bot.wssConnected} 
                label="WSS" 
                detail={
                  (!bot.wssConnected && bot.wssReconnectAttempts > 0)
                    ? `REC#${bot.wssReconnectAttempts}` 
                    : (bot.lastWssTime ? new Date(bot.lastWssTime).toLocaleTimeString([], { hour12: false }) : "")
                }
              />
              <StatusIndicator active={bot.apiConnected} label="API" />
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-4 md:space-x-6">
          {/* Trading Execution Mode segmented control */}
          <div className="flex bg-[#0B0E11] p-0.5 rounded border border-[#2B3139] items-center">
            <button 
              onClick={async () => {
                try {
                  const res = await fetch("/api/toggle-dry-run", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ dryRun: true })
                  });
                  if (res.ok) {
                    const data = await res.json();
                    setStatus((s: any) => s ? { ...s, bot: { ...s.bot, dryRun: data.dryRun, blocker: data.blocker } } : s);
                  }
                } catch (e) {
                  console.error("Failed to toggle dry run mode:", e);
                }
              }}
              className={cn(
                "px-3 py-1 text-[11px] font-medium rounded-sm transition-all h-6 flex items-center cursor-pointer border-none gap-1",
                bot.dryRun
                  ? "bg-[#2B3139] text-amber-400"
                  : "text-[#848E9C] hover:text-amber-400"
              )}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full", bot.dryRun ? "bg-amber-400" : "bg-transparent border border-[#848E9C]")}></span>
              Simulated
            </button>
            <button 
              onClick={async () => {
                try {
                  const res = await fetch("/api/toggle-dry-run", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ dryRun: false })
                  });
                  if (res.ok) {
                    const data = await res.json();
                    setStatus((s: any) => s ? { ...s, bot: { ...s.bot, dryRun: data.dryRun, blocker: data.blocker } } : s);
                  }
                } catch (e) {
                  console.error("Failed to toggle dry run mode:", e);
                }
              }}
              className={cn(
                "px-3 py-1 text-[11px] font-medium rounded-sm transition-all h-6 flex items-center cursor-pointer border-none gap-1",
                !bot.dryRun
                  ? "bg-[#2B3139] text-[#0ECB81]"
                  : "text-[#848E9C] hover:text-[#0ECB81]"
              )}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full animate-pulse", !bot.dryRun ? "bg-[#0ECB81]" : "bg-transparent border border-[#848E9C]")}></span>
              Live Trading
            </button>
          </div>

          {/* Mode Toggle Segmented Control */}
          <div className="flex bg-[#0B0E11] p-0.5 rounded border border-[#2B3139]">
            <button 
              onClick={() => handleSetAdvancedMode(false)}
              className={cn(
                "px-3 py-1 text-[11px] font-medium rounded-sm transition-all h-6 flex items-center cursor-pointer border-none",
                !isAdvancedMode 
                  ? "bg-[#2B3139] text-[#EAECEF]" 
                  : "text-[#848E9C] hover:text-[#EAECEF]"
              )}
            >
              Simple
            </button>
            <button 
              onClick={() => handleSetAdvancedMode(true)}
              className={cn(
                "px-3 py-1 text-[11px] font-medium rounded-sm transition-all h-6 flex items-center cursor-pointer border-none",
                isAdvancedMode 
                  ? "bg-[#2B3139] text-[#EAECEF]" 
                  : "text-[#848E9C] hover:text-[#EAECEF]"
              )}
            >
              Advanced
            </button>
          </div>

          <button 
            onClick={async () => {
              try {
                await fetch('/api/resume-all', { method: 'POST' });
              } catch (e) {
                console.error('Failed to resume:', e);
              }
            }} 
            className="hidden sm:flex px-3 py-1.5 text-[11px] font-medium bg-[#2B3139] hover:bg-[#4A515B] text-[#EAECEF] rounded transition-colors items-center"
          >
            Resume Engine
          </button>

          <div className="flex items-center space-x-4 px-3 py-1 md:px-4 md:py-1 hover:bg-[#2B3139] transition-colors rounded cursor-pointer" onClick={() => setIsSettingsOpen(true)}>
            <div className="text-right hidden sm:block">
              <p className="text-[10px] text-[#848E9C] leading-none mb-0.5">Mark Price</p>
              <p className="text-xs font-mono font-bold text-[#EAECEF]">${bot.markPrice.toFixed(2)}</p>
            </div>
            <div className="h-6 w-px bg-[#2B3139] hidden sm:block"></div>
            <div className="text-right">
              <p className="text-[10px] text-[#848E9C] leading-none mb-0.5">Status</p>
              <p className={cn("text-[11px] font-medium", bot.phase === "ACTIVE" ? "text-[#0ECB81]" : "text-[#FCD535]")}>
                {bot.phase || 'READY'}
              </p>
            </div>
          </div>
        </div>
      </header>

      {uiUpdateCount.isSafeMode && (
        <div className="bg-orange-500/10 border-b border-orange-500/20 px-6 py-2 flex items-center justify-center gap-3">
          <AlertTriangle className="w-4 h-4 text-orange-500 animate-pulse" />
          <span className="text-orange-500 text-[10px] uppercase font-bold tracking-widest font-mono">
             UI_PERFORMANCE_SAFE_MODE_ACTIVE: UI rendering throttled to protect trading engine resources.
          </span>
        </div>
      )}

      {!isAdvancedMode ? (
         <SimpleDashboard bot={bot} blockerInfo={blockerInfo} isAdvancedMode={isAdvancedMode} setIsAdvancedMode={handleSetAdvancedMode} />
      ) : (
      <main className="flex-1 flex flex-col xl:flex-row overflow-hidden relative">
        {/* Sidebar Panel */}
        {isAdvancedMode && (
          <aside className="w-80 border-r border-slate-800 bg-[#0C0E12] flex flex-col hidden xl:flex">
          <div className="p-4 border-b border-slate-800 space-y-4">
            <h3 className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-2">
              <Wallet className="w-3.5 h-3.5 text-[#8A4FFF]" /> Account Protocol
            </h3>
            <div className="bg-black/60 p-4 rounded-lg border border-slate-800/50 space-y-3 relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity">
                <Zap className="w-12 h-12 text-[#8A4FFF]" />
              </div>
              <div className="space-y-1">
                <p className="text-[9px] uppercase font-bold text-slate-600">Primary Wallet</p>
                <p className="text-[10px] font-mono break-all text-slate-400 leading-relaxed tabular-nums">0xEDA8eC30Ef8DeFB416DFf5c2c78D83Aaa906cC77</p>
              </div>
              <div className="flex justify-between items-center pt-3 border-t border-slate-800/50">
                <span className={cn("text-[9px] font-black tracking-tighter px-2 py-0.5 rounded", isFunded ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500")}>
                  {isFunded ? "PROTOCOL_FUNDED" : "PROTOCOL_EMPTY"}
                </span>
                <span className="text-[9px] font-mono text-slate-600">USDC_BASE</span>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            <div>
              <h3 className="text-[10px] uppercase font-bold text-slate-500 mb-3 tracking-widest">Active Position</h3>
              {bot.positionDetails ? (
                <div className="space-y-4">
                  <div className="flex justify-between items-end border-b border-slate-800/50 pb-2">
                    <div>
                      <p className="text-lg font-mono font-bold text-white tabular-nums">{bot.positionDetails.szi} <span className="text-[10px] text-slate-500 font-normal">{bot.activeSymbol}</span></p>
                      <p className="text-[10px] text-slate-500">Entry: ${formatPrice(bot.positionDetails.entryPx)}</p>
                    </div>
                    <div className="text-right">
                      <p className={cn("text-sm font-mono font-bold", parseFloat(bot.positionDetails.unrealizedPnl) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {parseFloat(bot.positionDetails.unrealizedPnl) >= 0 ? "+" : ""}${parseFloat(bot.positionDetails.unrealizedPnl).toFixed(2)}
                      </p>
                      <p className="text-[10px] text-slate-500">ROE: {(parseFloat(bot.positionDetails.returnOnEquity) * 100).toFixed(2)}%</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-slate-500 uppercase font-bold tracking-tighter italic">Stop Gain (TP)</span>
                      <span className="text-emerald-400 font-mono font-bold">${formatPrice(bot.protection.tpPrice) || "N/A"}</span>
                    </div>
                    <div className="flex justify-between text-[10px]">
                      <span className="text-slate-500 uppercase font-bold tracking-tighter italic">Loss Protection (SL)</span>
                      <span className="text-rose-400 font-mono font-bold">${formatPrice(bot.protection.slPrice) || "N/A"}</span>
                    </div>

                    <div className="border-t border-slate-800/40 my-1 pt-1 space-y-1.5 pb-1">
                      <div className="flex justify-between text-[9px] font-mono">
                        <span className="text-slate-500">Highest PnL %</span>
                        <span className="text-emerald-500 font-bold">{(bot.protection.highestUnrealizedPnlPct || 0).toFixed(2)}%</span>
                      </div>
                      <div className="flex justify-between text-[9px] font-mono">
                        <span className="text-slate-500">Locked Profit %</span>
                        <span className="text-yellow-500 font-bold">{(bot.protection.currentLockedProfitPct || 0).toFixed(2)}%</span>
                      </div>
                      <div className="flex justify-between text-[9px] font-mono">
                        <span className="text-slate-500">Profit-Lock Level</span>
                        <span className={cn(
                          "px-1 py-0.5 rounded text-[8px] font-black",
                          bot.protection.activeProfitLockLevel === "LEVEL_2" ? "bg-purple-500/20 text-purple-400" :
                          bot.protection.activeProfitLockLevel === "LEVEL_1" ? "bg-blue-500/20 text-blue-400" :
                          bot.protection.activeProfitLockLevel === "ARMED" ? "bg-amber-500/20 text-amber-500" :
                          "bg-slate-800 text-slate-500"
                        )}>
                          {bot.protection.activeProfitLockLevel || "NONE"}
                        </span>
                      </div>
                      <div className="flex justify-between text-[9px] font-mono">
                        <span className="text-slate-500">Trailing Status</span>
                        <span className={cn("font-bold", bot.protection.isTrailingActive ? "text-indigo-400 animate-pulse" : "text-slate-600")}>
                          {bot.protection.isTrailingActive ? "ACTIVE" : "INACTIVE"}
                        </span>
                      </div>
                    </div>

                    {bot.protection.isTrailingActive && (
                      <div className="flex justify-between text-[10px] bg-indigo-500/10 p-1 rounded border border-indigo-500/20">
                        <span className="text-indigo-400 uppercase font-bold tracking-tighter italic animate-pulse flex items-center gap-1">
                          <Activity className="w-2 h-2" /> Trailing
                        </span>
                        <span className="text-indigo-300 font-mono font-bold">${bot.protection.trailingStopPrice?.toFixed(2)}</span>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <StatBox label="Margin" value={`$${parseFloat(bot.positionDetails.marginUsed).toFixed(2)}`} />
                    <StatBox label="Liq. Price" value={bot.positionDetails.liquidationPx ? `$${bot.positionDetails.liquidationPx}` : "N/A"} />
                  </div>
                </div>
              ) : (
                <div className="h-24 border border-dashed border-slate-800 rounded-lg flex flex-col items-center justify-center text-slate-600">
                  <Activity className="w-5 h-5 mb-2 opacity-20" />
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-40">Scanning for entry...</p>
                </div>
              )}
            </div>

            <div>
              <h3 className="text-[10px] uppercase font-bold text-slate-500 mb-3 tracking-widest">Execution Registry</h3>
              <div className="space-y-2">
                <RegistryItem label="Validation" value={bot.validationStatus || "PENDING"} status={bot.validationStatus?.includes("SUCCESS") ? "success" : "neutral"} />
                <RegistryItem label="Last Order" value={bot.lastOrderId || "NONE"} />
                <RegistryItem label="Last Fill" value={bot.lastFillPrice ? `$${bot.lastFillPrice.toFixed(2)}` : "N/A"} />
                <RegistryItem label="Close Reason" value={bot.lastCloseReason || "N/A"} />
                <RegistryItem 
                  label="Drawdown" 
                  value={`${(bot.analytics?.currentDrawdown || 0).toFixed(2)}% (${bot.drawdownSeverity || "NONE"})`} 
                  status={(!bot.drawdownSeverity || bot.drawdownSeverity === "NONE") ? "success" : "neutral"}
                />
                {bot.drawdownSeverity && bot.drawdownSeverity !== "NONE" && (
                  <>
                    <RegistryItem 
                      label="Drawdown Progress" 
                      value={`${(bot.drawdownRecoveryProgress || 0).toFixed(1)}% Recovered`} 
                    />
                    <RegistryItem 
                      label="Recovery Threshold" 
                      value={`$${(bot.estimatedRecoveryThreshold || bot.peakEquity || 0).toFixed(2)}`} 
                    />
                  </>
                )}
                {bot.drawdownPauseUntil && bot.drawdownPauseUntil > Date.now() && (
                  <RegistryItem 
                    label="Drawdown Pause" 
                    value={`${Math.max(1, Math.round((bot.drawdownPauseUntil - Date.now()) / 1000 / 60))}m left`} 
                    status="neutral"
                  />
                )}
                {bot.peakEquity > 0 && (
                  <RegistryItem 
                    label="Peak Equity" 
                    value={`$${bot.peakEquity.toFixed(2)}`} 
                  />
                )}
              </div>
            </div>
          </div>
        </aside>
        )}

        {/* Content Area */}
        <section className="flex-1 flex flex-col bg-[#0A0B0D] relative overflow-hidden">
          {/* Top Bar with Balances (Desktop) */}
          <div className="hidden md:flex h-14 border-b border-slate-800/80 bg-[#0c0e12]/50 items-center px-6 gap-8 overflow-x-auto whitespace-nowrap scrollbar-hide shrink-0">
             <BalanceDisplay label="TOTAL EQUITY" value={bot.accountEquity || 0} />
             <BalanceDisplay label="AVAILABLE MARGIN" value={bot.availableMargin || 0} />
             <BalanceDisplay label="RESERVED POSITION MARGIN" value={bot.reservedPositionMargin !== undefined ? bot.reservedPositionMargin : (bot.marginUsed || 0)} />
             <BalanceDisplay label="RESERVED ORDER MARGIN" value={bot.reservedOrderMargin || 0} />
             <BalanceDisplay label="FREE COLLATERAL %" value={(bot.freeCollateralPct !== undefined ? bot.freeCollateralPct : (bot.accountEquity > 0 ? (bot.availableMargin / bot.accountEquity) * 100 : 100)).toFixed(1) + "%"} isString />
             <BalanceDisplay label="PORTFOLIO EXPOSURE USED %" value={(bot.portfolioExposureUsedPct || 0).toFixed(1) + "%"} isString />
             <BalanceDisplay label="OPEN POSITION COUNT" value={bot.openPositions || 0} isString />
             <BalanceDisplay label="RESTING ENTRY ORDER COUNT" value={bot.restingEntryOrderCount !== undefined ? bot.restingEntryOrderCount : 0} isString />
             <BalanceDisplay label="REALIZED PNL" value={bot.realizedPnl || 0} color={(bot.realizedPnl || 0) >= 0 ? "emerald" : "rose"} />
             <BalanceDisplay label="UNREALIZED PNL" value={bot.unrealizedPnl || 0} color={(bot.unrealizedPnl || 0) >= 0 ? "emerald" : "rose"} />
          </div>

          <div className="flex-1 p-4 md:p-6 space-y-4 md:space-y-6 overflow-y-auto">
            {/* System Health Bar */}
            <div className="bg-[#0C0E12] border border-slate-800/80 px-4 py-2.5 rounded-lg flex flex-wrap items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase font-black text-slate-500 tracking-widest font-mono">System Health</span>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono">
                <HealthIndicator label="WSS" status={bot.wssConnected ? "Healthy" : "Critical"} />
                <HealthIndicator label="API" status={bot.apiConnected ? "Healthy" : "Critical"} />
                <HealthIndicator label="Margin" status={bot.availableMargin >= 40 ? "Healthy" : bot.availableMargin >= 20 ? "Warning" : "Critical"} />
                <HealthIndicator label="Protection Health" status={bot.openPositions === 0 ? "Healthy" : (bot.protectionStatus === "CONFIRMED" ? "Healthy" : "Warning")} />
                {isAdvancedMode && <HealthIndicator label="Learning Engine" status="Healthy" />}
              </div>
            </div>

            {/* LEVEL 1 — Primary Trading Overview */}
            <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-2xl relative overflow-hidden flex flex-col gap-6">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500/0 via-indigo-500/30 to-indigo-500/0" />
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase font-black text-slate-400 tracking-[0.2em] font-mono">Level 1 — Primary Trading Overview</h3>
                <span className={cn(
                  "px-2.5 py-1 rounded text-[10px] uppercase font-black border font-mono",
                  getCleanSystemStatus(bot.blocker, bot.phase, bot.phase === "VALIDATION_FAILED").color
                )}>
                  {getCleanSystemStatus(bot.blocker, bot.phase, bot.phase === "VALIDATION_FAILED").label}
                </span>
              </div>
              
              <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {/* Total Equity */}
                <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-slate-800/60">
                  <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Total Equity</p>
                  <p className="text-xl font-black font-mono text-white">${bot.accountEquity.toFixed(2)}</p>
                </div>
                {/* Net PnL Grid Segment based on mode */}
                {!isAdvancedMode ? (
                  <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-slate-800/60 col-span-2">
                    <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Net PnL (Unrealized / Realized)</p>
                    <div className="flex justify-between items-baseline pt-1">
                      <span className={cn("text-xl font-black font-mono", bot.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {bot.unrealizedPnl >= 0 ? "+" : ""}${bot.unrealizedPnl.toFixed(2)} <span className="text-[9px] text-slate-500 font-normal">unrealized</span>
                      </span>
                      <span className={cn("text-sm font-semibold font-mono", (bot.analytics?.netProfitability || 0) >= 0 ? "text-emerald-500" : "text-rose-500")}>
                        ${(bot.analytics?.netProfitability || 0).toFixed(2)} <span className="text-[9px] text-slate-500 font-normal">realized</span>
                      </span>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Net PnL (Unrealized) */}
                    <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-slate-800/60">
                      <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Active PnL (Unrealized)</p>
                      <p className={cn("text-xl font-black font-mono", bot.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {bot.unrealizedPnl >= 0 ? "+" : ""}${bot.unrealizedPnl.toFixed(2)}
                      </p>
                    </div>
                    {/* Net Profitability */}
                    <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-slate-800/60">
                      <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Realized Net PnL</p>
                      <p className={cn("text-xl font-black font-mono", (bot.analytics?.netProfitability || 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        ${(bot.analytics?.netProfitability || 0).toFixed(2)}
                      </p>
                    </div>
                  </>
                )}
                {/* Open Positions / Slots */}
                <div className="space-y-1.5 bg-black/30 p-3.5 rounded-xl border border-slate-800/60 font-mono text-xs">
                  <div className="flex justify-between items-center mb-1">
                    <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Position Slots</p>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-slate-500 hover:text-slate-400">Configured Max:</span>
                    <span className="text-white font-medium">{bot.configuredMaxPositions || 3}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-slate-500 hover:text-slate-400">Effective Max:</span>
                    <span className={(bot.effectiveMaxPositions !== undefined ? bot.effectiveMaxPositions : 3) < (bot.configuredMaxPositions || 3) ? "text-rose-400 font-bold" : "text-white font-medium"}>{bot.effectiveMaxPositions !== undefined ? bot.effectiveMaxPositions : 3}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-slate-500 hover:text-slate-400">Used Positions:</span>
                    <span className="text-white font-medium">{bot.usedPositions !== undefined ? bot.usedPositions : (bot.openPositions || 0)}</span>
                  </div>
                  <div className="flex justify-between text-[10px] pb-1 border-b border-slate-800">
                    <span className="text-slate-500 hover:text-slate-400">Available Slots:</span>
                    <span className={(bot.availableSlots || 0) === 0 ? "text-rose-400 font-bold" : "text-emerald-400 font-bold"}>{bot.availableSlots !== undefined ? bot.availableSlots : Math.max(0, 3 - (bot.openPositions || 0))}</span>
                  </div>
                  <div className="pt-1 text-[9px] truncate" title={bot.slotReductionReason || "NONE"}>
                    <span className="text-slate-600">Restriction: </span>
                    <span className={(bot.slotReductionIsHardSafety) ? "text-rose-400 font-bold" : "text-slate-400 font-medium"}>{bot.slotReductionReason || "NONE"}</span>
                  </div>
                </div>
                {/* Available Margin */}
                <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-[#8A4FFF]/20">
                  <p className="text-[9px] uppercase font-bold text-[#8A4FFF] tracking-wider font-mono">Available Margin</p>
                  <p className="text-xl font-black font-mono text-white">${bot.availableMargin.toFixed(2)}</p>
                </div>
                {isAdvancedMode && (
                  <>
                    {/* Risk Mode */}
                    <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-slate-800/60">
                      <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Current Risk Mode</p>
                      <p className={cn(
                        "text-xs font-black uppercase font-mono mt-1",
                        bot.blocker && ["FEE_HARD_SUSPENSION_ACTIVE", "FEE_SOFT_SUSPENSION_ACTIVE", "BELOW_PREFERRED_SAFETY_TARGET"].includes(bot.blocker)
                          ? "text-amber-400"
                          : "text-emerald-400"
                      )}>
                        {bot.blocker && ["FEE_HARD_SUSPENSION_ACTIVE", "FEE_SOFT_SUSPENSION_ACTIVE", "BELOW_PREFERRED_SAFETY_TARGET"].includes(bot.blocker)
                          ? "Risk Reduced"
                          : "Balanced"}
                      </p>
                    </div>
                  </>
                )}
                {/* Market Regime */}
                <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-slate-800/60">
                  <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Market Regime</p>
                  <p className="text-xs font-black uppercase font-mono text-white mt-1">{(bot.marketRegime || bot.regime || "NORMAL").replace(/_/g, ' ')}</p>
                </div>
                {isAdvancedMode && (
                  <>
                    {/* Market Condition */}
                    <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-slate-800/60 animate-fade-in animate-duration-300">
                      <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Market Condition</p>
                      <p className={cn(
                        "text-xs font-black uppercase font-mono mt-1",
                        bot.chopState === "TRUE_CHOP_NO_TRADE" ? "text-rose-400 animate-pulse" :
                        bot.chopState === "DEVELOPING_BREAKOUT" ? "text-amber-400" :
                        bot.chopState === "DIRECTIONAL_CHOP_RECOVERY" ? "text-indigo-400" :
                        bot.chopState === "CHOP_RECOVERY_MONITORING" ? "text-emerald-400" : "text-sky-450"
                      )}>
                        {bot.chopState === "TRUE_CHOP_NO_TRADE" ? "True Chop — No Trade" :
                         bot.chopState === "DEVELOPING_BREAKOUT" ? "Breakout Developing" :
                         bot.chopState === "DIRECTIONAL_CHOP_RECOVERY" ? "Trend Recovering" :
                         bot.chopState === "CHOP_RECOVERY_MONITORING" ? "Monitoring Direction" :
                         "Directional / Clear"}
                      </p>
                    </div>
                  </>
                )}
                {/* Daily Win Rate */}
                <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-slate-800/60 animate-fade-in">
                  <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Daily Win Rate</p>
                  <p className="text-xl font-black font-mono text-emerald-400">{(bot.analytics?.winRate || 0).toFixed(1)}%</p>
                </div>
                {/* Expectancy */}
                <div className="space-y-1 bg-black/30 p-3.5 rounded-xl border border-slate-800/60 font-mono">
                  <p className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Expectancy After Fees</p>
                  <p className="text-xl font-black text-white">${bot.analytics?.expectancyAfterFees !== undefined ? bot.analytics.expectancyAfterFees.toFixed(2) : "0.00"}</p>
                </div>
              </div>
            </div>

            {/* Quick Performance Snapshot */}
            {isAdvancedMode && (
              <div className="bg-[#0C0E12] border border-slate-800/80 p-4 rounded-xl">
                <div className="text-[10px] uppercase font-black text-slate-500 tracking-widest mb-3 font-mono">Performance Snapshot (Today)</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                  <SnapshotMetric label="Trades" value={bot.analytics?.totalTrades || 0} />
                  <SnapshotMetric label="Win Rate" value={`${(bot.analytics?.winRate || 0).toFixed(1)}%`} color={(bot.analytics?.winRate || 0) >= 50 ? "emerald" : "slate"} />
                  <SnapshotMetric label="Net PnL" value={`$${(bot.analytics?.netProfitability || 0).toFixed(2)}`} color={(bot.analytics?.netProfitability || 0) >= 0 ? "emerald" : "rose"} />
                  <SnapshotMetric label="Fees" value={`$${(bot.analytics?.cumulativeFees || 0).toFixed(2)}`} />
                  <SnapshotMetric label="Expectancy" value={bot.analytics?.expectancyAfterFees !== undefined ? `$${bot.analytics.expectancyAfterFees.toFixed(2)}` : "$0.00"} color={(bot.analytics?.expectancyAfterFees || 0) >= 0 ? "emerald" : "rose"} />
                  <SnapshotMetric label="Best Trade" value={bot.analytics?.largestWin !== undefined ? `+$${bot.analytics.largestWin.toFixed(2)}` : "$0.00"} color="emerald" />
                  <SnapshotMetric label="Worst Trade" value={bot.analytics?.largestLoss !== undefined ? `-$${Math.abs(bot.analytics.largestLoss).toFixed(2)}` : "$0.00"} color="rose" />
                </div>
              </div>
            )}

            {/* LEVEL 1.5 — Trend-Matched Directional Execution Engine (Active Target) */}
            {isAdvancedMode && (
              <div className="bg-[#0D0E12] border border-slate-800 p-5 rounded-2xl flex flex-col gap-4">
                <div className="flex justify-between items-center border-b border-slate-800/80 pb-3">
                  <div>
                    <h3 className="text-xs uppercase font-black text-[#8A4FFF] tracking-[0.2em] font-mono">Level 1.5 — Active Target Execution Confirmation</h3>
                    <p className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mt-1">Real-time trend matchmaking & leverage risk assessment for {bot.activeSymbol || "N/A"}</p>
                  </div>
                <div className="bg-[#0A0B0D] px-2.5 py-1 rounded border border-slate-800 text-[9px] font-mono text-slate-400">
                  Adaptive Logic Clock
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                {/* Trend Match */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Trend Match status</span>
                  <span className={cn(
                    "text-xs font-black font-mono uppercase leading-snug mt-1 inline-block",
                    bot.executionTrendMatch === "TREND_MATCH_LONG" ? "text-emerald-400" :
                    bot.executionTrendMatch === "TREND_MATCH_SHORT" ? "text-rose-400" :
                    bot.executionTrendMatch === "TREND_CONFLICT" ? "text-amber-400 animate-pulse" : "text-slate-400"
                  )}>
                    {(bot.executionTrendMatch || "NO_CLEAR_TREND").replace(/_/g, ' ')}
                  </span>
                </div>

                {/* Direction Decision */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Direction Decision</span>
                  <span className={cn(
                    "text-xs font-black font-mono uppercase leading-snug mt-1 block",
                    bot.executionDirectionDecision?.includes("LONG") || bot.executionDirectionDecision?.includes("long") ? "text-emerald-400" :
                    bot.executionDirectionDecision?.includes("SHORT") || bot.executionDirectionDecision?.includes("short") ? "text-rose-400" : "text-slate-400"
                  )}>
                    {(bot.executionDirectionDecision || "NO_TRADE").replace(/_/g, ' ')}
                  </span>
                </div>

                {/* Leverage Selected */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block font-mono">Leverage Selected</span>
                  <span className="text-xs font-black font-mono text-indigo-400 leading-snug mt-1 block">
                    {bot.executionLeverageSelected !== undefined && bot.executionLeverageSelected !== null ? `${bot.executionLeverageSelected}x` : "N/A"}
                  </span>
                </div>

                {/* Leverage Reason */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Leverage Policy Reason</span>
                  <span className="text-[10px] font-bold font-mono text-slate-300 leading-relaxed mt-1 block max-h-12 overflow-y-auto">
                    {bot.executionLeverageReason || "Default risk bounds active"}
                  </span>
                </div>

                {/* Confirmation Status */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1 sm:col-span-2 lg:col-span-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Confirmation Status</span>
                  <span className={cn(
                    "text-[10px] font-bold font-mono leading-relaxed mt-1 block max-h-12 overflow-y-auto",
                    bot.executionConfirmationStatus === "CONFIRMED" ? "text-emerald-400 font-extrabold" : "text-rose-400/80"
                  )}>
                    {bot.executionConfirmationStatus || "EXAMINING SETUP"}
                  </span>
                </div>
              </div>
            </div>
            )}

            {/* Phase 2 Adaptive Intelligence & CMC Telemetry */}
            {isAdvancedMode && (
              <div className="bg-[#0D0E12] border border-slate-800 p-5 rounded-2xl flex flex-col gap-4">
                <div className="flex justify-between items-center border-b border-slate-800/80 pb-3">
                  <div>
                    <h3 className="text-xs uppercase font-black text-indigo-400 tracking-[0.2em] font-mono">Level 1.8 — Phase 2 Execution Intelligence</h3>
                    <p className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mt-1">Proof-of-performance & narrative volatility engine</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                  {/* Funding Readiness */}
                  <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Funding Readiness</span>
                    <span className={cn(
                      "text-xs font-black font-mono mt-1 block tracking-tight",
                      bot.fundingReadinessScore === "READY_SCALE" ? "text-emerald-400" :
                      bot.fundingReadinessScore === "READY_SMALL_ADD" ? "text-indigo-400" : "text-amber-400"
                    )}>
                      {(bot.fundingReadinessScore || "WATCH").replace(/_/g, " ")}
                    </span>
                  </div>

                  {/* Volatility Class */}
                  <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Volatility Class</span>
                    <span className={cn(
                      "text-[10px] sm:text-xs font-black font-mono uppercase leading-snug mt-1 block",
                      bot.volatilityClass?.includes("EXTREME") ? "text-fuchsia-400" :
                      bot.volatilityClass?.includes("HIGH") ? "text-emerald-400" :
                      bot.volatilityClass?.includes("CHAOTIC") ? "text-rose-400" : "text-slate-400"
                    )}>
                      {(bot.volatilityClass || "MODERATE_TREND").replace(/_/g, " ")}
                    </span>
                  </div>

                  {/* Narrative Strength */}
                  <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Narrative Strength</span>
                    <span className="text-xs font-black font-mono text-sky-400 leading-snug mt-1 block">
                      {bot.narrativeStrength ? `${(bot.narrativeStrength * 100).toFixed(0)}%` : "N/A"}
                    </span>
                  </div>

                  {/* Momentum Persistence */}
                  <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Momentum Persistence</span>
                    <span className={cn(
                      "text-xs font-black font-mono leading-snug mt-1 block",
                      bot.momentumPersistence && bot.momentumPersistence > 0.7 ? "text-emerald-400" : "text-amber-400"
                    )}>
                      {bot.momentumPersistence ? `${(bot.momentumPersistence * 100).toFixed(0)}%` : "MONITORING"}
                    </span>
                  </div>

                  {/* Execution Priority Rank */}
                  <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Priority Rank</span>
                    <span className="text-xs font-black font-mono text-indigo-400 leading-snug mt-1 block">
                      {bot.executionPriorityRank !== undefined ? `#${bot.executionPriorityRank}` : "UNRANKED"}
                    </span>
                  </div>

                  {/* Auto Recovery Mode */}
                  <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Auto Recovery</span>
                    <span className={cn(
                      "text-[10px] sm:text-xs font-black font-mono uppercase leading-snug mt-1 block",
                      bot.autoRecoveryMode === "ACTIVE" ? "text-amber-400 animate-pulse" : "text-emerald-400"
                    )}>
                      {bot.autoRecoveryMode === "ACTIVE" ? "RECOVERY ACTIVE" : "STANDARD"}
                    </span>
                  </div>

                  {/* Correlated Exposure */}
                  <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1 sm:col-span-3 lg:col-span-6">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Correlated Narrative Exposure</span>
                    <span className="text-[10px] font-bold font-mono text-slate-400 leading-relaxed mt-1 block">
                      {bot.correlatedExposure ? bot.correlatedExposure.join(" | ") : "Balanced Diversification Active – No Overexposure Detected"}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Participation Audit Diagnostics */}
            {isAdvancedMode && bot.analytics?.participationAudit && (
              <div className="bg-[#0C0E12] border border-blue-900/30 p-5 rounded-2xl flex flex-col gap-4">
                <div className="flex justify-between items-center border-b border-slate-800/80 pb-3">
                  <div>
                    <h3 className="text-xs uppercase font-black text-blue-400 tracking-[0.2em] font-mono">Scanner Participation Audit</h3>
                    <p className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mt-1">Live execution veto trace & market participation targeting</p>
                  </div>
                  <div className="bg-[#0A0B0D] px-3 py-1.5 rounded-lg border border-slate-800 text-[10px] font-mono text-slate-400 flex gap-4">
                    <span>Paralysis Status: <strong className={bot.analytics.participationAudit.participationParalysisActive ? "text-amber-400 animate-pulse" : "text-emerald-400"}>
                      {bot.analytics.participationAudit.participationParalysisActive ? "ACTIVE RECOVERY" : "NORMAL"}
                    </strong></span>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-1">
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Router Attempts (All Time)</span>
                    <span className="text-sm font-black font-mono text-indigo-400 mt-1 block">{bot.telemetry?.finalRouterAttemptsMap?.["EXECUTED"] || 0}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Skipped Non-Top Priority</span>
                    <span className="text-sm font-black font-mono text-slate-300 mt-1 block">{bot.telemetry?.skippedLowPriorityCandidates || 0}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Sizing Invalid (5m CD)</span>
                    <span className="text-sm font-black font-mono text-orange-400 mt-1 block">{bot.telemetry?.sizingInvalidCooldownCount || 0}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">High Risk (Prepare)</span>
                    <span className="text-sm font-black font-mono text-purple-400 mt-1 block">{bot.telemetry?.highRiskPrepareCount || 0}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Router Block (1m CD)</span>
                    <span className="text-sm font-black font-mono text-rose-400 mt-1 block">{bot.telemetry?.routerBlockCooldownCount || 0}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">API Rate Throttle Blocks</span>
                    <span className="text-sm font-black font-mono text-red-500 mt-1 block">{bot.telemetry?.finalRouterAttemptsMap?.["API_THROTTLED"] || 0}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 mt-1">
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Total Scanned</span>
                    <span className="text-sm font-black font-mono text-slate-300 mt-1 block">{bot.analytics.participationAudit.totalScanned}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Eligible</span>
                    <span className="text-sm font-black font-mono text-emerald-400 mt-1 block">{bot.analytics.participationAudit.eligibleCandidates}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Veto: Drawdown</span>
                    <span className="text-sm font-black font-mono text-rose-400 mt-1 block">{bot.analytics.participationAudit.blockedByDrawdown}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Veto: Sizing</span>
                    <span className="text-sm font-black font-mono text-orange-400 mt-1 block">{bot.analytics.participationAudit.blockedBySizing}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Veto: Volatility</span>
                    <span className="text-sm font-black font-mono text-purple-400 mt-1 block">{bot.analytics.participationAudit.blockedByVolatility}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] uppercase font-bold text-slate-500 block">Veto: Strategy</span>
                    <span className="text-sm font-black font-mono text-yellow-400 mt-1 block">{bot.analytics.participationAudit.blockedByRouter}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                     <span className="text-[9px] uppercase font-bold text-slate-500 block">Dominant Veto</span>
                     <span className="text-[9px] font-black font-mono text-slate-300 mt-1 block overflow-hidden text-ellipsis whitespace-nowrap" title={bot.analytics.participationAudit.dominantRejectionReason}>{bot.analytics.participationAudit.dominantRejectionReason}</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800">
                     <span className="text-[9px] uppercase font-bold text-slate-500 block">Participation Rate</span>
                     <span className="text-sm font-black font-mono text-emerald-400 mt-1 block">{(bot.analytics.participationAudit.participationRate * 100).toFixed(1)}%</span>
                  </div>
                  <div className="bg-black/30 p-3 rounded-lg border border-slate-800 col-span-2">
                     <span className="text-[9px] uppercase font-bold text-slate-500 block">Activity Status</span>
                     <div className="mt-1 text-[10px] font-mono text-slate-400 flex flex-col gap-0.5">
                        <div className="flex justify-between">
                           <span>Last Trade:</span>
                           <span className="text-emerald-400">{bot.analytics.participationAudit.lastTradeTime ? new Date(bot.analytics.participationAudit.lastTradeTime).toLocaleTimeString() : "Never"}</span>
                        </div>
                        <div className="flex justify-between">
                           <span>Cooldown Rem:</span>
                           <span className={(bot.cooldownUntil && bot.cooldownUntil > Date.now()) ? "text-amber-400" : "text-slate-500"}>
                              {(bot.cooldownUntil && bot.cooldownUntil > Date.now()) ? `${Math.ceil((bot.cooldownUntil - Date.now())/1000)}s (${bot.cooldownType || "SOFT"})` : "NONE"}
                           </span>
                        </div>
                     </div>
                  </div>
                </div>
                
                {Object.keys(bot.analytics.participationAudit.finalExecutionVetoes || {}).length > 0 && (
                   <div className="mt-2 text-[10px] font-mono text-slate-400 border border-slate-800/50 rounded-lg p-2.5 bg-black/50">
                     <span className="text-slate-500 mb-1 block uppercase font-bold tracking-widest text-[8px]">Final Execution Trace (Near-Valid Setups)</span>
                     <div className="flex flex-wrap gap-x-4 gap-y-1">
                       {Object.entries(bot.analytics.participationAudit.finalExecutionVetoes).map(([sym, reason]) => (
                         <div key={sym}><strong className="text-indigo-400">{sym}:</strong> {reason}</div>
                       ))}
                     </div>
                   </div>
                )}
              </div>
            )}

            {/* LEVEL 1.9 — Drawdown Protection Monitor */}
            <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-2xl flex flex-col gap-4">
              <div className="flex justify-between items-center border-b border-slate-800/80 pb-3">
                <div>
                  <h3 className="text-xs uppercase font-black text-indigo-400 tracking-[0.2em] font-mono">Level 1.9 — Drawdown Protection Safeguards</h3>
                  <p className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mt-1">Safeguard modes, recovery offsets, and override risk rules</p>
                </div>
                <div className="bg-[#0A0B0D] px-3 py-1.5 rounded-lg border border-slate-800 text-[10px] font-mono text-slate-400">
                  Status: <strong className={cn(
                    (bot.drawdownSeverity === "SOFT" || bot.drawdownSeverity === "SOFT_LEVEL_1" || bot.drawdownSeverity === "SOFT_LEVEL_2" || bot.drawdownSeverity === "MODERATE") ? "text-teal-400 animate-pulse" :
                    bot.drawdownSeverity === "HARD" ? "text-rose-400 font-black" : "text-emerald-400"
                  )}>{bot.drawdownSeverity || "NONE"} DRAWDOWN</strong>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {/* Drawdown Mode */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Drawdown Mode</span>
                  <span className={cn(
                    "text-xs font-black font-mono mt-1 block uppercase tracking-tight",
                    (bot.drawdownSeverity === "SOFT" || bot.drawdownSeverity === "SOFT_LEVEL_1" || bot.drawdownSeverity === "SOFT_LEVEL_2") ? "text-teal-400 animate-pulse" :
                    bot.drawdownSeverity === "MODERATE" ? "text-amber-400 animate-pulse" :
                    bot.drawdownSeverity === "HARD" ? "text-rose-500 font-bold" : "text-slate-400"
                  )}>
                    {bot.drawdownSeverity ? (bot.drawdownSeverity === "NONE" ? "NO_DRAWDOWN" : `${bot.drawdownSeverity}_DRAWDOWN`) : "NO_DRAWDOWN"}
                  </span>
                </div>

                {/* Drawdown % */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Drawdown %</span>
                  <span className="text-xs font-black font-mono text-rose-400 mt-1 block">
                    {bot.analytics?.currentDrawdown ? `-${Math.max(0, bot.analytics.currentDrawdown).toFixed(2)}%` : "0.00%"}
                  </span>
                </div>

                {/* Recovery Required */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Recovery Required</span>
                  <span className="text-xs font-black font-mono text-yellow-500 mt-1 block">
                    {bot.peakEquity && bot.accountEquity && bot.peakEquity > bot.accountEquity 
                      ? `$${Math.max(0, bot.peakEquity - bot.accountEquity).toFixed(2)}`
                      : "$0.00 (Fully Recovered)"}
                  </span>
                </div>

                {/* Peak Equity */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Peak Equity</span>
                  <span className="text-xs font-black font-mono text-emerald-400 mt-1 block">
                    {bot.peakEquity ? `$${bot.peakEquity.toFixed(2)}` : "—"}
                  </span>
                </div>

                {/* Current Equity */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Current Equity</span>
                  <span className="text-xs font-black font-mono text-slate-300 mt-1 block">
                    {bot.accountEquity ? `$${bot.accountEquity.toFixed(2)}` : "—"}
                  </span>
                </div>
                
                {/* Drawdown State Source */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">State Source</span>
                  <span className="text-xs font-black font-mono text-slate-400 mt-1 block">
                    {bot.drawdownSeverity && bot.drawdownSeverity !== "NONE" ? "Real-time Metrics" : "Safe/Fully Recovered"}
                  </span>
                </div>
                
                {/* Last Drawdown Trigger */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Last Trigger</span>
                  <span className="text-xs font-black font-mono text-slate-400 mt-1 block">
                    {bot.drawdownSeverity && bot.drawdownSeverity !== "NONE" ? (bot.drawdownSeverity === "HARD" ? "Peak-to-Trough >= 10%" : "Drawdown / Fee Bleed") : "—"}
                  </span>
                </div>
                
                {/* Recovery Cleared At */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Recovery Cleared At</span>
                  <span className="text-xs font-black font-mono text-slate-400 mt-1 block">
                    {bot.analytics?.lastDrawdownClearedAt ? new Date(bot.analytics.lastDrawdownClearedAt).toLocaleTimeString() : "—"}
                  </span>
                </div>

                {/* Elite Override Eligibility */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Elite Override Eligibility</span>
                  <span className={cn(
                    "text-xs font-black font-mono mt-1 block",
                    (bot.drawdownSeverity === "SOFT" || bot.drawdownSeverity === "SOFT_LEVEL_1" || bot.drawdownSeverity === "SOFT_LEVEL_2" || bot.drawdownSeverity === "MODERATE") ? "text-emerald-400 animate-pulse" : "text-slate-500"
                  )}>
                    {(bot.drawdownSeverity === "SOFT" || bot.drawdownSeverity === "SOFT_LEVEL_1" || bot.drawdownSeverity === "SOFT_LEVEL_2" || bot.drawdownSeverity === "MODERATE")
                      ? (bot.drawdownSeverity === "SOFT_LEVEL_1" ? "NO (Reduced risk allowed)" : "YES (Elite Only)")
                      : "NO"}
                  </span>
                </div>

                {/* Reduced Risk Rules Active */}
                <div className="bg-black/30 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between gap-1">
                  <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider block">Reduced Risk Rules Active</span>
                  <span className={cn(
                    "text-[10px] font-mono leading-tight mt-1 block uppercase font-bold",
                    (bot.drawdownSeverity === "SOFT" || bot.drawdownSeverity === "SOFT_LEVEL_1" || bot.drawdownSeverity === "SOFT_LEVEL_2") ? "text-teal-400" :
                    bot.drawdownSeverity === "MODERATE" ? "text-amber-400" : "text-slate-500"
                  )}>
                    {(bot.drawdownSeverity === "SOFT" || bot.drawdownSeverity === "SOFT_LEVEL_1" || bot.drawdownSeverity === "SOFT_LEVEL_2") ? "ACTIVE (-50% Sz, 2x Lev)" :
                     bot.drawdownSeverity === "MODERATE" ? "ACTIVE (-75% Sz, 1x Lev)" : "INACTIVE"}
                  </span>
                </div>
              </div>
            </div>

            {/* LEVEL 2 — Active Positions list (Multi-Symbol layout) */}
            <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-2xl flex flex-col gap-4">
              <div className="flex justify-between items-center border-b border-slate-800/80 pb-3">
                <div>
                  <h3 className="text-xs uppercase font-black text-slate-400 tracking-[0.2em] font-mono">Level 2 — Active Positions</h3>
                  <p className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mt-1">Multi-symbol allocation module</p>
                </div>
                <div className="bg-[#0A0B0D] px-3 py-1.5 rounded-lg border border-slate-800 text-[10px] font-mono text-slate-400">
                  Slots: <strong className="text-white">{bot.openPositions || 0} / 4</strong>
                </div>
              </div>

              {((bot.allPositions && bot.allPositions.length > 0) || (bot.positionDetails && parseFloat(bot.positionDetails.szi) !== 0)) ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {(bot.allPositions || [bot.positionDetails]).filter(Boolean).map((pos: any, idx: number) => {
                    const isLong = parseFloat(pos.szi) >= 0;
                    const coin = pos.coin || bot.activeSymbol || "USDC";
                    const currentUnrealizedPnl = parseFloat(pos.unrealizedPnl || 0);
                    const roe = parseFloat(pos.returnOnEquity || 0) * 100;
                    
                    const entryTrade = (bot.trades || [])
                      .slice()
                      .reverse()
                      .find((t: any) => t.symbol === coin && (t.type === "ENTRY" || t.type?.toUpperCase() === "ENTRY"));
                    const holdTimeMs = entryTrade ? Date.now() - entryTrade.timestamp : null;
                    const holdTimeFormatted = holdTimeMs ? formatDuration(holdTimeMs) : "—";

                    if (!isAdvancedMode) {
                      return (
                        <div key={idx} className="bg-black/30 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between gap-5 hover:border-slate-700 transition-all shadow-md">
                          <div className="flex justify-between items-center">
                            <div className="flex items-center gap-3">
                              <span className="text-xl font-black text-white font-mono tracking-tight">{coin}</span>
                              <span className={cn(
                                "text-[10px] font-black uppercase px-2.5 py-0.5 rounded leading-none text-center font-mono border",
                                isLong ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                              )}>
                                {isLong ? "LONG" : "SHORT"}
                              </span>
                            </div>
                            <div className="text-right">
                              <span className={cn("text-xl font-black font-mono block tracking-tight", currentUnrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                {currentUnrealizedPnl >= 0 ? "+" : ""}${currentUnrealizedPnl.toFixed(2)}
                              </span>
                              <span className="text-xs text-slate-400 font-mono block mt-0.5">
                                {roe >= 0 ? "+" : ""}{roe.toFixed(2)}%
                              </span>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4 text-sm font-mono bg-[#0A0B0D]/50 p-4 rounded-xl border border-slate-800/40">
                            <div>
                              <span className="text-slate-500 text-xs block mb-1">Entry Price</span>
                              <span className="text-white font-black text-base">${formatPrice(pos.entryPx)}</span>
                            </div>
                            <div>
                              <span className="text-slate-500 text-xs block mb-1">Hold Time</span>
                              <span className="text-indigo-400 font-black text-base">{holdTimeFormatted}</span>
                            </div>
                            <div className="border-t border-slate-800/40 pt-2 mt-1">
                              <span className="text-slate-500 text-xs block mb-1">Take Profit (TP)</span>
                              <span className="text-emerald-400 font-black text-base">${formatPrice(bot.protection?.tpPrice)}</span>
                            </div>
                            <div className="border-t border-slate-800/40 pt-2 mt-1">
                              <span className="text-slate-500 text-xs block mb-1">Stop Loss (SL)</span>
                              <span className="text-rose-400 font-black text-base">${formatPrice(bot.protection?.slPrice)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={idx} className="bg-black/30 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between gap-4 hover:border-slate-700/80 transition-all">
                        {/* Top: Asset, Side, and PnL */}
                        <div className="flex justify-between items-start">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-black text-white font-mono">{coin}</span>
                              <span className={cn(
                                "text-[9px] font-black uppercase px-2 py-0.5 rounded leading-none text-center font-mono border",
                                isLong ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                              )}>
                                {isLong ? "LONG" : "SHORT"}
                              </span>
                            </div>
                            <p className="text-[10px] text-slate-500 font-mono mt-1">Size: {pos.szi}</p>
                          </div>
                          <div className="text-right">
                            <span className={cn("text-base font-black font-mono block", currentUnrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                              {currentUnrealizedPnl >= 0 ? "+" : ""}${currentUnrealizedPnl.toFixed(2)}
                            </span>
                            <span className="text-[10px] text-slate-400 font-mono block mt-0.5">
                              ROE: {roe >= 0 ? "+" : ""}{roe.toFixed(2)}%
                            </span>
                          </div>
                        </div>

                        {/* Middle: Entry, tp/sl */}
                        <div className="grid grid-cols-2 gap-2 text-[10px] font-mono bg-[#0A0B0D]/50 p-2.5 rounded-lg border border-slate-800/40">
                          <div>
                            <span className="text-slate-500 block">Entry Price</span>
                            <span className="text-slate-300 font-bold">${formatPrice(pos.entryPx)}</span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Mark Price</span>
                            <span className="text-slate-300 font-bold">${formatPrice(bot.markPrices?.[coin] || bot.markPrice)}</span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Take Profit</span>
                            <span className="text-emerald-400 font-bold">${formatPrice(bot.protection?.tpPrice)}</span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Stop Loss</span>
                            <span className="text-rose-400 font-bold">${formatPrice(bot.protection?.slPrice)}</span>
                          </div>
                        </div>

                        {/* Bottom: Trailing Stop status & detail */}
                        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 border-t border-slate-800/50 pt-2.5">
                          <div>
                            <span className="text-slate-500 text-[9px] block uppercase font-bold tracking-wider mb-0.5">Trailing Status</span>
                            <span className={cn("font-extrabold", bot.protection?.isTrailingActive ? "text-indigo-400" : "text-slate-500")}>
                              {bot.protection?.isTrailingActive ? "ACTIVE" : "INACTIVE"}
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-slate-500 text-[9px] block uppercase font-bold tracking-wider mb-0.5">Liquidation Price</span>
                            <span className="text-orange-400 font-bold">${parseFloat(pos.liquidationPx || 0) > 0 ? parseFloat(pos.liquidationPx).toFixed(2) : "N/A"}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-8 bg-black/10 border border-slate-800/60 rounded-xl text-center text-slate-500 font-mono text-xs uppercase tracking-widest italic">
                  No Active Positions
                </div>
              )}
            </div>

            {bot.phaseDowngradeReason && bot.phaseDowngradeReason !== "" && bot.openPositions === 0 && (
              <motion.div 
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-lg p-3 text-xs font-mono flex items-center justify-between"
              >
                <span className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-amber-500" />
                  <span>Phase 2 Downgraded. Reason: <strong className="uppercase">{bot.phaseDowngradeReason}</strong></span>
                </span>
                <button 
                  onClick={async () => {
                    await fetch("/api/clear-downgrade-reason", { method: "POST" });
                    setStatus((s: any) => s ? { ...s, bot: { ...s.bot, phaseDowngradeReason: null } } : s);
                  }}
                  className="text-[10px] text-amber-500/60 hover:text-amber-500 hover:underline bg-transparent border-none cursor-pointer uppercase font-bold"
                >
                  Clear Info
                </button>
              </motion.div>
            )}

            {/* Unified Blocker Alert and Strategic Setup Panel */}
            {blockerInfo.category === "CRITICAL_FAILURE" ? (
              <motion.div 
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-rose-500/5 border border-rose-500/25 rounded-lg p-5 flex flex-col gap-4 text-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.12)]"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-rose-500/10 pb-4">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-rose-500/10 flex items-center justify-center shrink-0">
                      <ShieldAlert className="w-5 h-5 animate-pulse text-rose-500" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase font-black px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                          {blockerInfo.badgeLabel}
                        </span>
                        <p className="font-mono text-[9px] text-rose-400/50 leading-none tracking-wider font-bold">HALTED_EXEC_SAFETY_INTERRUPT</p>
                      </div>
                      <p className="font-black text-[13px] uppercase tracking-[0.1em] mt-2 mb-0.5 leading-none text-white">{blockerInfo.title}</p>
                      <p className="text-xs text-rose-400/80 font-mono italic my-1">{blockerInfo.description}</p>
                    </div>
                  </div>
                  
                  <div className="text-right shrink-0">
                    <p className="text-[9px] uppercase tracking-widest text-slate-500 font-bold leading-none mb-1">Executor Phase</p>
                    <p className="text-xs font-mono font-bold text-rose-400">{bot.phase || 'READY'}</p>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-1">
                  <p className="text-[10px] text-slate-500 font-mono italic max-w-md">System requires manual verification & state reset before re-initiating automation.</p>
                  <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
                    {(bot.validationStatus === "PENDING" || bot.phase === "VALIDATION_FAILED") && (
                      <button 
                        onClick={async () => {
                          try {
                            await fetch("/api/validate-executor", { method: "POST" });
                          } catch (e) {
                            console.error("Failed to trigger validation", e);
                          }
                        }}
                        className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-black uppercase text-[9px] tracking-wider rounded-lg transition-colors cursor-pointer shadow-[0_2px_10px_rgba(16,185,129,0.3)] border-none"
                      >
                        Validate Executor
                      </button>
                    )}
                    {bot.validationStatus === "SUCCESS" && bot.openPositions === 0 && bot.accountEquity > 15 && (
                      <button 
                        onClick={async () => {
                          try {
                            await fetch("/api/execute-test-trade", { method: "POST" });
                          } catch (e) {
                            console.error("Failed to execute test trade", e);
                          }
                        }}
                        className="px-4 py-2 bg-blue-500 hover:bg-blue-400 text-white font-black uppercase text-[9px] tracking-wider rounded-lg transition-colors cursor-pointer shadow-[0_2px_10px_rgba(59,130,246,0.3)] border-none"
                      >
                        Force Micro Test Trade
                      </button>
                    )}
                    <button 
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/reset", { method: "POST" });
                          const data = await res.json();
                          if (res.ok) {
                            setStatus((s: any) => {
                              if (!s) return s;
                              return {
                                ...s,
                                bot: {
                                  ...s.bot,
                                  phase: data.phase,
                                  blocker: data.blocker,
                                  cooldownUntil: 0,
                                  reverseLockUntil: 0,
                                  drawdownPauseUntil: 0,
                                  dailyTradeCount: 0,
                                  validationStatus: "SUCCESS",
                                  openPositions: 0,
                                  positionDetails: null
                                }
                              };
                            });
                          } else {
                            alert(`Reset Failed: ${data.message || data.error}`);
                          }
                        } catch (e) {
                          console.error("Failed to reset circuit breakers", e);
                          alert("API error during reset");
                        }
                      }}
                      className="px-4 py-2 bg-rose-500 hover:bg-rose-400 text-white font-black uppercase text-[9px] tracking-wider rounded-lg transition-colors cursor-pointer shadow-[0_2px_10px_rgba(244,63,94,0.3)] border-none"
                    >
                      Reset & Resume Phase 1
                    </button>
                  </div>
                </div>
              </motion.div>
            ) : blockerInfo.category === "PROTECTED_PAUSE" ? (
              <motion.div 
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-5 flex flex-col gap-4 text-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.03)]"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-amber-500/10 pb-4">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
                      <Clock className="w-5 h-5 animate-pulse text-amber-500" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase font-black px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          {blockerInfo.badgeLabel}
                        </span>
                        <p className="font-mono text-[9px] text-amber-400/50 leading-none tracking-wider font-bold">SYSTEM_REST_PAUSED</p>
                      </div>
                      <p className="font-black text-[13px] uppercase tracking-[0.1em] mt-2 mb-0.5 leading-none text-white">{blockerInfo.title}</p>
                      <p className="text-xs text-amber-400/80 font-mono italic my-1">{blockerInfo.description}</p>
                    </div>
                  </div>
                  
                  {bot.blocker === "DRAWDOWN_PAUSE_ACTIVE" && (
                    <div className="flex items-center gap-3 shrink-0 self-end md:self-center">
                      <button 
                        onClick={async () => {
                          try {
                            const res = await fetch("/api/reset", { method: "POST" });
                            const data = await res.json();
                            if (res.ok) {
                              setStatus((s: any) => {
                                if (!s) return s;
                                return {
                                  ...s,
                                  bot: {
                                    ...s.bot,
                                    phase: data.phase,
                                    blocker: data.blocker,
                                    cooldownUntil: 0,
                                    reverseLockUntil: 0,
                                    drawdownPauseUntil: 0,
                                    dailyTradeCount: 0,
                                    validationStatus: "SUCCESS",
                                    openPositions: 0,
                                    positionDetails: null
                                  }
                                };
                              });
                            } else {
                              alert(`Reset Failed: ${data.message || data.error}`);
                            }
                          } catch (e) {
                            console.error("Failed to reset circuit breakers", e);
                            alert("API error during reset");
                          }
                        }}
                        className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black font-black uppercase text-[9px] tracking-wider rounded-lg transition-colors cursor-pointer shadow-[0_2px_10px_rgba(245,158,11,0.3)] border-none font-bold"
                      >
                        Reset Drawdown State
                      </button>
                    </div>
                  )}
                </div>

                {/* Additional metrics/cooldown timer if drawdown is active */}
                {["HARD_DRAWDOWN_PAUSE_ACTIVE", "SOFT_DRAWDOWN_PAUSE_ACTIVE", "MODERATE_DRAWDOWN_PAUSE_ACTIVE"].includes(bot.blocker || "") ? (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[10px] font-mono border-t border-amber-500/10 pt-4 mt-1">
                       <div>
                         <span className="text-slate-500 uppercase block mb-1 font-bold tracking-widest">Drawdown Severity</span>
                         <span className="text-[#8A4FFF] font-black text-xs uppercase">{bot.drawdownSeverity || "ACTIVE"}</span>
                       </div>
                       <div>
                         <span className="text-slate-500 uppercase block mb-1 font-bold tracking-widest">Recovery Progress</span>
                         <span className="text-yellow-400 font-bold text-xs">{(bot.drawdownRecoveryProgress || 0).toFixed(1)}%</span>
                       </div>
                       <div>
                         <span className="text-slate-500 uppercase block mb-1 font-bold tracking-widest">Recovery Threshold</span>
                         <span className="text-white text-xs">${(bot.estimatedRecoveryThreshold || bot.peakEquity || 0).toFixed(2)}</span>
                       </div>
                       <div>
                         <span className="text-slate-500 uppercase block mb-1 font-bold tracking-widest">Drawdown Pct</span>
                         <span className="text-rose-400 font-bold text-xs">-{((bot.peakEquity > 0) ? ((bot.peakEquity - bot.accountEquity) / bot.peakEquity * 100) : 0).toFixed(2)}%</span>
                       </div>
                    </div>

                    <div className="bg-black/40 p-3 rounded-md border border-amber-500/15 flex flex-col gap-2 mt-1">
                       <p className="text-[9px] uppercase tracking-widest font-black text-slate-400 mb-1">Resume Eligibility Checklist</p>
                       <div className="grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-4 text-[10px] font-mono font-bold uppercase tracking-wider">
                         <div className="flex items-center gap-2">
                           {(!bot.drawdownPauseUntil || bot.drawdownPauseUntil <= Date.now()) ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400"/> : <XCircle className="w-3.5 h-3.5 text-amber-500"/>}
                           <span className={(!bot.drawdownPauseUntil || bot.drawdownPauseUntil <= Date.now()) ? "text-slate-300" : "text-amber-400/80"}>Cooldown Expired</span>
                         </div>
                         <div className="flex items-center gap-2">
                           {bot.openPositions === 0 ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400"/> : <XCircle className="w-3.5 h-3.5 text-amber-500"/>}
                           <span className={bot.openPositions === 0 ? "text-slate-300" : "text-amber-400/80"}>No Open Positions</span>
                         </div>
                         <div className="flex items-center gap-2">
                           {bot.availableMargin >= 40 ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400"/> : <XCircle className="w-3.5 h-3.5 text-amber-500"/>}
                           <span className={bot.availableMargin >= 40 ? "text-slate-300" : "text-amber-400/80"}>Margin &gt;= $40</span>
                         </div>
                         <div className="flex items-center gap-2">
                           {(bot.apiConnected !== false && bot.wssConnected !== false) ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400"/> : <XCircle className="w-3.5 h-3.5 text-amber-500"/>}
                           <span className={(bot.apiConnected !== false && bot.wssConnected !== false) ? "text-slate-300" : "text-amber-400/80"}>API & WSS OK</span>
                         </div>
                       </div>
                    </div>
                  </>
                ) : (bot.blocker === "HARD_POST_TRADE_COOLDOWN" || bot.blocker === "SOFT_POST_TRADE_COOLDOWN") ? (
                  <div className="text-[10px] font-mono border-t border-amber-500/10 pt-4 mt-1 flex justify-between items-center text-slate-400">
                    <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-amber-500" /> Holding setups until cooldown resets.</span>
                    <span className="text-xs font-bold text-white">Remaining: {bot.cooldownUntil && bot.cooldownUntil > Date.now() ? `${((bot.cooldownUntil - Date.now()) / 1000).toFixed(0)}s` : "0s"}</span>
                  </div>
                ) : bot.blocker === "REVERSE_LOCK_ACTIVE" ? (
                  <div className="text-[10px] font-mono border-t border-amber-500/10 pt-4 mt-1 flex justify-between items-center text-slate-400">
                    <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-amber-500" /> Preventative opposite side lock active to avoid whipsaws.</span>
                    <span className="text-xs font-bold text-white">Remaining: {bot.reverseLockUntil && bot.reverseLockUntil > Date.now() ? `${((bot.reverseLockUntil - Date.now()) / 1000).toFixed(0)}s` : "0s"}</span>
                  </div>
                ) : null}
              </motion.div>
            ) : bot.blocker === "WAITING_FOR_VALID_SETUP" || bot.blocker === "NO_VALID_MARKET_SETUP" || !bot.blocker ? (
              // Healthy strategically waiting state display showing candidates
              bot.openPositions === 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-[#0e1615] border border-emerald-500/15 rounded-lg p-5 flex flex-col gap-4 text-emerald-400 shadow-[0_0_25px_rgba(16,185,129,0.03)]"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-emerald-500/10 pb-4">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
                        <Radio className="w-5 h-5 animate-pulse text-emerald-400" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase font-black px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            {blockerInfo.badgeLabel}
                          </span>
                          <span className="font-mono text-[9px] text-emerald-500/50 font-bold tracking-wider leading-none">ANALYSIS_ACTIVE</span>
                        </div>
                        <p className="font-black text-[13px] uppercase tracking-[0.1em] mt-2 mb-0.5 leading-none text-white">{blockerInfo.title}</p>
                        <p className="text-xs text-emerald-400/80 font-mono italic my-1">{blockerInfo.description}</p>
                      </div>
                    </div>
                  </div>

                  {bot.rejectedSetups && bot.rejectedSetups.length > 0 ? (
                    <div className="mt-1">
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="text-[10px] uppercase tracking-widest font-black text-emerald-300/80">Filtered Candidates & Technical Screen Rejections</h4>
                        <span className="text-[8px] font-mono uppercase bg-emerald-500/10 text-emerald-400 px-2 py-0.5 font-bold rounded">Live Registry</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left font-mono text-[10px]">
                          <thead>
                            <tr className="border-b border-emerald-500/10 text-emerald-500/60 font-medium">
                              <th className="py-2 pr-2">Symbol</th>
                              <th className="py-2 px-2 text-center">Confidence</th>
                              <th className="py-2 px-2 text-center">Required</th>
                              <th className="py-2 px-2 text-center">Regime</th>
                              <th className="py-2 px-2 text-center">Trend Strength</th>
                              <th className="py-2 px-2 text-center">Volatility</th>
                              <th className="py-2 pl-2 text-right">Rejection Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bot.rejectedSetups.slice(0, 10).map((setup: any, idx: number) => (
                              <React.Fragment key={idx}>
                                <tr className="border-b border-emerald-500/[0.03] hover:bg-emerald-500/[0.01]">
                                  <td className="py-2 pr-2 font-bold text-emerald-300">{setup.symbol}</td>
                                  <td className="py-2 px-2 text-center text-slate-300">{setup.confidence}%</td>
                                  <td className="py-2 px-2 text-center text-slate-400">{setup.requiredConfidence}%</td>
                                  <td className="py-2 px-2 text-center text-slate-400">{setup.regime}</td>
                                  <td className="py-2 px-2 text-center text-slate-300">{(setup.trendStrength * 100).toFixed(1)}%</td>
                                  <td className="py-2 px-2 text-center text-slate-300">{(setup.volatility * 100).toFixed(1)}%</td>
                                  <td className="py-2 pl-2 text-right text-orange-400/90 italic">{setup.rejectionReason}</td>
                                </tr>
                                {setup.trendPhase && (
                                  <tr className="bg-black/20 border-b border-emerald-500/[0.05]">
                                    <td colSpan={7} className="py-1.5 px-2 text-[8px] text-slate-400">
                                      <div className="flex justify-between items-center opacity-80">
                                        <span><span className="text-slate-500">Phase:</span> <span className="text-indigo-400">{setup.trendPhase}</span></span>
                                        <span><span className="text-slate-500">Bias:</span> <span className={setup.directionalBiasWinner === "LONG" ? "text-emerald-400" : "text-rose-400"}>{setup.directionalBiasWinner}</span></span>
                                        <span><span className="text-slate-500">Conf:</span> <span className="text-emerald-400">L:{setup.longConfidence}</span> <span className="text-rose-400">S:{setup.shortConfidence}</span></span>
                                        <span><span className="text-slate-500">Exhaustion:</span> <span className="text-amber-400">{setup.exhaustionProbability}%</span></span>
                                        <span><span className="text-slate-500">Reversal:</span> <span className="text-fuchsia-400">{setup.reversalProbability}%</span></span>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[10px] text-slate-500 font-mono italic">No trade candidates detected in the current range yet. Scanner is searching approved markets...</p>
                  )}
                </motion.div>
              )
            ) : (
              // Any other custom wait-state (like VOLATILITY_NOISE_REJECTED, CHOP_NO_TRADE_ACTIVE, etc.) that acts as strategically waiting
              <motion.div 
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-[#0e1615] border border-emerald-500/15 rounded-lg p-5 flex flex-col gap-4 text-emerald-400 shadow-[0_0_25px_rgba(16,185,129,0.03)]"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-emerald-500/10 pb-4">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
                      <Radio className="w-5 h-5 animate-pulse text-emerald-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase font-black px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          {blockerInfo.badgeLabel}
                        </span>
                        <span className="font-mono text-[9px] text-emerald-500/50 font-bold tracking-wider leading-none">ANALYSIS_ACTIVE</span>
                      </div>
                      <p className="font-black text-[13px] uppercase tracking-[0.1em] mt-2 mb-0.5 leading-none text-white">{blockerInfo.title}</p>
                      <p className="text-xs text-emerald-400/80 font-mono italic my-1">{blockerInfo.description}</p>
                    </div>
                  </div>
                </div>

                {bot.rejectedSetups && bot.rejectedSetups.length > 0 && (
                  <div className="mt-1">
                    <div className="flex justify-between items-center mb-3">
                      <h4 className="text-[10px] uppercase tracking-widest font-black text-emerald-300/80">Filtered Candidates & Technical Screen Rejections</h4>
                      <span className="text-[8px] font-mono uppercase bg-emerald-500/10 text-emerald-400 px-2 py-0.5 font-bold rounded">Live Registry</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left font-mono text-[10px]">
                        <thead>
                          <tr className="border-b border-emerald-500/10 text-emerald-500/60 font-medium">
                            <th className="py-2 pr-2">Symbol</th>
                            <th className="py-2 px-2 text-center">Confidence</th>
                            <th className="py-2 px-2 text-center">Required</th>
                            <th className="py-2 px-2 text-center">Regime</th>
                            <th className="py-2 px-2 text-center">Trend Strength</th>
                            <th className="py-2 px-2 text-center">Volatility</th>
                            <th className="py-2 pl-2 text-right">Rejection Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bot.rejectedSetups.slice(0, 10).map((setup: any, idx: number) => (
                            <React.Fragment key={idx}>
                              <tr className="border-b border-emerald-500/[0.03] hover:bg-emerald-500/[0.01]">
                                <td className="py-2 pr-2 font-bold text-emerald-300">{setup.symbol}</td>
                                <td className="py-2 px-2 text-center text-slate-300">{setup.confidence}%</td>
                                <td className="py-2 px-2 text-center text-slate-400">{setup.requiredConfidence}%</td>
                                <td className="py-2 px-2 text-center text-slate-400">{setup.regime}</td>
                                <td className="py-2 px-2 text-center text-slate-300">{(setup.trendStrength * 100).toFixed(1)}%</td>
                                <td className="py-2 px-2 text-center text-slate-300">{(setup.volatility * 100).toFixed(1)}%</td>
                                <td className="py-2 pl-2 text-right text-orange-400/90 italic">{setup.rejectionReason}</td>
                              </tr>
                              {setup.trendPhase && (
                                <tr className="bg-black/20 border-b border-emerald-500/[0.05]">
                                  <td colSpan={7} className="py-1.5 px-2 text-[8px] text-slate-400">
                                    <div className="flex justify-between items-center opacity-80">
                                      <span><span className="text-slate-500">Phase:</span> <span className="text-indigo-400">{setup.trendPhase}</span></span>
                                      <span><span className="text-slate-500">Bias:</span> <span className={setup.directionalBiasWinner === "LONG" ? "text-emerald-400" : "text-rose-400"}>{setup.directionalBiasWinner}</span></span>
                                      <span><span className="text-slate-500">Conf:</span> <span className="text-emerald-400">L:{setup.longConfidence}</span> <span className="text-rose-400">S:{setup.shortConfidence}</span></span>
                                      <span><span className="text-slate-500">Exhaustion:</span> <span className="text-amber-400">{setup.exhaustionProbability}%</span></span>
                                      <span><span className="text-slate-500">Reversal:</span> <span className="text-fuchsia-400">{setup.reversalProbability}%</span></span>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {/* Validation Diagnostic Panel */}
            {bot.phase === "VALIDATION_FAILED" && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-rose-500/5 border border-rose-500/20 rounded-lg p-6 space-y-4 shadow-[0_0_40px_rgba(244,63,94,0.1)]"
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-rose-500/10 flex items-center justify-center shrink-0">
                      <ShieldAlert className="w-6 h-6 text-rose-500" />
                  </div>
                  <div>
                      <h2 className="text-sm font-black uppercase tracking-[0.2em] text-rose-500">
                        {bot.accountEquity < 20 ? "LOW_EQUITY_TRADING_BLOCKED" : (bot.lastApiError || bot.blocker || "VALIDATION_SYSTEM_BREACH")}
                      </h2>
                      <p className="text-[10px] text-rose-400/60 font-mono italic">Execution cycle terminated due to safety validation failure.</p>
                  </div>
                  <div className="ml-auto text-right">
                      {(bot.openPositions > 0 || Math.abs(parseFloat(bot.positionDetails?.szi || "0")) > 0) ? (
                        <span className="bg-rose-500 text-white text-[10px] px-3 py-1 rounded font-black tracking-widest animate-pulse shadow-[0_0_15px_rgba(244,63,94,0.4)]">MANUAL_CLOSE_REQUIRED</span>
                      ) : (
                        <span className="bg-orange-500 text-white text-[10px] px-3 py-1 rounded font-black tracking-widest shadow-[0_0_15px_rgba(249,115,22,0.4)]">CLEAR_LOCAL_STATE_REQUIRED</span>
                      )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 pt-6 border-t border-rose-500/10">
                  <div className="space-y-1.5">
                      <DiagnosticRow label="Failure Cause" value={bot.accountEquity < 20 ? "LOW_EQUITY_TRADING_BLOCKED" : (bot.lastApiError || bot.blocker || "VALIDATION_SYSTEM_BREACH")} status="error" />
                      <DiagnosticRow label="Account Equity" value={`$${bot.accountEquity.toFixed(2)}`} />
                      <DiagnosticRow label="Available Margin" value={`$${(bot.availableMargin || 0).toFixed(2)}`} />
                  </div>
                  <div className="space-y-1.5">
                      <DiagnosticRow label="Current Pos Count" value={bot.openPositions} status={bot.openPositions > 0 ? "error" : "success"} />
                      <DiagnosticRow label="Current Pos Size" value={bot.positionDetails?.szi || "0"} />
                      <DiagnosticRow label="Active Symbol" value={bot.activeSymbol} />
                  </div>
                  <div className="space-y-1.5">
                      <DiagnosticRow label="Last Order ID" value={bot.lastOrderId || "N/A"} />
                      <DiagnosticRow label="Last Order Failure" value={bot.lastOrderFailureReason || "NONE"} status={bot.lastOrderFailureReason ? "error" : "neutral"} />
                      <DiagnosticRow label="Last Fill Price" value={bot.lastFillPrice ? `$${bot.lastFillPrice.toFixed(2)}` : "N/A"} />
                      <DiagnosticRow label="TP/SL Status" value={bot.openPositions > 0 ? (bot.protectionStatus || "CONFIRMED") : "N/A"} status={bot.openPositions === 0 ? "neutral" : (bot.protectionStatus === "CONFIRMED" ? "success" : "error")} />
                  </div>
                  <div className="space-y-1.5">
                      <DiagnosticRow label="Drawdown Pause" value={(bot.drawdownPauseUntil && bot.drawdownPauseUntil > Date.now()) ? `${Math.round((bot.drawdownPauseUntil - Date.now())/1000/60)}m` : "NONE"} />
                      <DiagnosticRow label="Cloud Run ID" value={bot.cloudRunId || "LOCAL"} />
                      <DiagnosticRow 
                        label="HYPE-USDC_STATUS" 
                        value={bot.hypeStatus || "FOUND"} 
                        status={bot.hypeStatus === "ACTIVE_IN_SCANNER" ? "success" : bot.hypeStatus?.startsWith("FILTERED_OUT_REASON") ? "error" : "neutral"} 
                      />
                  </div>
                </div>
                
                {bot.openPositions > 0 && (
                  <div className="pt-4 border-t border-rose-500/10 flex justify-end">
                    <button 
                      disabled={!bot.apiConnected}
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/emergency-close", { method: "POST" });
                          const data = await res.json();
                          if (res.ok) alert(data.message || "Emergency close executed.");
                          else alert(`Emergency Close Failed: ${data.message || data.error}`);
                        } catch (e) {
                          alert("API error during emergency close.");
                        }
                      }}
                      className="disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white font-black uppercase text-[9px] tracking-wider rounded-lg transition-colors cursor-pointer shadow-[0_2px_10px_rgba(244,63,94,0.3)]"
                    >
                      Trigger Emergency Exit
                    </button>
                  </div>
                )}
              </motion.div>
            )}

            {/* Charts Grid */}
            {isAdvancedMode && (
              <CollapsibleSection title="Performance Charts" icon={<TrendingUp className="w-3.5 h-3.5 text-indigo-400" />} defaultOpen={true} storageKey="performance_charts">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-[400px]">
                  <ChartContainer 
                    title="Mark Price History" 
                    icon={<TrendingUp className="w-3.5 h-3.5" />}
                    data={bot.priceHistory || []}
                    color="#8A4FFF"
                    domain={['auto', 'auto']}
                  />
                  <ChartContainer 
                    title="PnL Trajectory" 
                    icon={<BarChart3 className="w-3.5 h-3.5" />}
                    data={bot.pnlHistory || []}
                    color="#10b981"
                    baseline={0}
                  />
                </div>
              </CollapsibleSection>
            )}
            
            {/* CoinMarketCap Discovery Layer */}
            <CollapsibleSection title="CoinMarketCap Trend Discovery" icon={<Compass className="w-3.5 h-3.5 text-teal-400" />} defaultOpen={true} storageKey="cmc_trend_discovery">
              <CoinMarketCapPanel intelligence={bot.cmcIntelligence || null} />
            </CollapsibleSection>
            
            {/* Analytics Grid */}
            {isAdvancedMode && (
              <>
                <CollapsibleSection title="Analytics Overview" icon={<BarChart3 className="w-3.5 h-3.5 text-indigo-400" />} defaultOpen={true} storageKey="analytics_overview font-mono">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <StatCard label="Win Rate" value={`${(analytics?.winRate || 0).toFixed(1)}%`} status={(analytics?.winRate || 0) > 50 ? "success" : "neutral"} />
                <StatCard label="Avg Win/Loss" value={`$${(analytics?.avgWin || 0).toFixed(1)} / $${(analytics?.avgLoss || 0).toFixed(1)}`} />
                <StatCard label="Net Profit" value={`$${(analytics?.netProfitability || 0).toFixed(2)}`} status={(analytics?.netProfitability || 0) > 0 ? "success" : "error"} />
                <StatCard label="Cumulative Fees" value={`$${(analytics?.cumulativeFees || 0).toFixed(2)}`} status="neutral" />
              </div>

              {/* Phase 2 Stabilization & Expectancy Metrics */}
              <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6 bg-slate-900/10 border border-slate-800/45 p-4 rounded-lg">
                <div className="bg-black/20 p-3 rounded border border-slate-800/50 space-y-1">
                  <p className="text-[9px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1"><Activity className="w-3 h-3 text-emerald-400" /> Expectancy / Trade</p>
                  <p className="text-lg font-black font-mono text-white">
                    {analytics?.expectancyAfterFees !== undefined ? `$${analytics.expectancyAfterFees.toFixed(2)}` : "$0.00"}
                  </p>
                  <p className="text-[9px] text-slate-500">Average net profitability per trade after fees</p>
                </div>
                <div className="bg-black/20 p-3 rounded border border-slate-800/50 space-y-1">
                  <p className="text-[9px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1"><Activity className="w-3 h-3 text-indigo-400" /> Project vs Real Move</p>
                  <p className="text-lg font-black font-mono text-white">
                    {analytics?.avgProjectedMove !== undefined ? `${analytics.avgProjectedMove.toFixed(2)}% vs ${analytics?.avgRealizedMove?.toFixed(2)}%` : "0.00% vs 0.00%"}
                  </p>
                  <p className="text-[9px] text-slate-500">Avg projected target vs realized performance</p>
                </div>
                <div className="bg-black/20 p-3 rounded border border-slate-800/50 space-y-1">
                  <p className="text-[9px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1"><Activity className="w-3 h-3 text-rose-400" /> Fee to Profit Ratio</p>
                  <p className="text-lg font-black font-mono text-white">
                    {analytics?.feeToProfitRatio !== undefined ? `${(analytics.feeToProfitRatio * 100).toFixed(1)}%` : "0.0%"}
                  </p>
                  <p className="text-[9px] text-slate-500">Total transaction friction relative to profits</p>
                </div>
                <div className="bg-black/20 p-3 rounded border border-slate-800/50 space-y-1">
                  <p className="text-[9px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1"><Activity className="w-3 h-3 text-amber-500" /> False Breakout Rate</p>
                  <p className="text-lg font-black font-mono text-white">
                    {analytics?.falseBreakoutRate !== undefined ? `${analytics.falseBreakoutRate.toFixed(1)}%` : "0.0%"}
                  </p>
                  <p className="text-[9px] text-slate-500">Failed breakouts entered / total breakout signals</p>
                </div>
                <div className="bg-black/20 p-3 rounded border border-slate-800/50 space-y-1">
                  <p className="text-[9px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1"><Activity className="w-3 h-3 text-violet-400" /> Volatility Failure Rate</p>
                  <p className="text-lg font-black font-mono text-white">
                    {analytics?.volatilityFailureRate !== undefined ? `${analytics.volatilityFailureRate.toFixed(1)}%` : "0.0%"}
                  </p>
                  <p className="text-[9px] text-slate-500">Losses in high-volatility setups / high-vol trades</p>
                </div>
              </div>

              {/* Phase 2 Adaptive Feedback Metrics */}
              <div className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6 bg-[#0c0e12] border border-[#8A4FFF]/20 p-4 rounded-lg shadow-[0_0_20px_rgba(138,79,255,0.05)]">
                <div className="space-y-1">
                  <p className="text-[9px] uppercase font-bold text-[#8A4FFF]/70 tracking-widest">Missed Runners</p>
                  <p className="text-lg font-black font-mono text-white">{analytics?.missedRunnerCount || 0}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[9px] uppercase font-bold text-[#8A4FFF]/70 tracking-widest">Post-Rally Cont. Score</p>
                  <p className="text-lg font-black font-mono text-white">{analytics?.postRallyContinuationScore || 0}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[9px] uppercase font-bold text-[#8A4FFF]/70 tracking-widest">Recent Entry Bias</p>
                  <p className="text-sm font-black font-mono text-white mt-1 pt-0.5">{analytics?.recentEntryBias || "NEUTRAL"}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[9px] uppercase font-bold text-[#8A4FFF]/70 tracking-widest">Last Missed Runner</p>
                  <p className="text-lg font-black font-mono text-white">{analytics?.lastMissedRunner || "NONE"}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[9px] uppercase font-bold text-[#8A4FFF]/70 tracking-widest">Threshold Adjustment</p>
                  <p className="text-lg font-black font-mono text-white">{analytics?.thresholdAdjustment > 0 ? "+" : ""}{analytics?.thresholdAdjustment || 0}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[9px] uppercase font-bold text-[#8A4FFF]/70 tracking-widest">False Breakout %</p>
                  <p className="text-lg font-black font-mono text-rose-400">{analytics?.falseBreakoutRate?.toFixed(1) || "0.0"}% <span className="text-[10px] text-slate-500">({analytics?.recentFalseBreakouts || 0})</span></p>
                </div>
                <div className="space-y-1">
                  <p className="text-[9px] uppercase font-bold text-[#8A4FFF]/70 tracking-widest">Cont. Success %</p>
                  <p className="text-lg font-black font-mono text-emerald-400">{analytics?.recentContinuationSuccessRate?.toFixed(1) || "0.0"}% <span className="text-[10px] text-slate-500">({(analytics as any)?.recentContinuationSuccessCount || 0})</span></p>
                </div>
              </div>

              {/* Cumulative PnL Trend LineChart */}
              <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg mb-6 flex flex-col relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[#8A4FFF]/0 via-[#8A4FFF]/40 to-[#8A4FFF]/0"></div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 pb-3 border-b border-slate-800/60 gap-4">
                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest flex items-center gap-1.5 font-mono">
                      <TrendingUp className="w-3.5 h-3.5 text-[#8A4FFF]" /> Cumulative PnL Progression
                    </span>
                    <p className="text-[10px] text-slate-500 mt-1 leading-relaxed font-mono">
                      Interactive equity trajectory analyzing trade milestones over time.
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-xs font-mono">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded bg-[#8A4FFF]/20 border border-[#8A4FFF]/50 block"></span>
                      <span className="text-slate-400">Net Profitability:</span>
                      <span className={cn("font-bold", (analytics?.netProfitability || 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        ${(analytics?.netProfitability || 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="h-[250px] w-full mt-2 -ml-4 pr-4">
                  {bot.pnlHistory && bot.pnlHistory.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={bot.pnlHistory} margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                        <XAxis 
                          dataKey="timestamp" 
                          stroke="#475569" 
                          fontSize={9}
                          tickLine={false}
                          tickFormatter={(ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                        />
                        <YAxis 
                          stroke="#475569" 
                          fontSize={9}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(val) => `$${val.toFixed(2)}`}
                          domain={['auto', 'auto']}
                        />
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#0C0E12', border: '1px solid #1e293b', borderRadius: '8px', padding: '10px' }}
                          labelStyle={{ color: '#64748b', fontSize: '10px', fontFamily: 'monospace', marginBottom: '4px' }}
                          labelFormatter={(label) => `Time: ${new Date(label).toLocaleTimeString([], { hour12: false })}`}
                          itemStyle={{ color: '#fff', fontSize: '11px', fontFamily: 'monospace' }}
                          formatter={(value: any) => [`$${parseFloat(value).toFixed(2)}`, "Cumulative PnL"]}
                        />
                        <ReferenceLine y={0} stroke="#ffffff20" strokeWidth={1} strokeDasharray="3 3" />
                        <Line 
                          type="monotone" 
                          dataKey="value" 
                          stroke="#8A4FFF" 
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4, stroke: '#8A4FFF', strokeWidth: 2, fill: '#0C0E12' }}
                          animationDuration={500}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-slate-500 font-mono text-[10px] border border-dashed border-slate-800/80 rounded py-12">
                      <Activity className="w-5 h-5 mb-2 opacity-55 animate-pulse text-indigo-400" />
                      SEEKING ACCUMULATED DATA STREAMS...
                    </div>
                  )}
                </div>
              </div>

              {/* Regime & Timing Analytics */}
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                {/* Capital Sizing & Free Collateral Health */}
                <div className="bg-[#0C0E12] border border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.05)] p-5 rounded-lg flex flex-col justify-between relative overflow-hidden">
                   <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500/0 via-emerald-500/50 to-emerald-500/0"></div>
                   <div className="space-y-4 relative z-10 w-full">
                      <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 text-emerald-400" /> Sizing & Capital Safety
                      </span>
                      <div className="space-y-3 pt-2">
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs text-slate-400 font-bold">Preferred Entry Size</span>
                          <span className="font-mono text-xs font-black text-amber-400">
                            ${(bot?.preferredEntrySize || 40).toFixed(2)} USDC
                          </span>
                        </div>
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs text-slate-400">Last/Active Actual Entry</span>
                          <span className="font-mono text-xs font-bold text-sky-400">
                            {bot?.actualEntrySize ? `$${bot.actualEntrySize.toFixed(2)}` : "—"}
                          </span>
                        </div>
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs text-slate-400">Sizing Tier</span>
                          <span className={cn(
                            "font-mono text-xs font-black px-1.5 py-0.5 rounded text-[10px]",
                            bot?.entryTier === "STANDARD_ENTRY" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
                            bot?.entryTier === "REDUCED_ENTRY" ? "bg-amber-500/10 text-amber-400 border border-amber-500/20" :
                            bot?.entryTier === "MICRO_ENTRY" ? "bg-sky-500/10 text-sky-400 border border-sky-500/20" :
                            "bg-slate-800 text-slate-400"
                          )}>
                            {bot?.entryTier || "NONE"}
                          </span>
                        </div>
                        {bot?.entryTier && bot.entryTier !== "NONE" && bot?.reducedSizeReason && (
                          <div className="text-[10px] text-slate-400 italic bg-slate-900/60 p-2 rounded border border-slate-800/40 font-mono mt-1">
                            <span className="text-amber-400 font-bold">Reason:</span> {bot.reducedSizeReason}
                          </div>
                        )}
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs text-slate-400">Safe Size vs Min Required</span>
                          <span className="font-mono text-xs font-semibold text-slate-300">
                             ${(bot?.sizingTelemetry?.lastSafeExposureComputed || 0).toFixed(2)} / ${(bot?.sizingTelemetry?.lastExchangeMinimumRequired || 40).toFixed(2)}
                          </span>
                        </div>
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs text-slate-400">Projected Margin After Entry</span>
                          <span className="font-mono text-xs font-bold text-sky-400">
                             ${(bot?.availableMargin !== undefined && bot?.sizingTelemetry?.lastExchangeMinimumRequired !== undefined)
                               ? Math.max(0, bot.availableMargin - (bot.sizingTelemetry.lastExchangeMinimumRequired / (bot.config?.leverage || 1) + (bot.sizingTelemetry.lastExchangeMinimumRequired * 0.005))).toFixed(2)
                               : "0.00"}
                          </span>
                        </div>
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs text-slate-400">Post-Trade Margin usage</span>
                          <span className="font-mono text-xs font-bold text-white">
                             {bot?.sizingTelemetry?.projectedMarginUsagePct?.toFixed(1) || 0}%
                          </span>
                        </div>
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs text-slate-400">Projected Free Collateral</span>
                          <span className={cn(
                            "font-mono text-xs font-bold",
                            (bot?.sizingTelemetry?.projectedFreeCollateralPct || 0) < 30 ? "text-rose-400" : "text-emerald-400"
                          )}>
                             {bot?.sizingTelemetry?.projectedFreeCollateralPct?.toFixed(1) || 0}%
                          </span>
                        </div>
                      </div>

                      <div className="pt-3 border-t border-slate-800/60">
                        <div className="flex items-center justify-between text-[10px] font-mono">
                          <span className="text-slate-500">Margin Health Index</span>
                          <span className={cn(
                            "font-bold",
                            (bot?.sizingTelemetry?.marginBufferHealthPct || 0) < 100 ? "text-rose-400" : "text-emerald-400"
                          )}>
                            {bot?.sizingTelemetry?.marginBufferHealthPct?.toFixed(0) || 0}/100
                          </span>
                        </div>
                        <div className="w-full bg-slate-800 h-1 mt-2 rounded overflow-hidden">
                           <div 
                             className={cn("h-full", (bot?.sizingTelemetry?.marginBufferHealthPct || 0) < 100 ? "bg-rose-500" : "bg-emerald-500")}
                             style={{ width: `${Math.min(100, Math.max(0, bot?.sizingTelemetry?.marginBufferHealthPct || 0))}%` }}
                           ></div>
                        </div>
                      </div>
                   </div>

                   <div className="mt-4 pt-3 border-t border-slate-800/40 flex justify-between text-[11px] font-mono text-slate-500 w-full relative z-10">
                     <span>Unsafe Sizing Rejections:</span>
                     <span className="font-bold text-rose-400">{bot?.sizingTelemetry?.rejectedTradesDueToSizing || 0}</span>
                   </div>
                </div>

                {/* Average Duration & Overtrading Info Card */}
                <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
                  <div className="space-y-4">
                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-indigo-400" /> Average Position Duration
                      </span>
                      <p className="text-3xl font-black font-mono tracking-tighter text-white pt-2">
                        {formatDuration(analytics?.averageTradeDuration || 0)}
                      </p>
                      <p className="text-[10px] text-slate-500 italic pt-1">
                        Calculated across all completed position exit-to-entry cycles
                      </p>
                    </div>
                    
                    <div className="pt-3 border-t border-slate-800/60">
                      <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 text-rose-400" /> Overtrading Risk Score
                      </span>
                      <div className="flex justify-between items-baseline pt-2">
                        <span className="text-2xl font-black font-mono text-white">
                          {analytics?.overtradingScore || 0} <span className="text-xs text-slate-500 font-normal">exits/hr</span>
                        </span>
                        <span className={cn(
                          "text-[9px] font-mono px-2 py-0.5 rounded-full font-bold uppercase",
                          (analytics?.overtradingScore || 0) > 3 
                            ? "bg-rose-500/10 text-rose-400 border border-rose-500/20" 
                            : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                        )}>
                          {(analytics?.overtradingScore || 0) > 3 ? "DRIVE COOLDOWN" : "NOMINAL"}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="mt-4 pt-3 border-t border-slate-800/40 flex justify-between text-[11px] font-mono text-slate-500">
                    <span>Total Cycles Analyzed:</span>
                    <span className="font-bold text-white">{analytics?.totalTrades || 0}</span>
                  </div>
                </div>

                {/* Best / Worst performing regime stats card */}
                <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
                  <div className="space-y-4 w-full">
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5">
                      <Target className="w-3.5 h-3.5 text-[#8A4FFF]" /> Edge Attribution by Regime
                    </span>

                    <div className="grid grid-cols-2 gap-3 pt-2">
                      {/* Best Regime Card */}
                      <div className="bg-emerald-950/20 p-3 rounded-lg border border-emerald-900/40 space-y-1">
                        <p className="text-[9px] uppercase font-bold text-emerald-400 tracking-wider">Top Source</p>
                        <p className="text-sm font-black text-white font-mono truncate">{analytics?.bestRegime?.replace(/_/g, ' ') || "N/A"}</p>
                        {analytics?.bestRegime && analytics.bestRegime !== "N/A" && analytics.regimeDetailedStats?.[analytics.bestRegime] && (
                          <p className="text-[10px] text-slate-400 font-mono">
                            Pnl: <span className="text-emerald-400 font-bold">${analytics.regimeDetailedStats[analytics.bestRegime].netPnl.toFixed(2)}</span>
                          </p>
                        )}
                      </div>

                      {/* Worst Regime Card */}
                      <div className="bg-rose-950/20 p-3 rounded-lg border border-rose-900/40 space-y-1">
                        <p className="text-[9px] uppercase font-bold text-rose-400 tracking-wider">Bottom Source</p>
                        <p className="text-sm font-black text-white font-mono truncate">{analytics?.worstRegime?.replace(/_/g, ' ') || "N/A"}</p>
                        {analytics?.worstRegime && analytics.worstRegime !== "N/A" && analytics.regimeDetailedStats?.[analytics.worstRegime] && (
                          <p className="text-[10px] text-slate-400 font-mono">
                            Pnl: <span className="text-rose-400 font-bold">${analytics.regimeDetailedStats[analytics.worstRegime].netPnl.toFixed(2)}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-800/40 text-[10px] text-slate-500 font-mono italic">
                    Dynamic confirmation adjusts to minimize adverse selection bias
                  </div>
                </div>

                {/* Detailed Market Regime & Fee Efficiency Analysis */}
                <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
                  <div className="space-y-2 w-full">
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5">
                      <BarChart3 className="w-3.5 h-3.5 text-indigo-400" /> Regime Efficiency & Net PnL
                    </span>

                    <div className="space-y-2.5 pt-2">
                      {Object.keys(analytics?.regimeDetailedStats || {}).length > 0 ? (
                        Object.entries(analytics?.regimeDetailedStats || {}).map(([regime, stats]: any) => (
                          <div key={regime} className="bg-black/40 p-2.5 rounded border border-slate-800/50 flex flex-col space-y-1">
                            <div className="flex justify-between items-center">
                              <span className="text-[10px] uppercase font-bold text-white tracking-wide">{regime.replace(/_/g, ' ')}</span>
                              <span className={cn(
                                "text-[10px] font-mono font-bold",
                                stats.netPnl >= 0 ? "text-emerald-400" : "text-rose-400"
                              )}>
                                {stats.netPnl >= 0 ? "+" : ""}${stats.netPnl.toFixed(2)} Net
                              </span>
                            </div>
                            
                            <div className="flex justify-between text-[10px] font-mono text-slate-500">
                              <span>WR: <span className="text-slate-300 font-bold">{stats.winRate.toFixed(0)}%</span></span>
                              <span>Fees: <span className="text-slate-300">${stats.fees.toFixed(2)}</span></span>
                              <span>Hold: <span className="text-slate-300">{formatDuration(stats.averageDuration)}</span></span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="h-24 flex items-center justify-center text-slate-600 gap-2 border border-dashed border-slate-800 rounded">
                          <Activity className="w-4 h-4 opacity-45 animate-pulse" />
                          <span className="text-[10px] uppercase tracking-wider font-mono">Seeking Statistical Consensus...</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Controlled Adaptive Learning Engine Dashboard */}
                <div className="bg-[#0C0E12] border border-indigo-900/40 p-5 rounded-lg flex flex-col justify-between md:col-span-2 lg:col-span-4">
                  <div className="space-y-4 w-full">
                    <span className="text-[10px] uppercase font-bold text-indigo-400 tracking-widest flex items-center justify-between">
                      <div className="flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> Adaptive Learning Engine</div>
                      <div className="text-[9px] font-mono bg-indigo-500/10 px-2 py-0.5 rounded text-indigo-300 border border-indigo-500/20">
                        CONFIDENCE: {bot?.learningState?.globalLearningConfidence?.toFixed(0) || 0}%
                      </div>
                    </span>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div className="bg-black/30 border border-slate-800 rounded p-3">
                         <div className="text-[9px] uppercase font-bold text-emerald-400 mb-1">Long Edge</div>
                         <div className="text-lg font-mono text-white font-bold">{bot?.learningState?.longEdgeScore >= 0 ? "+" : ""}${(bot?.learningState?.longEdgeScore || 0).toFixed(2)}</div>
                      </div>
                      <div className="bg-black/30 border border-slate-800 rounded p-3">
                         <div className="text-[9px] uppercase font-bold text-rose-400 mb-1">Short Edge</div>
                         <div className="text-lg font-mono text-white font-bold">{bot?.learningState?.shortEdgeScore >= 0 ? "+" : ""}${(bot?.learningState?.shortEdgeScore || 0).toFixed(2)}</div>
                      </div>
                      <div className="bg-black/30 border border-slate-800 rounded p-3">
                         <div className="text-[9px] uppercase font-bold text-slate-400 mb-1">Best Bucket</div>
                         <div className="text-xs font-mono text-emerald-400 truncate">{bot?.learningState?.bestBuckets?.[0] || "N/A"}</div>
                      </div>
                      <div className="bg-black/30 border border-slate-800 rounded p-3">
                         <div className="text-[9px] uppercase font-bold text-slate-400 mb-1">Worst Bucket</div>
                         <div className="text-xs font-mono text-rose-400 truncate">{bot?.learningState?.worstBuckets?.[0] || "N/A"}</div>
                      </div>
                    </div>

                    {bot?.learningState?.bestBuckets && bot.learningState.bestBuckets.length > 0 && (
                        <div className="space-y-2 mt-2">
                           <div className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Active Statistical Adjustments</div>
                           <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                              {bot.learningState.bestBuckets.slice(0, 2).map((id) => {
                                 const b = bot.learningState!.buckets[id];
                                 return b ? (
                                    <div key={id} className="bg-emerald-950/20 border border-emerald-900/30 rounded p-2 text-[10px] font-mono text-slate-300">
                                       <div className="truncate text-emerald-400 font-bold mb-1">{b.id}</div>
                                       <div>Size: {(b.sizeAdjustment * 100).toFixed(0)}%</div>
                                       <div>Thresh: {b.thresholdAdjustment.toFixed(1)}</div>
                                    </div>
                                 ) : null;
                              })}
                              {bot.learningState.worstBuckets.slice(0, 2).map((id) => {
                                 const b = bot.learningState!.buckets[id];
                                 return b ? (
                                    <div key={id} className="bg-rose-950/20 border border-rose-900/30 rounded p-2 text-[10px] font-mono text-slate-300">
                                       <div className="truncate text-rose-400 font-bold mb-1">{b.id}</div>
                                       <div>Size: {(b.sizeAdjustment * 100).toFixed(0)}%</div>
                                       <div>Thresh: +{b.thresholdAdjustment.toFixed(1)}</div>
                                    </div>
                                 ) : null;
                              })}
                           </div>
                        </div>
                    )}
                  </div>
                </div>
                
                {/* Friction Telemetry & Hard Pause Status */}
                <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg flex flex-col justify-between md:col-span-2 lg:col-span-4">
                  <div className="space-y-3 w-full">
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center justify-between">
                      <div className="flex flex-row items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5 text-rose-400" /> System Friction & Fee Bleed Tracker</div>
                      <div className="text-[9px] uppercase tracking-tighter">Overall Fee Ratio: {(bot.feeEfficiency?.feeToProfitRatio || 0).toFixed(2)}</div>
                    </span>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Left: Pause States */}
                      <div className="space-y-2 border border-rose-900/30 bg-rose-950/10 rounded p-3">
                        <h4 className="text-[10px] font-bold text-rose-400 tracking-widest uppercase pb-1 border-b border-rose-900/30">Active Pauses</h4>
                        <div className="flex justify-between text-[10px] font-mono">
                           <span className="text-slate-400">Pause State:</span>
                           <span className={bot.feeEfficiency?.isPaused ? "text-rose-400 font-bold" : "text-emerald-400 font-bold"}>
                             {bot.feeEfficiency?.isPaused ? bot.feeEfficiency.pauseType + " PAUSE" : "CLEAR"}
                           </span>
                        </div>
                        {bot.feeEfficiency?.isPaused && (
                          <div className="flex justify-between text-[10px] font-mono">
                             <span className="text-slate-400">Remaining time:</span>
                             <span className="text-white">
                                {Math.max(0, Math.floor(((bot.feeEfficiency.pauseUntil || 0) - Date.now())/60000))} mins
                             </span>
                          </div>
                        )}
                        <div className="flex justify-between text-[10px] font-mono">
                           <span className="text-slate-400">Elite Soft Pause Override:</span>
                           <span className={bot.feeEfficiency?.eliteOverrideEligibility ? "text-indigo-400 font-bold" : "text-slate-500"}>
                             {bot.feeEfficiency?.eliteOverrideEligibility ? "ALLOWED" : "BLOCKED"}
                           </span>
                        </div>
                        {bot.feeEfficiency?.eliteOverrideEligibility && (
                          <div className="flex justify-between text-[10px] font-mono">
                            <span className="text-slate-400">Required Reward Multiple:</span>
                            <span className="text-white">5x Est. Fees (Min 0.5% Move)</span>
                          </div>
                        )}
                      </div>
                      
                      {/* Right: Worst 2 Fee Markets */}
                      <div className="space-y-2 border border-slate-800 rounded p-3 bg-black/20">
                        <h4 className="text-[10px] font-bold text-slate-500 tracking-widest uppercase pb-1 border-b border-slate-800/60">High-Friction Assets</h4>
                        <div className="space-y-1">
                          {Object.entries(bot.assetFeeEfficiency || {})
                              .filter(([_, data]: any) => data.isHighFeeMarket || data.feeToProfitRatio > 0.4)
                              .sort((a: any, b: any) => b[1].totalFees - a[1].totalFees)
                              .slice(0, 3)
                              .map(([sym, data]: any) => (
                                <div key={sym} className="flex justify-between text-[10px] font-mono border-b border-slate-800/30 pb-0.5">
                                  <span className="text-rose-400 font-bold">{sym}</span>
                                  <div className="flex gap-2">
                                     <span className="text-slate-400">Net: ${data.netPnl.toFixed(1)}</span>
                                     <span className="text-slate-500">{(data.feeToProfitRatio * 100).toFixed(0)}% Fee Ratio</span>
                                  </div>
                                </div>
                          ))}
                          {Object.keys(bot.assetFeeEfficiency || {}).length === 0 && (
                            <div className="text-slate-600 text-[10px] font-mono italic">No friction logs yet...</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Calibration & Expectancy Analytics */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 pt-4">
                <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5"><Target className="w-3.5 h-3.5 text-indigo-400" /> Expectancy After Fees</span>
                  <div className="pt-3">
                    <p className={cn("text-3xl font-black font-mono tracking-tighter", (bot.expectancy?.globalExpectancyAfterFees || 0) < 0 ? "text-rose-400" : "text-emerald-400")}>
                      ${(bot.expectancy?.globalExpectancyAfterFees || 0).toFixed(2)} <span className="text-sm font-normal text-slate-500">avg</span>
                    </p>
                    <div className="mt-2 space-y-1">
                      <div className="flex justify-between text-[10px] font-mono text-slate-400"><span>Rolling 20:</span> <span className={cn((bot.expectancy?.rolling20 || 0) < 0 ? "text-rose-400" : "text-emerald-400")}>${(bot.expectancy?.rolling20 || 0).toFixed(2)}</span></div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-400"><span>Rolling 50:</span> <span className={cn((bot.expectancy?.rolling50 || 0) < 0 ? "text-rose-400" : "text-emerald-400")}>${(bot.expectancy?.rolling50 || 0).toFixed(2)}</span></div>
                    </div>
                  </div>
                </div>

                <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-blue-400" /> Global Fee Efficiency</span>
                  <div className="pt-3">
                    <p className={cn("text-3xl font-black font-mono tracking-tighter", (analytics?.feeToProfitRatio || 0) > 0.4 ? "text-rose-400" : "text-emerald-400")}>
                      {((analytics?.feeToProfitRatio || 0) * 100).toFixed(1)}% <span className="text-sm font-normal text-slate-500">ratio</span>
                    </p>
                    <div className="mt-2 text-[10px] font-mono text-slate-400 italic">
                      Tracking aggregate fee bleed against realized gross profits across all executed trades.
                    </div>
                  </div>
                </div>

                <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5"><Filter className="w-3.5 h-3.5 text-amber-400" /> Participation Engine</span>
                  <div className="pt-3">
                    <p className={cn("text-3xl font-black font-mono tracking-tighter text-white")}>
                      {((bot.participation?.participationRate || 0) * 100).toFixed(1)}% <span className="text-sm font-normal text-slate-500">health</span>
                    </p>
                    <div className="mt-2 space-y-1">
                      <div className="flex justify-between text-[10px] font-mono text-slate-400"><span>Scanner Pool:</span> <span className="text-amber-400">{bot.participation?.scannedCount || 0}</span></div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-400"><span>Eligible:</span> <span className="text-emerald-400">{bot.participation?.eligibleCount || 0}</span></div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-500 border-t border-slate-800/40 pt-1 mt-1"><span>Low-Vol Scan/App:</span> <span className="text-slate-300">{bot.participation?.lowVolScanned || 0}/{bot.participation?.lowVolApproved || 0}</span></div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-500"><span>High-Vol Scan/App:</span> <span className="text-slate-300">{bot.participation?.highVolScanned || 0}/{bot.participation?.highVolApproved || 0}</span></div>
                    </div>
                  </div>
                </div>

                <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5"><Crosshair className="w-3.5 h-3.5 text-rose-400" /> Quality Bleed Metrics</span>
                  <div className="pt-3 space-y-2">
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                        <span className="text-[10px] font-mono text-slate-400 uppercase">Missed Runners</span>
                        <span className="text-[11px] font-black font-mono text-white">{bot.participation?.missedRunnerCount || analytics?.missedRunnerCount || 0}</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                        <span className="text-[10px] font-mono text-slate-400 uppercase">False Breakout %</span>
                        <span className="text-[11px] font-black font-mono text-rose-400">{analytics?.falseBreakoutRate?.toFixed(1) || 0}%</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                        <span className="text-[10px] font-mono text-slate-400 uppercase">Vol Failures %</span>
                        <span className="text-[11px] font-black font-mono text-rose-400">{analytics?.volatilityFailureRate?.toFixed(1) || 0}%</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/60 pb-1">
                        <span className="text-[10px] font-mono text-slate-400 uppercase">Low-Vol Expectancy</span>
                        <span className={cn("text-[11px] font-black font-mono", (analytics as any)?.lowVolExpectancy >= 0 ? "text-emerald-400" : "text-rose-400")}>{(analytics as any)?.lowVolExpectancy !== undefined ? ((analytics as any).lowVolExpectancy >= 0 ? "+" : "") + (analytics as any).lowVolExpectancy.toFixed(2) : "0.00"}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-[10px] font-mono text-slate-400 uppercase">High-Vol Expectancy</span>
                        <span className={cn("text-[11px] font-black font-mono", (analytics as any)?.highVolExpectancy >= 0 ? "text-emerald-400" : "text-rose-400")}>{(analytics as any)?.highVolExpectancy !== undefined ? ((analytics as any).highVolExpectancy >= 0 ? "+" : "") + (analytics as any).highVolExpectancy.toFixed(2) : "0.00"}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Autonomous Recovery Engine Status Panel */}
              <div className="bg-[#0C0E12] border border-indigo-500/25 shadow-[0_0_20px_rgba(138,79,255,0.06)] p-5 rounded-lg mt-6 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-indigo-500/0 via-indigo-500/50 to-indigo-500/0"></div>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5 text-indigo-400 animate-pulse" /> Autonomous Recovery Engine
                    </span>
                    <div className="flex items-center gap-1.5 font-mono text-[10px]">
                      <span className="text-slate-500">Recovery Mode:</span>
                      <span className={cn(
                        "font-black px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider",
                        bot?.autoRecoveryMode === "ON" ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/35 animate-pulse" : "bg-slate-800 text-slate-400"
                      )}>
                        {bot?.autoRecoveryMode === "ON" ? "ON (ACTIVE)" : "OFF (MONITORING)"}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 pt-1">
                    <div className="bg-black/20 border border-slate-800/60 rounded p-3 space-y-1">
                      <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">State Bias</span>
                      <div className="text-xs font-mono font-bold text-white uppercase">{analytics?.recentEntryBias || "NEUTRAL"}</div>
                    </div>
                    <div className="bg-black/20 border border-slate-800/60 rounded p-3 space-y-1">
                      <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Threshold Adjust</span>
                      <div className="text-xs font-mono font-bold text-indigo-400">
                        {bot?.autoRecoveryMode === "ON" ? "-12 points (Relaxed)" : "0 points"}
                      </div>
                    </div>
                    <div className="bg-black/20 border border-slate-800/60 rounded p-3 space-y-1">
                      <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Missed Runners</span>
                      <div className="text-xs font-mono font-bold text-white">
                        {bot?.participation?.missedRunnerCount || analytics?.missedRunnerCount || 0} / 3
                      </div>
                    </div>
                    <div className="bg-black/20 border border-slate-800/60 rounded p-3 space-y-1 col-span-2">
                      <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">Participation Recovery Status</span>
                      <div className="text-xs font-mono font-bold text-slate-300 truncate" title={bot?.participationRecoveryStatus || "PENDING ACTIVATION"}>
                        {bot?.participationRecoveryStatus || "PENDING ACTIVATION"}
                      </div>
                    </div>
                  </div>

                  {bot?.autoRecoveryMode === "ON" && (
                    <div className="p-3 bg-indigo-950/15 border border-indigo-900/40 rounded space-y-2 mt-2">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
                        <div>
                          <span className="text-slate-500 text-[10px] uppercase font-bold block">Recovery Reason</span>
                          <span className="text-white block mt-0.5 text-[11px]" title={bot?.recoveryReason}>{bot?.recoveryReason}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 text-[10px] uppercase font-bold block">Active Risk Controls</span>
                          <span className="text-amber-400 block mt-0.5 text-[11px]" title={bot?.recoveryRiskLimits}>{bot?.recoveryRiskLimits}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 text-[10px] uppercase font-bold block">Exit Conditions</span>
                          <span className="text-sky-400 block mt-0.5 text-[11px]" title={bot?.recoveryExitConditions}>{bot?.recoveryExitConditions}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              
              {/* Cooldown Telemetry */}
              <div className="bg-[#0C0E12] border border-slate-800 p-5 rounded-lg mt-6">
                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-1.5 border-b border-slate-800/60 pb-3 mb-4">
                  <Clock className="w-3.5 h-3.5 text-amber-400" /> Post-Trade Cooldown Engine
                </span>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-left">
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-widest">Type</span>
                    <span className={cn("text-sm font-mono font-black", (bot.cooldownType === "HARD" || bot.cooldownType === "LOSS_COOLDOWN" || bot.cooldownType === "CHOP_COOLDOWN" || bot.cooldownType === "VOLATILITY_RESET_COOLDOWN") ? "text-rose-400" : (bot.cooldownType && bot.cooldownType !== "SOFT" && bot.cooldownType !== "HARD") ? "text-teal-400 animate-pulse" : bot.cooldownType === "SOFT" ? "text-emerald-400" : "text-slate-500")}>{bot.cooldownType || "NONE"}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-widest">Remaining</span>
                    <span className="text-sm font-mono font-black text-white">
                      {bot.cooldownUntil && bot.cooldownUntil > Date.now() ? `${((bot.cooldownUntil - Date.now()) / 1000).toFixed(0)}s` : "0s"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-widest">Override Eligible</span>
                    <span className={cn("text-sm font-mono font-black", (bot.cooldownType === "SOFT" || bot.cooldownType === "WIN_COOLDOWN" || bot.cooldownType === "NARRATIVE_CONTINUATION_COOLDOWN" || bot.cooldownType === "EARLY_REENTRY_COOLDOWN") ? "text-emerald-400" : "text-slate-500")}>
                      {(bot.cooldownType === "SOFT" || bot.cooldownType === "WIN_COOLDOWN" || bot.cooldownType === "NARRATIVE_CONTINUATION_COOLDOWN" || bot.cooldownType === "EARLY_REENTRY_COOLDOWN") ? "YES (Elite Only)" : "NO"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase font-bold text-slate-500 tracking-widest">Structure Status</span>
                    <span className={cn("text-sm font-mono font-black", bot.cooldownOverrideActive ? "text-emerald-400" : "text-amber-500")}>
                      {bot.cooldownOverrideActive ? "IMPROVED" : "PENDING"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                     <span className="text-[9px] uppercase font-bold text-slate-500 tracking-widest">Last Exit Reason</span>
                     <span className="text-[10px] font-mono font-bold text-slate-300 truncate max-w-[150px]" title={bot.trades?.filter(t => t.type === "EXIT").pop()?.reason || "N/A"}>
                        {bot.trades?.filter(t => t.type === "EXIT").pop()?.reason || "N/A"}
                     </span>
                  </div>
                </div>
              </div>
            </CollapsibleSection>

            {/* AI Insights Panel */}
            <div className="bg-slate-900/50 border border-indigo-500/10 rounded-lg p-5 space-y-3">
              <div className="flex items-center gap-2">
                <BrainCircuit className="w-4 h-4 text-indigo-400" />
                <h3 className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Trade Analyst Insights</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {(analytics?.lessons || []).map((lesson: string, i: number) => (
                  <div key={i} className="flex gap-3 text-[11px] text-slate-300 font-mono italic leading-relaxed p-3 bg-white/[0.02] border-l border-indigo-500/30">
                    <span className="text-indigo-500 font-bold opacity-40">#{i+1}</span>
                    {lesson}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

            {/* Resting Orders Section */}
            {isAdvancedMode && (
              <CollapsibleSection title={`Resting Orders (${bot.activeOrders?.length || 0})`} icon={<RefreshCcw className="w-3.5 h-3.5 text-[#8A4FFF]" />} storageKey="resting_orders">
                <div className="space-y-6">
                  {/* Pending Entry Orders */}
                  <div>
                    <h4 className="text-[10px] font-black uppercase text-amber-500 tracking-[0.15em] mb-2 font-mono flex items-center justify-between">
                      <span>Pending Entry Orders</span>
                      <span className="text-slate-500 text-[9px] font-normal">
                        ({(bot.activeOrders || []).filter((o: any) => !o.reduceOnly).length} resting)
                      </span>
                    </h4>
                    <div className="overflow-x-auto -mx-4 md:-mx-5 pb-2">
                      <table className="w-full text-left text-[11px] border-collapse min-w-[500px]">
                        <thead>
                          <tr className="border-b border-slate-900 bg-black/20">
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Asset</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Side</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Size</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Limit Price</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">TIF</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif text-right">Order ID</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-900 tabular-nums font-mono">
                          {(() => {
                            const activeOrdersList = (bot.activeOrders || []).filter((o: any) => !o.reduceOnly);
                            const renderedOrders = [
                              ...activeOrdersList.map((o: any) => ({ ...o, uiStatus: 'OPEN' })),
                              ...recentlyFilled.filter((o: any) => !o.reduceOnly).map((o: any) => ({ ...o, uiStatus: 'FILLED' })),
                              ...recentlyCanceled.filter((o: any) => !o.reduceOnly).map((o: any) => ({ ...o, uiStatus: 'CANCELED' }))
                            ];
                            
                            if (renderedOrders.length > 0) {
                              return renderedOrders.map((o: any, i: number) => {
                                const isNew = newlyPlaced.includes(String(o.oid));
                                let rowClass = "hover:bg-white/[0.02] transition-colors";
                                let labelSuffix = null;
                                
                                if (isNew) {
                                  rowClass = "bg-emerald-500/10 border-l-2 border-l-emerald-500 animate-pulse text-emerald-100 hover:bg-emerald-500/15";
                                  labelSuffix = (
                                    <span className="ml-2 inline-flex items-center text-[8px] bg-emerald-500/20 text-emerald-400 font-bold px-1 py-0.5 rounded leading-none uppercase tracking-widest animate-pulse">
                                      PLACED
                                    </span>
                                  );
                                } else if (o.uiStatus === 'FILLED') {
                                  rowClass = "bg-amber-500/10 border-l-2 border-l-amber-500 text-slate-400 line-through opacity-75 hover:bg-amber-500/15";
                                  labelSuffix = (
                                    <span className="ml-2 inline-flex items-center text-[8px] bg-amber-500/25 text-amber-300 font-bold px-1 py-0.5 rounded leading-none uppercase tracking-widest animate-bounce">
                                      FILLED
                                    </span>
                                  );
                                } else if (o.uiStatus === 'CANCELED') {
                                  rowClass = "bg-rose-500/10 border-l-2 border-l-rose-500 text-slate-500 line-through opacity-50 hover:bg-rose-500/15";
                                  labelSuffix = (
                                    <span className="ml-2 inline-flex items-center text-[8px] bg-rose-500/20 text-rose-400 font-bold px-1 py-0.5 rounded leading-none uppercase tracking-widest">
                                      CANCELED
                                    </span>
                                  );
                                }
                                
                                return (
                                  <motion.tr 
                                    key={`${o.oid || ''}-${i}`} 
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    whileHover={{ backgroundColor: "rgba(255, 255, 255, 0.02)" }}
                                    className={rowClass}
                                  >
                                    <td className="px-5 py-3 text-white font-bold flex items-center">
                                      {o.coin}
                                      {labelSuffix}
                                    </td>
                                    <td className="px-5 py-3">
                                      <span className={cn("font-black tracking-tighter italic uppercase", o.side === "B" || o.side === "BUY" ? "text-[#10B981]" : "text-[#EF4444]")}>
                                         {o.side === "B" || o.side === "BUY" ? "BUY" : "SELL"}
                                      </span>
                                    </td>
                                    <td className="px-5 py-3 text-slate-400">{o.sz}</td>
                                    <td className="px-5 py-3 text-slate-200">${parseFloat(o.limitPx || o.px || '0').toFixed(2)}</td>
                                    <td className="px-5 py-3 text-slate-500">{o.tif || "GTC"}</td>
                                    <td className="px-5 py-3 text-right text-slate-600 text-[9px]">{o.oid}</td>
                                  </motion.tr>
                                );
                              });
                            }
                            
                            return (
                              <tr>
                                <td colSpan={6} className="px-5 py-8 text-center text-slate-600 italic tracking-widest text-[9px] uppercase opacity-40">No pending entry orders</td>
                              </tr>
                            );
                          })()}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Reduce-Only TP/SL Orders */}
                  <div>
                    <h4 className="text-[10px] font-black uppercase text-[#8A4FFF] tracking-[0.15em] mb-2 font-mono flex items-center justify-between">
                      <span>Reduce-Only TP/SL Orders</span>
                      <span className="text-slate-500 text-[9px] font-normal">
                        ({(bot.activeOrders || []).filter((o: any) => o.reduceOnly).length} active)
                      </span>
                    </h4>
                    <div className="overflow-x-auto -mx-4 md:-mx-5 pb-2">
                      <table className="w-full text-left text-[11px] border-collapse min-w-[500px]">
                        <thead>
                          <tr className="border-b border-slate-900 bg-black/20">
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Asset</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Side</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Size</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Trigger/Limit</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">TIF</th>
                            <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif text-right">Order ID</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-900 tabular-nums font-mono">
                          {(() => {
                            const activeOrdersList = (bot.activeOrders || []).filter((o: any) => o.reduceOnly);
                            const renderedOrders = [
                              ...activeOrdersList.map((o: any) => ({ ...o, uiStatus: 'OPEN' })),
                              ...recentlyFilled.filter((o: any) => o.reduceOnly).map((o: any) => ({ ...o, uiStatus: 'FILLED' })),
                              ...recentlyCanceled.filter((o: any) => o.reduceOnly).map((o: any) => ({ ...o, uiStatus: 'CANCELED' }))
                            ];
                            
                            if (renderedOrders.length > 0) {
                              return renderedOrders.map((o: any, i: number) => {
                                const isNew = newlyPlaced.includes(String(o.oid));
                                let rowClass = "hover:bg-white/[0.02] transition-colors";
                                let labelSuffix = null;
                                
                                if (isNew) {
                                  rowClass = "bg-emerald-500/10 border-l-2 border-l-emerald-500 animate-pulse text-emerald-100 hover:bg-emerald-500/15";
                                  labelSuffix = (
                                    <span className="ml-2 inline-flex items-center text-[8px] bg-emerald-500/20 text-emerald-400 font-bold px-1 py-0.5 rounded leading-none uppercase tracking-widest animate-pulse">
                                      PLACED
                                    </span>
                                  );
                                } else if (o.uiStatus === 'FILLED') {
                                  rowClass = "bg-amber-500/10 border-l-2 border-l-amber-500 text-slate-400 line-through opacity-75 hover:bg-amber-500/15";
                                  labelSuffix = (
                                    <span className="ml-2 inline-flex items-center text-[8px] bg-amber-500/25 text-amber-300 font-bold px-1 py-0.5 rounded leading-none uppercase tracking-widest animate-bounce">
                                      FILLED
                                    </span>
                                  );
                                } else if (o.uiStatus === 'CANCELED') {
                                  rowClass = "bg-rose-500/10 border-l-2 border-l-rose-500 text-slate-500 line-through opacity-50 hover:bg-rose-500/15";
                                  labelSuffix = (
                                    <span className="ml-2 inline-flex items-center text-[8px] bg-rose-500/20 text-rose-400 font-bold px-1 py-0.5 rounded leading-none uppercase tracking-widest">
                                      CANCELED
                                    </span>
                                  );
                                }
                                
                                const priceVal = o.triggerPx || o.limitPx || o.px || '0';
                                const isSl = o.isTrigger || o.triggerPx || parseFloat(o.triggerPx || "0") > 0;
                                
                                return (
                                  <motion.tr 
                                    key={`${o.oid || ''}-${i}`} 
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    whileHover={{ backgroundColor: "rgba(255, 255, 255, 0.02)" }}
                                    className={rowClass}
                                  >
                                    <td className="px-5 py-3 text-white font-bold flex items-center">
                                      {o.coin}
                                      <span className={cn("ml-2 text-[8px] font-bold px-1 py-0.5 rounded leading-none", isSl ? "bg-rose-500/20 text-rose-400" : "bg-emerald-500/20 text-[#10B981]")}>
                                        {isSl ? "SL" : "TP"}
                                      </span>
                                      {labelSuffix}
                                    </td>
                                    <td className="px-5 py-3">
                                      <span className={cn("font-black tracking-tighter italic uppercase", o.side === "B" || o.side === "BUY" ? "text-[#10B981]" : "text-[#EF4444]")}>
                                         {o.side === "B" || o.side === "BUY" ? "BUY" : "SELL"}
                                      </span>
                                    </td>
                                    <td className="px-5 py-3 text-slate-400">{o.sz}</td>
                                    <td className="px-5 py-3 text-slate-200">${parseFloat(priceVal).toFixed(2)}</td>
                                    <td className="px-5 py-3 text-slate-500">{o.tif || "GTC"}</td>
                                    <td className="px-5 py-3 text-right text-slate-600 text-[9px]">{o.oid}</td>
                                  </motion.tr>
                                );
                              });
                            }
                            
                            return (
                              <tr>
                                <td colSpan={6} className="px-5 py-8 text-center text-slate-600 italic tracking-widest text-[9px] uppercase opacity-40">No reduction orders active</td>
                              </tr>
                            );
                          })()}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </CollapsibleSection>
            )}

            {/* Recent Orders List */}
            {isAdvancedMode && (
              <CollapsibleSection title="Trade Journal" defaultOpen={true} storageKey="trade_journal" badge={
              <button className="text-[10px] text-slate-600 hover:text-white transition-colors flex items-center gap-1.5 uppercase font-bold tracking-tighter">
                  View Full History <ChevronRight className="w-3 h-3" />
              </button>
            }>
              <div className="overflow-x-auto -mx-4 md:-mx-5 pb-2">
                <table className="w-full text-left text-[11px] border-collapse min-w-[500px]">
                  <thead>
                    <tr className="border-b border-slate-900 bg-black/20">
                      <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Time</th>
                      <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Asset</th>
                      <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Type</th>
                      <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Size</th>
                      <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Price</th>
                      <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif">Quality</th>
                      <th className="px-5 py-3 font-bold text-slate-600 uppercase tracking-tighter italic font-serif text-right">PnL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900 tabular-nums font-mono">
                    {(bot.trades || []).length > 0 ? (
                      (bot.trades || []).slice().reverse().slice(0, 10).map((t: any, i: number) => {
                        const isNewFill = recentTrades.includes(`${t.timestamp}-${t.oid || ''}`);
                        return (
                          <motion.tr 
                            key={i} 
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            whileHover={{ backgroundColor: "rgba(255, 255, 255, 0.02)" }}
                            className={cn(
                              "transition-all duration-500 group", 
                              isNewFill 
                                ? "bg-emerald-500/10 border-l-2 border-l-emerald-500 text-slate-100 font-semibold animate-pulse hover:bg-emerald-500/15" 
                                : "text-slate-300 transition-colors"
                            )}
                          >
                            <td className="px-5 py-3 text-slate-500">
                              {new Date(t.timestamp).toLocaleTimeString([], { hour12: false })}
                            </td>
                            <td className="px-5 py-3 text-white font-bold flex items-center">
                              {t.symbol}
                              {isNewFill && (
                                <span className="ml-2 inline-flex items-center text-[7px] bg-emerald-500/25 text-emerald-400 font-black px-1.5 py-0.5 rounded leading-none uppercase tracking-widest animate-pulse border border-emerald-500/30">
                                  ● NEW FILL
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-3 font-black tracking-tighter italic">
                              <span className={cn(t.side === "LONG" || t.side === "BUY" ? "text-emerald-500" : "text-rose-500")}>
                                {t.side} {t.type}
                              </span>
                            </td>
                            <td className="px-5 py-3 text-slate-400">${t.notional?.toFixed(2)}</td>
                            <td className="px-5 py-3 text-slate-400">${t.entryPrice?.toFixed(2) || t.fillPrice?.toFixed(2)}</td>
                            <td className="px-5 py-3">
                              {t.tradeQualityScore !== undefined ? (
                                <span className={cn(
                                  "px-1.5 py-0.5 rounded font-bold text-[9px]",
                                  t.tradeQualityScore >= 85 ? "bg-emerald-500/10 text-emerald-400" :
                                  t.tradeQualityScore >= 75 ? "bg-blue-500/10 text-blue-400" : "bg-rose-500/10 text-rose-400"
                                )}>
                                  {t.tradeQualityScore}/100
                                </span>
                              ) : "—"}
                            </td>
                            <td className={cn("px-5 py-3 text-right font-bold", (t.realizedPnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                              {t.type === "EXIT" ? (t.realizedPnl >= 0 ? "+" : "") + `$${(t.realizedPnl || 0).toFixed(2)}` : "—"}
                            </td>
                          </motion.tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={7} className="px-5 py-12 text-center text-slate-600 italic tracking-widest text-xs uppercase opacity-40">No records found in active cycle</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CollapsibleSection>
            )}
          </div>
        </section>
      </main>
      )}

      {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-6 overflow-hidden">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setIsSettingsOpen(false)}
              className="absolute inset-0 bg-black/85 backdrop-blur-md"
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative w-full max-w-4xl bg-[#111317] border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh] md:max-h-[85vh] z-10"
            >
              {/* Header */}
              <div className="h-14 shrink-0 border-b border-slate-800/60 px-6 flex items-center justify-between bg-[#14171d]/85">
                <div className="flex items-center gap-3">
                  <SettingsIcon className="w-5 h-5 text-[#8A4FFF]" />
                  <div>
                    <h2 className="text-xs font-black uppercase tracking-[0.25em] text-white">Executor Tuner</h2>
                    <p className="text-[8px] font-mono uppercase tracking-widest text-[#8A4FFF]/70">L5 Compliance Guardrails Matrix</p>
                  </div>
                </div>
                <button onClick={() => setIsSettingsOpen(false)} className="p-1 hover:bg-white/[0.04] rounded-lg text-slate-500 hover:text-white transition-colors cursor-pointer">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Grid content container with internal scrolling */}
              <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-12 divide-y md:divide-y-0 md:divide-x divide-slate-800/60">
                
                {/* Left Side: Forms and Phases (7 cols) */}
                <div className="md:col-span-7 p-6 md:p-8 space-y-6 flex flex-col justify-between">
                  <div className="space-y-5">
                    <div>
                      <h4 className="text-[10px] uppercase font-black text-[#8A4FFF] tracking-widest mb-1">Critical Guardrails</h4>
                      <p className="text-[9px] text-slate-500 uppercase tracking-wider">Configure maximum position size, leverage buffer boundaries, and trigger levels.</p>
                    </div>

                    <div className="space-y-4">
                      <ConfigField 
                        label="Max Exposure (USDC)" 
                        description="Maximum nominal contract value allocated for any single position"
                        value={configForm.maxExposure}
                        onChange={(v) => {
                          const parsed = parseFloat(v);
                          setConfigForm({...configForm, maxExposure: isNaN(parsed) ? 40 : parsed});
                        }}
                        type="number"
                        step="5"
                        min="40"
                        suffix="USDC"
                        error={configForm.maxExposure < 40 ? "Nominal size must be at least 40.00 USDC" : ""}
                        isPending={lastSavedConfig?.maxExposure !== configForm.maxExposure}
                      />
                      
                      <ConfigField 
                        label="User Minimum Entry Size (USDC)" 
                        description="Absolute live execution floor. No trades will execute below this notional size."
                        value={configForm.minEntrySize || 40}
                        onChange={(v) => {
                          const parsed = parseFloat(v);
                          setConfigForm({...configForm, minEntrySize: isNaN(parsed) ? 40 : parsed});
                        }}
                        type="number"
                        step="5"
                        min="11"
                        suffix="USDC"
                        error={configForm.minEntrySize! < 11 ? "Must clear critical exchange limits of at least $11" : ""}
                        isPending={lastSavedConfig?.minEntrySize !== configForm.minEntrySize}
                      />
                      
                      <ConfigField 
                        label="Max Leverage" 
                        description="Account-wide borrowing limits. Controls liquidation proximity."
                        value={configForm.leverage}
                        onChange={(v) => {
                          const parsed = parseFloat(v);
                          setConfigForm({...configForm, leverage: isNaN(parsed) ? 1 : parsed});
                        }}
                        type="number"
                        step="0.5"
                        min="1"
                        max="100"
                        suffix="X"
                        error={configForm.leverage < 1 ? "Leverage must be at least 1.0x" : configForm.leverage > 100 ? "Leverage capped at 100x" : ""}
                        isPending={lastSavedConfig?.leverage !== configForm.leverage}
                      />

                      <div className="grid grid-cols-2 gap-4">
                        <ConfigField 
                          label="Stop Loss (%)" 
                          description="Auto-closes adverse positions"
                          value={configForm.stopLossPct}
                          onChange={(v) => {
                            const parsed = parseFloat(v);
                            setConfigForm({...configForm, stopLossPct: isNaN(parsed) ? 0.1 : parsed});
                          }}
                          type="number"
                          step="0.1"
                          min="0.01"
                          max="20"
                          suffix="%"
                          error={configForm.stopLossPct < 0.01 ? "Min SL is 0.01%" : configForm.stopLossPct > 20 ? "Ample cap at 20.0%" : ""}
                          isPending={lastSavedConfig?.stopLossPct !== configForm.stopLossPct}
                        />
                        <ConfigField 
                          label="Take Profit (%)" 
                          description="Saves gains before trend exhaust"
                          value={configForm.takeProfitPct}
                          onChange={(v) => {
                            const parsed = parseFloat(v);
                            setConfigForm({...configForm, takeProfitPct: isNaN(parsed) ? 0.1 : parsed});
                          }}
                          type="number"
                          step="0.1"
                          min="0.01"
                          max="100"
                          suffix="%"
                          error={configForm.takeProfitPct < 0.01 ? "Min TP is 0.01%" : configForm.takeProfitPct > 100 ? "Cap is 100%" : ""}
                          isPending={lastSavedConfig?.takeProfitPct !== configForm.takeProfitPct}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4 pt-5 border-t border-slate-800/50">
                    <div>
                      <p className="text-[10px] uppercase font-bold text-slate-500 tracking-widest mb-1.5">Active Execution Phase</p>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
                        {["PHASE_0_STABILIZATION", "PHASE_2_ADAPTIVE_EXECUTION", "PAPER_MODE_ACTIVE", "VALIDATION_READY"].map((p) => (
                          <button
                            key={p}
                            onClick={async () => {
                              try {
                                const res = await fetch("/api/phase", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ phase: p })
                                });
                                if (res.ok) {
                                  const data = await res.json();
                                  setStatus((s: any) => {
                                    if (!s) return s;
                                    return {
                                      ...s,
                                      bot: {
                                        ...s.bot,
                                        phase: data.phase,
                                        blocker: data.blocker
                                      }
                                    };
                                  });
                                }
                              } catch (e) {
                                console.error("Failed to switch phase", e);
                              }
                            }}
                            className={cn(
                              "py-1.5 px-1 text-[8px] font-mono rounded-md border font-bold uppercase transition-all tracking-wider cursor-pointer text-center truncate",
                              bot.phase === p
                                ? "bg-[#8A4FFF]/25 border-[#8A4FFF] text-[#8A4FFF]"
                                : "bg-black/35 border-slate-800/80 text-slate-500 hover:text-white hover:border-slate-700"
                            )}
                          >
                            {p.replace(/_/g, " ")}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                       <div className="flex items-center justify-center h-10 w-full rounded-lg bg-[#8A4FFF]/10 border border-[#8A4FFF]/20 text-[#8A4FFF] font-black uppercase text-[10px] tracking-[0.15em] relative overflow-hidden">
                         <AnimatePresence mode="wait">
                           {isSaving ? (
                             <motion.span 
                               key="saving"
                               initial={{ opacity: 0, y: 10 }}
                               animate={{ opacity: 1, y: 0 }}
                               exit={{ opacity: 0, y: -10 }}
                               transition={{ duration: 0.15 }}
                               className="flex items-center gap-2"
                             >
                               <RefreshCcw className="w-3.5 h-3.5 animate-spin" />
                               Synchronizing Parameters...
                             </motion.span>
                           ) : (
                             <motion.span 
                               key="saved"
                               initial={{ opacity: 0, y: 10 }}
                               animate={{ opacity: 1, y: 0 }}
                               exit={{ opacity: 0, y: -10 }}
                               transition={{ duration: 0.15 }}
                               className="flex items-center gap-2 text-emerald-400"
                             >
                               <CheckCircle2 className="w-3.5 h-3.5" />
                               All Saved Locally & Live
                             </motion.span>
                           )}
                         </AnimatePresence>
                       </div>
                    </div>
                  </div>
                </div>

                {/* Right Side: Visual Risk Simulator and Projections (5 cols) */}
                <div className="md:col-span-5 bg-black/25 p-6 md:p-8 flex flex-col justify-between space-y-6">
                  <div className="space-y-5">
                    <div>
                      <h4 className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-1 flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-[#8A4FFF]" />
                        Risk Metrics Simulator
                      </h4>
                      <p className="text-[9px] text-slate-500 uppercase tracking-widest">Calculated simulations based on tuned values</p>
                    </div>

                    {/* Projections Matrix */}
                    <div className="space-y-4">
                      {/* Section: ABSOLUTE SIZES */}
                      <div className="p-3 bg-black/40 border border-slate-800/80 rounded-xl space-y-3">
                        <span className="text-[8px] font-black uppercase tracking-widest text-[#8A4FFF]/80">Maximum Drawdown Impact</span>
                        <div className="flex justify-between items-baseline">
                          <span className="text-slate-500 text-[10px] font-bold uppercase tracking-wide">Stop-Loss Drawdown:</span>
                          <span className="text-rose-400 h-6 font-mono text-sm font-extrabold tracking-tighter block">
                            -${calculatedRisk.maxLossUsd.toFixed(2)} USDC
                          </span>
                        </div>
                        {/* High contrast gauge bar */}
                        <div className="space-y-1">
                          <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden flex">
                            <motion.div 
                              className={cn(
                                "h-full rounded-full",
                                calculatedRisk.lossPctOfEquity > 5.0 ? "bg-rose-500" :
                                calculatedRisk.lossPctOfEquity > 1.5 ? "bg-amber-500" : "bg-emerald-500"
                              )}
                              initial={{ width: 0 }}
                              animate={{ width: `${Math.min(100, Math.max(2, calculatedRisk.lossPctOfEquity * 10))}%` }}
                              transition={{ duration: 0.3 }}
                            />
                          </div>
                          <div className="flex justify-between items-center text-[7.5px] font-mono text-slate-600">
                            <span>Balance Risk: {calculatedRisk.lossPctOfEquity.toFixed(2)}%</span>
                            <span className={cn("font-bold uppercase tracking-wider", calculatedRisk.equityRiskClass)}>
                              {calculatedRisk.equityRiskLabel}
                            </span>
                          </div>
                        </div>
                        <p className="text-[8.5px] text-slate-500 italic leading-snug">{calculatedRisk.equityRiskDesc}</p>
                      </div>

                      {/* Section: TARGET profit */}
                      <div className="p-3 bg-black/40 border border-slate-800/80 rounded-xl space-y-2">
                        <span className="text-[8px] font-black uppercase tracking-widest text-emerald-400">Projected Upside Advantage</span>
                        <div className="flex justify-between items-baseline">
                          <span className="text-slate-500 text-[10px] font-bold uppercase tracking-wide">Take-Profit Gains:</span>
                          <span className="text-emerald-400 font-mono text-sm font-extrabold tracking-tighter">
                            +${calculatedRisk.maxProfitUsd.toFixed(2)} USDC
                          </span>
                        </div>
                        <div className="flex justify-between items-center text-[8px] font-mono text-slate-600">
                          <span>Portfolio Upside: +{calculatedRisk.profitPctOfEquity.toFixed(2)}%</span>
                          <span className="text-[#8A4FFF] bg-[#8A4FFF]/5 border border-[#8A4FFF]/10 px-1 rounded uppercase font-bold tracking-tight text-[7.5px]">
                            {calculatedRisk.maxProfitUsd > calculatedRisk.maxLossUsd ? "Asymmetric Edge" : "Symmetric Risk"}
                          </span>
                        </div>
                      </div>

                      {/* Section: REWARD-TO-RISK ASYMMETRY */}
                      <div className="p-3 bg-black/40 border border-slate-800/80 rounded-xl space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-[8px] font-black uppercase tracking-widest text-[#8A4FFF]">Profit To Risk Ratio</span>
                          <span className={cn("px-1.5 py-0.5 rounded text-[8px] border font-bold uppercase tracking-wider", calculatedRisk.rrBadgeColor)}>
                            {calculatedRisk.rrLabel}
                          </span>
                        </div>
                        <div className="flex justify-between items-baseline">
                          <span className="text-slate-500 text-[10px] font-bold uppercase tracking-wide">Reward/Risk Multiplier:</span>
                          <span className={cn("font-mono text-base font-black tracking-tight", calculatedRisk.rrClass)}>
                            {calculatedRisk.rrRatio.toFixed(2)} : 1
                          </span>
                        </div>
                        <p className="text-[8.5px] text-slate-500 leading-snug">{calculatedRisk.rrDesc}</p>
                      </div>

                      {/* Section: LEVERAGE BUFFER */}
                      <div className="p-3 bg-black/40 border border-slate-800/80 rounded-xl space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">Leverage Insulation</span>
                          <span className={cn("px-1.5 py-0.5 rounded text-[8px] border font-bold uppercase tracking-wide", calculatedRisk.levBadgeColor)}>
                            {calculatedRisk.levLabel}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mt-1">
                          <div className="space-y-0.5">
                            <span className="text-[7.5px] font-mono text-slate-600 block uppercase">Required Margin:</span>
                            <span className="text-xs font-mono font-bold text-white">${calculatedRisk.reqMargin.toFixed(2)} USDC</span>
                          </div>
                          <div className="space-y-0.5 text-right">
                            <span className="text-[7.5px] font-mono text-slate-600 block uppercase">Liquidation Buffer:</span>
                            <span className="text-xs font-mono font-bold text-orange-400">~{calculatedRisk.liqDistance.toFixed(1)}% Move</span>
                          </div>
                        </div>
                        <p className="text-[8.5px] text-slate-500 leading-snug mt-1">{calculatedRisk.levDesc}</p>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 bg-[#15171e] rounded-xl border border-slate-800/60 text-[8.5px] text-slate-400 font-mono flex items-center gap-2 italic leading-relaxed select-none">
                    <ShieldAlert className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    Executing perp/futures contracts carries leverage-liquidation risks. These guardrails seek to limit risk but do not nullify extreme volatility event slippage.
                  </div>
                </div>

              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {false && <ScannerPanel opportunities={bot.scannerOpportunities || []} activeSymbol={bot.activeSymbol} scansSinceLastEntry={bot.scansSinceLastEntry || 0} isAdvancedMode={isAdvancedMode} />}

      <footer className="h-8 shrink-0 border-t border-slate-800 bg-[#0F1115] px-6 items-center justify-between text-[8px] font-mono flex pointer-events-none opacity-50">
        <div className="flex items-center space-x-4">
          <span className="text-slate-500 uppercase">System:</span>
          <span className="text-slate-400 uppercase">L5_AUTONOMOUS_TRADING_CORE</span>
        </div>
        <div className="flex items-center space-x-4">
           <span>LATENCY: <span className="text-emerald-500 font-bold">14MS</span></span>
           <span>SYNC: <span className="text-emerald-500 font-bold">STABLE</span></span>
        </div>
      </footer>

      {/* Mobile Sticky Emergency Controls */}
      <div className="xl:hidden fixed bottom-0 left-0 right-0 bg-[#0F1115] border-t border-slate-800 px-2 py-2 pb-6 z-50 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <select 
            value={bot.phase}
            onChange={async (e) => {
              const p = e.target.value;
              try {
                const res = await fetch("/api/config", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ phase: p })
                });
                if (res.ok) {
                  const data = await res.json();
                  setStatus((s: any) => {
                    if (!s) return s;
                    return {
                      ...s,
                      bot: { ...s.bot, phase: data.phase, blocker: data.blocker }
                    };
                  });
                }
              } catch (e) {
                console.error("Failed to switch phase", e);
              }
            }}
            className="flex-[2] bg-black/40 border border-slate-800 text-slate-300 font-bold text-[10px] uppercase tracking-wider rounded py-2 px-1 focus:outline-none appearance-none text-center"
          >
            {["PHASE_0_STABILIZATION", "PHASE_2_ADAPTIVE_EXECUTION", "PAPER_MODE_ACTIVE", "VALIDATION_READY"].map(p => (
              <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
            ))}
          </select>
          <button 
            onClick={async () => {
              try {
                await fetch("/api/config", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ phase: "PAPER_MODE_ACTIVE" })
                });
                setStatus((s: any) => ({ ...s, bot: { ...s.bot, phase: "PAPER_MODE_ACTIVE" }}));
              } catch (e) {
                console.error(e);
              }
            }}
            className="flex-1 bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/40 font-bold uppercase text-[10px] tracking-wider rounded py-2 transition-colors flex items-center justify-center gap-1"
          >
            Pause
          </button>
        </div>
        <div className="flex gap-2">
          <button 
            disabled={!bot.apiConnected}
            onClick={async () => {
              try {
                const res = await fetch("/api/emergency-close", { method: "POST" });
                const data = await res.json();
                if (res.ok) alert(data.message || "Emergency close executed.");
                else alert(`Emergency Close Failed: ${data.message || data.error}`);
              } catch (e) {
                alert("API error during emergency close.");
              }
            }}
            className="disabled:opacity-50 disabled:cursor-not-allowed flex-1 bg-rose-600 hover:bg-rose-500 text-white font-black uppercase text-[10px] tracking-wider rounded py-2 transition-colors flex items-center justify-center gap-1"
          >
            <ShieldAlert className="w-3 h-3" /> Exit
          </button>
          <button 
            onClick={async () => {
              try {
                const res = await fetch("/api/reset", { method: "POST" });
                const data = await res.json();
                if (res.ok) {
                  setStatus((s: any) => ({
                    ...s,
                    bot: {
                      ...s.bot,
                      phase: data.phase,
                      blocker: data.blocker,
                      cooldownUntil: 0,
                      reverseLockUntil: 0,
                      drawdownPauseUntil: 0,
                      dailyTradeCount: 0,
                      validationStatus: "SUCCESS",
                      openPositions: 0,
                      positionDetails: null
                    }
                  }));
                } else alert(`Reset Failed: ${data.message || data.error}`);
              } catch (e) {
                console.error(e);
                alert("API error during reset");
              }
            }}
            className="flex-1 bg-orange-500 hover:bg-orange-400 text-black font-black uppercase text-[10px] tracking-wider rounded py-2 transition-colors flex items-center justify-center gap-1"
          >
            <RefreshCcw className="w-3 h-3" /> Reset
          </button>
        </div>
      </div>
    </div>
  );
}

const getCleanSystemStatus = (blocker: string | null, activePhase: string | null, isCritical: boolean) => {
  if (isCritical) {
    if (blocker === "VALIDATION_NOT_SUCCESS" || blocker === "API_NOT_VERIFIED") {
      return { label: "Awaiting Confirmation", color: "text-amber-400 bg-amber-400/10 border-amber-400/20" };
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
      return { label: "Risk Reduced", color: "text-amber-400 bg-amber-400/10 border-amber-400/20" };
    }
    if (blocker === "PROTECTING_OPEN_POSITION" || blocker === "ENTRY_BLOCKED_POSITION_MANAGEMENT_ACTIVE") {
      return { label: "Protection Active", color: "text-indigo-400 bg-indigo-500/10 border-indigo-505/20" };
    }
  }

  if (activePhase === "PHASE_2_ADAPTIVE_EXECUTION" && !blocker) {
    return { label: "Trading Active", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" };
  }

  return { label: "Monitoring Market", color: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20" };
};

function StatCard({ label, value, status = "neutral" }: { label: string; value: string | number; status?: "neutral" | "success" | "error" }) {
  const colors = {
    neutral: "text-slate-200",
    success: "text-emerald-400",
    error: "text-rose-400"
  };
  return (
    <motion.div 
      whileHover={{ scale: 1.02, borderColor: "rgba(138, 79, 255, 0.4)", y: -1 }}
      transition={{ type: "spring", stiffness: 400, damping: 15 }}
      className="bg-[#0C0E12] border border-slate-800 p-4 rounded-lg space-y-1 cursor-default relative overflow-hidden"
    >
      <p className="text-[9px] uppercase font-bold text-slate-600 tracking-widest">{label}</p>
      <motion.p 
        key={value}
        initial={{ opacity: 0.6, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        className={cn("text-xl font-black tracking-tighter tabular-nums", colors[status])}
      >
        {value}
      </motion.p>
    </motion.div>
  );
}

function HealthIndicator({ label, status }: { label: string; status: "Healthy" | "Warning" | "Critical" }) {
  const styles = {
    Healthy: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    Warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    Critical: "bg-rose-500/10 text-rose-400 border-rose-500/20 animate-pulse"
  };
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#0A0B0D]/50 border border-slate-800/80">
      <span className="text-[10px] font-mono text-slate-500 font-bold uppercase tracking-wider">{label}:</span>
      <span className={cn("text-[10px] uppercase font-black px-1.5 py-0.5 rounded border text-[9px] font-mono", styles[status])}>
        {status}
      </span>
    </div>
  );
}

function SnapshotMetric({ label, value, color = "slate" }: { label: string; value: string | number; color?: "slate" | "emerald" | "rose" }) {
  const colors = {
    slate: "text-slate-300",
    emerald: "text-emerald-400",
    rose: "text-rose-400"
  };
  return (
    <div className="bg-[#0A0B0D] border border-slate-800 p-2.5 rounded-lg flex flex-col items-center justify-center text-center">
      <span className="text-[8px] uppercase tracking-wider text-slate-500 font-extrabold mb-1 font-mono">{label}</span>
      <span className={cn("text-xs font-mono font-black", colors[color])}>{value}</span>
    </div>
  );
}

function StatusIndicator({ active, label, detail }: { active: boolean; label: string; detail?: string }) {
  return (
    <span className={cn("text-[9px] flex items-center font-black tracking-widest shrink-0", active ? 'text-emerald-400' : 'text-rose-500')}>
      <span className={cn("w-1.5 h-1.5 rounded-full mr-2 shadow-[0_0_8px_currentColor]", active ? 'bg-emerald-400' : 'bg-rose-500 animate-pulse')}></span> 
      {label}
      {detail && <span className="ml-1 opacity-50 font-mono tracking-normal">{detail}</span>}
    </span>
  );
}

function BalanceDisplay({ label, value, color = "slate", isString = false }: { label: string; value: number | string; color?: "slate" | "emerald" | "rose"; isString?: boolean }) {
  const colorMap = {
    slate: "text-slate-400",
    emerald: "text-[#10B981]",
    rose: "text-[#EF4444]",
  };

  return (
    <div className="flex flex-col">
      <span className="text-[8px] font-bold text-slate-600 tracking-[0.2em] mb-0.5">{label}</span>
      <motion.span 
        key={String(value)}
        initial={{ opacity: 0.7 }}
        animate={{ opacity: 1 }}
        className={cn("text-xs font-mono font-black tabular-nums tracking-tighter", colorMap[color])}
      >
        {isString ? value : `$${typeof value === 'number' ? value.toFixed(2) : value}`}
      </motion.span>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <motion.div 
      whileHover={{ y: -1, borderColor: "rgba(138, 79, 255, 0.2)" }}
      className="bg-black/40 p-2.5 rounded border border-slate-800/50 cursor-default"
    >
      <p className="text-[8px] uppercase text-slate-600 font-bold mb-0.5 tracking-widest">{label}</p>
      <motion.p 
        key={value}
        initial={{ opacity: 0.6 }}
        animate={{ opacity: 1 }}
        className="text-[11px] font-mono text-white font-bold"
      >
        {value}
      </motion.p>
    </motion.div>
  );
}

function RegistryItem({ label, value, status }: { label: string; value: string; status?: "success" | "neutral" }) {
  return (
    <motion.div 
      whileHover={{ scale: 1.01, x: 2, borderColor: "rgba(138, 79, 255, 0.2)" }}
      className="flex justify-between items-center bg-slate-900/30 p-2.5 rounded group hover:bg-slate-900/50 transition-colors border border-slate-800/30 cursor-default"
    >
      <span className="text-[9px] uppercase font-bold text-slate-500 tracking-tighter group-hover:text-slate-400">{label}</span>
      <motion.span 
        key={value}
        initial={{ opacity: 0.6 }}
        animate={{ opacity: 1 }}
        className={cn("text-[10px] font-mono font-bold uppercase truncate max-w-[140px] text-right", 
          status === "success" ? "text-[#8A4FFF]" : "text-slate-300"
        )}
      >
        {value}
      </motion.span>
    </motion.div>
  );
}

function DiagnosticRow({ label, value, status }: { label: string; value: any; status?: "neutral" | "warning" | "error" | "success" }) {
  const statusColors = {
    neutral: "text-slate-400",
    warning: "text-orange-400",
    error: "text-rose-400",
    success: "text-emerald-400"
  };
  return (
    <motion.div 
      whileHover={{ scale: 1.01, x: 2 }}
      className="flex justify-between items-center py-2 border-b border-white/[0.03] cursor-default"
    >
      <span className="text-[9px] uppercase font-bold text-slate-600 tracking-widest">{label}</span>
      <motion.span 
        key={value?.toString()}
        initial={{ opacity: 0.6 }}
        animate={{ opacity: 1 }}
        title={value?.toString() || "N/A"} 
        className={cn("text-[10px] font-mono font-bold tracking-tight truncate max-w-[180px]", status ? statusColors[status] : "text-slate-300")}
      >
        {value?.toString() || "N/A"}
      </motion.span>
    </motion.div>
  );
}

function ConfigField({ label, value, onChange, type = "text", description, isPending, error, suffix, ...props }: any) {
  return (
    <div className="space-y-1.5 flex-1 relative">
      <label className="text-[9px] font-black uppercase tracking-[0.15em] flex items-center justify-between transition-colors">
        <span className={cn(error ? "text-rose-500" : isPending ? "text-amber-500" : "text-slate-500")}>
          {label}
        </span>
        <div className="flex items-center gap-2">
          {error && (
            <motion.span 
              initial={{ opacity: 0, x: -5 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-[8px] text-rose-500 tracking-wider font-extrabold uppercase bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20"
            >
              Exceeded Guard-rail
            </motion.span>
          )}
          {isPending && !error && (
            <motion.span 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-1 text-[8px] text-amber-500 tracking-widest font-normal uppercase animate-pulse"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
              Unsaved
            </motion.span>
          )}
          {props.step && <span className="opacity-40 italic tracking-normal text-[8px] flex items-center gap-1 font-normal text-slate-500"><RefreshCcw className="w-2 h-2" />STEP {props.step}</span>}
        </div>
      </label>
      <div className="relative flex items-center">
        <input 
          type={type} 
          value={Number.isNaN(value) ? "" : value} 
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full h-10 bg-black/40 border rounded-lg px-4 text-sm font-mono text-white focus:outline-none transition-all pr-12",
            error 
              ? "border-rose-500/50 shadow-[0_0_15px_rgba(239,68,68,0.15)] focus:border-rose-500" 
              : isPending 
                ? "border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.15)] focus:border-amber-500" 
                : "border-slate-800 focus:border-[#8A4FFF]"
          )}
          {...props}
        />
        {suffix && (
          <span className="absolute right-4 font-mono text-[10px] uppercase font-bold text-slate-500 pointer-events-none select-none">
            {suffix}
          </span>
        )}
      </div>
      {error ? (
        <p className="text-[9px] text-rose-400 font-bold leading-tight">{error}</p>
      ) : description ? (
        <p className="text-[9px] text-slate-600 italic leading-tight">{description}</p>
      ) : null}
    </div>
  );
}

function ChartContainer({ title, icon, data, color, baseline, domain }: any) {
  return (
    <div className="bg-[#0C0E12] border border-slate-800 rounded-lg flex flex-col group overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-2 bg-black/20">
        <div className="text-slate-500 p-1.5 rounded bg-slate-900 group-hover:text-white transition-colors">
          {icon}
        </div>
        <h3 className="text-[10px] uppercase font-black text-slate-500 tracking-[0.2em]">{title}</h3>
      </div>
      <div className="flex-1 p-4 -ml-4">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${title.replace(/ /g,'')}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3}/>
                <stop offset="95%" stopColor={color} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
            <XAxis dataKey="timestamp" hide />
            <YAxis hide domain={domain || ['auto', 'auto']} />
            <Tooltip 
              contentStyle={{ backgroundColor: '#121418', border: '1px solid #1e293b', borderRadius: '8px', padding: '10px' }}
              labelStyle={{ display: 'none' }}
              itemStyle={{ color: '#fff', fontSize: '12px', fontFamily: 'monospace' }}
              formatter={(value: any) => [`$${parseFloat(value).toFixed(2)}`, "VALUE"]}
            />
            {baseline !== undefined && <ReferenceLine y={baseline} stroke="#ffffff20" strokeWidth={1} />}
            <Area 
              type="monotone" 
              dataKey="value" 
              stroke={color} 
              strokeWidth={2}
              fillOpacity={1} 
              fill={`url(#grad-${title.replace(/ /g,'')})`} 
              animationDuration={500}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
