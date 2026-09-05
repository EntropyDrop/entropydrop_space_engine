export const ENTITY_UPDATE_HZ = 20;
export const ENTITY_UPDATE_DT = 1 / ENTITY_UPDATE_HZ;
export const PHYSICS_SUBSTEPS_PER_ENTITY_UPDATE = 3;

const MAX_FRAME_DELTA = 0.08;
const MAX_ENTITY_UPDATES_PER_FRAME = 2;
const STEP_EPSILON = 1e-9;

export type EntitySimulationAdvance = Readonly<{
  steps: number;
  alpha: number;
}>;

/**
 * The one fixed clock shared by player simulation, entity code, and entity
 * physics. Its cadence is deliberately not configurable: render frames merely
 * add elapsed time and interpolate between the two latest simulation poses.
 */
export class EntitySimulationClock {
  private accumulator = 0;

  advance(frameDelta: number, step: (dt: number) => void): EntitySimulationAdvance {
    const safeDelta = Number.isFinite(frameDelta)
      ? Math.max(0, Math.min(MAX_FRAME_DELTA, frameDelta))
      : 0;
    this.accumulator += safeDelta;

    let steps = 0;
    while (
      this.accumulator + STEP_EPSILON >= ENTITY_UPDATE_DT
      && steps < MAX_ENTITY_UPDATES_PER_FRAME
    ) {
      step(ENTITY_UPDATE_DT);
      this.accumulator = Math.max(0, this.accumulator - ENTITY_UPDATE_DT);
      steps++;
    }

    // MAX_FRAME_DELTA is below two fixed steps, so this is only reachable
    // after a floating-point edge case or a future caller bypasses that cap.
    // Never enter a spiral of death trying to replay stale simulation time.
    if (this.accumulator >= ENTITY_UPDATE_DT) {
      this.accumulator %= ENTITY_UPDATE_DT;
    }

    return Object.freeze({
      steps,
      alpha: Math.max(0, Math.min(1, this.accumulator / ENTITY_UPDATE_DT))
    });
  }

  reset(): void {
    this.accumulator = 0;
  }
}
