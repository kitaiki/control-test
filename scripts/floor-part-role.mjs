/** GLB Y-up: 0 facade, 1 beam/member, 2 slab, 3 interior, 4 column.
 * These exports lack external-wall flags. Use IFC material hints first, then
 * connected-component dimensions and the floor envelope for unnamed surfaces.
 */
export function classifyFloorPart({ min, max }, envelope, material = {}) {
  const name = [material.name, material.extras?.ifcType].filter(Boolean).join(' ')
  const dx = max.x - min.x, height = max.y - min.y, dz = max.z - min.z
  const [short, long] = [dx, dz].sort((a, b) => a - b)
  if (/IfcColumn/i.test(name)) return 4
  if (/Ifc(Beam|Member)/i.test(name)) return 1
  if (/Ifc(Slab|Roof)|floor-cap/i.test(name)) return 2
  if (/Ifc(Window|CurtainWall|Plate)/i.test(name) || material.alphaMode === 'BLEND') return 0
  const wall = /Ifc(Wall|Door)/i.test(name)
  const column = !wall && height >= 1.8 && short >= 0.12 && long <= 1.6 && height >= long * 2
  const beam = !wall && long >= 2 && short >= 0.15 && short <= 1.2 && height >= 0.15 && height <= 1.2 && long >= height * 3
  if (column) return 4
  if (beam) return 1
  if (!wall && height <= 1.2 && short >= 1.2 && long >= 2) return 2
  const edge = min.x <= envelope.min.x + 3 || max.x >= envelope.max.x - 3
    || min.z <= envelope.min.z + 3 || max.z >= envelope.max.z - 3
  // Merged corner/wrapping walls can span the entire floor in both axes.
  // Keep horizontal slabs and explicit structural members via the rules above.
  if (edge && (wall || height >= 1.2 || (height >= 0.35 && short <= 1.5))) return 0
  return 3
}
