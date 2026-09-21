import { fetchRoadData, ROAD_LIMIT } from './roadData.ts'
import type { RoadBounds, RoadData, RoadFeature, RoadLine } from './roadData.ts'

type Point = [number, number]
export type RoadQuery = { bounds: RoadBounds; origin: Point; range: number }
type Tile = { bounds: RoadBounds; depth: number; distance: number }
const METERS_PER_DEGREE = 111_320
const TILE_LIMIT = 400
const MAX_REQUESTS = 24

// The horizon can make computeViewRectangle span most of the city at a low pitch.
// Intersect it with a bounded neighborhood around the camera's ground position.
export function createRoadQuery(view: RoadBounds, origin: Point, height: number): RoadQuery | undefined {
  const range = Math.max(800, Math.min(5000, Math.max(0, height) * 4))
  const dx = range / (METERS_PER_DEGREE * Math.max(0.01, Math.cos(origin[1] * Math.PI / 180)))
  const dy = range / METERS_PER_DEGREE
  const bounds: RoadBounds = [Math.max(view[0], origin[0] - dx), Math.max(view[1], origin[1] - dy),
    Math.min(view[2], origin[0] + dx), Math.min(view[3], origin[1] + dy)]
  if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return undefined
  return { bounds, origin, range }
}

// A small margin lets complete results survive minor pans without retaining a tile cache.
export function padRoadQuery(query: RoadQuery): RoadQuery {
  const [west, south, east, north] = query.bounds
  const dx = Math.min((east - west) * 0.1, 100 / (METERS_PER_DEGREE * Math.max(0.01, Math.cos(query.origin[1] * Math.PI / 180))))
  const dy = Math.min((north - south) * 0.1, 100 / METERS_PER_DEGREE)
  return { ...query, bounds: [Math.max(-180, west - dx), Math.max(-90, south - dy),
    Math.min(180, east + dx), Math.min(90, north + dy)] }
}

export function sameRoadQuery(a: RoadQuery, b: RoadQuery): boolean {
  return Math.abs(a.range - b.range) < 1e-6
    && a.origin.every((value, i) => Math.abs(value - b.origin[i]) < 1e-10)
    && a.bounds.every((value, i) => Math.abs(value - b.bounds[i]) < 1e-10)
}

export function canReuseRoadQuery(previous: RoadQuery, coverage: RoadQuery, next: RoadQuery, limited: boolean): boolean {
  // Truncated results cannot prove coverage, and moving changes nearest-road priority.
  if (limited) return sameRoadQuery(previous, next)
  const [west, south, east, north] = coverage.bounds
  return next.bounds[0] >= west && next.bounds[1] >= south
    && next.bounds[2] <= east && next.bounds[3] <= north
}

function relative(point: Point, origin: Point): Point {
  return [(point[0] - origin[0]) * METERS_PER_DEGREE * Math.cos(origin[1] * Math.PI / 180),
    (point[1] - origin[1]) * METERS_PER_DEGREE]
}

// Segment distance, not vertex distance: a long road may pass right under the camera.
export function roadDistance(lines: RoadLine[], origin: Point): number {
  let distance = Infinity
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = relative(line[i - 1], origin)
      const [bx, by] = relative(line[i], origin)
      const dx = bx - ax, dy = by - ay
      const length2 = dx * dx + dy * dy
      const t = length2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2)) : 0
      distance = Math.min(distance, Math.hypot(ax + t * dx, ay + t * dy))
    }
  }
  return distance
}

// Clip full WFS geometries too; BBOX queries return complete roads crossing the box.
export function clipRoadLines(lines: RoadLine[], bounds: RoadBounds): RoadLine[] {
  const result: RoadLine[] = []
  for (const line of lines) {
    let part: RoadLine = []
    for (let i = 1; i < line.length; i++) {
      const [x, y] = line[i - 1], [endX, endY] = line[i]
      const dx = endX - x, dy = endY - y
      let start = 0, end = 1
      for (const [p, q] of [[-dx, x - bounds[0]], [dx, bounds[2] - x], [-dy, y - bounds[1]], [dy, bounds[3] - y]]) {
        if (p === 0) { if (q < 0) end = -1; continue }
        if (p < 0) start = Math.max(start, q / p)
        else end = Math.min(end, q / p)
      }
      if (start >= end) { if (part.length > 1) result.push(part); part = []; continue }
      const a: Point = [x + start * dx, y + start * dy]
      const b: Point = [x + end * dx, y + end * dy]
      const last = part.at(-1)
      if (last && (Math.abs(last[0] - a[0]) > 1e-10 || Math.abs(last[1] - a[1]) > 1e-10)) {
        if (part.length > 1) result.push(part)
        part = []
      }
      if (!part.length) part.push(a)
      part.push(b)
    }
    if (part.length > 1) result.push(part)
  }
  return result
}

function split(bounds: RoadBounds, divisions: number): RoadBounds[] {
  const dx = (bounds[2] - bounds[0]) / divisions, dy = (bounds[3] - bounds[1]) / divisions
  return Array.from({ length: divisions * divisions }, (_, i) => {
    const x = i % divisions, y = Math.floor(i / divisions)
    return [bounds[0] + dx * x, bounds[1] + dy * y, bounds[0] + dx * (x + 1), bounds[1] + dy * (y + 1)]
  })
}

export async function fetchNearbyRoadData(query: RoadQuery, signal: AbortSignal,
  fetchTile: typeof fetchRoadData = fetchRoadData): Promise<RoadData> {
  function tile(bounds: RoadBounds, depth: number): Tile {
    const nearest: Point = [Math.max(bounds[0], Math.min(bounds[2], query.origin[0])),
      Math.max(bounds[1], Math.min(bounds[3], query.origin[1]))]
    return { bounds, depth, distance: Math.hypot(...relative(nearest, query.origin)) }
  }
  const queue = split(query.bounds, 3).map(bounds => tile(bounds, 0))
  const candidates = new Map<string, RoadFeature & { distance: number }>()
  let requests = 0
  let incomplete = false
  let distanceCutoff = Infinity
  while (queue.length && requests < MAX_REQUESTS) {
    signal.throwIfAborted()
    queue.sort((a, b) => a.distance - b.distance)
    if (queue[0].distance > distanceCutoff) break
    const batch = queue.splice(0, Math.min(3, MAX_REQUESTS - requests))
    requests += batch.length
    const results = await Promise.all(batch.map(async area => ({ area, data: await fetchTile(area.bounds, signal, TILE_LIMIT) })))
    signal.throwIfAborted()
    for (const { area, data } of results) {
      for (const feature of data.features) {
        if (candidates.has(feature.id)) continue
        const lines = clipRoadLines(feature.lines, query.bounds)
        if (lines.length) candidates.set(feature.id, { id: feature.id, lines, distance: roadDistance(lines, query.origin) })
      }
      if (data.limited) {
        // A dense tile must be subdivided; sorting an already truncated broad response
        // cannot recover nearby features omitted by GeoServer's storage order.
        if (area.depth < 3) queue.push(...split(area.bounds, 2).map(bounds => tile(bounds, area.depth + 1)))
        else incomplete = true
      }
    }
    if (candidates.size >= ROAD_LIMIT) {
      distanceCutoff = [...candidates.values()].sort((a, b) => a.distance - b.distance)[ROAD_LIMIT - 1].distance
    }
  }
  const features = [...candidates.values()].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, ROAD_LIMIT).map(({ id, lines }) => ({ id, lines }))
  return { features, lines: features.flatMap(feature => feature.lines), featureCount: features.length,
    limited: incomplete || queue.length > 0 || candidates.size > ROAD_LIMIT }
}
