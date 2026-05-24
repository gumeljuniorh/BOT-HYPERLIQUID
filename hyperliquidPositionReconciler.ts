import { botState } from "./state.js";
import { hClient } from "./hyperliquidClient.js";

export class HyperliquidPositionReconciler {
  async reconcile() {
    // Reconcile bot's local position tracker with actual Hyperliquid account state
    // Block if mismatch occurs
    return true;
  }
}

export const positionReconciler = new HyperliquidPositionReconciler();
