import { useEffect, useRef, useState } from 'react'
import {
  Cartesian3, Cesium3DTileset, Cesium3DTileStyle, Color, HeadingPitchRange, Math as CesiumMath, Matrix4,
  OpenStreetMapImageryProvider, ScreenSpaceEventHandler, ScreenSpaceEventType, Viewer,
} from 'cesium'
import type { Cartesian2 } from 'cesium'
import { createBuildingMotion } from './buildingMotion'
import { Icon } from './Icons'
import 'cesium/Build/Cesium/Widgets/widgets.css'

type Catalog = {
  building: {
    name: string
    projectName: string
    ifcId: number
    bounds: { minimum: number[]; maximum: number[] }
  }
  storeys: { sequence: number; name: string; elevation: number }[]
}
type LoadingState = 'loading' | 'ready' | 'error'

function App() {
  const rootRef = useRef<HTMLElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const openRef = useRef<HTMLButtonElement>(null)
  const actionsRef = useRef<{ select: () => void; close: () => void; focus: () => void } | null>(null)
  const [loadingState, setLoadingState] = useState<LoadingState>('loading')
  const [selected, setSelected] = useState(false)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [tab, setTab] = useState<'overview' | 'floors'>('overview')
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

    const motion = createBuildingMotion(viewer, root)
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    const abortController = new AbortController()
    let cancelled = false
    let selectedBuilding = false
    let tileset: Cesium3DTileset | undefined
    let removeTileFailed: (() => void) | undefined

    function focus() {
      if (!tileset) return
      if (selectedBuilding) { motion.resize(tileset.boundingSphere); return }
      viewer.camera.flyToBoundingSphere(tileset.boundingSphere, {
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.9,
        offset: new HeadingPitchRange(CesiumMath.toRadians(25), CesiumMath.toRadians(-38), 240),
      })
    }
    function select() {
      if (!tileset || selectedBuilding) return
      selectedBuilding = true
      setSelected(true)
      motion.animate(true, tileset.boundingSphere, () => closeRef.current?.focus({ preventScroll: true }))
    }
    function close() {
      if (!tileset || !selectedBuilding) return
      selectedBuilding = false
      setSelected(false)
      openRef.current?.focus({ preventScroll: true })
      motion.animate(false, tileset.boundingSphere)
    }
    actionsRef.current = { select, close, focus }

    function isBuilding(position: Cartesian2) {
      const picked = viewer.scene.pick(position)
      return !!tileset && (picked?.primitive === tileset || picked?.content?.tileset === tileset)
    }
    handler.setInputAction(({ position }: { position: Cartesian2 }) => {
      if (isBuilding(position)) select()
    }, ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction(({ endPosition }: { endPosition: Cartesian2 }) => {
      viewer.scene.canvas.style.cursor = isBuilding(endPosition) ? 'pointer' : 'grab'
    }, ScreenSpaceEventType.MOUSE_MOVE)
    // Prevent Cesium's default double-click from launching a competing camera action.
    viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', escape)
    const resize = new ResizeObserver(() => {
      if (tileset && selectedBuilding) motion.resize(tileset.boundingSphere)
    })
    resize.observe(root)

    async function load() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}sample_10/catalog.json`, { signal: abortController.signal })
        if (!response.ok) throw new Error(`Catalog: ${response.status}`)
        const data: Catalog = await response.json()
        if (cancelled) return
        setCatalog(data)
        const loaded = await Cesium3DTileset.fromUrl(`${import.meta.env.BASE_URL}sample_10/tileset.json`)
        if (cancelled) { loaded.destroy(); return }
        tileset = loaded
        tileset.style = new Cesium3DTileStyle({ color: "color('#637580')" })
        // The root already contains the georeference transform. Do not apply it twice.
        viewer.scene.primitives.add(tileset)
        const { minimum: min, maximum: max } = data.building.bounds
        const corners = [[min[0] - 2, min[1] - 2], [max[0] + 2, min[1] - 2],
          [max[0] + 2, max[1] + 2], [min[0] - 2, max[1] + 2], [min[0] - 2, min[1] - 2]]
          .map(([x, y]) => Matrix4.multiplyByPoint(loaded.root.transform, new Cartesian3(x, y, 0.3), new Cartesian3()))
        viewer.entities.add({ polyline: { positions: corners, width: 2, material: Color.fromCssColorString('#d1f171').withAlpha(0.85) } })
        removeTileFailed = tileset.tileFailed.addEventListener(() => setLoadingState('error'))
        viewer.camera.viewBoundingSphere(tileset.boundingSphere,
          new HeadingPitchRange(CesiumMath.toRadians(25), CesiumMath.toRadians(-38), 240))
        viewer.camera.lookAtTransform(Matrix4.IDENTITY)
        setLoadingState('ready')
      } catch (error) {
        if (!cancelled) { console.error('Building load failed', error); setLoadingState('error') }
      }
    }
    void load()
    return () => {
      cancelled = true
      abortController.abort()
      resize.disconnect()
      window.removeEventListener('keydown', escape)
      actionsRef.current = null
      removeTileFailed?.()
      motion.destroy()
      handler.destroy()
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
    <main ref={rootRef} className="city-app" data-selected={selected}>
      <div ref={containerRef} className="map-canvas" aria-label="서울 3D 건물 지도" />
      <div className="map-vignette" />
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
          <div className="condition-grid"><div><span>Buildings <Icon name="building" size={14} /></span><strong>{ready ? '01' : '—'} <small>건물</small></strong></div><div><span>Levels <Icon name="layers" size={14} /></span><strong>{catalog?.storeys.length ?? '—'} <small>레벨</small></strong></div><div><span>Height <span>↥</span></span><strong>{buildingHeight.toFixed(1)} <small>m</small></strong></div><div><span>Footprint <Icon name="grid" size={14} /></span><strong>{(width * depth).toFixed(0)} <small>m²</small></strong></div></div>
          <p className="micro-note">모델 기준 · Footprint는 경계 상자 면적</p>
        </section>
        <section className="glass-card elevation-card"><div className="card-heading"><h2>ELEVATION</h2><span className="mini-code">METERS</span></div><div className="elevation-value">{buildingHeight.toFixed(1)}<span>m</span><small>지상 최고점</small></div>
          <div className="elevation-chart" role="img" aria-label="층별 표고 막대 차트">{catalog?.storeys.map(s => <div key={s.sequence} title={`${s.name}: ${s.elevation.toFixed(1)}m`} style={{ height: `${18 + (s.elevation + 12) / 61 * 82}%` }} />)}</div><div className="chart-axis"><span>−11.9 m</span><span>층별 표고</span><span>47.4 m</span></div>
        </section>
        <button className="glass-card explore-card" disabled={!ready} onClick={() => actionsRef.current?.select()}><span className="model-badge"><Icon name="building" size={22} /></span><span>EXPLORE BUILDING<small>{building?.name ?? '불러오는 중'}</small></span><Icon name="arrow" size={18} /></button>
      </aside>

      <aside id="building-panel" className="building-panel" aria-labelledby="building-name" aria-hidden={!selected} inert={!selected}>
        <div className="panel-top"><span className="eyebrow">← BUILDING INSIGHT</span><button ref={closeRef} className="icon-button" aria-label="건물 정보 닫기" onClick={() => actionsRef.current?.close()}><Icon name="close" size={15} /></button></div>
        <div className="panel-details">
          <section className="glass-card identity-card"><div className="building-tag"><span className="live-dot" /> SELECTED BUILDING <span>#{building?.ifcId ?? '—'}</span></div><h2 id="building-name">{building?.name ?? '건물 정보'}</h2><p className="project-name"><Icon name="pin" size={12} /> Seoul, City Hall <span>·</span> {building?.projectName}</p></section>
          <div className="panel-tabs" role="tablist" aria-label="건물 정보 종류"><button id="overview-tab" role="tab" aria-selected={tab === 'overview'} aria-controls="overview-content" onClick={() => setTab('overview')}>Overview</button><button id="floors-tab" role="tab" aria-selected={tab === 'floors'} aria-controls="floors-content" onClick={() => setTab('floors')}>Floor directory <span>{catalog?.storeys.length}</span></button></div>
          <div id="overview-content" role="tabpanel" aria-labelledby="overview-tab" hidden={tab !== 'overview'}>
          <section className="glass-card metrics-card"><div className="card-heading"><h3>DIMENSIONS</h3><Icon name="building" size={16} /></div><div className="stat-grid"><div><span>지상 최고점</span><strong>{buildingHeight.toFixed(1)}<small> m</small></strong></div><div><span>전체 높이</span><strong>{bounds ? (bounds.maximum[2] - bounds.minimum[2]).toFixed(1) : '—'}<small> m</small></strong></div></div><div className="segmented-bar" /><div className="dimension-row"><span>폭 <b>{width.toFixed(1)} m</b></span><span>깊이 <b>{depth.toFixed(1)} m</b></span></div></section>
          <section className="glass-card structure-card"><div className="card-heading"><h3>STRUCTURE</h3><span className="mini-code">{catalog?.storeys.length} LEVELS</span></div><div className="level-bubbles"><div><strong>{belowGround}</strong><span>지하 · PIT</span></div><div className="accent-bubble"><strong>{aboveGround}</strong><span>지상층</span></div><div><strong>{otherLevels}</strong><span>GL · 옥탑</span></div></div><div className="dimension-row"><span>기준 높이</span><b>0.0 m <em>WGS84</em></b></div></section>
          <section className="glass-card location-card"><div className="card-heading"><h3>LOCATION</h3><Icon name="pin" size={16} /></div><dl className="location-list"><div><dt>Latitude</dt><dd>37.566536° N</dd></div><div><dt>Longitude</dt><dd>126.977966° E</dd></div></dl></section>
          </div>
          <section id="floors-content" role="tabpanel" aria-labelledby="floors-tab" hidden={tab !== 'floors'} className="glass-card floor-section"><div className="card-heading"><h3>FLOOR DIRECTORY</h3><span className="mini-code">METERS</span></div>
            <ol className="floor-list">{catalog?.storeys.toReversed().map(storey => (
              <li key={storey.sequence}><span className="floor-index">{String(storey.sequence + 1).padStart(2, '0')}</span><span>{storey.name}</span><span className="floor-elevation">{storey.elevation.toFixed(1)}<small> m</small></span></li>
            ))}</ol>
          </section>
          <p className="data-note"><span className="live-dot" /> 모델 메타데이터 기준 · SAMPLE_10</p>
        </div>
      </aside>

      <div className="map-tools"><button className="icon-button focus-button" aria-label="건물 중심으로 이동" title="건물 중심으로 이동" disabled={!ready} onClick={() => actionsRef.current?.focus()}><Icon name="focus" size={19} /></button></div>
      <div className="bottom-action"><p className="map-instruction" aria-live="polite">{loadingState === 'error' ? '건물을 불러오지 못했습니다. 새로고침해 주세요.' : loadingState === 'loading' ? 'LOADING CITY MODEL…' : selected ? 'DRAG TO EXPLORE · ESC TO RETURN' : 'SELECT A BUILDING TO EXPLORE'}</p><button ref={openRef} className="detail-button" aria-controls="building-panel" aria-expanded={selected} disabled={!ready} onClick={() => selected ? actionsRef.current?.close() : actionsRef.current?.select()}>{selected ? '도시 보기로 돌아가기' : '건물 자세히 보기'}<Icon name="arrow" size={14} /></button></div>
      <footer className="city-footer"><div className="footer-place"><span className="footer-logo"><Icon name="layers" size={17} /></span><Icon name="pin" size={13} /><span>South Korea, Seoul</span></div><div className="footer-center">SMART CITY <span>Spatial intelligence platform</span><i /><span className="live-dot" />{ready ? 'MODEL ONLINE' : 'MODEL LOADING'}</div><div className="footer-time"><Icon name="clock" size={13} /><time>{now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })} KST</time></div><div className="footer-date">{now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Seoul' })}</div></footer>
    </main>
  )
}

export default App
