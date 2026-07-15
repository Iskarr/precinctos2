/**
 * Unit tests for the PrecinctOS SimulationEngine.
 *
 * These drive the engine manually (no real timers) so results are deterministic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SimulationEngine,
  SimulationError,
} from './SimulationEngine.js';
import type { Incident, Unit } from '../types.js';

/** Fixed RNG that always returns `value` — useful for spawn-chance tests. */
function constantRandom(value: number): () => number {
  return () => value;
}

describe('SimulationEngine', () => {
  let engine: SimulationEngine;

  beforeEach(() => {
    // Deterministic RNG (always mid-range) so seed locations are stable-ish.
    engine = new SimulationEngine(
      {
        tickIntervalMs: 1000,
        incidentSpawnIntervalMs: 5000,
        incidentSpawnChance: 1,
        movementStepDegrees: 0.01,
        arrivalThresholdDegrees: 0.001,
        onSceneDurationMs: 30_000,
      },
      constantRandom(0.5),
    );
  });

  // ── Incident generation ───────────────────────────────────────────────────

  describe('incident generator', () => {
    it('spawns a new incident with valid random properties', () => {
      const before = engine.getIncidents().length;
      const incident = engine.spawnRandomIncident();

      expect(incident.id).toBeTruthy();
      expect(typeof incident.id).toBe('string');
      expect(incident.code).toMatch(/^(10-\d+|11-\d+|Code 3)$/);
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(incident.priority);
      expect(incident.description.length).toBeGreaterThan(0);
      expect(incident.status).toBe('PENDING');
      expect(incident.assignedUnits).toEqual([]);
      expect(incident.arrivedAt).toBeNull();
      expect(typeof incident.createdAt).toBe('number');

      const { cityBounds } = engine.getConfig();
      expect(incident.location.latitude).toBeGreaterThanOrEqual(cityBounds.minLat);
      expect(incident.location.latitude).toBeLessThanOrEqual(cityBounds.maxLat);
      expect(incident.location.longitude).toBeGreaterThanOrEqual(cityBounds.minLng);
      expect(incident.location.longitude).toBeLessThanOrEqual(cityBounds.maxLng);

      expect(engine.getIncidents()).toHaveLength(before + 1);
    });

    it('maybeSpawnIncident respects spawn chance (skips when RNG is high)', () => {
      const shyEngine = new SimulationEngine(
        { incidentSpawnChance: 0.3 },
        constantRandom(0.9), // 0.9 > 0.3 → skip
      );
      expect(shyEngine.maybeSpawnIncident()).toBeNull();
    });

    it('maybeSpawnIncident creates an incident when chance succeeds', () => {
      const eagerEngine = new SimulationEngine(
        { incidentSpawnChance: 0.3 },
        constantRandom(0.1), // 0.1 <= 0.3 → spawn
      );
      const incident = eagerEngine.maybeSpawnIncident();
      expect(incident).not.toBeNull();
      expect(incident!.status).toBe('PENDING');
    });
  });

  // ── Movement physics ──────────────────────────────────────────────────────

  describe('movement physics', () => {
    it('moves a unit closer to its assigned incident on each update step', () => {
      const pointA = { latitude: 34.04, longitude: -118.28 };
      const pointB = { latitude: 34.08, longitude: -118.22 };

      const unit: Unit = {
        id: 'unit-test-1',
        callsign: 'TEST-1',
        status: 'DISPATCHED',
        type: 'PATROL',
        location: { ...pointA },
        assignedIncidentId: 'incident-test-1',
      };

      const incident: Incident = {
        id: 'incident-test-1',
        code: '10-31',
        priority: 'HIGH',
        description: 'Crime in progress',
        status: 'ACTIVE',
        location: { ...pointB },
        assignedUnits: [unit.id],
        createdAt: Date.now(),
        arrivedAt: null,
      };

      engine.upsertUnit(unit);
      engine.upsertIncident(incident);

      const distanceBefore = SimulationEngine.distanceDegrees(
        pointA,
        pointB,
      );

      engine.moveUnits();

      const moved = engine.getUnit(unit.id)!;
      const distanceAfter = SimulationEngine.distanceDegrees(
        moved.location,
        pointB,
      );

      expect(distanceAfter).toBeLessThan(distanceBefore);
      // Still heading toward B (not past it in one large leap with our step size).
      expect(distanceAfter).toBeGreaterThan(0);
    });

    it('moveToward snaps to destination when within one step', () => {
      const from = { latitude: 34.05, longitude: -118.25 };
      const to = { latitude: 34.0501, longitude: -118.2501 };
      const next = SimulationEngine.moveToward(from, to, 0.01);

      expect(next.latitude).toBe(to.latitude);
      expect(next.longitude).toBe(to.longitude);
    });

    it('transitions DISPATCHED → ON_SCENE when within arrival threshold', () => {
      const scene = { latitude: 34.05, longitude: -118.25 };

      engine.upsertUnit({
        id: 'unit-near',
        callsign: 'NEAR-1',
        status: 'DISPATCHED',
        type: 'PATROL',
        // Already almost on top of the scene.
        location: { latitude: 34.0502, longitude: -118.2502 },
        assignedIncidentId: 'inc-near',
      });

      engine.upsertIncident({
        id: 'inc-near',
        code: '10-50',
        priority: 'MEDIUM',
        description: 'Traffic collision',
        status: 'ACTIVE',
        location: { ...scene },
        assignedUnits: ['unit-near'],
        createdAt: Date.now(),
        arrivedAt: null,
      });

      engine.moveUnits();

      const unit = engine.getUnit('unit-near')!;
      expect(unit.status).toBe('ON_SCENE');
      expect(unit.location).toEqual(scene);

      const incident = engine.getIncident('inc-near')!;
      expect(incident.arrivedAt).not.toBeNull();
    });
  });

  // ── Status transitions ────────────────────────────────────────────────────

  describe('unit status transitions', () => {
    it('dispatches an AVAILABLE unit onto a PENDING incident', () => {
      const unit = engine.getUnits().find((u) => u.status === 'AVAILABLE')!;
      const incident = engine.spawnRandomIncident();

      const result = engine.dispatch(unit.id, incident.id);

      expect(result.unit.status).toBe('DISPATCHED');
      expect(result.unit.assignedIncidentId).toBe(incident.id);
      expect(result.incident.status).toBe('ACTIVE');
      expect(result.incident.assignedUnits).toContain(unit.id);
    });

    it('cannot dispatch a unit that is OFF_DUTY', () => {
      const unit = engine.getUnits()[0]!;
      engine.setUnitStatus(unit.id, 'OFF_DUTY');

      const incident = engine.spawnRandomIncident();

      expect(() => engine.dispatch(unit.id, incident.id)).toThrow(
        SimulationError,
      );

      try {
        engine.dispatch(unit.id, incident.id);
      } catch (err) {
        expect(err).toBeInstanceOf(SimulationError);
        expect((err as SimulationError).statusCode).toBe(422);
        expect((err as SimulationError).message).toMatch(/OFF_DUTY/i);
      }

      // Unit remains off duty; incident still pending.
      expect(engine.getUnit(unit.id)!.status).toBe('OFF_DUTY');
      expect(engine.getIncident(incident.id)!.status).toBe('PENDING');
    });

    it('cannot double-dispatch a unit that is already DISPATCHED', () => {
      const [unitA, unitB] = engine.getUnits();
      expect(unitA).toBeDefined();
      expect(unitB).toBeDefined();

      const first = engine.spawnRandomIncident();
      const second = engine.spawnRandomIncident();

      engine.dispatch(unitA!.id, first.id);

      expect(() => engine.dispatch(unitA!.id, second.id)).toThrow(
        /DISPATCHED/i,
      );
    });

    it('resolves an incident after on-scene duration and frees the unit', () => {
      const now = Date.now();

      engine.upsertUnit({
        id: 'unit-resolve',
        callsign: 'RES-1',
        status: 'ON_SCENE',
        type: 'PATROL',
        location: { latitude: 34.05, longitude: -118.25 },
        assignedIncidentId: 'inc-resolve',
      });

      engine.upsertIncident({
        id: 'inc-resolve',
        code: '10-31',
        priority: 'HIGH',
        description: 'Crime in progress',
        status: 'ACTIVE',
        location: { latitude: 34.05, longitude: -118.25 },
        assignedUnits: ['unit-resolve'],
        createdAt: now - 60_000,
        arrivedAt: now - 31_000, // past the 30s on-scene window
      });

      engine.resolveCompletedIncidents(now);

      expect(engine.getIncident('inc-resolve')!.status).toBe('RESOLVED');
      expect(engine.getUnit('unit-resolve')!.status).toBe('AVAILABLE');
      expect(engine.getUnit('unit-resolve')!.assignedIncidentId).toBeNull();
    });
  });
});
