<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

const canvasHost = ref(null)
const status = ref('正在加载 008.glb')
const selectedMaterialLabel = ref('请选择脑区')
const regionTabs = ref([])
const activeRegionKey = ref('')

const renderSettings = reactive({
  exposure: 0.86,
  bloomStrength: 0.2,
  bloomThreshold: 0.82,
  bloomRadius: 0.16,
})

let renderer
let composer
let bloomPass
let scene
let camera
let orbitControls
let brainRoot
let brainModel
let baseGroup
let scanRing
let selectedMesh
let animationFrame
let resizeObserver
let pointerDown

const clock = new THREE.Clock()
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const meshClickTargets = []
const meshByRegionKey = new Map()
const animatedMaterials = []
const transparentBrainMaterial = createTransparentBrainMaterial()
const selectedBrainMaterial = createSelectedBrainMaterial()

const updateRenderSettings = () => {
  if (renderer) renderer.toneMappingExposure = renderSettings.exposure
  if (!bloomPass) return
  bloomPass.strength = renderSettings.bloomStrength
  bloomPass.threshold = renderSettings.bloomThreshold
  bloomPass.radius = renderSettings.bloomRadius
}

const resetCamera = () => {
  if (!brainModel) return
  fitCameraToObject(brainModel)
  orbitControls?.update()
}

const centerScene = (loadedScene) => {
  const box = new THREE.Box3().setFromObject(loadedScene)
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())

  loadedScene.position.sub(center)
  return Math.max(size.x, size.y, size.z) || 1
}

const fitCameraToObject = (object) => {
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const maxAxis = Math.max(size.x, size.y, size.z) || 1
  const distance = maxAxis * 1.78

  camera.position.set(distance * -1.1, distance * 0.28, distance * 0.18)
  camera.near = Math.max(distance / 100, 0.01)
  camera.far = distance * 80
  camera.updateProjectionMatrix()
  orbitControls.target.set(0, maxAxis * 0.02, 0)
  orbitControls.update()
}

function createTransparentBrainMaterial() {
  return new THREE.MeshPhysicalMaterial({
    name: '透明冰白脑体材质',
    color: '#b8ddff',
    emissive: '#bde4ff',
    emissiveIntensity: 0.055,
    metalness: 0.02,
    roughness: 0.08,
    transmission: 0,
    thickness: 0.72,
    ior: 1.48,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    transparent: true,
    opacity: 0.38,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
}

function createSelectedBrainMaterial() {
  return new THREE.MeshPhysicalMaterial({
    name: '选中区域蓝色材质',
    color: '#066fff',
    emissive: '#0768ff',
    emissiveIntensity: 0.26,
    metalness: 0.02,
    roughness: 0.16,
    transmission: 0,
    thickness: 0.42,
    ior: 1.48,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
}

const createFresnelMaterial = () => {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color('#9fd6ff') },
      time: { value: 0 },
    },
    vertexShader: `
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;

      void main() {
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform float time;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;

      void main() {
        vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
        float fresnel = pow(1.0 - max(dot(viewDirection, normalize(vWorldNormal)), 0.0), 2.0);
        float pulse = 0.76 + 0.24 * sin(time * 2.35);
        gl_FragColor = vec4(glowColor * (0.82 + fresnel) * pulse, fresnel * 0.42);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
    transparent: true,
  })

  animatedMaterials.push(material)
  return material
}

const addFresnelShell = (mesh) => {
  const shell = new THREE.Mesh(mesh.geometry, createFresnelMaterial())
  shell.name = 'frontend-generated-fresnel-shell'
  shell.scale.setScalar(1.035)
  shell.renderOrder = 2
  mesh.add(shell)
}

const prepareBrainModel = (loadedScene) => {
  const meshes = []

  loadedScene.traverse((child) => {
    if (child.isMesh) meshes.push(child)
  })

  regionTabs.value = meshes.map((mesh, index) => {
    const key = `region-${index + 1}`
    mesh.name = mesh.name || `脑区 ${index + 1}`
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.material = transparentBrainMaterial
    mesh.renderOrder = 3
    mesh.userData.regionKey = key
    meshClickTargets.push(mesh)
    meshByRegionKey.set(key, mesh)
    addFresnelShell(mesh)

    return {
      key,
      label: `区域 ${index + 1}`,
      detail: mesh.name,
    }
  })
}

const setBaseMaterialOptions = (material) => {
  material.toneMapped = false
  return material
}

const createHologramBase = (maxAxis, y) => {
  const group = new THREE.Group()
  const radius = maxAxis * 0.66
  group.position.y = y

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 128),
    setBaseMaterialOptions(new THREE.MeshBasicMaterial({
      color: '#7edcff',
      transparent: true,
      opacity: 0.22,
      blending: THREE.NormalBlending,
      depthWrite: false,
    })),
  )
  disc.rotation.x = -Math.PI / 2
  group.add(disc)

  const ringMaterial = setBaseMaterialOptions(new THREE.MeshBasicMaterial({
    color: '#29bbff',
    transparent: true,
    opacity: 0.72,
    blending: THREE.NormalBlending,
    depthWrite: false,
  }))

  ;[0.24, 0.42, 0.66, 0.92].forEach((scale, index) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * scale, maxAxis * 0.0028, 10, 160), ringMaterial.clone())
    ring.material.toneMapped = false
    ring.rotation.x = Math.PI / 2
    ring.userData.spin = index % 2 === 0 ? 1 : -1
    group.add(ring)
  })

  scanRing = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.34, maxAxis * 0.0046, 12, 160),
    setBaseMaterialOptions(new THREE.MeshBasicMaterial({
      color: '#009dff',
      transparent: true,
      opacity: 0.86,
      blending: THREE.NormalBlending,
      depthWrite: false,
    })),
  )
  scanRing.rotation.x = Math.PI / 2
  group.add(scanRing)

  const radialPositions = []
  for (let index = 0; index < 48; index += 1) {
    const angle = (index / 48) * Math.PI * 2
    const inner = radius * (index % 3 === 0 ? 0.12 : 0.52)
    const outer = radius * 0.98
    radialPositions.push(Math.cos(angle) * inner, 0.004, Math.sin(angle) * inner)
    radialPositions.push(Math.cos(angle) * outer, 0.004, Math.sin(angle) * outer)
  }

  const radialGeometry = new THREE.BufferGeometry()
  radialGeometry.setAttribute('position', new THREE.Float32BufferAttribute(radialPositions, 3))
  const radialLines = new THREE.LineSegments(
    radialGeometry,
    setBaseMaterialOptions(new THREE.LineBasicMaterial({
      color: '#5acfff',
      transparent: true,
      opacity: 0.38,
      blending: THREE.NormalBlending,
      depthWrite: false,
    })),
  )
  group.add(radialLines)

  return group
}

const loadModel = async () => {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(new URL('../008.glb', import.meta.url).href)
  const maxAxis = centerScene(gltf.scene)
  prepareBrainModel(gltf.scene)

  const box = new THREE.Box3().setFromObject(gltf.scene)
  const baseY = box.min.y - maxAxis * 0.18

  brainRoot = new THREE.Group()
  brainRoot.name = 'holographic-brain-root'
  brainRoot.add(gltf.scene)

  brainModel = new THREE.Group()
  brainModel.name = 'frontend-holographic-008-glb'
  brainModel.add(brainRoot)
  scene.add(brainModel)

  baseGroup = createHologramBase(maxAxis, baseY)
  scene.add(baseGroup)

  fitCameraToObject(brainModel)
  const defaultMesh = meshClickTargets.find((mesh) => mesh.name === 'zuozhenye') || meshClickTargets[0]
  selectMesh(defaultMesh)
  status.value = '008.glb 已加载，可点击模型或顶部 Tab 切换区域'
}

const updatePointerFromEvent = (event) => {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
}

const selectMesh = (mesh) => {
  if (!mesh) return
  if (selectedMesh) selectedMesh.material = transparentBrainMaterial
  selectedMesh = mesh
  selectedMesh.material = selectedBrainMaterial
  activeRegionKey.value = mesh.userData.regionKey || ''
  selectedMaterialLabel.value = regionTabs.value.find((item) => item.key === activeRegionKey.value)?.label || '蓝色选中区域'
}

const handleCanvasPointerDown = (event) => {
  if (event.button !== 0) return
  pointerDown = { x: event.clientX, y: event.clientY }
}

const handleCanvasPointerUp = (event) => {
  if (!pointerDown || event.button !== 0) {
    pointerDown = null
    return
  }

  const dragDistance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y)
  pointerDown = null
  if (dragDistance > 5) return

  updatePointerFromEvent(event)
  raycaster.setFromCamera(pointer, camera)

  const [hit] = raycaster.intersectObjects(meshClickTargets, false)
  if (hit?.object) selectMesh(hit.object)
}

const createScene = () => {
  const host = canvasHost.value
  const { width, height } = host.getBoundingClientRect()

  scene = new THREE.Scene()
  scene.background = new THREE.Color('#ffffff')
  scene.fog = new THREE.Fog('#ffffff', 9, 28)

  camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 1000)
  camera.position.set(4, 2, 6)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height)
  renderer.setClearColor('#ffffff', 1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = renderSettings.exposure
  host.appendChild(renderer.domElement)
  renderer.domElement.addEventListener('pointerdown', handleCanvasPointerDown)
  renderer.domElement.addEventListener('pointerup', handleCanvasPointerUp)

  const renderPass = new RenderPass(scene, camera)
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    renderSettings.bloomStrength,
    renderSettings.bloomRadius,
    renderSettings.bloomThreshold,
  )
  composer = new EffectComposer(renderer)
  composer.addPass(renderPass)
  composer.addPass(bloomPass)
  composer.addPass(new OutputPass())

  orbitControls = new OrbitControls(camera, renderer.domElement)
  orbitControls.enableDamping = true
  orbitControls.dampingFactor = 0.06
  orbitControls.autoRotate = true
  orbitControls.autoRotateSpeed = 0.42
  orbitControls.enablePan = false
  orbitControls.minDistance = 1.6
  orbitControls.maxDistance = 18

  scene.add(new THREE.HemisphereLight('#ffffff', '#cbeaff', 1.46))

  const keyLight = new THREE.DirectionalLight('#ffffff', 1.28)
  keyLight.position.set(4, 5, 6)
  scene.add(keyLight)

  const cyanRim = new THREE.DirectionalLight('#9edfff', 1.8)
  cyanRim.position.set(-5, 2.4, -3)
  scene.add(cyanRim)

  const bluePoint = new THREE.PointLight('#56b7ff', 2.2, 12)
  bluePoint.position.set(0, -0.6, 2.4)
  scene.add(bluePoint)

  resizeObserver = new ResizeObserver(([entry]) => {
    const nextWidth = entry.contentRect.width
    const nextHeight = entry.contentRect.height
    camera.aspect = nextWidth / nextHeight
    camera.updateProjectionMatrix()
    renderer.setSize(nextWidth, nextHeight)
    composer?.setSize(nextWidth, nextHeight)
  })
  resizeObserver.observe(host)
}

const animate = () => {
  const elapsed = clock.getElapsedTime()
  const delta = clock.getDelta()

  orbitControls?.update()

  if (brainRoot) {
    brainRoot.position.y = Math.sin(elapsed * 1.3) * 0.045
    brainRoot.rotation.z = Math.sin(elapsed * 0.62) * 0.018
  }

  if (baseGroup) {
    baseGroup.rotation.y += delta * 0.12
    baseGroup.children.forEach((child) => {
      if (child.userData.spin) child.rotation.z += delta * child.userData.spin * 0.18
    })
  }

  if (scanRing) {
    const phase = (elapsed * 0.34) % 1
    const scale = 0.74 + phase * 1.08
    scanRing.scale.set(scale, scale, scale)
    scanRing.material.opacity = 0.86 * (1 - phase)
  }

  animatedMaterials.forEach((material) => {
    if (material.uniforms?.time) material.uniforms.time.value = elapsed
  })

  composer?.render()
  animationFrame = requestAnimationFrame(animate)
}

onMounted(async () => {
  createScene()
  updateRenderSettings()
  animate()

  try {
    await loadModel()
  } catch (error) {
    console.error(error)
    status.value = `加载失败：${error?.message || '请确认 008.glb 位于项目根目录'}`
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  cancelAnimationFrame(animationFrame)
  orbitControls?.dispose()
  composer?.dispose()
  renderer?.domElement.removeEventListener('pointerdown', handleCanvasPointerDown)
  renderer?.domElement.removeEventListener('pointerup', handleCanvasPointerUp)
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <main class="viewer-page">
    <section class="viewer-shell" aria-label="008 GLB 分区展示页">
      <div class="stage-row">
        <div ref="canvasHost" class="canvas-host" aria-label="008 GLB 白底分区大脑预览" />

      </div>
    </section>
  </main>
</template>
