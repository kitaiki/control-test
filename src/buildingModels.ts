import {
  Axis, Color, CustomShader, CustomShaderTranslucencyMode, Matrix4, Model, UniformType, Viewer,
} from 'cesium'
import { prepareFloorStructure } from './floorStructure.ts'
import type { StructureMask } from './floorStructure.ts'

export type Storey = { sequence: number; name: string; elevation: number; glb: string }
type FloorModel = { model: Model; storey: Storey; shader: CustomShader; hoverShader: CustomShader }

const baseColor = Color.fromCssColorString('#637580')
const neonColor = Color.fromCssColorString('#ceff35')

/** Keeps the preview visible until every floor is GPU-ready, then swaps in one frame. */
export function createBuildingModels(viewer: Viewer, modelMatrix: Matrix4, baseUrl: string) {
  const abort = new AbortController()
  const models = new Set<Model>()
  const floors = new Map<Model, FloorModel>()
  let preview: Model | undefined
  let highlighted: FloorModel | undefined
  let floorsVisible = false

  function assertActive() {
    abort.signal.throwIfAborted()
  }

  async function loadModel(uri: string, show: boolean, mask?: StructureMask) {
    assertActive()
    const model = await Model.fromGltfAsync({
      url: `${baseUrl}${uri}`, modelMatrix: Matrix4.clone(modelMatrix), show,
      // Match the original 3D Tiles glTF axis conventions exactly.
      upAxis: Axis.Y, forwardAxis: Axis.X,
      color: baseColor, silhouetteColor: neonColor,
      incrementallyLoadTextures: false,
      gltfCallback: mask ? gltf => prepareFloorStructure(gltf, mask) : undefined,
    })
    if (abort.signal.aborted) { model.destroy(); assertActive() }
    models.add(model)
    viewer.scene.primitives.add(model)
    return model
  }

  function waitUntilRendered(model: Model, frames = 1) {
    assertActive()
    return new Promise<void>((resolve, reject) => {
      let readyFrames = 0
      const cleanups: (() => void)[] = []
      const finish = (error?: unknown) => {
        cleanups.forEach(cleanup => cleanup())
        if (error) reject(error)
        else resolve()
      }
      const onAbort = () => finish(abort.signal.reason)
      const timeout = setTimeout(() => finish(new Error('Model rendering timed out')), 60_000)
      cleanups.push(() => clearTimeout(timeout))
      abort.signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => abort.signal.removeEventListener('abort', onAbort))
      cleanups.push(model.errorEvent.addEventListener((error: unknown) => finish(error)))
      cleanups.push(viewer.scene.postRender.addEventListener(() => {
        if (model.ready && ++readyFrames >= frames) finish()
        else viewer.scene.requestRender()
      }))
      viewer.scene.requestRender()
    })
  }

  function remove(model: Model) {
    const floor = floors.get(model)
    viewer.scene.primitives.remove(model)
    if (floor) {
      floor.shader.destroy()
      floor.hoverShader.destroy()
      floors.delete(model)
    }
    models.delete(model)
  }

  function highlight(model?: Model) {
    const next = floorsVisible && model ? floors.get(model) : undefined
    if (next === highlighted) return next?.storey
    if (highlighted) {
      highlighted.model.customShader = highlighted.shader
      highlighted.model.color = baseColor
      highlighted.model.silhouetteSize = 0
    }
    highlighted = next
    if (next) {
      next.model.customShader = next.hoverShader
      next.model.color = Color.WHITE
    }
    viewer.scene.requestRender()
    return next?.storey
  }

  return {
    async loadPreview(uri: string) {
      preview = await loadModel(uri, true)
      // ready is set after rendering; allow another frame to actually draw the preview.
      await waitUntilRendered(preview, 2)
    },
    async loadFloors(storeys: Storey[], masks: Record<string, StructureMask>) {
      if (!storeys.length) throw new Error('No floor models in catalog')
      // All failures settle before cleanup, so late loads cannot leave stray models behind.
      const results = await Promise.allSettled(storeys.map(async storey => {
        const mask = masks[storey.glb]
        if (!mask) throw new Error(`Missing structural mask: ${storey.name}`)
        const model = await loadModel(storey.glb, false, mask)
        assertActive()
        const fragmentShaderText = `
            void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
              vec3 neon = vec3(0.808, 1.0, 0.208);
              float structure = step(0.5, fsInput.attributes.structure);
              vec3 selectedColor = mix(vec3(0.22, 0.32, 0.38), neon, structure);
              material.diffuse = mix(material.diffuse, selectedColor, u_hover);
              material.alpha *= mix(1.0, mix(0.055, 1.0, structure), u_hover);
              material.emissive += neon * structure * u_hover * 1.4;
            }
          `
        const shader = new CustomShader({
          uniforms: { u_hover: { type: UniformType.FLOAT, value: 0 } },
          fragmentShaderText,
        })
        const hoverShader = new CustomShader({
          translucencyMode: CustomShaderTranslucencyMode.TRANSLUCENT,
          uniforms: { u_hover: { type: UniformType.FLOAT, value: 1 } },
          fragmentShaderText,
        })
        model.customShader = shader
        floors.set(model, { model, storey, shader, hoverShader })
        await waitUntilRendered(model)
      }))
      assertActive()
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        for (const model of floors.keys()) remove(model)
        throw failure.reason
      }
      for (const model of floors.keys()) model.show = true
      floorsVisible = true
      if (preview) { remove(preview); preview = undefined }
      viewer.scene.requestRender()
    },
    owns(model: unknown): model is Model { return models.has(model as Model) },
    highlight,
    destroy() {
      abort.abort()
      for (const model of models) remove(model)
      highlighted = undefined
    },
  }
}
