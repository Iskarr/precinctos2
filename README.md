# PrecinctOS

Police dispatch simulation app. The **server** runs a real-time city simulation and REST/SSE API; the **frontend** is a Next.js App Router starter (not wired to the backend yet).

```
PrecinctOS2/
├── server/      # Node.js + Express + TypeScript backend
└── frontend/    # Next.js frontend
```

## Prerequisites

- [Node.js](https://nodejs.org/) **18+** (20+ recommended)
- npm (comes with Node)

There is no install at the repo root — set up `server` and `frontend` separately.

---

## Server (backend)

Simulates units and incidents in memory, exposes a REST API, and streams live events over SSE.

### Install

```bash
cd server
npm install
```

No database, `.env`, or migrations required. Optional: set `PORT` (default is `3001`).

### Run

```bash
npm run dev
```

Server starts at **http://localhost:3001**.

Useful URLs:

| URL | Description |
|-----|-------------|
| `GET /api/health` | Health check |
| `GET /api/units` | All police units |
| `GET /api/incidents` | Active / pending incidents |
| `POST /api/dispatch` | Assign a unit to an incident (`{ "unitId", "incidentId" }`) |
| `POST /api/units/:id/status` | Override unit status (`{ "status" }`) |
| `GET /api/stream` | Live Server-Sent Events feed |

### Tests

```bash
npm test
```

### Production-style start

```bash
npm start
```

---

## Frontend

Stock Next.js app (TypeScript, App Router). Runs independently of the server for now.

### Install

```bash
cd frontend
npm install
```

### Run (development)

```bash
npm run dev
```

App starts at **http://localhost:3000**.

### Build & production start

```bash
npm run build
npm start
```

---

## Typical local workflow

Use two terminals:

**Terminal 1 — API**

```bash
cd server
npm install   # first time only
npm run dev
```

**Terminal 2 — UI**

```bash
cd frontend
npm install   # first time only
npm run dev
```

Then open http://localhost:3000 for the UI and http://localhost:3001/api/health to confirm the backend is up.
