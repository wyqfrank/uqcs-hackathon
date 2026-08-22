import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Leaderboard, isValidName, nameKey, normaliseName } from "./leaderboard.mjs";

describe("name handling", () => {
  it("collapses surrounding and repeated whitespace", () => {
    expect(normaliseName("  Angus   Chou ")).toBe("Angus Chou");
  });

  it("matches names case-insensitively so a record is not split", () => {
    expect(nameKey("ANGUS")).toBe(nameKey("angus"));
  });

  it("rejects empty and overlong names", () => {
    expect(isValidName("   ")).toBe(false);
    expect(isValidName("a".repeat(25))).toBe(false);
    expect(isValidName("Angus")).toBe(true);
  });
});

describe("Leaderboard", () => {
  let directory: string;
  let board: Leaderboard;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fitted-leaderboard-"));
    board = new Leaderboard({ path: join(directory, "leaderboard.json") });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("starts empty when no file exists", async () => {
    expect(await board.standings()).toEqual([]);
  });

  it("creates entries for both players and credits only the winner", async () => {
    await board.recordBattle([
      { name: "Angus", score: 82.4, won: true },
      { name: "Frank", score: 77.1, won: false },
    ]);

    const standings = await board.standings();
    expect(standings.map((entry) => entry.name)).toEqual(["Angus", "Frank"]);
    expect(standings[0]).toMatchObject({ wins: 1, battles: 1, highestScore: 82.4 });
    expect(standings[1]).toMatchObject({ wins: 0, battles: 1, highestScore: 77.1 });
  });

  it("adds a win to an existing player rather than duplicating them", async () => {
    await board.recordBattle([{ name: "Angus", score: 60, won: true }]);
    await board.recordBattle([{ name: "angus", score: 50, won: true }]);

    const standings = await board.standings();
    expect(standings).toHaveLength(1);
    expect(standings[0]).toMatchObject({ wins: 2, battles: 2 });
  });

  it("keeps the highest score rather than the most recent", async () => {
    await board.recordBattle([{ name: "Angus", score: 91.2, won: true }]);
    await board.recordBattle([{ name: "Angus", score: 40.5, won: false }]);

    const [entry] = await board.standings();
    expect(entry.highestScore).toBe(91.2);
    expect(entry.battles).toBe(2);
  });

  it("credits nobody a win on a draw but still counts the battle", async () => {
    await board.recordBattle([
      { name: "Angus", score: 70, won: false },
      { name: "Frank", score: 70, won: false },
    ]);

    const standings = await board.standings();
    expect(standings.every((entry) => entry.wins === 0)).toBe(true);
    expect(standings.every((entry) => entry.battles === 1)).toBe(true);
  });

  it("ranks by wins, then highest score", async () => {
    await board.recordBattle([{ name: "OneWin", score: 50, won: true }]);
    await board.recordBattle([{ name: "TwoWins", score: 10, won: true }]);
    await board.recordBattle([{ name: "TwoWins", score: 12, won: true }]);
    await board.recordBattle([{ name: "HighScore", score: 99, won: false }]);

    expect((await board.standings()).map((entry) => entry.name)).toEqual([
      "TwoWins",
      "OneWin",
      "HighScore",
    ]);
  });

  it("ignores unusable names without dropping the other player", async () => {
    await board.recordBattle([
      { name: "   ", score: 88, won: true },
      { name: "Frank", score: 55, won: false },
    ]);

    const standings = await board.standings();
    expect(standings.map((entry) => entry.name)).toEqual(["Frank"]);
  });

  it("survives a reload from disk", async () => {
    await board.recordBattle([{ name: "Angus", score: 64, won: true }]);

    const reopened = new Leaderboard({ path: board.path });
    const [entry] = await reopened.standings();
    expect(entry).toMatchObject({ name: "Angus", wins: 1, highestScore: 64 });
  });

  it("does not interleave concurrent battles", async () => {
    await Promise.all([
      board.recordBattle([{ name: "Angus", score: 10, won: true }]),
      board.recordBattle([{ name: "Angus", score: 20, won: true }]),
      board.recordBattle([{ name: "Angus", score: 30, won: false }]),
    ]);

    const [entry] = await board.standings();
    expect(entry).toMatchObject({ wins: 2, battles: 3, highestScore: 30 });

    // The file on disk must agree with memory, not be a partial write.
    const onDisk = JSON.parse(await readFile(board.path, "utf8"));
    expect(onDisk.angus).toMatchObject({ wins: 2, battles: 3 });
  });
});
