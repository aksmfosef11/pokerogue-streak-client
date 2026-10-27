import * as account from "#app/account";
import { AbilityId } from "#enums/ability-id";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import * as journal from "../../../src/pvp/log";
import { installBattleHooks } from "../../../src/pvp/runtime";
import * as state from "../../../src/pvp/state";

let phaser: Phaser.Game;
let restore: (() => void) | undefined;
beforeAll(() => { phaser = new Phaser.Game({ type: Phaser.HEADLESS }); });
afterEach(() => restore?.());

it("captures the post-battle candidate before GameOver and matches the final party and inventory", async () => {
  const game = new GameManager(phaser);
  game.override.moveset([MoveId.ICE_BEAM, MoveId.SPLASH]).ability(AbilityId.BALL_FETCH)
    .battleStyle("single").criticalHits(false).enemyAbility(AbilityId.BALL_FETCH)
    .enemyMoveset(MoveId.SPLASH).startingWave(200).startingBiome(BiomeId.END).startingLevel(10000);
  await game.classicMode.startBattle(SpeciesId.BULBASAUR);
  vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(true);
  vi.spyOn(account, "loggedInUser", "get").mockReturnValue({ username: "clear-test" } as any);
  const saved = vi.spyOn(journal, "registerClearedRun").mockImplementation(() => {});
  restore = installBattleHooks({
    handlePvpForfeit: () => false, replayPvpCommand: () => false,
    pausePvpTurn: () => false, handlePvpSwitch: () => false,
    handlePvpVictory: () => false, handlePvpLoss: () => false,
  });
  game.move.select(MoveId.ICE_BEAM);
  await game.toNextTurn();
  game.move.select(MoveId.ICE_BEAM);
  await game.phaseInterceptor.to("PostGameOverPhase", false);
  expect(saved).toHaveBeenCalledOnce();
  const [candidate, username] = saved.mock.calls[0];
  const final = game.scene.gameData.getSessionSaveData();
  expect(username).toBe("clear-test");
  expect(candidate).toMatchObject({ waveIndex: 200, battleType: 2 });
  expect(JSON.parse(JSON.stringify(candidate.party))).toEqual(JSON.parse(JSON.stringify(final.party)));
  expect(JSON.parse(JSON.stringify(candidate.modifiers))).toEqual(JSON.parse(JSON.stringify(final.modifiers)));
  expect(candidate.money).toBe(final.money);
});

it("does not capture a candidate when the player loses on wave 200", async () => {
  const game = new GameManager(phaser);
  game.override.moveset([MoveId.MEMENTO, MoveId.SPLASH]).ability(AbilityId.BALL_FETCH)
    .battleStyle("single").criticalHits(false).enemyAbility(AbilityId.BALL_FETCH)
    .enemyMoveset(MoveId.SPLASH).startingWave(200).startingBiome(BiomeId.END).startingLevel(10000);
  await game.classicMode.startBattle(SpeciesId.BULBASAUR);
  vi.spyOn(state, "pvpEnabled", "get").mockReturnValue(true);
  vi.spyOn(account, "loggedInUser", "get").mockReturnValue({ username: "clear-test" } as any);
  const saved = vi.spyOn(journal, "registerClearedRun").mockImplementation(() => {});
  restore = installBattleHooks({
    handlePvpForfeit: () => false, replayPvpCommand: () => false,
    pausePvpTurn: () => false, handlePvpSwitch: () => false,
    handlePvpVictory: () => false, handlePvpLoss: () => false,
  });
  game.move.select(MoveId.MEMENTO);
  await game.phaseInterceptor.to("PostGameOverPhase", false);
  expect(saved).not.toHaveBeenCalled();
});
