import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFloorPart } from '../scripts/floor-part-role.mjs'

const envelope = { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 4, z: 30 } }
const part = (x, y, z, dx, dy, dz) => ({ min: { x, y, z }, max: { x: x + dx, y: y + dy, z: z + dz } })
test('material roles distinguish facade and glazing from interior partitions and slabs', () => {
  assert.equal(classifyFloorPart(part(0, 0, 0, 40, 4, 0.3), envelope, { name: 'IfcWallStandardCase' }), 0)
  assert.equal(classifyFloorPart(part(8, 0, 8, 15, 4, 0.3), envelope, { name: 'IfcWallStandardCase' }), 3)
  assert.equal(classifyFloorPart(part(0, 0, 0, 40, 0.3, 30), envelope, { name: 'IfcSlab' }), 2)
  assert.equal(classifyFloorPart(part(0, 0, 0, 40, 4, 0.1), envelope, { alphaMode: 'BLEND' }), 0)
  assert.equal(classifyFloorPart(part(0, 0, 0, 0.8, 4, 0.8), envelope, { extras: { ifcType: 'IfcColumn' } }), 4)
  assert.equal(classifyFloorPart(part(0, 0, 0, 0.2, 3.5, 8), envelope), 0)
  assert.equal(classifyFloorPart(part(0, 0, 0, 40, 4, 30), envelope), 0, 'merged wrapping facade must be classified as facade')
})
