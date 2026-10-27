// SPDX-License-Identifier: AGPL-3.0-only
import { BattleScene } from "#app/battle-scene";
import { Command } from "#enums/command";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { battleDigest, reseedBattle } from "../../../src/pvp/battle-state";
import { installBattleHooks } from "../../../src/pvp/runtime";
import { setPvpMatchActive } from "../../../src/pvp/state";
import { configureTrainerAi } from "../../../src/pvp/trainer-ai";
import fixture from "../../fixtures/pvp/session.json";

describe("streak trainer native battle", () => {
  let phaser: Phaser.Game;
  let restore: (() => void) | undefined;
  beforeAll(() => {
    phaser = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
    setPvpMatchActive(false);
    configureTrainerAi();
  });

  async function playTurn(game: GameManager) {
    const input = structuredClone(fixture);
    input.seed = "trainer-ai-replay";
    input.enemyParty = input.enemyParty.slice(0, 1);
    Reflect.set(game.reload, "sessionData", game.scene.gameData.parseSessionData(JSON.stringify(input)));
    await game.reload.reloadSession();
    const scene = game.scene;
    for (const pokemon of [...scene.getPlayerParty(), ...scene.getEnemyParty()]) {
      pokemon.calculateStats();
      pokemon.hp = pokemon.stats[0];
      pokemon.status = null;
    }
    configureTrainerAi(input.seed);
    setPvpMatchActive(true);
    restore = installBattleHooks({
      handlePvpForfeit: () => false,
      replayPvpCommand: () => false,
      pausePvpTurn: () => {
        reseedBattle(scene, "turn-one");
        return false;
      },
      handlePvpSwitch: () => false,
      handlePvpVictory: () => false,
      handlePvpLoss: () => false,
    });
    const phase = scene.phaseManager.getCurrentPhase();
    expect(Reflect.get(phase, "handleCommand").call(phase, Command.FIGHT, 0)).toBe(true);
    await game.toEndOfTurn(false);
    return { tera: scene.getEnemyParty()[0].isTerastallized, digest: battleDigest(scene) };
  }

  it("executes Tera through the real battle engine and reproduces the turn", async () => {
    const game = new GameManager(phaser);
    BattleScene.prototype.randBattleSeedInt = function (range, min = 0) {
      return this.currentBattle?.randSeedInt(range, min);
    };
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    const first = await playTurn(game);
    expect(first.tera).toBe(true);
    restore?.();
    restore = undefined;
    setPvpMatchActive(false);
    const replay = await playTurn(game);
    expect(replay).toEqual(first);
  }, 120000);
});
