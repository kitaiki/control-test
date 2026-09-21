import assert from 'node:assert/strict'
import test from 'node:test'
import { canReuseRoadQuery, padRoadQuery, createRoadQuery, roadDistance, clipRoadLines, fetchNearbyRoadData } from '../src/roadQuery.ts'
import { parseRoadData, ROAD_LIMIT } from '../src/roadData.ts'

const feature = (id, x, y, length = 0.00001) => ({ type: 'Feature', id,
  geometry: { type: 'LineString', coordinates: [[x, y], [x + length, y]] } })
const signal = () => new AbortController().signal

function mockServer(features, calls) {
  return async (bounds, abortSignal, limit) => {
    abortSignal.throwIfAborted()
    calls.push(bounds)
    const matching = features.filter(f => clipRoadLines([f.geometry.coordinates], bounds).length)
    return parseRoadData({ type: 'FeatureCollection', features: matching.slice(0, limit + 1), numberMatched: matching.length }, limit)
  }
}

test('a horizon-sized view is clamped to a camera neighborhood, with a fixed maximum at high altitude', () => {
  const q = createRoadQuery([120, 30, 140, 45], [127, 37.5], 300)
  assert.equal(q.range, 1200)
  assert.ok(q.bounds[2] - q.bounds[0] < 0.03)
  assert.ok(q.bounds[3] - q.bounds[1] < 0.03)
  assert.equal(createRoadQuery([120, 30, 140, 45], [127, 37.5], 100000).range, 5000)
  assert.equal(createRoadQuery([120, 30, 140, 45], [127, 37.5], 10).range, 800)
  assert.equal(createRoadQuery([135, 40, 136, 41], [127, 37.5], 300), undefined)
  const small = [126.999, 37.499, 127.001, 37.501]
  assert.deepEqual(createRoadQuery(small, [127, 37.5], 300).bounds, small)
})

test('distance uses segments so a long crossing road is prioritized over nearby endpoints', () => {
  assert.equal(roadDistance([[[-1, 0], [1, 0]]], [0, 0]), 0)
  assert.ok(roadDistance([[[0.01, 0.01], [0.02, 0.01]]], [0, 0]) > 1000)
})

test('clipping removes distant portions and never connects separate exits and re-entries', () => {
  assert.deepEqual(clipRoadLines([[[-2, 0], [2, 0]]], [-1, -1, 1, 1]), [[[-1, 0], [1, 0]]])
  assert.deepEqual(clipRoadLines([[[-2, 2], [2, 2]]], [-1, -1, 1, 1]), [])
  const parts = clipRoadLines([[[0, 0], [2, 0], [2, 0.5], [0, 0.5]]], [-1, -1, 1, 1])
  assert.equal(parts.length, 2)
  assert.deepEqual(parts[0], [[0, 0], [1, 0]])
  assert.deepEqual(parts[1], [[1, 0.5], [0, 0.5]])
})

test('nearest tiles are queried first and roads crossing multiple tiles are deduplicated', async () => {
  const calls = []
  const data = await fetchNearbyRoadData({ bounds: [-0.03, -0.03, 0.03, 0.03], origin: [0, 0], range: 4000 }, signal(),
    mockServer([feature('crossing', -0.02, 0, 0.04)], calls))
  assert.ok(calls[0][0] < 0 && calls[0][2] > 0 && calls[0][1] < 0 && calls[0][3] > 0)
  assert.equal(data.featureCount, 1)
  assert.equal(data.features[0].id, 'crossing')
  assert.equal(data.limited, false)
})

test('near roads omitted by far-first server ordering are recovered by subdividing saturated tiles', async () => {
  // All 400 far entries precede the near road in the same initial tile.
  const far = Array.from({ length: 400 }, (_, i) => feature(`far-${i}`, 0.008 + i * 0.000001, 0.008))
  const near = feature('near', 0.0001, 0.0001)
  const calls = []
  const data = await fetchNearbyRoadData({ bounds: [-0.03, -0.03, 0.03, 0.03], origin: [0, 0], range: 4000 }, signal(),
    mockServer([...far, near], calls))
  assert.equal(data.features[0].id, 'near')
  assert.equal(data.featureCount, 401)
  assert.ok(calls.length > 9 && calls.length <= 24)
})

test('global cap selects nearest features rather than the first server results', async () => {
  const features = Array.from({ length: 1900 }, (_, i) => feature(`road-${i}`, -0.029 + (i % 50) * 0.00116, -0.028 + Math.floor(i / 50) * 0.00145))
  const near = feature('nearest', 0.00001, 0.00001)
  const data = await fetchNearbyRoadData({ bounds: [-0.03, -0.03, 0.03, 0.03], origin: [0, 0], range: 4000 }, signal(),
    mockServer([...features, near], []))
  assert.equal(data.featureCount, ROAD_LIMIT)
  assert.equal(data.features[0].id, 'nearest')
  assert.equal(data.limited, true)
  const distances = data.features.map(f => roadDistance(f.lines, [0, 0]))
  assert.ok(distances.every((d, i) => i === 0 || d >= distances[i - 1]))
})

test('overloaded areas have bounded requests and cancellation rejects stale results', async () => {
  let calls = 0
  const saturated = async () => { calls++; return { features: [], lines: [], featureCount: 0, limited: true } }
  const query = { bounds: [-0.03, -0.03, 0.03, 0.03], origin: [0, 0], range: 4000 }
  const data = await fetchNearbyRoadData(query, signal(), saturated)
  assert.equal(calls, 24)
  assert.equal(data.limited, true)
  const controller = new AbortController()
  await assert.rejects(fetchNearbyRoadData(query, controller.signal, async () => {
    controller.abort()
    return { features: [], lines: [], featureCount: 0, limited: false }
  }), { name: 'AbortError' })
})


test('reuse requires containment, and incomplete results cannot be reused after zoom or movement', () => {
  const query = { bounds: [126.97, 37.56, 126.98, 37.57], origin: [126.975, 37.565], range: 800 }
  const coverage = padRoadQuery(query)
  const smallPan = { ...query, bounds: query.bounds.map((v, i) => i % 2 === 0 ? v + 0.0001 : v), origin: [126.9751, 37.565] }
  assert.equal(canReuseRoadQuery(query, coverage, smallPan, false), true)
  assert.equal(canReuseRoadQuery(query, coverage, smallPan, true), false)
  assert.equal(canReuseRoadQuery(query, coverage, { ...query, range: 1600 }, true), false)
  assert.equal(canReuseRoadQuery(query, coverage, { ...query, bounds: [126.97, 37.56, 127, 37.57] }, false), false)
  assert.equal(canReuseRoadQuery(query, coverage, query, true), true)
  const marginMeters = (query.bounds[0] - coverage.bounds[0]) * 111320 * Math.cos(query.origin[1] * Math.PI / 180)
  assert.ok(marginMeters > 0 && marginMeters <= 100.00001)
})
