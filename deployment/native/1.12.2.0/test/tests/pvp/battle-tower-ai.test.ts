// SPDX-License-Identifier: AGPL-3.0-only
import { globalScene } from "#app/global-scene";
import { ArenaTagSide } from "#enums/arena-tag-side";
import { ArenaTagType } from "#enums/arena-tag-type";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { PokemonMove } from "#data/moves/pokemon-move";
import { GameManager } from "#test/framework/game-manager";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustBattleTowerMatchupScore,
  calculateActiveBattleTowerScore,
  calculateBenchBattleTowerScore,
  getBattleTowerSwitchThreshold,
} from "../../../src/pvp/ai";
import { installBattleHooks } from "../../../src/pvp/runtime";
import { setPvpMatchActive } from "../../../src/pvp/state";

describe("PvP Battle Tower Smart AI", () => {
  let phaser: Phaser.Game;
  let game: GameManager;
  let restore: (() => void) | undefined;

  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    setPvpMatchActive(false);
    game = new GameManager(phaser);
    await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
    game.scene.phaseManager.clearPhaseQueue();
    restore = installBattleHooks({
      handlePvpForfeit: () => false,
      replayPvpCommand: () => false,
      pausePvpTurn: () => false,
      handlePvpSwitch: () => false,
      handlePvpVictory: () => false,
      handlePvpLoss: () => false,
    });
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
    setPvpMatchActive(false);
  });

  it("passes matchup scores through unchanged when PvP is not active", () => {
    setPvpMatchActive(false);
    const enemy = game.scene.getEnemyPokemon()!;
    const player = game.scene.getPlayerPokemon()!;

    enemy.setStatStage(Stat.ATK, -4);
    const baseScore = enemy.getMatchupScore(player);
    const adjustedScore = adjustBattleTowerMatchupScore(enemy, player, baseScore);

    expect(adjustedScore).toBe(baseScore);
  });

  it("penalizes active Pokémon score and relaxes threshold when crippled by -2 debuffs", () => {
    setPvpMatchActive(true);
    const enemy = game.scene.getEnemyPokemon()!;
    const player = game.scene.getPlayerPokemon()!;

    // Set physical moveset on enemy
    enemy.moveset = [new PokemonMove(MoveId.TACKLE), new PokemonMove(MoveId.SCRATCH)];

    // Initial neutral state
    const neutralThreshold = getBattleTowerSwitchThreshold(enemy, player);
    expect(neutralThreshold).toBe(3.0);

    // Apply -2 Attack debuff
    enemy.setStatStage(Stat.ATK, -2);
    const debuffedThreshold = getBattleTowerSwitchThreshold(enemy, player);
    expect(debuffedThreshold).toBe(1.35);

    const baseScore = 2.0;
    const adjustedScore = calculateActiveBattleTowerScore(enemy, player, baseScore);

    // -2 debuff formula: 2 / (2 + 2) = 0.5x
    expect(adjustedScore).toBeCloseTo(baseScore * 0.5, 2);
  });

  it("penalizes active Pokémon score and relaxes threshold when opponent has +2 setup boosts", () => {
    setPvpMatchActive(true);
    const enemy = game.scene.getEnemyPokemon()!;
    const player = game.scene.getPlayerPokemon()!;

    // Player sets up +2 Attack
    player.setStatStage(Stat.ATK, 2);
    const threshold = getBattleTowerSwitchThreshold(enemy, player);
    expect(threshold).toBe(1.35);

    const baseScore = 2.0;
    const adjustedScore = calculateActiveBattleTowerScore(enemy, player, baseScore);

    // +2 opponent boost formula: 2 / (2 + 2) = 0.5x
    expect(adjustedScore).toBeCloseTo(baseScore * 0.5, 2);
  });

  it("vetoes bench switch candidates whose remaining HP after hazards would be <= 15%", () => {
    setPvpMatchActive(true);
    const enemy = game.scene.getEnemyPokemon()!;
    enemy.calculateStats();
    // Set 40% HP
    enemy.hp = Math.floor(enemy.getMaxHp() * 0.4);

    // Add Stealth Rock on ENEMY side
    globalScene.arena.addTag(ArenaTagType.STEALTH_ROCK, 0, undefined, MoveId.STEALTH_ROCK, ArenaTagSide.ENEMY);

    // Mock type effectiveness to 4x (50% hazard damage)
    const spy = vi.spyOn(enemy, "getAttackTypeEffectiveness").mockReturnValue(4);

    // 40% - 50% <= 0 (lethal upon entry)
    const baseScore = 3.0;
    const adjustedScore = calculateBenchBattleTowerScore(enemy, baseScore);

    // Should receive severe lethal hazard penalty (0.05x)
    expect(adjustedScore).toBeCloseTo(baseScore * 0.05, 3);
    spy.mockRestore();
  });

  it("allows safe bench candidates that take survivable hazard damage", () => {
    setPvpMatchActive(true);
    const enemy = game.scene.getEnemyPokemon()!;
    enemy.calculateStats();
    enemy.hp = enemy.getMaxHp(); // 100% HP

    // Add Stealth Rock on ENEMY side
    globalScene.arena.addTag(ArenaTagType.STEALTH_ROCK, 0, undefined, MoveId.STEALTH_ROCK, ArenaTagSide.ENEMY);

    // Mock type effectiveness to 0.5x (6.25% hazard damage)
    const spy = vi.spyOn(enemy, "getAttackTypeEffectiveness").mockReturnValue(0.5);

    const baseScore = 3.0;
    const adjustedScore = calculateBenchBattleTowerScore(enemy, baseScore);

    // Score is gently discounted for entry damage (1 - 0.0625 * 1.5 = 0.90625), not vetoed
    expect(adjustedScore).toBeGreaterThan(baseScore * 0.85);
    spy.mockRestore();
  });
});
