// SPDX-License-Identifier: AGPL-3.0-only
import { globalScene } from "#app/global-scene";
import { BattleType } from "#enums/battle-type";
import type { Command } from "#enums/command";
import { GameModes } from "#enums/game-modes";
import type { SwitchType } from "#enums/switch-type";
import { UiMode } from "#enums/ui-mode";
import { EntryHazardTag } from "#data/arena-tag";
import { EnemyPokemon, Pokemon } from "#field/pokemon";
import { BattleEndPhase } from "#phases/battle-end-phase";
import { CommandPhase } from "#phases/command-phase";
import { EnemyCommandPhase } from "#phases/enemy-command-phase";
import { GameOverPhase } from "#phases/game-over-phase";
import { MysteryEncounterOptionSelectedPhase, MysteryEncounterPhase } from "#phases/mystery-encounter-phases";
import { SwitchPhase } from "#phases/switch-phase";
import { VictoryPhase } from "#phases/victory-phase";
import { loggedInUser } from "#app/account";
import { logBattleEnd, logDreamTransformations, logEncounterChoice, registerClearedRun } from "./log";
import { isPvpMatchActive, pvpEnabled } from "./state";
import { adjustBattleTowerMatchupScore, getBattleTowerSwitchThreshold } from "./ai";
import { chooseTrainerTera, trainerPersonality, withTrainerMoveWeights } from "./trainer-ai";

interface BattleHooks {
  handlePvpForfeit(command: Command, resume: () => void): boolean;
  replayPvpCommand(phase: CommandPhase): boolean;
  pausePvpTurn(phase: EnemyCommandPhase): boolean;
  handlePvpSwitch(
    phase: SwitchPhase,
    fieldIndex: number,
    switchType: SwitchType,
    doReturn: boolean,
    isModal: boolean,
  ): boolean;
  handlePvpVictory(end: () => void): boolean;
  handlePvpLoss(): boolean;
}
let uninstall: (() => void) | undefined;
/** Loaded after title boot, after the upstream phase classes are initialized.
 * All behavior passes through unchanged unless a synthetic PvP match is active. */
export function installBattleHooks(handlers: BattleHooks): () => void {
  if (uninstall) {
    return uninstall;
  }
  const restore: (() => void)[] = [];
  function patch(target: object, key: string, wrap: (original: (...args: any[]) => any) => (...args: any[]) => any) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const original = Reflect.get(target, key);
    if (typeof original !== "function") {
      throw new Error(`upstream PvP seam changed: ${key}`);
    }
    Reflect.set(target, key, wrap(original));
    restore.push(() => {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        Reflect.deleteProperty(target, key);
      }
    });
  }
  patch(
    MysteryEncounterPhase.prototype,
    "handleOptionSelect",
    original =>
      function (this: MysteryEncounterPhase, ...args) {
        logEncounterChoice(args[1]);
        return original.apply(this, args);
      },
  );
  patch(
    MysteryEncounterOptionSelectedPhase.prototype,
    "end",
    original =>
      function (this: MysteryEncounterOptionSelectedPhase) {
        logDreamTransformations();
        return original.call(this);
      },
  );
  patch(
    BattleEndPhase.prototype,
    "end",
    original =>
      function (this: BattleEndPhase) {
        if (!isPvpMatchActive()) {
          logBattleEnd();
        }
        return original.call(this);
      },
  );
  // This is the exact original boundary after queued moves and before command UI.
  patch(
    CommandPhase.prototype,
    "tryExecuteQueuedMove",
    original =>
      function (this: CommandPhase) {
        return original.call(this) || (isPvpMatchActive() && handlers.replayPvpCommand(this));
      },
  );
  patch(
    CommandPhase.prototype,
    "handleCommand",
    original =>
      function (this: CommandPhase, ...args) {
        if (isPvpMatchActive() && handlers.handlePvpForfeit(args[0], () => this.start())) {
          return true;
        }
        return original.apply(this, args);
      },
  );
  patch(
    Pokemon.prototype,
    "getMatchupScore",
    original =>
      function (this: Pokemon, opponent: Pokemon) {
        const baseScore = original.call(this, opponent);
        if (!isPvpMatchActive()) {
          return baseScore;
        }
        return adjustBattleTowerMatchupScore(this, opponent, baseScore);
      },
  );
  patch(
    EntryHazardTag.prototype,
    "getMatchupScoreMultiplier",
    original =>
      function (this: EntryHazardTag, pokemon: Pokemon) {
        if (isPvpMatchActive()) {
          return 1;
        }
        return original.call(this, pokemon);
      },
  );
  patch(
    EnemyCommandPhase.prototype,
    "start",
    original =>
      function (this: EnemyCommandPhase) {
        if (isPvpMatchActive() && handlers.pausePvpTurn(this)) {
          return;
        }
        const profile = isPvpMatchActive() ? trainerPersonality() : undefined;
        const trainer = globalScene.currentBattle.trainer;
        if (!profile || !trainer) {
          return original.call(this);
        }
        const scores = trainer.getPartyMemberMatchupScores;
        const shouldTera = trainer.shouldTera;
        const enemyPokemon = globalScene.getEnemyField()[this.getFieldIndex()];
        const opponent = globalScene.getPlayerPokemon();
        const smartThreshold = enemyPokemon && opponent
          ? getBattleTowerSwitchThreshold(enemyPokemon, opponent, trainer.config.isBoss)
          : profile.switchThreshold;
        const effectiveThreshold = Math.min(profile.switchThreshold, smartThreshold);
        trainer.getPartyMemberMatchupScores = function (slot, forSwitch) {
          const result = scores.call(this, slot, forSwitch);
          return forSwitch ? result.map(([index, score]) => [index, (score * 3) / effectiveThreshold]) : result;
        };
        trainer.shouldTera = pokemon =>
          !Reflect.get(this, "skipTurn")
          && chooseTrainerTera(
            pokemon,
            globalScene.currentBattle.turn,
            globalScene.getEnemyParty().filter(p => p.isAllowedInBattle()).length,
          );
        try {
          return original.call(this);
        } finally {
          trainer.getPartyMemberMatchupScores = scores;
          trainer.shouldTera = shouldTera;
        }
      },
  );
  patch(
    EnemyPokemon.prototype,
    "getNextMove",
    original =>
      function (this: EnemyPokemon) {
        return isPvpMatchActive() ? withTrainerMoveWeights(this, () => original.call(this)) : original.call(this);
      },
  );
  patch(
    VictoryPhase.prototype,
    "start",
    original =>
      function (this: VictoryPhase) {
        if (isPvpMatchActive() && handlers.handlePvpVictory(() => this.end())) {
          return;
        }
        return original.call(this);
      },
  );
  patch(
    GameOverPhase.prototype,
    "start",
    original =>
      function (this: GameOverPhase) {
        if (isPvpMatchActive() && handlers.handlePvpLoss()) {
          return;
        }
        if (pvpEnabled && !isPvpMatchActive() && globalScene.gameMode.modeId === GameModes.CLASSIC
          && globalScene.currentBattle.waveIndex === 200 && globalScene.currentBattle.battleType === BattleType.CLEAR) {
          // BattleEnd has finished by this point; preserve the final candidate
          // before GameOver makes its first network request.
          try {
            registerClearedRun(globalScene.gameData.getSessionSaveData(), loggedInUser?.username);
          } catch (error) {
            console.warn("Failed to prepare cleared party registration:", error);
          }
        }
        return original.call(this);
      },
  );
  patch(
    SwitchPhase.prototype,
    "start",
    original =>
      function (this: SwitchPhase) {
        if (!isPvpMatchActive()) {
          return original.call(this);
        }
        // Let upstream perform every switch eligibility check and calculate the
        // effective field index. Intercept only this phase's final party prompt.
        const ui = globalScene.ui;
        const setMode = ui.setMode;
        const phase = this;
        let intercepted = false;
        ui.setMode = function (this: typeof ui, mode, ...args) {
          if (!intercepted && mode === UiMode.PARTY && globalScene.phaseManager.getCurrentPhase() === phase) {
            intercepted = true;
            if (
              handlers.handlePvpSwitch(
                phase,
                args[1] as number,
                Reflect.get(phase, "switchType") as SwitchType,
                Reflect.get(phase, "doReturn"),
                Reflect.get(phase, "isModal"),
              )
            ) {
              return Promise.resolve();
            }
          }
          return setMode.call(this, mode, ...args);
        } as typeof setMode;
        try {
          return original.call(this);
        } finally {
          ui.setMode = setMode;
        }
      },
  );
  uninstall = () => {
    for (const reset of restore.reverse()) {
      reset();
    }
    uninstall = undefined;
  };
  return uninstall;
}
