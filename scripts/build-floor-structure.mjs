import fs from 'node:fs/promises'
import { classifyFloorPart } from './floor-part-role.mjs'
import { MeshoptDecoder } from 'meshoptimizer'
import { Cartesian3 as C, Matrix4 as M, Quaternion as Q } from 'cesium'

// Recover disconnected geometry islands from gltfpack's merged primitives.
await MeshoptDecoder.ready
const datasets = process.argv.slice(2)
for (const dataset of datasets.length ? datasets : ['sample_10', 'sample_ch_coords']) {
if (!/^[a-zA-Z0-9_-]+$/.test(dataset)) throw new Error('Invalid dataset name')
const folder = new URL(`../public/${dataset}/`, import.meta.url)
const catalog = JSON.parse(await fs.readFile(new URL('catalog.json', folder), 'utf8'))
const result = {}
for (const floor of catalog.storeys) {
  const glb = await fs.readFile(new URL(floor.glb, folder))
  const jsonLength = glb.readUInt32LE(12)
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString())
  const bin = glb.subarray(28 + jsonLength)
  const views = new Map()
  function view(index) {
    if (views.has(index)) return views.get(index)
    const v = gltf.bufferViews[index]
    const ext = v.extensions?.EXT_meshopt_compression
    let bytes
    if (ext) {
      bytes = new Uint8Array(ext.count * ext.byteStride)
      MeshoptDecoder.decodeGltfBuffer(bytes, ext.count, ext.byteStride,
        bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength), ext.mode, ext.filter)
    } else bytes = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)
    views.set(index, bytes)
    return bytes
  }
  const accessors = new Map()
  function accessor(index) {
    if (accessors.has(index)) return accessors.get(index)
    const a = gltf.accessors[index]
    const bytes = view(a.bufferView)
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const size = {5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}[a.componentType]
    const method = {5120:'getInt8',5121:'getUint8',5122:'getInt16',5123:'getUint16',5125:'getUint32',5126:'getFloat32'}[a.componentType]
    const width = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type]
    const stride = gltf.bufferViews[a.bufferView].byteStride ?? size * width
    const values = Array.from({length:a.count}, (_, i) => Array.from({length:width}, (_, c) => {
      const value = data[method]((a.byteOffset ?? 0) + i * stride + c * size, true)
      if (!a.normalized) return value
      const max = {5120:127,5121:255,5122:32767,5123:65535}[a.componentType]
      return Math.max(-1, value / max)
    }))
    accessors.set(index, values)
    return values
  }
  const chunks = [], entries = []
  let offset = 0
  const parts = []
  const envelope = { min: new C(Infinity, Infinity, Infinity), max: new C(-Infinity, -Infinity, -Infinity) }
  function walk(index, parent) {
    const n = gltf.nodes[index]
    const local = n.matrix ? M.fromArray(n.matrix) : M.fromTranslationQuaternionRotationScale(
      C.fromArray(n.translation ?? [0,0,0]), Q.unpack(n.rotation ?? [0,0,0,1]), C.fromArray(n.scale ?? [1,1,1]))
    const transform = M.multiply(parent, local, new M())
    const attrs = n.extensions?.EXT_mesh_gpu_instancing?.attributes
    let geometryTransform = transform
    if (attrs) {
      const instance = M.fromTranslationQuaternionRotationScale(
        C.fromArray(attrs.TRANSLATION === undefined ? [0,0,0] : accessor(attrs.TRANSLATION)[0]),
        Q.unpack(attrs.ROTATION === undefined ? [0,0,0,1] : accessor(attrs.ROTATION)[0]),
        C.fromArray(attrs.SCALE === undefined ? [1,1,1] : accessor(attrs.SCALE)[0]))
      geometryTransform = M.multiply(transform, instance, new M())
    }
    if (n.mesh !== undefined) gltf.meshes[n.mesh].primitives.forEach((p, primitive) => {
      const points = accessor(p.attributes.POSITION)
      const mask = new Uint8Array(Math.ceil(points.length / 4) * 4)
      const material = gltf.materials?.[p.material] ?? {}
      if ((p.mode ?? 4) === 4) {
        const parents = points.map((_, i) => i)
        function find(i) { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i] } return i }
        function join(a,b) { parents[find(b)] = find(a) }
        const welded = new Map()
        points.forEach((point, i) => {
          const key = point.join(',')
          if (welded.has(key)) join(i, welded.get(key))
          else welded.set(key,i)
        })
        const indices = p.indices === undefined ? points.map((_,i)=>i) : accessor(p.indices).map(v=>v[0])
        for (let i=0;i<indices.length;i+=3) { join(indices[i],indices[i+1]);join(indices[i],indices[i+2]) }
        const groups = new Map()
        points.forEach((point,i) => {
          const group = find(i)
          if (!groups.has(group)) groups.set(group,{min:new C(Infinity,Infinity,Infinity),max:new C(-Infinity,-Infinity,-Infinity),indices:[]})
          const item = groups.get(group)
          const world = M.multiplyByPoint(geometryTransform,C.fromArray(point),new C())
          C.minimumByComponent(item.min,world,item.min);C.maximumByComponent(item.max,world,item.max)
          item.indices.push(i)
        })
        for (const group of groups.values()) {
          C.minimumByComponent(envelope.min, group.min, envelope.min)
          C.maximumByComponent(envelope.max, group.max, envelope.max)
          parts.push({ group, material, mask })
        }
      }

      entries.push({node:index,primitive,offset,count:points.length})
      chunks.push(mask); offset += mask.length
    })
    for (const child of n.children ?? []) walk(child,transform)
  }
  for (const index of gltf.scenes[gltf.scene ?? 0].nodes) walk(index,M.IDENTITY)
  const counts = [0, 0, 0, 0, 0]
  for (const { group, material, mask } of parts) {
    const role = classifyFloorPart(group, envelope, material)
    group.indices.forEach(i => { mask[i] = role })
    counts[role]++
  }
  result[floor.glb] = {entries, bytes:Buffer.concat(chunks).toString('base64')}
  console.log(`${dataset} / ${floor.name}: facade, beam/member, slab, interior, column = ${counts.join(", ")}`)
}
await fs.writeFile(new URL('structure.json',folder),JSON.stringify(result))

}
