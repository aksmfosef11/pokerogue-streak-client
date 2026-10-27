// SPDX-License-Identifier: AGPL-3.0-only

import { MoveCategory } from "#enums/move-category";
import type { EnemyPokemon } from "#field/pokemon";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseTrainerTera,
  configureTrainerAi,
  trainerPersonality,
  withTrainerMoveWeights,
} from "../../../src/pvp/trainer-ai";

describe("streak trainer personality", () => {
  afterEach(() => configureTrainerAi());

  it("is repeatable for the same match and varies across match seeds", () => {
    configureTrainerAi("match-one");
    const first = trainerPersonality();
    configureTrainerAi("match-one");
    expect(trainerPersonality()).toEqual(first);
    const variants = new Set(
      Array.from({ length: 30 }, (_, i) => {
        configureTrainerAi(`match-${i}`);
        return JSON.stringify(trainerPersonality());
      }),
    );
    expect(variants.size).toBeGreaterThan(10);
  });

  it("uses at most one Tera, resets for replay, and skips incompatible forms", () => {
    const pokemon = {
      hp: 50,
      getMaxHp: () => 100,
      isTerastallized: false,
      isMega: () => false,
      isMax: () => false,
      getTeraType: () => 1,
      getMoveset: () => [],
    } as unknown as EnemyPokemon;
    configureTrainerAi("match-one");
    expect(chooseTrainerTera(pokemon, 1, 2)).toBe(true);
    expect(chooseTrainerTera(pokemon, 2, 1)).toBe(false);
    configureTrainerAi("match-one");
    expect(chooseTrainerTera({ ...pokemon, isMega: () => true } as EnemyPokemon, 1, 1)).toBe(false);
    expect(chooseTrainerTera({ ...pokemon, isMax: () => true } as EnemyPokemon, 1, 1)).toBe(false);
    expect(chooseTrainerTera(pokemon, 1, 1)).toBe(true);
  });

  it("weights move scores only while evaluating the enemy move and restores them even on failure", () => {
    const move = { category: MoveCategory.STATUS, getUserBenefitScore: () => 10, getTargetBenefitScore: () => 5 };
    const pokemon = { getMoveset: () => [{ getMove: () => move }] } as unknown as EnemyPokemon;
    configureTrainerAi("match-one");
    const weight = trainerPersonality()!.statusWeight;
    expect(withTrainerMoveWeights(pokemon, () => move.getUserBenefitScore())).toBeCloseTo(10 * weight);
    expect(move.getUserBenefitScore()).toBe(10);
    expect(() =>
      withTrainerMoveWeights(pokemon, () => {
        throw new Error("failed");
      }),
    ).toThrow("failed");
    expect(move.getTargetBenefitScore()).toBe(5);
  });
});
