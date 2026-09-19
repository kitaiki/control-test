import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Color, Event, Matrix4, Model } from 'cesium'
import { createBuildingModels } from '../src/buildingModels.ts'

function setup(t, failingUrl) {
  const loaded = []
  const primitives = new Set()
  const postRender = new Event()
  t.mock.method(Model, 'fromGltfAsync', async options => {
    if (options.url === failingUrl) throw new Error('Floor download failed')
    const model = {
      ...options, ready: false, errorEvent: new Event(), destroyed: false,
      destroy() { this.destroyed = true },
    }
    loaded.push(model)
    return model
  })
  const viewer = { scene: {
    postRender, requestRender() {},
    primitives: {
      add(model) { primitives.add(model) },
      remove(model) { primitives.delete(model); model.destroy() },
    },
  } }
  const building = createBuildingModels(viewer, Matrix4.IDENTITY, '/models/')
  t.after(() => building.destroy())
  return { building, loaded, primitives, postRender }
}

const storeys = Array.from({ length: 16 }, (_, sequence) => ({
  sequence, name: `Floor ${sequence}`, elevation: sequence * 4, glb: `${sequence}.glb`,
}))
const masks = Object.fromEntries(storeys.map(storey => [storey.glb, { entries: [], bytes: '' }]))

async function renderPreview(ctx) {
  const loading = ctx.building.loadPreview('building.glb')
  await setImmediate()
  const preview = ctx.loaded[0]
  preview.ready = true
  ctx.postRender.raiseEvent()
  ctx.postRender.raiseEvent()
  await loading
  return preview
}

test('preview stays visible until all 16 floors are ready; hover restores the preceding floor', async t => {
  const ctx = setup(t)
  const preview = await renderPreview(ctx)
  const loading = ctx.building.loadFloors(storeys, masks)
  await setImmediate()
  const floors = ctx.loaded.slice(1)
  floors.slice(0, -1).forEach(model => { model.ready = true })
  ctx.postRender.raiseEvent()
  await setImmediate()
  assert.equal(ctx.primitives.has(preview), true)
  assert.equal(preview.show, true)
  assert.equal(floors.every(model => !model.show), true)
  floors.at(-1).ready = true
  ctx.postRender.raiseEvent()
  await loading
  assert.equal(preview.destroyed, true)
  assert.equal(ctx.primitives.size, 16)
  assert.equal(floors.every(model => model.show), true)
  assert.equal(ctx.building.highlight(floors[6]), storeys[6])
  assert.equal(floors[6].customShader.uniforms.u_hover.value, 1)
  assert.equal(Color.equals(floors[6].color, Color.WHITE), true)
  ctx.building.highlight(floors[7])
  assert.equal(floors[6].silhouetteSize, 0)
  assert.equal(Color.equals(floors[6].color, Color.fromCssColorString('#637580')), true)
  assert.equal(floors[7].customShader.uniforms.u_hover.value, 1)
  ctx.building.highlight()
  assert.equal(floors[7].silhouetteSize, 0)
})

test('a failed floor leaves the preview intact and removes partial floor models', async t => {
  const ctx = setup(t, '/models/7.glb')
  const preview = await renderPreview(ctx)
  const loading = ctx.building.loadFloors(storeys, masks)
  const rejection = assert.rejects(loading, /Floor download failed/)
  await setImmediate()
  ctx.loaded.slice(1).forEach(model => { model.ready = true })
  ctx.postRender.raiseEvent()
  await rejection
  assert.deepEqual([...ctx.primitives], [preview])
  assert.equal(preview.show, true)
  assert.equal(preview.destroyed, false)
  assert.equal(ctx.loaded.slice(1).every(model => model.destroyed), true)
})

test('unmount during floor preparation releases models and pending render listeners', async t => {
  const ctx = setup(t)
  await renderPreview(ctx)
  const loading = ctx.building.loadFloors(storeys, masks)
  const rejection = assert.rejects(loading, { name: 'AbortError' })
  await setImmediate()
  ctx.building.destroy()
  await rejection
  assert.equal(ctx.primitives.size, 0)
  assert.equal(ctx.postRender.numberOfListeners, 0)
  assert.equal(ctx.loaded.every(model => model.destroyed), true)
})
