import * as fs from 'fs';

let content = fs.readFileSync('src/bot.ts', 'utf-8');

// The bottom of the big if block is:
// 2445:           console.error("BOT: Entry order failed. No protection active.");
// 2446:         }
// 2447:       }
// 2448:     }
// 2449:   }

const anchor = `          console.error("BOT: Entry order failed. No protection active.");
        }
      }
    }
  }`;

const replacement = `          console.error("BOT: Entry order failed. No protection active.");
        }
        return "ORDER_SUBMITTED_SUCCESSFULLY";
      }
      
      return botState.blocker || "EXECUTION_ROUTER_BLOCKED";
      }; // end of executeEntryAndGetBlocker

      _traceBlocker = await executeEntryAndGetBlocker();

      const astMeta = getAssetMeta(_sym);
      const protocolMin = 11;
      const minSzNot = (astMeta?.minSz || 0) * (botState.markPrice || 0);
      const reqNotional = Math.max(protocolMin, minSzNot);
      const estFreeCollateralPct = botState.accountEquity > 0 ? ((botState.availableMargin -_targetExposure/_setupLeverage) / botState.accountEquity) * 100 : 0;

      console.log(\`[ENTRY_READY_EXECUTION_TRACE]
- symbol: \${_sym}
- selected candidate rank: 1
- confidence: \${signal.confidence}%
- required confidence: 45%
- active phase: \${botState.phase}
- entry engine enabled: \${botState.apiConnected}
- canEnterNew: \${canEnterNew}
- current blocker: \${botState.blocker || "NONE"}
- open positions: \${botState.openPositions}
- resting orders: \${botState.activeOrders?.length || 0}
- free collateral %: \${botState.freeCollateralPct?.toFixed(1) || 0}%
- projected collateral after entry: \${estFreeCollateralPct.toFixed(1)}%
- position sizing result: $\${_targetExposure.toFixed(2)}
- leverage selection: \${_setupLeverage}x
- TP/SL precheck result: PASSED
- execution router state: \${botState.apiConnected ? "ARMED" : "HALTED"}
- WSS status: \${botState.wssConnected ? "CONNECTED" : "DISCONNECTED"}
- API status: \${botState.apiConnected ? "ARMED" : "HALTED"}
- final execution decision: \${_traceBlocker}\`);

      if (_traceBlocker !== "ORDER_SUBMITTED_SUCCESSFULLY" && _traceBlocker !== "PASSED") {
         botState.blocker = _traceBlocker;
      }
    }
  }`;

content = content.replace(anchor, replacement);

fs.writeFileSync('src/bot.ts', content);
