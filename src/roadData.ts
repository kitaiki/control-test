export type RoadBounds = [number, number, number, number]
export type RoadLine = [number, number][]
export type RoadFeature = { id: string; lines: RoadLine[] }
export type RoadData = { features: RoadFeature[]; lines: RoadLine[]; featureCount: number; limited: boolean }
export const ROAD_LIMIT = 1500

export function roadRequestUrl(bounds: RoadBounds, endpoint = '/geoserver/platform3d/wfs', limit = ROAD_LIMIT) {
  const params = new URLSearchParams({
    service: 'WFS', version: '1.0.0', request: 'GetFeature',
    typeName: 'platform3d:road_11', outputFormat: 'application/json',
    srsName: 'EPSG:4326', bbox: `${bounds.join(',')},EPSG:4326`,
    maxFeatures: String(limit + 1),
  })
  return `${endpoint}?${params}`
}

// Fail visibly on service exceptions or unexpected CRS instead of drawing bad coordinates.
export function parseRoadData(value: unknown, limit = ROAD_LIMIT): RoadData {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'FeatureCollection'
    || !('features' in value) || !Array.isArray(value.features)) {
    throw new Error('GeoServer가 올바른 도로 GeoJSON을 반환하지 않았습니다.')
  }
  const lines: RoadLine[] = []
  const features: RoadFeature[] = []
  for (const feature of value.features.slice(0, limit)) {
    const geometry = feature?.geometry
    if (!geometry) continue
    const parts = geometry.type === 'LineString' ? [geometry.coordinates]
      : geometry.type === 'MultiLineString' ? geometry.coordinates : null
    if (!Array.isArray(parts)) throw new Error('도로 레이어의 선 형식을 확인하세요.')
    const before = lines.length
    for (const part of parts) {
      if (!Array.isArray(part)) throw new Error('도로 좌표 형식이 올바르지 않습니다.')
      const line: RoadLine = []
      for (const point of part) {
        if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0])
          || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
          throw new Error('도로 좌표가 EPSG:4326 경도·위도 형식이 아닙니다.')
        }
        const previous = line.at(-1)
        if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) line.push([point[0], point[1]])
      }
      if (line.length > 1) lines.push(line)
    }
    if (lines.length > before) {
      const parts = lines.slice(before)
      features.push({ id: String(feature.id ?? JSON.stringify(parts)), lines: parts })
    }
  }
  const matched = 'numberMatched' in value ? Number(value.numberMatched) : 'totalFeatures' in value ? Number(value.totalFeatures) : NaN
  return { features, lines, featureCount: features.length, limited: value.features.length > limit || matched > value.features.length }
}

export async function fetchRoadData(bounds: RoadBounds, signal: AbortSignal, limit = ROAD_LIMIT): Promise<RoadData> {
  const response = await fetch(roadRequestUrl(bounds, '/geoserver/platform3d/wfs', limit), { signal })
  if (!response.ok) throw new Error(`도로 WFS 요청 실패 (HTTP ${response.status})`)
  const body = await response.text()
  let json: unknown
  try { json = JSON.parse(body) } catch {
    throw new Error('도로 WFS 응답을 읽을 수 없습니다. GeoServer 연결과 WFS 설정을 확인하세요.')
  }
  return parseRoadData(json, limit)
}
