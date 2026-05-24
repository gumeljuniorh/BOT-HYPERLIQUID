import fs from 'fs';
import path from 'path';

const SNAPSHOT_FILE = path.join(process.cwd(), '.bot_state_snapshot.json');

export interface BotStateSnapshot {
  activeSymbol: string;
  phase: string;
  leverage: number;
  openPositions: number;
  positionDetails: any | null;
  protection: any | null;
  validationStatus: string;
  blocker: string | null;
  accountEquity: number;
  availableMargin: number;
  analytics: {
    totalTrades: number;
    winRate: number;
    netProfitability: number;
    totalWins?: number;
    totalLosses?: number;
  };
  cooldownUntil: number;
  cooldownType?: "HARD" | "SOFT";
  lastCooldownSymbol?: string;
  reverseLockUntil: number;
  lastUpdateTime: number;
}

export class SnapshotService {
  public saveSnapshot(state: any) {
    try {
      // Create a shallow copy and append lastUpdateTime
      const snapshot = {
        ...state,
        lastUpdateTime: Date.now()
      };
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (e) {
      console.error("[SNAPSHOT] Error saving snapshot:", e);
    }
  }

  public loadSnapshot(): any | null {
    try {
      if (fs.existsSync(SNAPSHOT_FILE)) {
        const data = fs.readFileSync(SNAPSHOT_FILE, 'utf-8');
        return JSON.parse(data);
      }
    } catch (e) {
      console.error("[SNAPSHOT] Error loading snapshot:", e);
    }
    return null;
  }
}

export const snapshotService = new SnapshotService();
