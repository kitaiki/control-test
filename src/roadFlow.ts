import {
  Cartesian3, ClassificationType, Color, GeometryInstance, GroundPolylineGeometry,
  GroundPolylinePrimitive, Material, Math as CesiumMath, PolylineMaterialAppearance,
} from 'cesium'
import type { Viewer } from 'cesium'
import { createRoadQuery, fetchNearbyRoadData } from './roadQuery'
import type { RoadBounds } from './roadData'

export type RoadState = { status: 'idle' | 'loading' | 'ready' | 'error'; count: number; limited: boolean; message?: string }

export function createRoadFlow(viewer: Viewer, onState: (state: RoadState) => void) {
  // Ground polyline st.s follows the original coordinate order along each line.
  // This is a visual effect, not a statement about traffic direction or speed.
  const material = new Material({
    fabric: {
      type: 'RoadFlow',
      uniforms: { color: Color.fromCssColorString('#7ceeff'), phase: 0 },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          float tail = fract(materialInput.st.s * 3.0 - phase);
          float pulse = smoothstep(0.48, 0.96, tail) * (1.0 - smoothstep(0.96, 1.0, tail));
          float edge = abs(materialInput.st.t - 0.5) * 2.0;
          float halo = pow(max(0.0, 1.0 - edge), 1.6);
          float core = 1.0 - smoothstep(0.12, 0.45, edge);
          m.diffuse = mix(color.rgb, vec3(0.93, 1.0, 1.0), pulse * core);
          m.emission = color.rgb * pulse * 0.55;
          m.alpha = halo * (0.16 + pulse * 0.78) + core * 0.12;
          return m;
        }
      `,
    },
    translucent: true,
  })
  let primitive: GroundPolylinePrimitive | undefined
  let pendingPrimitive: GroundPolylinePrimitive | undefined
  let removeReady: (() => void) | undefined
  let controller: AbortController | undefined
  let disposed = false
  let enabled = true
  let playing = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let speed = 1
  let generation = 0
  let debounce: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let previousTime = performance.now()
  let phase = 0
  let state: RoadState = { status: 'idle', count: 0, limited: false }

  function publish(next: RoadState) { state = next; onState(next) }
  function updateTimer() {
    clearInterval(timer)
    timer = undefined
    previousTime = performance.now()
    if (disposed || !enabled || document.hidden || (!pendingPrimitive && !(playing && primitive))) return
    timer = setInterval(() => {
      const now = performance.now()
      if (playing) phase = (phase + Math.min((now - previousTime) / 1000, 0.1) * speed * 0.45) % 1
      previousTime = now
      material.uniforms.phase = phase
      viewer.scene.requestRender()
    }, 1000 / 30)
  }
  function clearPending() {
    removeReady?.()
    removeReady = undefined
    if (pendingPrimitive) viewer.scene.groundPrimitives.remove(pendingPrimitive)
    pendingPrimitive = undefined
  }
  async function refresh() {
    clearTimeout(debounce)
    controller?.abort()
    const request = ++generation
    clearPending()
    updateTimer()
    if (disposed || !enabled) return
    const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid)
    if (!rect) { publish({ ...state, status: 'ready', message: '지도를 향해 카메라를 이동하세요.' }); return }
    const bounds = [rect.west, rect.south, rect.east, rect.north].map(CesiumMath.toDegrees) as RoadBounds
    if (bounds[0] > bounds[2]) { publish({ ...state, status: 'ready', message: '서울 지역을 확대하세요.' }); return }
    const camera = viewer.camera.positionCartographic
    const query = createRoadQuery(bounds, [CesiumMath.toDegrees(camera.longitude), CesiumMath.toDegrees(camera.latitude)], camera.height)
    if (!query) {
      if (primitive) viewer.scene.groundPrimitives.remove(primitive)
      primitive = undefined
      publish({ status: 'ready', count: 0, limited: false, message: '가까운 지면이 보이도록 카메라를 아래로 기울이세요.' })
      updateTimer()
      viewer.scene.requestRender()
      return
    }
    controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
    publish({ ...state, status: 'loading', message: undefined })
    try {
      const data = await fetchNearbyRoadData(query, signal)
      if (disposed || request !== generation) return
      if (!data.lines.length) {
        if (primitive) viewer.scene.groundPrimitives.remove(primitive)
        primitive = undefined
        publish({ status: 'ready', count: 0, limited: data.limited })
        updateTimer()
        viewer.scene.requestRender()
        return
      }
      const next = new GroundPolylinePrimitive({
        geometryInstances: data.lines.map(line => new GeometryInstance({
          geometry: new GroundPolylineGeometry({ positions: Cartesian3.fromDegreesArray(line.flat()), width: 7 }),
        })),
        appearance: new PolylineMaterialAppearance({ material }),
        classificationType: ClassificationType.TERRAIN,
        allowPicking: false,
      })
      pendingPrimitive = viewer.scene.groundPrimitives.add(next)
      // Keep the preceding view visible until the worker has prepared its replacement.
      removeReady = viewer.scene.postRender.addEventListener(() => {
        if (!next.ready) return
        removeReady?.()
        removeReady = undefined
        if (primitive) viewer.scene.groundPrimitives.remove(primitive)
        primitive = next
        pendingPrimitive = undefined
        publish({ status: 'ready', count: data.featureCount, limited: data.limited })
        updateTimer()
        viewer.scene.requestRender()
      })
      updateTimer()
      viewer.scene.requestRender()
    } catch (error) {
      if (disposed || request !== generation) return
      publish({ ...state, status: 'error', message: signal.aborted ? '도로 조회 시간이 초과되었습니다. 다시 시도하세요.'
        : error instanceof Error ? error.message : '도로를 불러오지 못했습니다.' })
    }
  }
  function scheduleRefresh() {
    clearTimeout(debounce)
    debounce = setTimeout(() => void refresh(), 250)
  }
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(scheduleRefresh)
  let firstResize = true
  const resize = new ResizeObserver(() => {
    if (firstResize) { firstResize = false; return }
    scheduleRefresh()
  })
  resize.observe(viewer.scene.canvas)
  document.addEventListener('visibilitychange', updateTimer)
  return {
    refresh,
    setEnabled(value: boolean) {
      enabled = value
      if (primitive) primitive.show = value
      if (!value) {
        clearTimeout(debounce)
        controller?.abort()
        generation++
        clearPending()
        publish({ ...state, status: primitive ? 'ready' : 'idle' })
      } else void refresh()
      updateTimer()
      viewer.scene.requestRender()
    },
    setPlaying(value: boolean) { playing = value; updateTimer() },
    setSpeed(value: number) { speed = value },
    destroy() {
      disposed = true
      generation++
      controller?.abort()
      clearTimeout(debounce)
      clearInterval(timer)
      removeMoveEnd()
      resize.disconnect()
      document.removeEventListener('visibilitychange', updateTimer)
      clearPending()
      if (primitive) viewer.scene.groundPrimitives.remove(primitive)
      material.destroy()
    },
  }
}
