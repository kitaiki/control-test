import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Cartographic, Ellipsoid, Event, PrimitiveCollection, Rectangle } from 'cesium'
import ContextLimits from '@cesium/engine/Source/Renderer/ContextLimits.js'
import { createRoadFlow } from '../src/roadFlow.ts'

function setup(t) {
  const replacements = {
    window: { matchMedia: () => ({ matches: true }) },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    HTMLCanvasElement: class {}, HTMLImageElement: class {}, ImageBitmap: class {}, OffscreenCanvas: class {},
  }
  // These limits normally come from a WebGL context; no draw calls run in these lifecycle tests.
  const maximumLineWidth = ContextLimits._maximumAliasedLineWidth
  ContextLimits._maximumAliasedLineWidth = 1
  const restore = [() => { ContextLimits._maximumAliasedLineWidth = maximumLineWidth }]
  for (const [key, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    restore.push(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key])
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const primitives = new PrimitiveCollection()
  const postRender = new Event(), moveEnd = new Event()
  const ctx = { primitives, postRender, moveEnd, requests: 0, limited: false, empty: false, fail: false,
    bounds: [126.97, 37.56, 126.98, 37.57], origin: [126.975, 37.565], states: [], signals: [] }
  ctx.respond = () => new Response(JSON.stringify({ type: 'FeatureCollection',
    totalFeatures: ctx.limited ? 2000 : ctx.empty ? 0 : 1,
    features: ctx.empty ? [] : [{ type: 'Feature', id: 'road-1', geometry: { type: 'LineString',
      coordinates: [[126.975, 37.565], [126.976, 37.566]] } }],
  }))
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    ctx.requests++
    ctx.signals.push(signal)
    if (ctx.fail) throw new Error('Server unavailable')
    if (ctx.wait) await ctx.wait
    return ctx.respond()
  })
  ctx.flow = createRoadFlow({ camera: {
    moveEnd, computeViewRectangle: () => Rectangle.fromDegrees(...ctx.bounds),
    get positionCartographic() { return Cartographic.fromDegrees(...ctx.origin, 1000) },
  }, scene: { globe: { ellipsoid: Ellipsoid.WGS84 }, canvas: {}, groundPrimitives: primitives,
    postRender, requestRender() {} } }, state => ctx.states.push(state))
  t.after(() => { ctx.flow.destroy(); restore.forEach(reset => reset()) })
  ctx.ready = () => {
    assert.notEqual(ctx.states.at(-1).status, 'error', ctx.states.at(-1).message)
    primitives.get(primitives.length - 1)._ready = true
    postRender.raiseEvent()
  }
  ctx.move = async (shift = 0) => {
    ctx.bounds = ctx.bounds.map((value, i) => i % 2 === 0 ? value + shift : value)
    ctx.origin[0] += shift
    moveEnd.raiseEvent()
    t.mock.timers.tick(250)
    await setImmediate()
  }
  return ctx
}

test('complete coverage reuses the primitive for small pans; leaving coverage replaces it', async t => {
  const ctx = setup(t)
  await ctx.flow.refresh()
  ctx.ready()
  const initial = ctx.primitives.get(0), count = ctx.requests
  await ctx.move(0.0001)
  assert.equal(ctx.requests, count)
  assert.equal(ctx.primitives.get(0), initial)
  await ctx.move(0.002)
  assert.ok(ctx.requests > count)
  assert.equal(ctx.primitives.length, 2)
  ctx.ready()
  assert.equal(ctx.primitives.length, 1)
  assert.equal(initial.isDestroyed(), true)
})

test('limited results reuse identical queries but requery after a small pan', async t => {
  const ctx = setup(t)
  ctx.limited = true
  await ctx.flow.refresh()
  ctx.ready()
  const count = ctx.requests
  await ctx.move()
  assert.equal(ctx.requests, count)
  await ctx.move(0.0001)
  assert.ok(ctx.requests > count)
})

test('OFF destroys both displayed and pending geometry and ON loads fresh roads', async t => {
  const ctx = setup(t)
  await ctx.flow.refresh()
  ctx.ready()
  const initial = ctx.primitives.get(0)
  await ctx.flow.refresh()
  const pending = ctx.primitives.get(1)
  ctx.flow.setEnabled(false)
  assert.equal(initial.isDestroyed(), true)
  assert.equal(pending.isDestroyed(), true)
  assert.equal(ctx.primitives.length, 0)
  assert.equal(ctx.postRender.numberOfListeners, 0)
  assert.deepEqual(ctx.states.at(-1), { status: 'idle', count: 0, limited: false })
  const count = ctx.requests
  await ctx.move()
  assert.equal(ctx.requests, count)
  ctx.flow.setEnabled(true)
  await setImmediate()
  assert.ok(ctx.requests > count)
  assert.equal(ctx.primitives.length, 1)
})

test('an identical in-flight query is not restarted, and OFF rejects late responses', async t => {
  const ctx = setup(t)
  let release
  ctx.wait = new Promise(resolve => { release = resolve })
  const loading = ctx.flow.refresh()
  const count = ctx.requests
  await ctx.move()
  assert.equal(ctx.requests, count)
  assert.ok(ctx.signals.every(signal => !signal.aborted))
  ctx.flow.setEnabled(false)
  assert.ok(ctx.signals.every(signal => signal.aborted))
  release()
  await loading
  assert.equal(ctx.primitives.length, 0)
  assert.equal(ctx.states.at(-1).status, 'idle')
})

test('empty complete results are reused, but explicit refresh bypasses reuse', async t => {
  const ctx = setup(t)
  ctx.empty = true
  await ctx.flow.refresh()
  const count = ctx.requests
  await ctx.move(0.0001)
  assert.equal(ctx.requests, count)
  await ctx.flow.refresh()
  assert.ok(ctx.requests > count)
  assert.equal(ctx.primitives.length, 0)
})

test('failed replacement keeps displayed roads and retry fetches again', async t => {
  const ctx = setup(t)
  await ctx.flow.refresh()
  ctx.ready()
  const initial = ctx.primitives.get(0)
  ctx.fail = true
  await ctx.flow.refresh()
  assert.equal(ctx.states.at(-1).status, 'error')
  assert.equal(ctx.states.at(-1).message, 'Server unavailable')
  assert.equal(ctx.primitives.get(0), initial)
  ctx.fail = false
  await ctx.flow.refresh()
  ctx.ready()
  assert.equal(initial.isDestroyed(), true)
  assert.equal(ctx.states.at(-1).status, 'ready')
})

test('destroy cancels loading and removes geometry and render listeners', async t => {
  const ctx = setup(t)
  await ctx.flow.refresh()
  const pending = ctx.primitives.get(0)
  ctx.flow.destroy()
  assert.equal(pending.isDestroyed(), true)
  assert.equal(ctx.primitives.length, 0)
  assert.equal(ctx.postRender.numberOfListeners, 0)
  assert.equal(ctx.moveEnd.numberOfListeners, 0)
})
