import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { prepareFloorStructure } from '../src/floorStructure.ts'

test('structural masks match all 16 source GLBs and preserve original geometry', async () => {
  const base = new URL('../public/sample_10/', import.meta.url)
  const catalog = JSON.parse(await fs.readFile(new URL('catalog.json', base), 'utf8'))
  const masks = JSON.parse(await fs.readFile(new URL('structure.json', base), 'utf8'))
  assert.equal(Object.keys(masks).length, catalog.storeys.length)
  for (const storey of catalog.storeys) {
    const bytes = await fs.readFile(new URL(storey.glb, base))
    const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString())
    const mask = masks[storey.glb]
    const roles = Buffer.from(mask.bytes, 'base64')
    const originalMeshes = structuredClone(gltf.meshes)
    for (const entry of mask.entries) {
      const primitive = gltf.meshes[gltf.nodes[entry.node].mesh].primitives[entry.primitive]
      assert.equal(entry.count, gltf.accessors[primitive.attributes.POSITION].count)
      assert.equal(entry.offset % 4, 0)
      assert.ok(entry.offset + entry.count <= roles.length)
    }
    assert.ok(roles.every(value => value === 0 || value === 1))
    if (storey.name.startsWith('지상')) {
      assert.ok(roles.includes(1), `${storey.name} should contain structural members`)
      assert.ok(roles.includes(0), `${storey.name} should contain transparent surfaces`)
    }
    prepareFloorStructure(gltf, mask)
    assert.deepEqual(gltf.meshes.slice(0, originalMeshes.length), originalMeshes)
    for (const entry of mask.entries) {
      const primitive = gltf.meshes[gltf.nodes[entry.node].mesh].primitives[entry.primitive]
      const accessor = gltf.accessors[primitive.attributes._STRUCTURE]
      assert.equal(accessor.count, entry.count)
      assert.equal(gltf.bufferViews[accessor.bufferView].byteOffset, entry.offset)
    }
    const length = gltf.accessors.length
    prepareFloorStructure(gltf, mask)
    assert.equal(gltf.accessors.length, length, 'Repeated preparation must not duplicate attributes')
  }
})
