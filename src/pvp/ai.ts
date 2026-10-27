// SPDX-License-Identifier: AGPL-3.0-only
import { globalScene } from "#app/global-scene";
import { AbilityId } from "#enums/ability-id";
import { ArenaTagSide } from "#enums/arena-tag-side";
import { ArenaTagType } from "#enums/arena-tag-type";
import { BattlerIndex } from "#enums/battler-index";
import { BattlerTagType } from "#enums/battler-tag-type";
import { Command } from "#enums/command";
import { MoveCategory } from "#enums/move-category";
import { PokemonType } from "#enums/pokemon-type";
import { Stat } from "#enums/stat";
import { StatusEffect } from "#enums/status-effect";
import type { EnemyPokemon, Pokemon } from "#field/pokemon";
import type { EnemyCommandPhase } from "#phases/enemy-command-phase";
import { isPvpMatchActive } from "./state";

/**
 * Calculates Battle Tower Smart AI score adjustments for Pokémon in PvP Streak Battles.
 * - Active Pokémon: severely penalizes matchup score if crippled by offensive debuffs or facing a boosted sweeper.
 * - Bench Pokémon: accounts for entry hazard damage, vetoing switches that would be lethal or leave <= 15% HP.
 */
export function adjustBattleTowerMatchupScore(pokemon: Pokemon, opponent: Pokemon, baseScore: number): number {
  if (!isPvpMatchActive() || baseScore <= 0 || pokemon.hp <= 0) {
    return baseScore;
  }

  // Active Pokémon on the enemy side evaluating current matchup
  if (pokemon.isEnemy() && pokemon.isOnField()) {
    return calculateActiveBattleTowerScore(pokemon, opponent, baseScore);
  }

  // Bench Pokémon on the enemy side evaluating candidate switch-in
  if (pokemon.isEnemy() && !pokemon.isOnField()) {
    return calculateBenchBattleTowerScore(pokemon, baseScore);
  }

  return baseScore;
}

/**
 * Calculates debuff and opponent threat multipliers for an active Pokémon.
 */
export function calculateActiveBattleTowerScore(pokemon: Pokemon, opponent: Pokemon, baseScore: number): number {
  const moves = pokemon.moveset ?? [];
  let hasPhysical = false;
  let hasSpecial = false;
  for (const m of moves) {
    const cat = m.getMove()?.category;
    if (cat === MoveCategory.PHYSICAL) hasPhysical = true;
    else if (cat === MoveCategory.SPECIAL) hasSpecial = true;
  }

  const atkStage = pokemon.getStatStage(Stat.ATK) ?? 0;
  const spAtkStage = pokemon.getStatStage(Stat.SPATK) ?? 0;

  let relevantDebuff = 0;
  if (hasPhysical && !hasSpecial) {
    relevantDebuff = Math.min(atkStage, 0);
  } else if (hasSpecial && !hasPhysical) {
    relevantDebuff = Math.min(spAtkStage, 0);
  } else {
    relevantDebuff = Math.min(atkStage, spAtkStage, 0);
  }

  let debuffMult = 1;
  if (relevantDebuff < 0) {
    debuffMult = 2 / (2 + Math.abs(relevantDebuff));
  }
  if (hasPhysical && !hasSpecial && pokemon.status?.effect === StatusEffect.BURN) {
    debuffMult *= 0.5;
  }

  const oppAtk = opponent.getStatStage(Stat.ATK) ?? 0;
  const oppSpAtk = opponent.getStatStage(Stat.SPATK) ?? 0;
  const oppSpd = opponent.getStatStage(Stat.SPD) ?? 0;

  let oppBoost = Math.max(oppAtk, oppSpAtk, 0);
  if (oppBoost > 0 && oppSpd > 0) {
    oppBoost += 1;
  }

  let threatMult = 1;
  if (oppBoost > 0) {
    threatMult = 2 / (2 + oppBoost);
  }

  return baseScore * debuffMult * threatMult;
}

/**
 * Calculates hazard damage penalty and lethal hazard veto for a bench candidate.
 */
export function calculateBenchBattleTowerScore(pokemon: Pokemon, baseScore: number): number {
  const arena = globalScene.arena;
  if (!arena) {
    return baseScore;
  }

  const hasMagicGuard = pokemon.hasAbility(AbilityId.MAGIC_GUARD);
  let hazardDamageRatio = 0;

  if (!hasMagicGuard) {
    const srTags = arena.findTagsOnSide(t => t.tagType === ArenaTagType.STEALTH_ROCK, ArenaTagSide.ENEMY);
    if (srTags.length > 0) {
      const rockEff = pokemon.getAttackTypeEffectiveness(PokemonType.ROCK, { ignoreStrongWinds: true });
      hazardDamageRatio += 0.125 * rockEff;
    }

    const spikeTags = arena.findTagsOnSide(t => t.tagType === ArenaTagType.SPIKES, ArenaTagSide.ENEMY);
    if (spikeTags.length > 0 && pokemon.isGrounded()) {
      const layers = Reflect.get(spikeTags[0], "layers") || 1;
      hazardDamageRatio += layers === 1 ? 0.125 : layers === 2 ? 0.166 : 0.25;
    }
  }

  if (hazardDamageRatio <= 0) {
    return baseScore;
  }

  const hpRatio = pokemon.getHpRatio();
  const remainingHpRatio = hpRatio - hazardDamageRatio;

  if (remainingHpRatio <= 0.15) {
    // Lethal or near-lethal hazard entry: veto candidate
    return baseScore * 0.05;
  }

  return baseScore * Math.max(0.1, 1 - hazardDamageRatio * 1.5);
}

/**
 * Returns the Battle Tower Smart AI switch threshold.
 * Under severe debuffs or opponent boosts, drops the threshold to 1.35x.
 * When neutral, preserves the standard 3.0x / 2.0x threshold to protect momentum.
 */
export function getBattleTowerSwitchThreshold(active: Pokemon, opponent: Pokemon, isBoss = false): number {
  const moves = active.moveset ?? [];
  let hasPhysical = false;
  let hasSpecial = false;
  for (const m of moves) {
    const cat = m.getMove()?.category;
    if (cat === MoveCategory.PHYSICAL) hasPhysical = true;
    else if (cat === MoveCategory.SPECIAL) hasSpecial = true;
  }

  const atkStage = active.getStatStage(Stat.ATK) ?? 0;
  const spAtkStage = active.getStatStage(Stat.SPATK) ?? 0;

  let relevantDebuff = 0;
  if (hasPhysical && !hasSpecial) {
    relevantDebuff = Math.min(atkStage, 0);
  } else if (hasSpecial && !hasPhysical) {
    relevantDebuff = Math.min(spAtkStage, 0);
  } else {
    relevantDebuff = Math.min(atkStage, spAtkStage, 0);
  }

  const oppAtk = opponent.getStatStage(Stat.ATK) ?? 0;
  const oppSpAtk = opponent.getStatStage(Stat.SPATK) ?? 0;
  const oppSpd = opponent.getStatStage(Stat.SPD) ?? 0;

  let oppBoost = Math.max(oppAtk, oppSpAtk, 0);
  if (oppBoost > 0 && oppSpd > 0) {
    oppBoost += 1;
  }

  if (relevantDebuff <= -2 || oppBoost >= 2) {
    return 1.35;
  }
  if (relevantDebuff === -1 || oppBoost === 1) {
    return 1.65;
  }
  return isBoss ? 2.0 : 3.0;
}

/**
 * Executes an enemy AI command in PvP using Battle Tower Smart logic.
 * Returns true if the command phase was completed.
 */
export function executeBattleTowerEnemyCommand(phase: EnemyCommandPhase): boolean {
  const fieldIndex = phase.getFieldIndex();
  const enemyPokemon = globalScene.getEnemyField()[fieldIndex] as EnemyPokemon | undefined;
  const battle = globalScene.currentBattle;
  if (!enemyPokemon || !battle) {
    return false;
  }

  const trainer = battle.trainer;
  if (
    battle.double
    && enemyPokemon.hasAbility(AbilityId.COMMANDER)
    && enemyPokemon.getAlly()?.getTag(BattlerTagType.COMMANDED)
  ) {
    Reflect.set(phase, "skipTurn", true);
  }

  const skipTurn = Boolean(Reflect.get(phase, "skipTurn"));

  if (trainer && enemyPokemon.getMoveQueue().length === 0 && !enemyPokemon.isTrapped()) {
    const partyMemberScores = trainer.getPartyMemberMatchupScores(enemyPokemon.trainerSlot, true);
    if (partyMemberScores.length > 0) {
      const opponents = enemyPokemon.getOpponents();
      const matchupScores = opponents.map(opp => enemyPokemon.getMatchupScore(opp));
      const matchupScore = matchupScores.reduce((total, score) => (total += score), 0) / (matchupScores.length || 1);

      const sortedPartyMemberScores = trainer.getSortedPartyMemberMatchupScores(partyMemberScores);
      const switchMultiplier = 1 - (battle.enemySwitchCounter ? Math.pow(0.1, 1 / battle.enemySwitchCounter) : 0);

      const opponent = opponents[0] ?? globalScene.getPlayerPokemon();
      const threshold = opponent
        ? getBattleTowerSwitchThreshold(enemyPokemon, opponent, trainer.config.isBoss)
        : trainer.config.isBoss
          ? 2.0
          : 3.0;

      if (sortedPartyMemberScores[0][1] * switchMultiplier >= matchupScore * threshold) {
        const index = trainer.getNextSummonIndex(enemyPokemon.trainerSlot, partyMemberScores);

        battle.turnCommands[fieldIndex + BattlerIndex.ENEMY] = {
          command: Command.POKEMON,
          cursor: index,
          args: [false],
          skip: skipTurn,
        };

        battle.enemySwitchCounter++;
        phase.end();
        return true;
      }
    }
  }

  // Not switching: select move & tera
  const nextMove = enemyPokemon.getNextMove();
  if (trainer?.shouldTera(enemyPokemon)) {
    battle.preTurnCommands[fieldIndex + BattlerIndex.ENEMY] = { command: Command.TERA };
  }

  battle.turnCommands[fieldIndex + BattlerIndex.ENEMY] = {
    command: Command.FIGHT,
    move: nextMove,
    skip: skipTurn,
  };

  battle.enemySwitchCounter = Math.max(battle.enemySwitchCounter - 1, 0);
  phase.end();
  return true;
}
