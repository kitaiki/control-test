import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRoadData, roadRequestUrl, ROAD_LIMIT, fetchRoadData } from '../src/roadData.ts'

const line = [[126.97, 37.56], [126.971, 37.561]]
const feature = coordinates => ({ type: 'Feature', geometry: { type: 'LineString', coordinates } })
const collection = features => ({ type: 'FeatureCollection', features })

test('WFS uses longitude/latitude for both output and viewport filter, and one extra feature to detect truncation', () => {
  const url = new URL(roadRequestUrl([126.9, 37.5, 127, 37.6]), 'http://localhost')
  assert.equal(url.pathname, '/geoserver/platform3d/wfs')
  assert.equal(url.searchParams.get('typeName'), 'platform3d:road_11')
  assert.equal(url.searchParams.get('srsName'), 'EPSG:4326')
  assert.equal(url.searchParams.get('bbox'), '126.9,37.5,127,37.6,EPSG:4326')
  assert.equal(Number(url.searchParams.get('maxFeatures')), ROAD_LIMIT + 1)
})

test('keeps multipart roads separate and removes duplicate vertices and degenerate lines', () => {
  const result = parseRoadData(collection([
    feature([line[0], line[0], line[1]]),
    { geometry: { type: 'MultiLineString', coordinates: [line, line, [line[0], line[0]]] } },
    { geometry: null },
  ]))
  assert.equal(result.featureCount, 2)
  assert.deepEqual(result.lines, [line, line, line])
  assert.equal(result.limited, false)
})

test('rejects service errors, unsupported shapes, and projected or invalid coordinates', () => {
  for (const value of [null, {}, { type: 'ExceptionReport' }, collection([feature([[952206, 1947525], [952207, 1947526]])]),
    collection([feature([[NaN, 37], line[0]])]), collection([{ geometry: { type: 'Polygon', coordinates: [line] } }])]) {
    assert.throws(() => parseRoadData(value))
  }
})

test('caps large viewport responses and reports an empty viewport', () => {
  const result = parseRoadData(collection(Array.from({ length: ROAD_LIMIT + 1 }, () => feature(line))))
  assert.equal(result.featureCount, ROAD_LIMIT)
  assert.equal(result.limited, true)
  assert.deepEqual(parseRoadData(collection([])), { features: [], lines: [], featureCount: 0, limited: false })
})

test('HTTP and XML service errors produce actionable failures; abort signal reaches fetch', async t => {
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.signal, controller.signal)
    return new Response('<ServiceException>Missing layer</ServiceException>', { status: 200 })
  })
  await assert.rejects(fetchRoadData([126, 37, 127, 38], controller.signal), /WFS/)
  globalThis.fetch.mock.mockImplementation(async () => new Response('', { status: 503 }))
  await assert.rejects(fetchRoadData([126, 37, 127, 38], controller.signal), /503/)
})
