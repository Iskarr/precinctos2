/**
 * SimulationEngine — the "State of the City" for PrecinctOS.
 *
 * Responsibilities:
 *  1. Hold in-memory unit & incident state
 *  2. Periodically spawn random incidents
 *  3. Move DISPATCHED / ON_SCENE units toward their assigned incidents
 *  4. Resolve incidents after units spend enough time on scene
 *  5. Emit SimulationEvents for the SSE stream
 *
 * Design note: all interval-driven work is also exposed as public methods
 * (`tick`, `spawnRandomIncident`, `moveUnits`, …) so unit tests can drive
 * the engine deterministically without waiting for real timers.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SIMULATION_CONFIG,
  INCIDENT_TEMPLATES,
  type Incident,
  type Location,
  type SimulationConfig,
  type SimulationEvent,
  type SimulationEventType,
  type Unit,
  type UnitStatus,
  type UnitType,
} from '../types.js';

/** Custom error for invalid CAD operations (mapped to HTTP 4xx by the API). */
export class SimulationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'SimulationError';
  }
}

export class SimulationEngine extends EventEmitter {
  private readonly config: SimulationConfig;
  private readonly units = new Map<string, Unit>();
  private readonly incidents = new Map<string, Incident>();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private spawnTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Optional RNG override — inject in tests for deterministic behaviour. */
  private readonly random: () => number;

  constructor(
    config: Partial<SimulationConfig> = {},
    random: () => number = Math.random,
  ) {
    super();
    this.config = { ...DEFAULT_SIMULATION_CONFIG, ...config };
    this.random = random;
    this.seedInitialUnits();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Start the background simulation loops. Safe to call multiple times. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.tickTimer = setInterval(() => this.tick(), this.config.tickIntervalMs);
    this.spawnTimer = setInterval(
      () => this.maybeSpawnIncident(),
      this.config.incidentSpawnIntervalMs,
    );

    // Allow Node to exit even if timers are still scheduled (useful in tests).
    this.tickTimer.unref?.();
    this.spawnTimer.unref?.();
  }

  /** Stop the background loops. */
  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.spawnTimer) {
      clearInterval(this.spawnTimer);
      this.spawnTimer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── One simulation frame ─────────────────────────────────────────────────

  /**
   * Advance the simulation by one frame:
   * move units, transition arrivals to ON_SCENE, then resolve completed calls.
   */
  tick(): void {
    this.moveUnits();
    this.resolveCompletedIncidents();
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getUnits(): Unit[] {
    return Array.from(this.units.values()).map((u) => structuredClone(u));
  }

  getUnit(id: string): Unit | undefined {
    const unit = this.units.get(id);
    return unit ? structuredClone(unit) : undefined;
  }

  /** Active + pending incidents (excludes RESOLVED by default). */
  getIncidents(includeResolved = false): Incident[] {
    const all = Array.from(this.incidents.values());
    const filtered = includeResolved
      ? all
      : all.filter((i) => i.status !== 'RESOLVED');
    return filtered.map((i) => structuredClone(i));
  }

  getIncident(id: string): Incident | undefined {
    const incident = this.incidents.get(id);
    return incident ? structuredClone(incident) : undefined;
  }

  getConfig(): Readonly<SimulationConfig> {
    return this.config;
  }

  // ─── Mutations (API-facing) ───────────────────────────────────────────────

  /**
   * Assign a unit to an incident.
   * Rules:
   *  - Unit must exist and not be OFF_DUTY
   *  - Unit must be AVAILABLE (cannot double-dispatch)
   *  - Incident must exist and not already be RESOLVED
   */
  dispatch(unitId: string, incidentId: string): { unit: Unit; incident: Incident } {
    const unit = this.units.get(unitId);
    if (!unit) {
      throw new SimulationError(`Unit not found: ${unitId}`, 404);
    }

    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new SimulationError(`Incident not found: ${incidentId}`, 404);
    }

    if (unit.status === 'OFF_DUTY') {
      throw new SimulationError(
        `Unit ${unit.callsign} is OFF_DUTY and cannot be dispatched`,
        422,
      );
    }

    if (unit.status !== 'AVAILABLE') {
      throw new SimulationError(
        `Unit ${unit.callsign} is ${unit.status} and cannot accept a new dispatch`,
        422,
      );
    }

    if (incident.status === 'RESOLVED') {
      throw new SimulationError(
        `Incident ${incidentId} is already RESOLVED`,
        422,
      );
    }

    unit.status = 'DISPATCHED';
    unit.assignedIncidentId = incident.id;

    if (!incident.assignedUnits.includes(unit.id)) {
      incident.assignedUnits.push(unit.id);
    }
    incident.status = 'ACTIVE';

    this.emitEvent('DISPATCHED', { unitId: unit.id, incidentId: incident.id });
    this.emitEvent('UNIT_STATUS_CHANGED', { unit: structuredClone(unit) });
    this.emitEvent('INCIDENT_UPDATED', { incident: structuredClone(incident) });

    return {
      unit: structuredClone(unit),
      incident: structuredClone(incident),
    };
  }

  /**
   * Manually override a unit's status (e.g. mark OFF_DUTY).
   * Clearing DISPATCHED / ON_SCENE also unassigns them from their incident.
   */
  setUnitStatus(unitId: string, status: UnitStatus): Unit {
    const unit = this.units.get(unitId);
    if (!unit) {
      throw new SimulationError(`Unit not found: ${unitId}`, 404);
    }

    const validStatuses: UnitStatus[] = [
      'AVAILABLE',
      'DISPATCHED',
      'ON_SCENE',
      'OFF_DUTY',
    ];
    if (!validStatuses.includes(status)) {
      throw new SimulationError(`Invalid unit status: ${status}`, 400);
    }

    // Guard: you cannot manually jump to DISPATCHED / ON_SCENE without an incident.
    if (
      (status === 'DISPATCHED' || status === 'ON_SCENE') &&
      !unit.assignedIncidentId
    ) {
      throw new SimulationError(
        `Cannot set status to ${status} without an assigned incident — use POST /api/dispatch`,
        422,
      );
    }

    const previousStatus = unit.status;
    const previousIncidentId = unit.assignedIncidentId;

    // Going OFF_DUTY or AVAILABLE while assigned → detach from the incident.
    if (
      (status === 'OFF_DUTY' || status === 'AVAILABLE') &&
      unit.assignedIncidentId
    ) {
      this.unassignUnitFromIncident(unit);
    }

    unit.status = status;

    this.emitEvent('UNIT_STATUS_CHANGED', {
      unit: structuredClone(unit),
      previousStatus,
      previousIncidentId,
    });

    return structuredClone(unit);
  }

  // ─── Simulation internals (also public for testing) ───────────────────────

  /**
   * Generate a brand-new random incident and add it to the active queue.
   * Returns the created incident so tests can assert on its fields.
   */
  spawnRandomIncident(): Incident {
    const template =
      INCIDENT_TEMPLATES[
        Math.floor(this.random() * INCIDENT_TEMPLATES.length)
      ]!;

    const incident: Incident = {
      id: randomUUID(),
      code: template.code,
      priority: template.priority,
      description: template.description,
      status: 'PENDING',
      location: this.randomLocation(),
      assignedUnits: [],
      createdAt: Date.now(),
      arrivedAt: null,
    };

    this.incidents.set(incident.id, incident);
    this.emitEvent('INCIDENT_CREATED', { incident: structuredClone(incident) });
    return structuredClone(incident);
  }

  /**
   * Probabilistic spawn used by the background interval.
   * Returns the incident if one was created, otherwise null.
   */
  maybeSpawnIncident(): Incident | null {
    if (this.random() > this.config.incidentSpawnChance) {
      return null;
    }
    return this.spawnRandomIncident();
  }

  /**
   * Move every DISPATCHED / ON_SCENE unit one step closer to its incident.
   * When a DISPATCHED unit comes within the arrival threshold it becomes ON_SCENE.
   */
  moveUnits(): void {
    for (const unit of this.units.values()) {
      if (unit.status !== 'DISPATCHED' && unit.status !== 'ON_SCENE') {
        continue;
      }
      if (!unit.assignedIncidentId) continue;

      const incident = this.incidents.get(unit.assignedIncidentId);
      if (!incident || incident.status === 'RESOLVED') continue;

      const next = moveToward(
        unit.location,
        incident.location,
        this.config.movementStepDegrees,
      );

      unit.location = next;
      const distanceAfter = distanceDegrees(unit.location, incident.location);

      this.emitEvent('UNIT_MOVED', {
        unitId: unit.id,
        location: { ...unit.location },
        distanceRemaining: distanceAfter,
      });

      // Arrival: first time within threshold while DISPATCHED → ON_SCENE.
      if (
        unit.status === 'DISPATCHED' &&
        distanceAfter <= this.config.arrivalThresholdDegrees
      ) {
        unit.status = 'ON_SCENE';
        unit.location = { ...incident.location }; // snap to exact scene
        if (incident.arrivedAt === null) {
          incident.arrivedAt = Date.now();
        }
        this.emitEvent('UNIT_STATUS_CHANGED', { unit: structuredClone(unit) });
        this.emitEvent('INCIDENT_UPDATED', {
          incident: structuredClone(incident),
        });
      }
    }
  }

  /**
   * Resolve incidents whose units have been on scene long enough.
   * Freed units return to AVAILABLE.
   */
  resolveCompletedIncidents(now: number = Date.now()): void {
    for (const incident of this.incidents.values()) {
      if (incident.status !== 'ACTIVE') continue;
      if (incident.arrivedAt === null) continue;

      const elapsed = now - incident.arrivedAt;
      if (elapsed < this.config.onSceneDurationMs) continue;

      // Free every assigned unit.
      for (const unitId of incident.assignedUnits) {
        const unit = this.units.get(unitId);
        if (!unit) continue;
        unit.status = 'AVAILABLE';
        unit.assignedIncidentId = null;
        this.emitEvent('UNIT_STATUS_CHANGED', { unit: structuredClone(unit) });
      }

      incident.status = 'RESOLVED';
      this.emitEvent('INCIDENT_RESOLVED', {
        incident: structuredClone(incident),
      });
    }
  }

  /**
   * Pure helper exposed for tests: given from/to locations and a step size,
   * return the new location after one movement step.
   */
  static moveToward(from: Location, to: Location, stepDegrees: number): Location {
    return moveToward(from, to, stepDegrees);
  }

  static distanceDegrees(a: Location, b: Location): number {
    return distanceDegrees(a, b);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private unassignUnitFromIncident(unit: Unit): void {
    if (!unit.assignedIncidentId) return;
    const incident = this.incidents.get(unit.assignedIncidentId);
    if (incident) {
      incident.assignedUnits = incident.assignedUnits.filter(
        (id) => id !== unit.id,
      );
      // If nobody left and it was ACTIVE but never fully handled, go back PENDING.
      if (
        incident.assignedUnits.length === 0 &&
        incident.status === 'ACTIVE' &&
        incident.arrivedAt === null
      ) {
        incident.status = 'PENDING';
      }
      this.emitEvent('INCIDENT_UPDATED', {
        incident: structuredClone(incident),
      });
    }
    unit.assignedIncidentId = null;
  }

  private emitEvent(type: SimulationEventType, payload: unknown): void {
    const event: SimulationEvent = {
      type,
      timestamp: Date.now(),
      payload,
    };
    this.emit('event', event);
  }

  private randomLocation(): Location {
    const { minLat, maxLat, minLng, maxLng } = this.config.cityBounds;
    return {
      latitude: minLat + this.random() * (maxLat - minLat),
      longitude: minLng + this.random() * (maxLng - minLng),
    };
  }

  private seedInitialUnits(): void {
    const roster: Array<{ callsign: string; type: UnitType }> = [
      { callsign: '1-Adam-12', type: 'PATROL' },
      { callsign: '1-Adam-14', type: 'PATROL' },
      { callsign: '2-Boy-6', type: 'PATROL' },
      { callsign: '3-Lincoln-7', type: 'TRAFFIC' },
      { callsign: 'K9-1', type: 'K9' },
      { callsign: 'SWAT-1', type: 'TACTICAL' },
    ];

    for (const entry of roster) {
      const unit: Unit = {
        id: randomUUID(),
        callsign: entry.callsign,
        status: 'AVAILABLE',
        type: entry.type,
        location: this.randomLocation(),
        assignedIncidentId: null,
      };
      this.units.set(unit.id, unit);
    }
  }

  /**
   * Test helper: inject a unit directly into the store (bypasses seeding).
   */
  upsertUnit(unit: Unit): void {
    this.units.set(unit.id, structuredClone(unit));
  }

  /**
   * Test helper: inject an incident directly into the store.
   */
  upsertIncident(incident: Incident): void {
    this.incidents.set(incident.id, structuredClone(incident));
  }
}

// ─── Pure geometry helpers ──────────────────────────────────────────────────

/**
 * Move `from` toward `to` by at most `stepDegrees` (Euclidean in lat/lng space).
 * If already within one step, snap exactly onto the destination.
 */
function moveToward(
  from: Location,
  to: Location,
  stepDegrees: number,
): Location {
  const dLat = to.latitude - from.latitude;
  const dLng = to.longitude - from.longitude;
  const dist = Math.sqrt(dLat * dLat + dLng * dLng);

  if (dist === 0 || dist <= stepDegrees) {
    return { latitude: to.latitude, longitude: to.longitude };
  }

  const ratio = stepDegrees / dist;
  return {
    latitude: from.latitude + dLat * ratio,
    longitude: from.longitude + dLng * ratio,
  };
}

/** Straight-line distance in degrees (sufficient for short urban hops). */
function distanceDegrees(a: Location, b: Location): number {
  const dLat = b.latitude - a.latitude;
  const dLng = b.longitude - a.longitude;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}
