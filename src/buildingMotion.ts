import {
  BoundingSphere, Cartesian3, Math as CesiumMath, Matrix3, Matrix4,
  PerspectiveFrustum, Quaternion, Transforms, Viewer,
} from 'cesium'

type CameraPose = { position: Cartesian3; rotation: Quaternion }

/** One RAF clock drives both the camera and panel, including interrupted transitions. */
export function createBuildingMotion(viewer: Viewer, root: HTMLElement) {
  let frame = 0
  let progress = 0
  let open = false
  let origin: Cartesian3 | undefined
  let originRotation: Quaternion | undefined
  let target: CameraPose | undefined
  let restoreInputs: boolean | undefined
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  function rotation() {
    const matrix = new Matrix3()
    Matrix3.setColumn(matrix, 0, viewer.camera.rightWC, matrix)
    Matrix3.setColumn(matrix, 1, viewer.camera.upWC, matrix)
    Matrix3.setColumn(matrix, 2, Cartesian3.negate(viewer.camera.directionWC, new Cartesian3()), matrix)
    return Quaternion.fromRotationMatrix(matrix)
  }

  function rotationFrom(direction: Cartesian3, up: Cartesian3) {
    const right = Cartesian3.normalize(Cartesian3.cross(direction, up, new Cartesian3()), new Cartesian3())
    const orthogonalUp = Cartesian3.normalize(Cartesian3.cross(right, direction, new Cartesian3()), new Cartesian3())
    const matrix = new Matrix3()
    Matrix3.setColumn(matrix, 0, right, matrix)
    Matrix3.setColumn(matrix, 1, orthogonalUp, matrix)
    Matrix3.setColumn(matrix, 2, Cartesian3.negate(direction, new Cartesian3()), matrix)
    return Quaternion.fromRotationMatrix(matrix)
  }

  function stop() {
    cancelAnimationFrame(frame)
    if (restoreInputs !== undefined) {
      viewer.scene.screenSpaceCameraController.enableInputs = restoreInputs
      restoreInputs = undefined
    }
  }

  function destination(sphere: BoundingSphere): CameraPose {
    const camera = viewer.camera
    const frustum = camera.frustum
    if (!(frustum instanceof PerspectiveFrustum)) {
      return { position: camera.positionWC.clone(), rotation: rotation() }
    }
    const width = root.clientWidth
    const height = root.clientHeight
    const mobile = width < 720
    const panelWidth = Math.min(380, width * 0.36)
    const viewport = mobile
      ? { left: 20, right: width - 20, top: 86, bottom: Math.max(190, height * 0.58 - 128) }
      : { left: panelWidth + 56, right: width - 48, top: 100, bottom: height - 100 }
    const desiredX = (viewport.left + viewport.right) / 2
    const desiredY = (viewport.top + viewport.bottom) / 2
    const horizontalRoom = Math.max(80, Math.min(desiredX - viewport.left, viewport.right - desiredX))
    const verticalRoom = Math.max(80, Math.min(desiredY - viewport.top, viewport.bottom - desiredY))
    const tanVertical = Math.tan((frustum.fovy ?? Math.PI / 3) / 2)
    const aspect = frustum.aspectRatio ?? width / height
    const tanHorizontal = tanVertical * aspect
    const range = sphere.radius * 1.18 / Math.min(
      tanHorizontal * horizontalRoom * 2 / width,
      tanVertical * verticalRoom * 2 / height,
    )

    // A slightly lower oblique view keeps the roof and facade legible together.
    const heading = CesiumMath.toRadians(28)
    const pitch = CesiumMath.toRadians(-27)
    const adjustedHeading = CesiumMath.zeroToTwoPi(heading) - CesiumMath.PI_OVER_TWO
    const pitchRotation = Quaternion.fromAxisAngle(Cartesian3.UNIT_Y, -pitch, new Quaternion())
    const headingRotation = Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, -adjustedHeading, new Quaternion())
    const offsetRotation = Quaternion.multiply(headingRotation, pitchRotation, new Quaternion())
    const offset = Matrix3.multiplyByVector(
      Matrix3.fromQuaternion(offsetRotation, new Matrix3()), Cartesian3.UNIT_X, new Cartesian3(),
    )
    Cartesian3.multiplyByScalar(Cartesian3.negate(offset, offset), range, offset)
    const localFrame = Transforms.eastNorthUpToFixedFrame(sphere.center)
    const position = Matrix4.multiplyByPoint(localFrame, offset, new Cartesian3())
    const direction = Cartesian3.normalize(Cartesian3.subtract(sphere.center, position, new Cartesian3()), new Cartesian3())
    const localUp = Cartesian3.normalize(
      Matrix4.multiplyByPointAsVector(localFrame, Cartesian3.UNIT_Z, new Cartesian3()), new Cartesian3(),
    )
    const targetRotation = rotationFrom(direction, localUp)

    // Shift the framed model into the UI's unobstructed viewport without changing its scale.
    const right = Cartesian3.normalize(Cartesian3.cross(direction, localUp, new Cartesian3()), new Cartesian3())
    const up = Cartesian3.normalize(Cartesian3.cross(right, direction, new Cartesian3()), new Cartesian3())
    const halfHeight = range * tanVertical
    const halfWidth = halfHeight * aspect
    const x = -(2 * desiredX / width - 1) * halfWidth
    const y = -(1 - 2 * desiredY / height) * halfHeight
    Cartesian3.add(position, Cartesian3.multiplyByScalar(right, x, new Cartesian3()), position)
    Cartesian3.add(position, Cartesian3.multiplyByScalar(up, y, new Cartesian3()), position)
    return { position, rotation: targetRotation }
  }

  function animate(nextOpen: boolean, sphere: BoundingSphere, complete?: () => void) {
    stop()
    viewer.camera.cancelFlight()
    if (nextOpen && !open && progress === 0) {
      origin = viewer.camera.positionWC.clone()
      originRotation = rotation()
    }
    // Reopening a closing panel reuses its destination; no cumulative camera drift.
    if (nextOpen && (progress === 0 || !target)) target = destination(sphere)
    open = nextOpen
    const start = viewer.camera.positionWC.clone()
    const end = (nextOpen ? target?.position : origin) ?? start
    const startRotation = rotation()
    const endRotation = nextOpen ? target?.rotation ?? startRotation : originRotation ?? startRotation
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
    resize(sphere: BoundingSphere) {
      if (!open) return
      viewer.resize()
      target = destination(sphere)
      animate(true, sphere)
    },
    destroy: stop,
  }
}
