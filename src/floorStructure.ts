export type StructureMask = {
  entries: { node: number; primitive: number; offset: number; count: number }[]
  bytes: string
}

type Primitive = { attributes: Record<string, number> }
type Gltf = {
  nodes: { mesh?: number }[]
  meshes: { primitives: Primitive[] }[]
  accessors: { bufferView?: number; componentType: number; count: number; type: string }[]
  buffers: { byteLength: number; uri?: string }[]
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; target?: number }[]
}
const prepared = new WeakSet<object>()

/** Attach the geometry-derived structural mask, preserving the original GLB. */
export function prepareFloorStructure(gltf: Gltf, mask: StructureMask) {
  if (prepared.has(gltf)) return
  prepared.add(gltf)
  const buffer = gltf.buffers.push({
    byteLength: atob(mask.bytes).length,
    uri: `data:application/octet-stream;base64,${mask.bytes}`,
  }) - 1
  const clonedNodes = new Set<number>()
  for (const entry of mask.entries) {
    const node = gltf.nodes[entry.node]
    if (node.mesh === undefined) continue
    if (!clonedNodes.has(entry.node)) {
      const mesh = gltf.meshes[node.mesh]
      node.mesh = gltf.meshes.push({ ...mesh, primitives: mesh.primitives.map(p => ({ ...p, attributes: { ...p.attributes } })) }) - 1
      clonedNodes.add(entry.node)
    }
    const view = gltf.bufferViews.push({ buffer, byteOffset: entry.offset, byteLength: entry.count, target: 34962 }) - 1
    const accessor = gltf.accessors.push({ bufferView: view, componentType: 5121, count: entry.count, type: 'SCALAR' }) - 1
    gltf.meshes[node.mesh].primitives[entry.primitive].attributes._STRUCTURE = accessor
  }
}
