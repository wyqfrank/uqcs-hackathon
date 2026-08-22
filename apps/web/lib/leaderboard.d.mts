export type LeaderboardEntry = {
  /** Display name, as most recently typed. */
  name: string;
  wins: number;
  battles: number;
  highestScore: number;
  /** ISO timestamp of the last recorded battle. */
  updatedAt: string;
};

export type BattlePlayer = {
  name: string;
  score: number;
  won: boolean;
};

export declare const MAX_NAME_LENGTH: number;
export declare function normaliseName(value: unknown): string;
export declare function nameKey(value: unknown): string;
export declare function isValidName(value: unknown): boolean;

export declare class Leaderboard {
  constructor(options?: { path?: string });
  path: string;
  load(): Promise<Map<string, LeaderboardEntry>>;
  recordBattle(players: BattlePlayer[]): Promise<LeaderboardEntry[]>;
  standings(): Promise<LeaderboardEntry[]>;
}

export declare const leaderboard: Leaderboard;
