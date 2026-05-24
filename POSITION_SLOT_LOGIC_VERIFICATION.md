# Position Slot Logic Implementation - Test & Verification Guide

## Overview
This PR implements the max position slot logic that allows the bot to support **at least 3 concurrent trades** when market conditions are healthy, while reducing to 1 position when hard safety conditions are triggered.

## Files Modified

### 1. `src/types.ts`
**Changes:**
- Added `SlotReductionReason` type enum with hard safety conditions
- Extended `BotState` interface with new slot fields:
  - `configuredMaxPositions: number` (default: 3)
  - `effectiveMaxPositions: number` (calculated based on health)
  - `usedPositions: number` (current open position count)
  - `availableSlots: number` (calculated)
  - `slotReductionReason: SlotReductionReason` 
  - `slotReductionIsHardSafety: boolean`

### 2. `src/services/positionSlotCalculator.ts` (NEW FILE)
**Key Functions:**
- `detectHardSafetyConditions()` - Checks for hard safety triggers
- `calculatePositionSlots()` - Main slot calculation logic
- `canOpenNewEntry()` - Guards for entry orders
- `getSlotStateSummary()` - Dashboard summary
- `logSlotState()` - Debug logging

**Hard Safety Conditions (reduce to 1 slot):**
- `PROTECTION_UNHEALTHY` - Protection sync not healthy
- `MISSING_SL` - Active position missing SL
- `DUPLICATE_PROTECTION` - Duplicate TP/SL detected
- `UNSAFE_COLLATERAL` - Free collateral < 5%
- `WSS_API_FAILURE` - WSS or API disconnected
- `SEVERE_DRAWDOWN` - Drawdown severity = "HARD"
- `CORRUPTED_POSITION` - Open position but no positionDetails
- `CATASTROPHIC_SPREAD` - Spread quality < 0.1
- `EXCHANGE_REJECTION` - Recent API rejection

**Soft Warnings (do NOT reduce slots):**
- Low confidence
- Fee pressure
- No-trade period warning
- Mild volatility warning
- Cooldown pressure
- Soft drawdown warning
- Monitoring state
- CMC uncertainty
- Weak narrative confirmation

### 3. `src/state.ts`
**Changes:**
- Initialize all new slot fields with healthy defaults:
  ```
  configuredMaxPositions: 3
  effectiveMaxPositions: 3
  usedPositions: 0
  availableSlots: 3
  slotReductionReason: "NONE"
  slotReductionIsHardSafety: false
  ```

### 4. `src/hyperliquidExecutionEngine.ts`
**Changes:**
- Import `calculatePositionSlots` and `canOpenNewEntry`
- **Entry Orders** (`reduceOnly=false`):
  - Check `canOpenNewEntry()` before placing
  - Block if no slots available or hard safety active
  - Recalculate slots after successful order
- **Reduce-Only Orders** (`reduceOnly=true`):
  - Bypass slot restrictions completely
  - Log: `[REDUCE_ONLY_ORDER_BYPASS_SLOTS]`
  - Allow TP/SL/emergency closes regardless of slot state

### 5. `src/dashboardServer.ts`
**Changes:**
- Add `/api/position-slots` GET endpoint
- Returns detailed slot state:
  ```json
  {
    "configuredMaxPositions": 3,
    "effectiveMaxPositions": 3,
    "usedPositions": 1,
    "availableSlots": 2,
    "slotReductionReason": "NONE",
    "slotReductionIsHardSafety": false,
    "wssHealthy": true,
    "apiHealthy": true,
    "marginHealthy": true,
    "protectionHealthy": true,
    "canOpenNewEntry": true
  }
  ```
- Recalculate slots in `/api/status` and `/api/reset` endpoints
- Recalculate after emergency close

## Verification Checklist

### ✅ Test 1: Healthy State - Should Allow 3 Slots
**Setup:** Fresh bot start, no open positions
```
Expected State:
  configuredMaxPositions: 3
  effectiveMaxPositions: 3
  usedPositions: 0
  availableSlots: 3
  slotReductionReason: "NONE"
  slotReductionIsHardSafety: false
```
**Verification:** Call `/api/position-slots` and confirm values

### ✅ Test 2: With 1 Open Position - Should Show 2 Available
**Setup:** 1 position open, all health checks pass
```
Expected State:
  configuredMaxPositions: 3
  effectiveMaxPositions: 3
  usedPositions: 1
  availableSlots: 2
  canOpenNewEntry: true
```
**Verification:** Can place new entry order

### ✅ Test 3: Protection Unhealthy - Should Reduce to 1 Slot
**Setup:** `botState.telemetry.protectionSyncHealth = "UNHEALTHY"`
```
Expected State:
  effectiveMaxPositions: 1
  slotReductionReason: "PROTECTION_UNHEALTHY"
  slotReductionIsHardSafety: true
```
**Verification:** Console logs `[EFFECTIVE_MAX_POSITIONS_REDUCED]`

### ✅ Test 4: Missing SL on Active Position - Should Reduce to 1 Slot
**Setup:** `botState.openPositions = 1; botState.protection.slPrice = null`
```
Expected State:
  effectiveMaxPositions: 1
  slotReductionReason: "MISSING_SL"
  slotReductionIsHardSafety: true
```
**Verification:** Cannot open new entry despite having slots

### ✅ Test 5: Soft Drawdown - Should NOT Reduce Slots
**Setup:** `botState.drawdownSeverity = "SOFT_LEVEL_1"`
```
Expected State:
  effectiveMaxPositions: 3  // NOT reduced
  availableSlots: 2
  slotReductionReason: "NONE"
```
**Verification:** Slots remain at 3, soft warning only reduces score/size

### ✅ Test 6: Low Confidence Setup - Should NOT Block Entry
**Setup:** Opportunity with low confidence score
```
Expected Behavior:
  - availableSlots: 2 (unchanged)
  - Entry NOT blocked by slot logic
  - Size reduced by other risk managers
  - Score penalized by confidence module
```
**Verification:** Can still execute entry (other modules control size)

### ✅ Test 7: Reduce-Only Orders Bypass Slots
**Setup:** 3 positions open (full), attempt to place TP/SL
```
Expected Behavior:
  - availableSlots: 0
  - TP/SL order ALLOWED (reduce-only bypasses)
  - Console logs: `[REDUCE_ONLY_ORDER_BYPASS_SLOTS]`
```
**Verification:** TP/SL places successfully despite no slots

### ✅ Test 8: Emergency Close Bypasses Slots
**Setup:** 3 positions open, call `/api/emergency-close`
```
Expected Behavior:
  - Reduce-only close order placed
  - Slot check skipped
  - Position closed successfully
```
**Verification:** Position closes via emergency endpoint

### ✅ Test 9: Unsafe Collateral (< 5%) - Should Reduce to 1 Slot
**Setup:** `botState.freeCollateralPct = 3`
```
Expected State:
  effectiveMaxPositions: 1
  slotReductionReason: "UNSAFE_COLLATERAL"
  slotReductionIsHardSafety: true
```
**Verification:** Entry orders blocked

### ✅ Test 10: WSS Disconnected - Should Reduce to 1 Slot
**Setup:** `botState.wssConnected = false`
```
Expected State:
  effectiveMaxPositions: 1
  slotReductionReason: "WSS_API_FAILURE"
  slotReductionIsHardSafety: true
```
**Verification:** Entry orders blocked, dashboard shows issue

### ✅ Test 11: Severe Drawdown (HARD) - Should Reduce to 1 Slot
**Setup:** `botState.drawdownSeverity = "HARD"`
```
Expected State:
  effectiveMaxPositions: 1
  slotReductionReason: "SEVERE_DRAWDOWN"
  slotReductionIsHardSafety: true
```
**Verification:** Entry blocked until drawdown clears

### ✅ Test 12: Fee Pressure Warning - Should NOT Reduce Slots
**Setup:** `botState.feeEfficiency.isPaused = true (SOFT)`
```
Expected Behavior:
  - effectiveMaxPositions: 3 (NOT reduced)
  - Size reduced by fee manager
  - availableSlots: 2
```
**Verification:** Slots unchanged, soft warning controls size only

### ✅ Test 13: Cooldown Active - Should NOT Reduce Slots
**Setup:** `botState.cooldownUntil = future timestamp`
```
Expected Behavior:
  - effectiveMaxPositions: 3 (NOT reduced)
  - Entry blocked by cooldown logic (separate)
  - availableSlots: 2
```
**Verification:** Slots show available, but cooldown prevents trade

## Logging Verification

### Expected Log Messages

**Healthy State:**
```
[POSITION_SLOT_STATE_UPDATED] Hard safety not active. Configured: 3, Effective: 3
[AVAILABLE_TRADE_SLOT_CONFIRMED] Slots: 2/3, Open: 1, Health: OK
```

**Hard Safety Triggered:**
```
[SLOT_CALC] Hard safety: Protection sync unhealthy
[POSITION_SLOT_STATE_UPDATED] Hard safety active. Configured: 3, Effective: 1, Reason: PROTECTION_UNHEALTHY
[EFFECTIVE_MAX_POSITIONS_REDUCED] Reason: PROTECTION_UNHEALTHY, Effective: 1, Available: 0
[POSITION_SLOT_BLOCKED_HARD_SAFETY] Entry order rejected: no available slots or hard safety condition active
```

**Entry Blocked - No Slots:**
```
[AVAILABLE_TRADE_SLOT_BLOCKED] Reasons: NO_AVAILABLE_SLOTS
```

**Reduce-Only Allowed:**
```
[REDUCE_ONLY_ORDER_BYPASS_SLOTS] Reduce-only order allowed regardless of slot state
```

## No Breaking Changes

✅ **Backward Compatible:**
- Existing `maxAllowedPositions` retained for legacy code
- New fields all optional with safe defaults
- Slot logic only affects entry orders
- Reduce-only/TP/SL unaffected
- No lever changes
- No SL/TP placement changes
- No hard safety protection removal

## Dashboard Display Changes

**Old (Confusing):**
```
Max: 1
1 / 3
0 slots left
```

**New (Clear):**
```
Configured Max Positions: 3
Effective Max Positions: 3
Used Positions: 1
Available Slots: 2
Slot Restriction Reason: NONE
Is Hard Safety: false
```

Only shows restrictive message when reason is explicitly set and hard safety is true.

## Summary

This PR fixes the position slot contradiction by:
1. Implementing explicit, transparent slot calculation
2. Distinguishing hard safety from soft warnings
3. Allowing 3 concurrent trades in healthy conditions
4. Blocking entries ONLY when justified by hard safety
5. Protecting reduce-only orders (TP/SL/emergency closes)
6. Providing clear dashboard visibility
7. Maintaining full backward compatibility
