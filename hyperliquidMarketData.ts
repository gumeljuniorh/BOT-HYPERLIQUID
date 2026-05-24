import WebSocket from "ws";
import { config } from "./config.js";
import { botState } from "./state.js";

export class HyperliquidMarketData {
  private ws: WebSocket | null = null;
  private lastMessageTime: number = 0;
  private pingInterval: NodeJS.Timeout | null = null;

  connect() {
    console.log(`Connecting to WebSocket: ${config.HYPERLIQUID_WS_URL}`);
    this.ws = new WebSocket(config.HYPERLIQUID_WS_URL);
    
    // Clear old ping interval if re-connecting
    if (this.pingInterval) clearInterval(this.pingInterval);

    this.pingInterval = setInterval(() => {
      // Check for stale connection
      if (this.lastMessageTime > 0 && Date.now() - this.lastMessageTime > 15000) {
        console.warn("[WS] Connection stale (no messages in 15s). Terminating to reconnect...");
        this.ws?.terminate(); // This will trigger the 'close' event handler
      } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: "ping" }));
      }
    }, 10000);

    this.ws.on("open", () => {
      if (botState.wssReconnectAttempts && botState.wssReconnectAttempts > 0) {
        console.log("[WSS_AUTO_RECOVERED] WebSocket connection automatically restored.");
      }
      botState.wssConnected = true;
      botState.wssReconnectAttempts = 0;
      this.lastMessageTime = Date.now();
      console.log("WebSocket connected");
      
      this.ws?.send(JSON.stringify({ method: "subscribe", subscription: { type: "webData2", user: config.HYPERLIQUID_WALLET_ADDRESS } }));
      this.ws?.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
    });

    this.ws.on("message", (data: any) => {
      this.lastMessageTime = Date.now();
      botState.lastWssTime = this.lastMessageTime;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.channel === "webData2" && msg.data) {
          const mids = msg.data.meta?.universe;
          if (mids) {
            import("./state.js").then((s) => {
              s.setAssetMeta(mids);
            });
          }
        }
        
        if (msg.channel === "allMids" && msg.data) {
           if (!botState.markPrices) botState.markPrices = {};
           if (msg.data.mids) {
             for (const coin in msg.data.mids) {
               botState.markPrices[coin] = parseFloat(msg.data.mids[coin]);
             }
             if (botState.activeSymbol && botState.markPrices[botState.activeSymbol]) {
               botState.markPrice = botState.markPrices[botState.activeSymbol];
             }
           }
        }
      } catch (e) {
        // ignore
      }
    });

    this.ws.on("close", () => {
      botState.wssConnected = false;
      botState.wssReconnectAttempts = (botState.wssReconnectAttempts || 0) + 1;
      console.log(`WebSocket disconnected. Reconnect attempt ${botState.wssReconnectAttempts} in 5s...`);
      setTimeout(() => this.connect(), 5000);
    });

    this.ws.on("error", (err: any) => {
      botState.wssConnected = false;
      console.error("HyperliquidMarketData WS error:", err);
    });
  }

  subscribeL2Book(coin: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin } }));
    }
  }

  subscribeTrades(coin: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
    }
  }
}

export const marketData = new HyperliquidMarketData();
