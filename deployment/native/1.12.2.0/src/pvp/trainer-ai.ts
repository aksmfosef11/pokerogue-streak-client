// SPDX-License-Identifier: AGPL-3.0-only

import { MoveCategory } from "#enums/move-category";
import type { EnemyPokemon } from "#field/pokemon";

export interface TrainerPersonality {
  switchThreshold: number;
  attackWeight: number;
  statusWeight: number;
  teraTurn: number;
}

let personality: TrainerPersonality | undefined;
let teraUsed = false;

/** The match seed is generated on the server and remains fixed for replay. */
export function configureTrainerAi(seed?: string): void {
  teraUsed = false;
  if (!seed) {
    personality = undefined;
    return;
  }
  let hash = 2166136261;
  for (const character of seed) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  const attack = (((hash >>> 8) % 25) - 12) / 100;
  personality = {
    switchThreshold: 1.8 + (hash % 6) / 10,
    attackWeight: 1 + attack,
    statusWeight: 1 - attack,
    teraTurn: 1 + ((hash >>> 16) % 3),
  };
}

export function trainerPersonality(): TrainerPersonality | undefined {
  return personality;
}

/** Only one enemy Tera per match. Replaying the match reconstructs this state. */
export function chooseTrainerTera(pokemon: EnemyPokemon, turn: number, remaining: number): boolean {
  if (!personality || teraUsed || pokemon.isTerastallized || pokemon.isMega() || pokemon.isMax()) {
    return false;
  }
  const hasTeraAttack = pokemon.getMoveset().some(move => {
    const data = move.getMove();
    return (
      data.category !== MoveCategory.STATUS
      && data.type === pokemon.getTeraType()
      && move.isUsable(pokemon, false, true)[0]
    );
  });
  const underPressure = pokemon.hp <= pokemon.getMaxHp() / 2;
  if (remaining > 1 && !underPressure && !(hasTeraAttack && turn >= personality.teraTurn) && turn < 5) {
    return false;
  }
  teraUsed = true;
  return true;
}

/** Temporarily weight the native AI's move benefit scores, without changing KO selection. */
export function withTrainerMoveWeights<T>(pokemon: EnemyPokemon, action: () => T): T {
  if (!personality) {
    return action();
  }
  const profile = personality;
  const restore: (() => void)[] = [];
  try {
    for (const move of new Set(pokemon.getMoveset().map(entry => entry.getMove()))) {
      const weight = move.category === MoveCategory.STATUS ? profile.statusWeight : profile.attackWeight;
      for (const key of ["getUserBenefitScore", "getTargetBenefitScore"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(move, key);
        const original = move[key];
        Reflect.set(move, key, function (this: typeof move, ...args: Parameters<typeof original>) {
          return original.apply(this, args) * weight;
        });
        restore.push(() =>
          descriptor ? Object.defineProperty(move, key, descriptor) : Reflect.deleteProperty(move, key),
        );
      }
    }
    return action();
  } finally {
    for (const reset of restore.reverse()) {
      reset();
    }
  }
}
