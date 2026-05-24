import { config } from "./config.js";
import { ethers } from "ethers";
import { signL1Action } from "hyperliquid";

export class HyperliquidClient {
  private wallet: ethers.Wallet | null = null;
  public isValidSigner: boolean = false;
  
  public get walletAddress(): string | null {
    return this.wallet?.address || null;
  }

  constructor() {
    this.initializeWallet();
  }

  private initializeWallet() {
    if (config.HYPERLIQUID_PRIVATE_KEY) {
      try {
        // Ensure private key has 0x prefix if it doesn't
        let pk = config.HYPERLIQUID_PRIVATE_KEY.trim();
        if (pk && !pk.startsWith("0x")) pk = "0x" + pk;
        
        if (pk.length === 42) {
          throw new Error("Private key looks like a wallet address (42 chars). Please use the actual 64-char private key.");
        }
        
        this.wallet = new ethers.Wallet(pk);
        console.log(`[CLIENT] Wallet loaded: ${this.wallet.address}`);
        this.isValidSigner = true;
        
        if (this.wallet.address.toLowerCase() !== config.HYPERLIQUID_API_WALLET.toLowerCase()) {
           console.warn(`[CLIENT] Signer address mismatch: expected ${config.HYPERLIQUID_API_WALLET}, got ${this.wallet.address}`);
        }
      } catch (e: any) {
        // Silently handle to prevent console error spam since RiskManager sets a blocker
        this.wallet = null;
        this.isValidSigner = false;
      }
    } else {
      console.warn("[CLIENT] No private key found during initialization.");
    }
  }

  async infoRequest(payload: any, retries = 3, delay = 1000): Promise<any> {
    for (let i = 0; i < retries; i++) {
        try {
          const res = await fetch(`${config.HYPERLIQUID_API_URL}/info`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.status === 429) {
             const waitTime = delay * Math.pow(2, i);
             console.log(`[RATE_LIMIT] 429 on infoRequest, backing off ${waitTime}ms...`);
             await new Promise(resolve => setTimeout(resolve, waitTime));
             continue;
          }
          if (!res.ok && res.status >= 500) {
              throw new Error(`Server error: ${res.status}`);
          }
          return await res.json();
        } catch (err: any) {
          if (i === retries - 1) {
             console.error("infoRequest failed after retries", err);
             return null;
          }
          if (err.message?.includes('ECONNRESET') || err.message?.includes('fetch failed')) {
              const waitTime = delay * Math.pow(2, i);
              await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
              // If it's another kind of error (like parsing error), just try again?
              const waitTime = delay * Math.pow(2, i);
              await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
    }
    return null;
  }

  async exchangeRequest(action: any, retries = 3, delay = 1000): Promise<any> {
    if (!this.wallet) {
      // Try initializing again in case it was set later (though config should be static usually)
      this.initializeWallet();
    }

    if (!this.wallet) {
      console.error("Exchange request attempted without a valid wallet/private key.");
      return { status: "error", response: "No valid private key provided. Check logs for wallet init errors." };
    }

    for (let i = 0; i < retries; i++) {
        try {
          const nonce = Date.now();
          const isMainnet = true; // Use mainnet config
          const signature = await signL1Action(this.wallet, action, null, nonce, isMainnet);

          const payload = {
            action,
            nonce,
            signature,
          };

          if (i === 0) {
            console.log(`[CLIENT] Sending exchange request:`, JSON.stringify(payload));
          } else {
            console.log(`[CLIENT] Retrying exchange request (attempt ${i + 1}):`, JSON.stringify(payload));
          }

          const res = await fetch(`${config.HYPERLIQUID_API_URL}/exchange`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (res.status === 429) {
             const waitTime = delay * Math.pow(2, i);
             console.log(`[RATE_LIMIT] 429 on exchangeRequest, backing off ${waitTime}ms...`);
             await new Promise(resolve => setTimeout(resolve, waitTime));
             continue;
          }

          if (!res.ok && res.status >= 500) {
             throw new Error(`Server error: ${res.status}`);
          }

          const responseText = await res.text();
          try {
            return JSON.parse(responseText);
          } catch (err) {
            console.error("exchangeRequest returned non-JSON:", responseText, "Payload was:", JSON.stringify(payload));
            return { status: "error", response: responseText };
          }
        } catch (err: any) {
          if (i === retries - 1) {
            console.error("exchangeRequest failed after retries", err);
            return null;
          }
          const waitTime = delay * Math.pow(2, i);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    return null;
  }
}

export const hClient = new HyperliquidClient();
