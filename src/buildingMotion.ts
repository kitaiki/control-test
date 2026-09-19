import { Cartesian3, Matrix3, PerspectiveFrustum, Quaternion, Viewer } from 'cesium'

/** One RAF clock drives both the camera and panel, including interrupted transitions. */
export function createBuildingMotion(viewer: Viewer, root: HTMLElement) {
  let frame = 0
  let progress = 0
  let open = false
  let origin: Cartesian3 | undefined
  let originRotation: Quaternion | undefined
  let target: Cartesian3 | undefined
  let restoreInputs: boolean | undefined
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  function rotation() {
    const matrix = new Matrix3()
    Matrix3.setColumn(matrix, 0, viewer.camera.rightWC, matrix)
    Matrix3.setColumn(matrix, 1, viewer.camera.upWC, matrix)
    Matrix3.setColumn(matrix, 2, Cartesian3.negate(viewer.camera.directionWC, new Cartesian3()), matrix)
    return Quaternion.fromRotationMatrix(matrix)
  }

  function stop() {
    cancelAnimationFrame(frame)
    if (restoreInputs !== undefined) {
      viewer.scene.screenSpaceCameraController.enableInputs = restoreInputs
      restoreInputs = undefined
    }
  }

  function destination(center: Cartesian3) {
    const camera = viewer.camera
    const frustum = camera.frustum
    if (!(frustum instanceof PerspectiveFrustum)) return camera.positionWC.clone()
    const width = root.clientWidth
    const height = root.clientHeight
    const mobile = width < 720
    const panelWidth = Math.min(380, width * 0.36)
    const desiredX = mobile ? width / 2 : (panelWidth + 48 + width) / 2
    const desiredY = mobile ? height * 0.29 : height * 0.47
    const delta = Cartesian3.subtract(center, camera.positionWC, new Cartesian3())
    const depth = Cartesian3.dot(delta, camera.directionWC)
    const halfHeight = Math.max(depth, 1) * Math.tan((frustum.fovy ?? Math.PI / 3) / 2)
    const halfWidth = halfHeight * (frustum.aspectRatio ?? width / height)
    const x = Cartesian3.dot(delta, camera.rightWC) - (2 * desiredX / width - 1) * halfWidth
    const y = Cartesian3.dot(delta, camera.upWC) - (1 - 2 * desiredY / height) * halfHeight
    const position = camera.positionWC.clone()
    Cartesian3.add(position, Cartesian3.multiplyByScalar(camera.rightWC, x, new Cartesian3()), position)
    Cartesian3.add(position, Cartesian3.multiplyByScalar(camera.upWC, y, new Cartesian3()), position)
    return position
  }

  function animate(nextOpen: boolean, center: Cartesian3, complete?: () => void) {
    stop()
    viewer.camera.cancelFlight()
    if (nextOpen && !open && progress === 0) {
      origin = viewer.camera.positionWC.clone()
      originRotation = rotation()
    }
    // Reopening a closing panel reuses its destination; no cumulative camera drift.
    if (nextOpen && (progress === 0 || !target)) target = destination(center)
    open = nextOpen
    const start = viewer.camera.positionWC.clone()
    const end = (nextOpen ? target : origin) ?? start
    const startRotation = rotation()
    const endRotation = nextOpen ? startRotation : originRotation ?? startRotation
    const quaternion = new Quaternion()
    const matrix = new Matrix3()
    const direction = new Cartesian3()
    const up = new Cartesian3()
    const startProgress = progress
    const endProgress = nextOpen ? 1 : 0
    const duration = reducedMotion.matches ? 0 : 900 * Math.max(0.4, Math.abs(endProgress - progress))
    const startTime = performance.now()
    restoreInputs = viewer.scene.screenSpaceCameraController.enableInputs
    viewer.scene.screenSpaceCameraController.enableInputs = false
    const position = new Cartesian3()

    function tick(now: number) {
      const t = duration === 0 ? 1 : Math.min((now - startTime) / duration, 1)
      // Quintic smoothstep: zero velocity and acceleration at either end.
      const eased = t * t * t * (t * (t * 6 - 15) + 10)
      progress = startProgress + (endProgress - startProgress) * eased
      root.style.setProperty('--reveal', String(progress))
      root.style.setProperty('--detail', String(Math.max(0, Math.min(1, (progress - 0.18) / 0.82))))
      Matrix3.fromQuaternion(Quaternion.slerp(startRotation, endRotation, eased, quaternion), matrix)
      Cartesian3.negate(Matrix3.getColumn(matrix, 2, direction), direction)
      Matrix3.getColumn(matrix, 1, up)
      viewer.camera.setView({
        destination: Cartesian3.lerp(start, end, eased, position),
        orientation: { direction, up },
      })
      viewer.scene.requestRender()
      if (t < 1) frame = requestAnimationFrame(tick)
      else {
        stop()
        if (!nextOpen) { origin = undefined; originRotation = undefined; target = undefined }
        complete?.()
      }
    }
    frame = requestAnimationFrame(tick)
  }

  return {
    animate,
    resize(center: Cartesian3) {
      if (!open) return
      viewer.resize()
      target = destination(center)
      animate(true, center)
    },
    destroy: stop,
  }
}
