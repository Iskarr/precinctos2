/**
 * PrecinctOS Express API entry point.
 *
 * Exposes:
 *  - REST endpoints for units, incidents, dispatch, and status overrides
 *  - Server-Sent Events stream at GET /api/stream for live state updates
 *
 * The SimulationEngine is injected via `createApp` so integration tests
 * can supply a controlled engine (no background timers required).
 */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SimulationEngine,
  SimulationError,
} from './simulation/SimulationEngine.js';
import type { SimulationEvent, UnitStatus } from './types.js';

const VALID_UNIT_STATUSES: UnitStatus[] = [
  'AVAILABLE',
  'DISPATCHED',
  'ON_SCENE',
  'OFF_DUTY',
];

/**
 * Build an Express application wired to the given simulation engine.
 * Does NOT start the engine or listen on a port — callers control that.
 */
export function createApp(engine: SimulationEngine): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'precinctos-server',
      simulationRunning: engine.isRunning(),
    });
  });

  // ── Units ─────────────────────────────────────────────────────────────────
  app.get('/api/units', (_req, res) => {
    res.json({ units: engine.getUnits() });
  });

  app.post('/api/units/:id/status', (req, res, next) => {
    try {
      const { status } = req.body as { status?: unknown };

      if (typeof status !== 'string' || !VALID_UNIT_STATUSES.includes(status as UnitStatus)) {
        res.status(400).json({
          error: 'Bad Request',
          message: `body.status must be one of: ${VALID_UNIT_STATUSES.join(', ')}`,
        });
        return;
      }

      const unit = engine.setUnitStatus(req.params.id, status as UnitStatus);
      res.json({ unit });
    } catch (err) {
      next(err);
    }
  });

  // ── Incidents ─────────────────────────────────────────────────────────────
  app.get('/api/incidents', (req, res) => {
    const includeResolved = req.query.includeResolved === 'true';
    res.json({ incidents: engine.getIncidents(includeResolved) });
  });

  // ── Dispatch ──────────────────────────────────────────────────────────────
  app.post('/api/dispatch', (req, res, next) => {
    try {
      const { unitId, incidentId } = req.body as {
        unitId?: unknown;
        incidentId?: unknown;
      };

      if (typeof unitId !== 'string' || unitId.length === 0) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'body.unitId must be a non-empty string',
        });
        return;
      }

      if (typeof incidentId !== 'string' || incidentId.length === 0) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'body.incidentId must be a non-empty string',
        });
        return;
      }

      const result = engine.dispatch(unitId, incidentId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── Live stream (Server-Sent Events) ──────────────────────────────────────
  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Disable Express / proxy buffering where supported.
    res.flushHeaders?.();

    // Immediate hello so clients know the pipe is open.
    writeSse(res, {
      type: 'CONNECTED',
      timestamp: Date.now(),
      payload: { message: 'PrecinctOS live stream connected' },
    });

    const onEvent = (event: SimulationEvent) => {
      writeSse(res, event);
    };

    engine.on('event', onEvent);

    // Keepalive comments every 15s (prevents idle proxy timeouts).
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15_000);
    keepalive.unref?.();

    req.on('close', () => {
      clearInterval(keepalive);
      engine.off('event', onEvent);
    });
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      if (err instanceof SimulationError) {
        res.status(err.statusCode).json({
          error: statusLabel(err.statusCode),
          message: err.message,
        });
        return;
      }

      console.error('[server] Unhandled error:', err);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred',
      });
    },
  );

  return app;
}

function writeSse(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function statusLabel(code: number): string {
  switch (code) {
    case 400:
      return 'Bad Request';
    case 404:
      return 'Not Found';
    case 422:
      return 'Unprocessable Entity';
    default:
      return 'Error';
  }
}

// ── Boot when run directly (`npm run dev` / `npm start`) ────────────────────

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);

export function boot(port = Number(process.env.PORT) || 3001): {
  engine: SimulationEngine;
  app: Express;
  server: ReturnType<Express['listen']>;
} {
  const engine = new SimulationEngine();
  engine.start();

  const app = createApp(engine);
  const server = app.listen(port, () => {
    console.log(`PrecinctOS backend listening on http://localhost:${port}`);
    console.log(`  REST  → http://localhost:${port}/api/units`);
    console.log(`  SSE   → http://localhost:${port}/api/stream`);
  });

  const shutdown = () => {
    console.log('\nShutting down PrecinctOS…');
    engine.stop();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { engine, app, server };
}

if (isMainModule) {
  boot();
}
