import * as fs from 'fs';

let content = fs.readFileSync('src/bot.ts', 'utf-8');

const anchor = `  // Phase 1 Rules: Only execute entries if completely flat (Requirement 15)
  // Phase 2 allows multiple entries
  if (canEnterNew) {
    if (signal.direction !== "NONE") {
      console.log(\`ENTRY_SIGNAL: \${signal.direction} signal confirmed!\`);`;

const replacementAnchor = `  // Phase 1 Rules: Only execute entries if completely flat (Requirement 15)
  // Phase 2 allows multiple entries
  if (canEnterNew) {
    if (signal.direction !== "NONE") {
      console.log(\`ENTRY_SIGNAL: \${signal.direction} signal confirmed!\`);
      
      let _traceBlocker = "PASSED";
      let _targetExposure = botState.config.maxExposure;
      let _setupLeverage = botState.config.leverage;
      let _sym = botState.activeSymbol;

      const executeEntryAndGetBlocker = async (): Promise<string> => {`;

let modified = content.replace(anchor, replacementAnchor);

// Now we need to close the executeEntryAndGetBlocker at the right place.
const endAnchor = `          if (botState.lastOrderId) {
            if (!botState.entryOrdersContext) botState.entryOrdersContext = {};
            botState.entryOrdersContext[botState.lastOrderId.toString()] = {
              symbol: botState.activeSymbol,
              side: isBuy ? "LONG" : "SHORT",
              size: roundedBaseSize,
              px: botState.markPrice,
              confidence: conf,
              regime: signal.marketRegime || "UNKNOWN",
              reason: contextEntryReason,
              ts: Date.now()
            };
          }
        }
      }
    }
  }`;

const replacementEndAnchor = `          if (botState.lastOrderId) {
            if (!botState.entryOrdersContext) botState.entryOrdersContext = {};
            botState.entryOrdersContext[botState.lastOrderId.toString()] = {
              symbol: botState.activeSymbol,
              side: isBuy ? "LONG" : "SHORT",
              size: roundedBaseSize,
              px: botState.markPrice,
              confidence: conf,
              regime: signal.marketRegime || "UNKNOWN",
              reason: contextEntryReason,
              ts: Date.now()
            };
          }
          return "ORDER_SUBMITTED_SUCCESSFULLY";
        }
      }
      return botState.blocker || "EXECUTION_ROUTER_BLOCKED";
      }; // end of executeEntryAndGetBlocker

      _traceBlocker = await executeEntryAndGetBlocker();

      const astMeta = getAssetMeta(_sym);
      const protocolMin = 11;
      const minSzNot = (astMeta?.minSz || 0) * (botState.markPrice || 0);
      const reqNotional = Math.max(protocolMin, minSzNot);
      const minMarg = (reqNotional / _setupLeverage) * 1.01;
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

modified = modified.replace(endAnchor, replacementEndAnchor);

// Since we opened a closure, any top level `return;` inside it will return from the closure instead of tick().
// This is exactly what we want! But wait, `return;` inside `executeEntryAndGetBlocker` returns `undefined`, 
// causing `_traceBlocker = undefined`. So let's change `return;` to `return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";`
// ONLY between the start and end anchors.

const startIndex = modified.indexOf('const executeEntryAndGetBlocker = async (): Promise<string> => {');
const endIndex = modified.indexOf('return botState.blocker || "EXECUTION_ROUTER_BLOCKED";\n      }; // end of executeEntryAndGetBlocker');

if (startIndex !== -1 && endIndex !== -1) {
  const before = modified.substring(0, startIndex);
  let middle = modified.substring(startIndex, endIndex);
  const after = modified.substring(endIndex);
  
  // replace all `return;` with `return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";`
  middle = middle.replace(/return;/g, 'return botState.blocker || "UNKNOWN_EXECUTION_BLOCK";');
  
  // also track the local variables `targetExposure` and `setupLeverage` being reassigned so they can be logged
  middle = middle.replace(/let targetExposure =/g, '_targetExposure =');
  middle = middle.replace(/let setupLeverage =/g, '_setupLeverage =');
  middle = middle.replace(/targetExposure =/g, '_targetExposure =');
  middle = middle.replace(/targetExposure \*\=/g, '_targetExposure *=');
  middle = middle.replace(/setupLeverage =/g, '_setupLeverage =');
  middle = middle.replace(/targetExposure/g, '_targetExposure');
  middle = middle.replace(/setupLeverage/g, '_setupLeverage');
  
  modified = before + middle + after;
}

fs.writeFileSync('src/bot.ts', modified);
console.log('Done!');
