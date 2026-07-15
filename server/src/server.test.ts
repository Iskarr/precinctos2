/**
 * Integration tests for the PrecinctOS REST API.
 *
 * Uses Supertest against an Express app wired to a fresh SimulationEngine
 * (no background timers — we only exercise HTTP ↔ state-layer wiring).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from './server.js';
import { SimulationEngine } from './simulation/SimulationEngine.js';

describe('PrecinctOS REST API', () => {
  let engine: SimulationEngine;
  let app: Express;

  beforeEach(() => {
    engine = new SimulationEngine({ incidentSpawnChance: 0 });
    // Do NOT call engine.start() — keep tests free of intervals.
    app = createApp(engine);
  });

  // ── Happy paths ───────────────────────────────────────────────────────────

  describe('GET /api/units', () => {
    it('returns the seeded roster', async () => {
      const res = await request(app).get('/api/units').expect(200);

      expect(Array.isArray(res.body.units)).toBe(true);
      expect(res.body.units.length).toBeGreaterThan(0);
      expect(res.body.units[0]).toMatchObject({
        id: expect.any(String),
        callsign: expect.any(String),
        status: expect.any(String),
        type: expect.any(String),
        location: {
          latitude: expect.any(Number),
          longitude: expect.any(Number),
        },
      });
    });
  });

  describe('GET /api/incidents', () => {
    it('returns active/pending incidents only by default', async () => {
      engine.spawnRandomIncident();

      const res = await request(app).get('/api/incidents').expect(200);

      expect(res.body.incidents).toHaveLength(1);
      expect(res.body.incidents[0].status).toBe('PENDING');
    });
  });

  describe('POST /api/dispatch', () => {
    it('links a unit to an incident and updates both statuses', async () => {
      const unit = engine.getUnits().find((u) => u.status === 'AVAILABLE')!;
      const incident = engine.spawnRandomIncident();

      const res = await request(app)
        .post('/api/dispatch')
        .send({ unitId: unit.id, incidentId: incident.id })
        .expect(200);

      expect(res.body.unit.status).toBe('DISPATCHED');
      expect(res.body.unit.assignedIncidentId).toBe(incident.id);
      expect(res.body.incident.status).toBe('ACTIVE');
      expect(res.body.incident.assignedUnits).toContain(unit.id);

      // State layer reflects the same mutation.
      expect(engine.getUnit(unit.id)!.status).toBe('DISPATCHED');
      expect(engine.getIncident(incident.id)!.status).toBe('ACTIVE');
    });
  });

  describe('POST /api/units/:id/status', () => {
    it('overrides a unit status to OFF_DUTY', async () => {
      const unit = engine.getUnits()[0]!;

      const res = await request(app)
        .post(`/api/units/${unit.id}/status`)
        .send({ status: 'OFF_DUTY' })
        .expect(200);

      expect(res.body.unit.status).toBe('OFF_DUTY');
      expect(engine.getUnit(unit.id)!.status).toBe('OFF_DUTY');
    });
  });

  // ── Error cases ───────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns 400 when dispatch body is missing fields', async () => {
      const res = await request(app)
        .post('/api/dispatch')
        .send({ unitId: 'only-unit' })
        .expect(400);

      expect(res.body.error).toBe('Bad Request');
      expect(res.body.message).toMatch(/incidentId/i);
    });

    it('returns 404 for unknown unit or incident IDs', async () => {
      const incident = engine.spawnRandomIncident();

      await request(app)
        .post('/api/dispatch')
        .send({ unitId: 'does-not-exist', incidentId: incident.id })
        .expect(404);

      const unit = engine.getUnits()[0]!;
      await request(app)
        .post('/api/dispatch')
        .send({ unitId: unit.id, incidentId: 'does-not-exist' })
        .expect(404);
    });

    it('returns 422 when dispatching an OFF_DUTY unit', async () => {
      const unit = engine.getUnits()[0]!;
      engine.setUnitStatus(unit.id, 'OFF_DUTY');
      const incident = engine.spawnRandomIncident();

      const res = await request(app)
        .post('/api/dispatch')
        .send({ unitId: unit.id, incidentId: incident.id })
        .expect(422);

      expect(res.body.error).toBe('Unprocessable Entity');
      expect(res.body.message).toMatch(/OFF_DUTY/i);
    });

    it('returns 400 for an invalid status override value', async () => {
      const unit = engine.getUnits()[0]!;

      const res = await request(app)
        .post(`/api/units/${unit.id}/status`)
        .send({ status: 'VACATION' })
        .expect(400);

      expect(res.body.error).toBe('Bad Request');
    });

    it('returns 404 when overriding status for an unknown unit', async () => {
      await request(app)
        .post('/api/units/missing-id/status')
        .send({ status: 'OFF_DUTY' })
        .expect(404);
    });

    it('returns 422 when manually setting DISPATCHED without an assignment', async () => {
      const unit = engine.getUnits()[0]!;

      const res = await request(app)
        .post(`/api/units/${unit.id}/status`)
        .send({ status: 'DISPATCHED' })
        .expect(422);

      expect(res.body.error).toBe('Unprocessable Entity');
    });
  });
});
