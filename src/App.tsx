import { useEffect, useRef, useState } from 'react'
import {
  BoundingSphere, Cartesian3, Color, HeadingPitchRange, Math as CesiumMath, Matrix4,
  OpenStreetMapImageryProvider, ScreenSpaceEventHandler, ScreenSpaceEventType, Viewer,
} from 'cesium'
import type { Cartesian2 } from 'cesium'
import { createBuildingMotion } from './buildingMotion'
import { createBuildingModels } from './buildingModels'
import type { Storey } from './buildingModels'
import { Icon } from './Icons'
import 'cesium/Build/Cesium/Widgets/widgets.css'

type Catalog = {
  building: {
    name: string
    projectName: string
    ifcId: number
    bounds: { minimum: number[]; maximum: number[] }
  }
  storeys: Storey[]
}
type BuildingCatalog = Catalog & { id: string; label: string; longitude: number; latitude: number }
type BuildingScene = { catalog: BuildingCatalog; models: ReturnType<typeof createBuildingModels>; sphere: BoundingSphere; ready: boolean }
const sources = [
  { id: 'sample_10', label: '시청 서측' },
  { id: 'sample_ch_coords', label: '시청 동측' },
]
type LoadingState = 'loading' | 'ready' | 'error'
type HoverFloor = { name: string; elevation: number } | null

function App() {
  const rootRef = useRef<HTMLElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const openRef = useRef<HTMLButtonElement>(null)
  const floorTooltipRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<{ select: (id?: string) => void; close: () => void; focus: () => void } | null>(null)
  const [loadingState, setLoadingState] = useState<LoadingState>('loading')
  const [selected, setSelected] = useState(false)
  const [catalog, setCatalog] = useState<BuildingCatalog | null>(null)
  const [buildings, setBuildings] = useState<BuildingCatalog[]>([])
  const [tab, setTab] = useState<'overview' | 'floors'>('overview')
  const [hoverFloor, setHoverFloor] = useState<HoverFloor>(null)
  const [modelStage, setModelStage] = useState<'loading' | 'preview' | 'floors' | 'fallback'>('loading')
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!containerRef.current || !rootRef.current) return
    const root = rootRef.current
    const viewer = new Viewer(containerRef.current, {
      animation: false, baseLayer: false, baseLayerPicker: false,
      fullscreenButton: false, geocoder: false, homeButton: false, infoBox: false,
      navigationHelpButton: false, sceneModePicker: false,
      selectionIndicator: false, timeline: false,
      requestRenderMode: true, maximumRenderTimeChange: Infinity,
    })
    viewer.scene.globe.baseColor = Color.fromCssColorString('#182222')
    viewer.scene.globe.depthTestAgainstTerrain = true
    const imagery = viewer.imageryLayers.addImageryProvider(new OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/', maximumLevel: 19,
      credit: '© OpenStreetMap contributors',
    }))
    imagery.brightness = 0.19
    imagery.saturation = 0
    imagery.contrast = 1.2

    // Only the lit floor crosses the bloom threshold; the dark city stays crisp.
    const bloom = viewer.scene.postProcessStages.bloom
    bloom.enabled = false
    bloom.uniforms.glowOnly = false
    bloom.uniforms.contrast = 145
    bloom.uniforms.brightness = -0.38
    bloom.uniforms.delta = 1.0
    bloom.uniforms.sigma = 3.2
    bloom.uniforms.stepSize = 2.0

    const motion = createBuildingMotion(viewer, root)
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    const abortController = new AbortController()
    let cancelled = false
    let selectedBuilding = false
    const scenes: BuildingScene[] = []
    let activeBuilding: BuildingScene | undefined
    let overviewSphere: BoundingSphere | undefined
    let hoveredFloorName = ''

    function clearHover() {
      if (bloom.enabled) { bloom.enabled = false; viewer.scene.requestRender() }
      scenes.forEach(building => building.models.highlight())
      if (hoveredFloorName) { hoveredFloorName = ''; setHoverFloor(null) }
      viewer.scene.canvas.style.cursor = 'grab'
    }

    function focus() {
      const sphere = selectedBuilding ? activeBuilding?.sphere : overviewSphere
      if (!sphere) return
      clearHover()
      if (selectedBuilding) { motion.resize(sphere); return }
      viewer.camera.flyToBoundingSphere(sphere, {
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.9,
        offset: new HeadingPitchRange(CesiumMath.toRadians(25), CesiumMath.toRadians(-38), Math.max(240, sphere.radius * 3.4)),
      })
    }
    function select(id?: string) {
      const next = id ? scenes.find(building => building.catalog.id === id && building.ready) : activeBuilding
      if (!next?.ready) return
      clearHover()
      activeBuilding = next
      setCatalog(next.catalog)
      if (selectedBuilding) { motion.resize(next.sphere); return }
      selectedBuilding = true
      setSelected(true)
      motion.animate(true, next.sphere, () => closeRef.current?.focus({ preventScroll: true }))
    }
    function close() {
      if (!activeBuilding || !selectedBuilding) return
      clearHover()
      selectedBuilding = false
      setSelected(false)
      openRef.current?.focus({ preventScroll: true })
      motion.animate(false, activeBuilding.sphere)
    }
    actionsRef.current = { select, close, focus }

    function pickBuilding(position: Cartesian2) {
      const pick = scenes.reduceRight<() => ReturnType<typeof viewer.scene.pick>>(
        (next, building) => () => building.models.withPickingSurface(next),
        () => viewer.scene.pick(position),
      )
      const picked = pick()
      const building = scenes.find(item => item.ready && item.models.owns(picked?.primitive))
      return { picked, building }
    }
    handler.setInputAction(({ position }: { position: Cartesian2 }) => {
      const { building } = pickBuilding(position)
      if (building) select(building.catalog.id)
    }, ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction(({ endPosition }: { endPosition: Cartesian2 }) => {
      // Pick the actual floor GLB, so stairs and overhangs retain their owning floor.
      const { picked, building } = pickBuilding(endPosition)
      const tooltip = floorTooltipRef.current
      if (!building || !tooltip || !viewer.scene.screenSpaceCameraController.enableInputs) {
        clearHover()
        return
      }
      viewer.scene.canvas.style.cursor = 'pointer'
      scenes.forEach(item => { if (item !== building) item.models.highlight() })
      const floor = building.models.highlight(picked.primitive)
      if (bloom.enabled !== !!floor) { bloom.enabled = !!floor; viewer.scene.requestRender() }
      if (!floor) {
        if (hoveredFloorName) { hoveredFloorName = ''; setHoverFloor(null) }
        return
      }
      const left = Math.min(endPosition.x + 16, root.clientWidth - tooltip.offsetWidth - 8)
      const top = Math.min(endPosition.y + 16, root.clientHeight - 62)
      tooltip.style.transform = `translate3d(${Math.max(8, left)}px, ${Math.max(8, top)}px, 0)`
      const floorKey = `${building.catalog.id}:${floor.sequence}`
      if (hoveredFloorName !== floorKey) {
        hoveredFloorName = floorKey
        setHoverFloor({ name: `${building.catalog.label} · ${floor.name}`, elevation: floor.elevation })
      }
    }, ScreenSpaceEventType.MOUSE_MOVE)
    // Prevent Cesium's default double-click from launching a competing camera action.
    viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', escape)
    window.addEventListener('blur', clearHover)
    viewer.scene.canvas.addEventListener('pointerleave', clearHover)
    const removeCameraMoveStart = viewer.camera.moveStart.addEventListener(clearHover)
    const resize = new ResizeObserver(() => {
      clearHover()
      if (activeBuilding && selectedBuilding) motion.resize(activeBuilding.sphere)
    })
    resize.observe(root)

    async function load() {
      const metadata = await Promise.allSettled(sources.map(async source => {
        const baseUrl = `${import.meta.env.BASE_URL}${source.id}/`
        const [data, manifest] = await Promise.all(['catalog.json', 'tileset.json'].map(async file => {
          const response = await fetch(`${baseUrl}${file}`, { signal: abortController.signal })
          if (!response.ok) throw new Error(`${source.id}/${file}: ${response.status}`)
          return response.json()
        })) as [Catalog, { root: { transform: number[]; content: { uri: string } } }]
        return { source, baseUrl, data, manifest }
      }))
      if (cancelled) return
      const prepared = metadata.flatMap(result => {
        if (result.status === 'rejected') { console.error('Building metadata failed', result.reason); return [] }
        const { source, baseUrl, data, manifest } = result.value
        const transform = Matrix4.fromArray(manifest.root.transform)
        const { minimum: min, maximum: max } = data.building.bounds
        const localSphere = BoundingSphere.fromCornerPoints(Cartesian3.fromArray(min), Cartesian3.fromArray(max))
        const location = viewer.scene.globe.ellipsoid.cartesianToCartographic(Matrix4.getTranslation(transform, new Cartesian3()))
        const item: BuildingScene = {
          catalog: { ...data, ...source, longitude: CesiumMath.toDegrees(location.longitude), latitude: CesiumMath.toDegrees(location.latitude) },
          models: createBuildingModels(viewer, transform, baseUrl),
          sphere: BoundingSphere.transform(localSphere, transform), ready: false,
        }
        scenes.push(item)
        const corners = [[min[0] - 2, min[1] - 2], [max[0] + 2, min[1] - 2],
          [max[0] + 2, max[1] + 2], [min[0] - 2, max[1] + 2], [min[0] - 2, min[1] - 2]]
          .map(([x, y]) => Matrix4.multiplyByPoint(transform, new Cartesian3(x, y, 0.3), new Cartesian3()))
        viewer.entities.add({ polyline: { positions: corners, width: 2, material: Color.fromCssColorString('#d1f171').withAlpha(0.85) } })
        return [{ item, baseUrl, manifest }]
      })
      if (!prepared.length) { setLoadingState('error'); return }
      overviewSphere = BoundingSphere.fromBoundingSpheres(scenes.map(item => item.sphere))
      viewer.camera.viewBoundingSphere(overviewSphere,
        new HeadingPitchRange(CesiumMath.toRadians(25), CesiumMath.toRadians(-38), Math.max(240, overviewSphere.radius * 3.4)))
      viewer.camera.lookAtTransform(Matrix4.IDENTITY)
      const results = await Promise.allSettled(prepared.map(async ({ item, baseUrl, manifest }) => {
        try {
          await item.models.loadPreview(manifest.root.content.uri)
          if (cancelled) return
          item.ready = true
          setBuildings(scenes.filter(scene => scene.ready).map(scene => scene.catalog))
          if (!activeBuilding) { activeBuilding = item; setCatalog(item.catalog) }
          setLoadingState('ready')
          setModelStage('preview')
          const response = await fetch(`${baseUrl}structure.json`, { signal: abortController.signal })
          if (!response.ok) throw new Error(`Floor structure: ${response.status}`)
          const masks = await response.json()
          if (cancelled) return
          await item.models.loadFloors(item.catalog.storeys, masks)
        } catch (error) {
          if (!cancelled) console.error(`Building load failed: ${item.catalog.id}`, error)
          throw error
        }
      }))
      if (cancelled) return
      if (!scenes.some(item => item.ready)) setLoadingState('error')
      setModelStage(results.every(result => result.status === 'fulfilled') ? 'floors' : 'fallback')
    }
    void load()
    return () => {
      cancelled = true
      abortController.abort()
      resize.disconnect()
      window.removeEventListener('keydown', escape)
      window.removeEventListener('blur', clearHover)
      viewer.scene.canvas.removeEventListener('pointerleave', clearHover)
      removeCameraMoveStart()
      actionsRef.current = null
      motion.destroy()
      handler.destroy()
      scenes.forEach(item => item.models.destroy())
      viewer.destroy()
    }
  }, [])

  const building = catalog?.building
  const bounds = building?.bounds
  const buildingHeight = bounds ? bounds.maximum[2] - Math.max(0, bounds.minimum[2]) : 0
  const width = bounds ? bounds.maximum[0] - bounds.minimum[0] : 0
  const depth = bounds ? bounds.maximum[1] - bounds.minimum[1] : 0
  const belowGround = catalog?.storeys.filter(s => s.elevation < -1).length ?? 0
  const aboveGround = catalog?.storeys.filter(s => s.name.startsWith('지상')).length ?? 0
  const otherLevels = (catalog?.storeys.length ?? 0) - belowGround - aboveGround
  const ready = loadingState === 'ready'

  return (
    <main ref={rootRef} className="city-app" data-selected={selected} data-model-stage={modelStage}>
      <div ref={containerRef} className="map-canvas" aria-label="서울 3D 건물 지도" />
      <div className="map-vignette" />
      <div ref={floorTooltipRef} className="floor-tooltip" data-visible={!!hoverFloor} role="status" aria-live="polite">
        <span>FLOOR</span><strong>{hoverFloor?.name}</strong><small>{hoverFloor?.elevation.toFixed(1)} m</small>
      </div>
      <header className="city-header">
        <div className="city-brand"><span className="brand-mark"><Icon name="layers" size={22} /></span><h1>SMART CITY<span>SEOUL · DIGITAL TWIN</span></h1></div>
        <div className="header-status"><span className="live-dot" />{ready ? 'SCENE CONNECTED' : loadingState === 'error' ? 'LOAD FAILED' : 'CONNECTING'}<span className="status-code">01 / SEOUL</span></div>
      </header>

      <div className="scene-intro" aria-hidden={selected}>
        <span className="eyebrow"><span className="live-dot" /> URBAN INTELLIGENCE</span>
        <h2>Your city.<br /><span>In perspective.</span></h2>
        <p>도시의 공간을 연결하고,<br />건물의 이야기를 발견하세요.</p>
        <div className="intro-index"><span>01</span><i /><span>SEOUL CITY HALL</span></div>
      </div>

      <aside className="overview-stack" aria-label="도시 요약" aria-hidden={selected} inert={selected}>
        <section className="glass-card condition-card"><div className="card-heading"><h2>CONDITION</h2><span className="mini-code">SEOUL / 01</span></div>
          <div className="condition-grid"><div><span>Buildings <Icon name="building" size={14} /></span><strong>{ready ? String(buildings.length).padStart(2, '0') : '—'} <small>건물</small></strong></div><div><span>Levels <Icon name="layers" size={14} /></span><strong>{catalog?.storeys.length ?? '—'} <small>레벨</small></strong></div><div><span>Height <span>↥</span></span><strong>{buildingHeight.toFixed(1)} <small>m</small></strong></div><div><span>Footprint <Icon name="grid" size={14} /></span><strong>{(width * depth).toFixed(0)} <small>m²</small></strong></div></div>
          <p className="micro-note">모델 기준 · Footprint는 경계 상자 면적</p>
        </section>
        <section className="glass-card elevation-card"><div className="card-heading"><h2>ELEVATION</h2><span className="mini-code">METERS</span></div><div className="elevation-value">{buildingHeight.toFixed(1)}<span>m</span><small>지상 최고점</small></div>
          <div className="elevation-chart" role="img" aria-label="층별 표고 막대 차트">{catalog?.storeys.map(s => <div key={s.sequence} title={`${s.name}: ${s.elevation.toFixed(1)}m`} style={{ height: `${18 + (s.elevation + 12) / 61 * 82}%` }} />)}</div><div className="chart-axis"><span>−11.9 m</span><span>층별 표고</span><span>47.4 m</span></div>
        </section>
        {buildings.map(item => <button key={item.id} className="glass-card explore-card" onClick={() => actionsRef.current?.select(item.id)}><span className="model-badge"><Icon name="building" size={22} /></span><span>{item.label}<small>{item.building.name}</small></span><Icon name="arrow" size={18} /></button>)}
      </aside>

      <aside id="building-panel" className="building-panel" aria-labelledby="building-name" aria-hidden={!selected} inert={!selected}>
        <div className="panel-top"><span className="eyebrow">← BUILDING INSIGHT</span><button ref={closeRef} className="icon-button" aria-label="건물 정보 닫기" onClick={() => actionsRef.current?.close()}><Icon name="close" size={15} /></button></div>
        <div className="panel-details">
          <section className="glass-card identity-card"><div className="building-tag"><span className="live-dot" /> SELECTED BUILDING <span>#{building?.ifcId ?? '—'}</span></div><h2 id="building-name">{building?.name ?? '건물 정보'} · {catalog?.label}</h2><p className="project-name"><Icon name="pin" size={12} /> Seoul, City Hall <span>·</span> {building?.projectName}</p></section>
          <div className="panel-tabs" role="tablist" aria-label="건물 정보 종류"><button id="overview-tab" role="tab" aria-selected={tab === 'overview'} aria-controls="overview-content" onClick={() => setTab('overview')}>Overview</button><button id="floors-tab" role="tab" aria-selected={tab === 'floors'} aria-controls="floors-content" onClick={() => setTab('floors')}>Floor directory <span>{catalog?.storeys.length}</span></button></div>
          <div id="overview-content" role="tabpanel" aria-labelledby="overview-tab" hidden={tab !== 'overview'}>
          <section className="glass-card metrics-card"><div className="card-heading"><h3>DIMENSIONS</h3><Icon name="building" size={16} /></div><div className="stat-grid"><div><span>지상 최고점</span><strong>{buildingHeight.toFixed(1)}<small> m</small></strong></div><div><span>전체 높이</span><strong>{bounds ? (bounds.maximum[2] - bounds.minimum[2]).toFixed(1) : '—'}<small> m</small></strong></div></div><div className="segmented-bar" /><div className="dimension-row"><span>폭 <b>{width.toFixed(1)} m</b></span><span>깊이 <b>{depth.toFixed(1)} m</b></span></div></section>
          <section className="glass-card structure-card"><div className="card-heading"><h3>STRUCTURE</h3><span className="mini-code">{catalog?.storeys.length} LEVELS</span></div><div className="level-bubbles"><div><strong>{belowGround}</strong><span>지하 · PIT</span></div><div className="accent-bubble"><strong>{aboveGround}</strong><span>지상층</span></div><div><strong>{otherLevels}</strong><span>GL · 옥탑</span></div></div><div className="dimension-row"><span>기준 높이</span><b>0.0 m <em>WGS84</em></b></div></section>
          <section className="glass-card location-card"><div className="card-heading"><h3>LOCATION</h3><Icon name="pin" size={16} /></div><dl className="location-list"><div><dt>Latitude</dt><dd>{catalog?.latitude.toFixed(6)}° N</dd></div><div><dt>Longitude</dt><dd>{catalog?.longitude.toFixed(6)}° E</dd></div></dl></section>
          </div>
          <section id="floors-content" role="tabpanel" aria-labelledby="floors-tab" hidden={tab !== 'floors'} className="glass-card floor-section"><div className="card-heading"><h3>FLOOR DIRECTORY</h3><span className="mini-code">METERS</span></div>
            <ol className="floor-list">{catalog?.storeys.toReversed().map(storey => (
              <li key={storey.sequence}><span className="floor-index">{String(storey.sequence + 1).padStart(2, '0')}</span><span>{storey.name}</span><span className="floor-elevation">{storey.elevation.toFixed(1)}<small> m</small></span></li>
            ))}</ol>
          </section>
          <p className="data-note"><span className="live-dot" /> 모델 메타데이터 기준 · {catalog?.label}</p>
        </div>
      </aside>

      <div className="map-tools"><button className="icon-button focus-button" aria-label="건물 중심으로 이동" title="건물 중심으로 이동" disabled={!ready} onClick={() => actionsRef.current?.focus()}><Icon name="focus" size={19} /></button></div>
      <div className="bottom-action"><p className="map-instruction" aria-live="polite">{loadingState === 'error' ? '건물을 불러오지 못했습니다. 새로고침해 주세요.' : loadingState === 'loading' ? 'LOADING CITY MODEL…' : selected ? 'DRAG TO EXPLORE · ESC TO RETURN' : '층에 마우스를 올려 내부 조명 보기 · 클릭하여 건물 선택'}</p><button ref={openRef} className="detail-button" aria-controls="building-panel" aria-expanded={selected} disabled={!ready} onClick={() => selected ? actionsRef.current?.close() : actionsRef.current?.select()}>{selected ? '도시 보기로 돌아가기' : '건물 자세히 보기'}<Icon name="arrow" size={14} /></button></div>
      <footer className="city-footer"><div className="footer-place"><span className="footer-logo"><Icon name="layers" size={17} /></span><Icon name="pin" size={13} /><span>South Korea, Seoul</span></div><div className="footer-center">SMART CITY <span>Spatial intelligence platform</span><i /><span className="live-dot" />{ready ? 'MODEL ONLINE' : 'MODEL LOADING'}</div><div className="footer-time"><Icon name="clock" size={13} /><time>{now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })} KST</time></div><div className="footer-date">{now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Seoul' })}</div></footer>
    </main>
  )
}

export default App
