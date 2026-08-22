import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {object} LeaderboardEntry
 * @property {string} name         Display name, as most recently typed.
 * @property {number} wins
 * @property {number} battles
 * @property {number} highestScore
 * @property {string} updatedAt    ISO timestamp of the last recorded battle.
 */

/**
 * @typedef {object} BattlePlayer
 * @property {string} name
 * @property {number} score
 * @property {boolean} won
 */

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(here, "../../../.data/leaderboard.json");

/** Names are typed fresh each battle, so match them forgivingly. */
export function normaliseName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function nameKey(value) {
  return normaliseName(value).toLowerCase();
}

export const MAX_NAME_LENGTH = 24;

export function isValidName(value) {
  const name = normaliseName(value);
  return name.length > 0 && name.length <= MAX_NAME_LENGTH;
}

export class Leaderboard {
  constructor({ path = process.env.FITTED_LEADERBOARD_PATH || DEFAULT_PATH } = {}) {
    this.path = path;
    /** Writes are chained so two battles finishing together cannot interleave. */
    this.queue = Promise.resolve();
  }

  /**
   * Reads from disk every time rather than caching.
   *
   * The Socket.IO server imports this module through Node's loader while the
   * API route imports it through the bundler, so the two are separate module
   * instances. A cache would leave each holding a private view, and recorded
   * battles would never appear on the leaderboard page.
   */
  async load() {
    try {
      const raw = await readFile(this.path, "utf8");
      return new Map(Object.entries(JSON.parse(raw)));
    } catch {
      // Missing or unreadable file simply means nobody has played yet.
      return new Map();
    }
  }

  async persist(entries) {
    const payload = JSON.stringify(Object.fromEntries(entries), null, 2);
    await mkdir(dirname(this.path), { recursive: true });
    // Write beside the target and rename, so a crash cannot leave a half file.
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, payload, "utf8");
    await rename(temporary, this.path);
  }

  /**
   * Records one finished battle for both players.
   * @param {BattlePlayer[]} players
   * @returns {Promise<LeaderboardEntry[]>} the updated entries, in the given order
   */
  recordBattle(players) {
    const run = async () => {
      const entries = await this.load();
      const updated = [];

      for (const player of players) {
        if (!isValidName(player?.name)) continue;
        const name = normaliseName(player.name);
        const key = nameKey(name);
        const existing = entries.get(key);
        const score = Number.isFinite(player.score) ? player.score : 0;

        const entry = {
          // Keep the most recent spelling so someone can fix their own casing.
          name,
          wins: (existing?.wins ?? 0) + (player.won ? 1 : 0),
          battles: (existing?.battles ?? 0) + 1,
          highestScore: Math.max(existing?.highestScore ?? 0, score),
          updatedAt: new Date().toISOString(),
        };
        entries.set(key, entry);
        updated.push(entry);
      }

      if (updated.length) await this.persist(entries);
      return updated;
    };

    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** Ranked best-first: wins, then highest score, then fewest battles. */
  async standings() {
    const entries = await this.load();
    return [...entries.values()].sort(
      (a, b) =>
        b.wins - a.wins ||
        b.highestScore - a.highestScore ||
        a.battles - b.battles ||
        a.name.localeCompare(b.name),
    );
  }
}

/** Shared instance. server.mjs writes to it; the API route reads from it. */
export const leaderboard = new Leaderboard();
