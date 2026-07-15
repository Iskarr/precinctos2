/**
 * Shared domain types for the PrecinctOS dispatch simulation.
 *
 * These interfaces define the shape of units, incidents, and the
 * real-time events streamed to connected clients.
 */

/** Geographic coordinates used for unit/incident placement. */
export interface Location {
  latitude: number;
  longitude: number;
}

/** Current operational status of a police unit. */
export type UnitStatus = 'AVAILABLE' | 'DISPATCHED' | 'ON_SCENE' | 'OFF_DUTY';

/** Classification of a unit's role / equipment. */
export type UnitType = 'PATROL' | 'K9' | 'TRAFFIC' | 'TACTICAL';

/** How urgently an incident needs response. */
export type IncidentPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Lifecycle stage of an emergency call. */
export type IncidentStatus = 'PENDING' | 'ACTIVE' | 'RESOLVED';

/** A police officer / vehicle tracked by the CAD system. */
export interface Unit {
  id: string;
  callsign: string;
  status: UnitStatus;
  type: UnitType;
  location: Location;
  /** Incident currently assigned to this unit, if any. */
  assignedIncidentId: string | null;
}

/** An emergency call (active or historical). */
export interface Incident {
  id: string;
  /** Radio/ten-code style identifier, e.g. "10-31". */
  code: string;
  priority: IncidentPriority;
  description: string;
  status: IncidentStatus;
  location: Location;
  assignedUnits: string[];
  createdAt: number;
  /** Wall-clock ms when the first unit arrived on scene (for resolution timing). */
  arrivedAt: number | null;
}

/** Event kinds emitted by the simulation / API for live streaming. */
export type SimulationEventType =
  | 'UNIT_MOVED'
  | 'UNIT_STATUS_CHANGED'
  | 'INCIDENT_CREATED'
  | 'INCIDENT_UPDATED'
  | 'INCIDENT_RESOLVED'
  | 'DISPATCHED';

/** Envelope sent over SSE (or logged) when state changes. */
export interface SimulationEvent {
  type: SimulationEventType;
  timestamp: number;
  payload: unknown;
}

/** Tunable knobs for the background simulation loop. */
export interface SimulationConfig {
  /** How often the engine ticks (ms). Default: 2000. */
  tickIntervalMs: number;
  /** How often we attempt to spawn a new incident (ms). Default: 20000. */
  incidentSpawnIntervalMs: number;
  /** Probability (0–1) of spawning an incident each spawn interval. Default: 0.6. */
  incidentSpawnChance: number;
  /** Degrees moved toward a target per tick. Default: 0.002 (~200m at mid-latitudes). */
  movementStepDegrees: number;
  /** Distance threshold in degrees to count as "arrived". Default: 0.0005. */
  arrivalThresholdDegrees: number;
  /** How long a unit stays on scene before resolving (ms). Default: 30000. */
  onSceneDurationMs: number;
  /** Bounding box for random incident / unit spawn. */
  cityBounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  tickIntervalMs: 2000,
  incidentSpawnIntervalMs: 20000,
  incidentSpawnChance: 0.6,
  movementStepDegrees: 0.002,
  arrivalThresholdDegrees: 0.0005,
  onSceneDurationMs: 30_000,
  // Rough downtown bounding box (fictional precinct overlay).
  cityBounds: {
    minLat: 34.04,
    maxLat: 34.08,
    minLng: -118.28,
    maxLng: -118.22,
  },
};

/** Catalog of ten-codes / incident templates used by the generator. */
export interface IncidentTemplate {
  code: string;
  description: string;
  priority: IncidentPriority;
}

export const INCIDENT_TEMPLATES: IncidentTemplate[] = [
  { code: '10-31', description: 'Crime in progress', priority: 'HIGH' },
  { code: '10-15', description: 'Civil disturbance', priority: 'MEDIUM' },
  { code: '10-50', description: 'Traffic collision', priority: 'MEDIUM' },
  { code: '11-99', description: 'Officer needs help', priority: 'CRITICAL' },
  { code: '10-71', description: 'Shooting reported', priority: 'CRITICAL' },
  { code: '10-16', description: 'Domestic dispute', priority: 'HIGH' },
  { code: '10-66', description: 'Suspicious person', priority: 'LOW' },
  { code: '10-33', description: 'Alarm sounding', priority: 'MEDIUM' },
  { code: '10-40', description: 'Fight in progress', priority: 'HIGH' },
  { code: 'Code 3', description: 'Medical assist requested', priority: 'MEDIUM' },
];
