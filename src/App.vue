<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { cleanWhiteEffect } from './effects/cleanWhite.js'
import { commit8d4ea3fEffect } from './effects/commit8d4ea3f.js'

const canvasHost = ref(null)
const status = ref('正在加载 008.glb')
const selectedMaterialLabel = ref('请选择脑区')
const regionTabs = ref([])
const activeRegionKey = ref('')
const effectPresets = [cleanWhiteEffect, commit8d4ea3fEffect]
const activeEffectKey = ref(cleanWhiteEffect.key)
const activeEffect = computed(() => effectPresets.find((effect) => effect.key === activeEffectKey.value) || cleanWhiteEffect)

const renderSettings = reactive({
  ...cleanWhiteEffect.renderSettings,
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
let neuralGlowGroup
let modelMaxAxis
let selectedMesh
let animationFrame
let resizeObserver
let pointerDown
let glowSpriteTexture
let starSpriteTexture

const clock = new THREE.Clock()
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const meshClickTargets = []
const meshByRegionKey = new Map()
const animatedMaterials = []
const neuralLineMaterials = []
const neuralSparkSprites = []
const neuralTravelSignals = []
const getEffect = () => activeEffect.value
const transparentBrainMaterial = createTransparentBrainMaterial()
const selectedBrainMaterial = createSelectedBrainMaterial()

const updateRenderSettings = () => {
  if (renderer) renderer.toneMappingExposure = renderSettings.exposure
  if (!bloomPass) return
  bloomPass.strength = renderSettings.bloomStrength
  bloomPass.threshold = renderSettings.bloomThreshold
  bloomPass.radius = renderSettings.bloomRadius
}

const applySceneStyle = () => {
  if (!scene || !renderer) return
  const { scene: sceneStyle } = getEffect()
  scene.background = new THREE.Color(sceneStyle.background)
  renderer.setClearColor(sceneStyle.clear, 1)
  scene.fog = sceneStyle.fog.type === 'exp2'
    ? new THREE.FogExp2(sceneStyle.fog.color, sceneStyle.fog.density)
    : new THREE.Fog(sceneStyle.fog.color, sceneStyle.fog.near, sceneStyle.fog.far)
}

const applyMaterialPreset = () => {
  const effect = getEffect()
  transparentBrainMaterial.color.set(effect.colors.brain)
  transparentBrainMaterial.emissive.set(effect.colors.brainEmissive)
  transparentBrainMaterial.emissiveIntensity = effect.material.brainEmissiveIntensity
  transparentBrainMaterial.opacity = effect.material.brainOpacity

  selectedBrainMaterial.color.set(effect.colors.selected)
  selectedBrainMaterial.emissive.set(effect.colors.selectedEmissive)
  selectedBrainMaterial.emissiveIntensity = effect.material.selectedEmissiveIntensity
  selectedBrainMaterial.opacity = effect.material.selectedOpacity

  animatedMaterials.forEach((material) => {
    material.uniforms?.glowColor?.value.set(effect.colors.fresnel)
  })

  neuralLineMaterials.forEach((material, index) => {
    material.color.set(index % 4 === 0 ? effect.colors.neuralStrong : effect.colors.neural)
  })

  neuralSparkSprites.forEach((sprite) => {
    sprite.material.color.set(sprite.userData.star ? effect.colors.neuralStrong : effect.colors.neural)
  })

  baseGroup?.traverse((child) => {
    const colorKey = child.material?.userData?.effectColor
    if (!colorKey) return
    child.material.color.set(effect.colors[colorKey])
    child.material.blending = getBlendingMode(effect.base.blending)
    const opacityKey = child.material.userData.effectOpacity
    child.material.userData.baseOpacity = effect.base[opacityKey]
    child.material.opacity = effect.base[opacityKey]
  })
}

const getDefaultMesh = () => meshClickTargets.find((mesh) => mesh.name === 'zuozhenye') || meshClickTargets[0]

const clearSelectedMesh = () => {
  if (selectedMesh) selectedMesh.material = transparentBrainMaterial
  selectedMesh = null
  activeRegionKey.value = ''
}

const applyFeatureVisibility = () => {
  if (neuralGlowGroup) neuralGlowGroup.visible = getEffect().features.neuralNetwork
}

const applySelectionPreset = () => {
  if (getEffect().features.autoSelectDefaultMesh) {
    selectMesh(getDefaultMesh())
    return
  }

  clearSelectedMesh()
  selectedMaterialLabel.value = '蓝色神经光路常态展示'
}

const setActiveEffect = (key) => {
  activeEffectKey.value = key
  Object.assign(renderSettings, getEffect().renderSettings)
  updateRenderSettings()
  applySceneStyle()
  applyMaterialPreset()
  applyFeatureVisibility()
  applySelectionPreset()
  resetCamera()
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
  const distance = maxAxis * getEffect().camera.distanceMultiplier

  camera.position.set(distance * -1.1, distance * 0.28, distance * 0.18)
  camera.near = Math.max(distance / 100, 0.01)
  camera.far = distance * 80
  camera.updateProjectionMatrix()
  orbitControls.target.set(0, maxAxis * 0.02, 0)
  orbitControls.update()
}

function createTransparentBrainMaterial() {
  const effect = getEffect()
  return new THREE.MeshPhysicalMaterial({
    name: '透明冰蓝脑体材质',
    color: effect.colors.brain,
    emissive: effect.colors.brainEmissive,
    emissiveIntensity: effect.material.brainEmissiveIntensity,
    metalness: 0.02,
    roughness: 0.08,
    transmission: 0,
    thickness: 0.72,
    ior: 1.48,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    transparent: true,
    opacity: effect.material.brainOpacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
}

function createSelectedBrainMaterial() {
  const effect = getEffect()
  return new THREE.MeshPhysicalMaterial({
    name: '选中区域蓝色材质',
    color: effect.colors.selected,
    emissive: effect.colors.selectedEmissive,
    emissiveIntensity: effect.material.selectedEmissiveIntensity,
    metalness: 0.02,
    roughness: 0.16,
    transmission: 0,
    thickness: 0.42,
    ior: 1.48,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    transparent: true,
    opacity: effect.material.selectedOpacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
}

const createFresnelMaterial = () => {
  const effect = getEffect()
  const material = new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(effect.colors.fresnel) },
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
        gl_FragColor = vec4(glowColor * (0.72 + fresnel * 0.9) * pulse, fresnel * 0.32);
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

const createGlowSpriteTexture = () => {
  if (glowSpriteTexture) return glowSpriteTexture

  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 62)
  gradient.addColorStop(0, 'rgba(240, 250, 255, 1)')
  gradient.addColorStop(0.18, 'rgba(105, 181, 255, 0.96)')
  gradient.addColorStop(0.5, 'rgba(21, 94, 239, 0.48)')
  gradient.addColorStop(1, 'rgba(21, 94, 239, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)

  glowSpriteTexture = new THREE.CanvasTexture(canvas)
  glowSpriteTexture.colorSpace = THREE.SRGBColorSpace
  return glowSpriteTexture
}

const createStarSpriteTexture = () => {
  if (starSpriteTexture) return starSpriteTexture

  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 160
  const context = canvas.getContext('2d')
  const gradient = context.createRadialGradient(80, 80, 0, 80, 80, 74)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.98)')
  gradient.addColorStop(0.12, 'rgba(156, 218, 255, 0.96)')
  gradient.addColorStop(0.38, 'rgba(41, 135, 255, 0.52)')
  gradient.addColorStop(1, 'rgba(41, 135, 255, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 160, 160)
  context.strokeStyle = 'rgba(92, 191, 255, 0.9)'
  context.lineWidth = 1.2

  ;[0, Math.PI / 4, Math.PI / 2, (Math.PI * 3) / 4].forEach((angle) => {
    const length = angle % (Math.PI / 2) === 0 ? 66 : 42
    context.beginPath()
    context.moveTo(80 - Math.cos(angle) * 8, 80 - Math.sin(angle) * 8)
    context.lineTo(80 + Math.cos(angle) * length, 80 + Math.sin(angle) * length)
    context.moveTo(80 + Math.cos(angle) * 8, 80 + Math.sin(angle) * 8)
    context.lineTo(80 - Math.cos(angle) * length, 80 - Math.sin(angle) * length)
    context.stroke()
  })

  starSpriteTexture = new THREE.CanvasTexture(canvas)
  starSpriteTexture.colorSpace = THREE.SRGBColorSpace
  return starSpriteTexture
}

const createGlowSprite = ({ position, maxAxis, scale, opacity, phase = 0, star = false }) => {
  const effect = getEffect()
  const material = setBaseMaterialOptions(new THREE.SpriteMaterial({
    map: star ? createStarSpriteTexture() : createGlowSpriteTexture(),
    color: star ? effect.colors.neuralStrong : effect.colors.neural,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  }))
  const sprite = new THREE.Sprite(material)
  const size = maxAxis * scale
  sprite.position.copy(position)
  sprite.scale.set(size, size, size)
  sprite.renderOrder = 9
  sprite.userData.baseScale = size
  sprite.userData.baseOpacity = opacity
  sprite.userData.phase = phase
  sprite.userData.star = star
  neuralSparkSprites.push(sprite)
  return sprite
}

const brainSpacePoint = (point, size, maxAxis) => new THREE.Vector3(
  point[0] * size.x * 0.45,
  point[1] * size.y * 0.5 + maxAxis * 0.02,
  point[2] * size.z * 0.36,
)

const createBranchCurve = (points, size, maxAxis) => new THREE.CatmullRomCurve3(
  points.map((point) => brainSpacePoint(point, size, maxAxis)),
)

const createNeuralLine = (curve, maxAxis, index) => {
  const effect = getEffect()
  const tube = new THREE.TubeGeometry(curve, 96, maxAxis * (index % 3 === 0 ? 0.0026 : 0.0018), 8, false)
  const material = setBaseMaterialOptions(new THREE.MeshBasicMaterial({
    color: index % 4 === 0 ? effect.colors.neuralStrong : effect.colors.neural,
    transparent: true,
    opacity: index % 4 === 0 ? 0.68 : 0.48,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  }))
  neuralLineMaterials.push(material)

  const line = new THREE.Mesh(tube, material)
  line.renderOrder = 6
  return line
}

const createTravelSignal = (curve, maxAxis, branchIndex) => {
  const sprites = [0, 1, 2].map((trailIndex) => ({
    sprite: createGlowSprite({
      position: curve.getPointAt(0),
      maxAxis,
      scale: 0.04 - trailIndex * 0.007,
      opacity: 0.95 - trailIndex * 0.2,
      phase: branchIndex * 0.7 + trailIndex,
      star: trailIndex === 0,
    }),
    gap: trailIndex * 0.018,
  }))

  neuralTravelSignals.push({
    curve,
    sprites,
    speed: 0.09 + (branchIndex % 5) * 0.012,
    offset: (branchIndex * 0.053) % 1,
    phase: branchIndex * 0.53,
  })

  return sprites.map(({ sprite }) => sprite)
}

const createNeuralGlowNetwork = (maxAxis, size) => {
  const group = new THREE.Group()
  group.name = 'memorybear-style-neural-glow'

  const centerHub = [-0.05, -0.12, 0.12]
  const upperHub = [0.02, 0.18, 0.08]
  const cortexTargets = [
    [-0.88, 0.28, 0.06], [-0.78, 0.48, -0.22], [-0.58, 0.66, 0.16],
    [-0.32, 0.78, -0.08], [-0.08, 0.82, 0.18], [0.18, 0.76, -0.12],
    [0.44, 0.66, 0.14], [0.72, 0.48, -0.1], [0.88, 0.22, 0.08],
    [0.72, -0.08, 0.22], [0.42, -0.24, 0.28], [0.1, -0.28, 0.32],
    [-0.24, -0.18, 0.34], [-0.58, 0.06, 0.2], [-0.72, 0.24, -0.16],
    [-0.54, 0.38, 0.42], [-0.22, 0.56, 0.42], [0.28, 0.54, 0.4],
    [0.62, 0.28, 0.34], [-0.42, 0.3, -0.42], [0.42, 0.34, -0.44],
    [-0.02, 0.88, -0.02], [0.58, 0.62, -0.32], [-0.68, 0.64, 0.3],
  ]

  const branches = cortexTargets.map((target, index) => {
    const hub = index % 4 === 0 ? upperHub : centerHub
    const control = [
      target[0] * 0.55 + Math.sin(index * 1.3) * 0.06,
      target[1] * 0.54 + (target[1] > 0.45 ? 0.12 : 0.04),
      target[2] * 0.46 + Math.cos(index * 1.7) * 0.05,
    ]
    return createBranchCurve([centerHub, hub, control, target], size, maxAxis)
  })

  branches.forEach((curve, index) => {
    group.add(createNeuralLine(curve, maxAxis, index))
    createTravelSignal(curve, maxAxis, index).forEach((sprite) => group.add(sprite))

    const terminal = createGlowSprite({
      position: curve.getPointAt(1),
      maxAxis,
      scale: 0.022 + (index % 3) * 0.003,
      opacity: 1,
      phase: index * 0.91,
      star: true,
    })
    group.add(terminal)
  })

  return group
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

const getBlendingMode = (mode) => (mode === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending)

const createHologramBase = (maxAxis, y) => {
  const effect = getEffect()
  const group = new THREE.Group()
  const radius = maxAxis * 0.66
  group.position.y = y

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 128),
    setBaseMaterialOptions(new THREE.MeshBasicMaterial({
      color: effect.colors.baseDisc,
      transparent: true,
      opacity: effect.base.discOpacity,
      blending: getBlendingMode(effect.base.blending),
      depthWrite: false,
    })),
  )
  disc.material.userData.effectColor = 'baseDisc'
  disc.material.userData.effectOpacity = 'discOpacity'
  disc.material.userData.baseOpacity = effect.base.discOpacity
  disc.rotation.x = -Math.PI / 2
  group.add(disc)

  const ringMaterial = setBaseMaterialOptions(new THREE.MeshBasicMaterial({
    color: effect.colors.baseRing,
    transparent: true,
    opacity: effect.base.ringOpacity,
    blending: getBlendingMode(effect.base.blending),
    depthWrite: false,
  }))

  ;[0.24, 0.42, 0.66, 0.92].forEach((scale, index) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * scale, maxAxis * 0.0028, 10, 160), ringMaterial.clone())
    ring.material.toneMapped = false
    ring.material.userData.effectColor = 'baseRing'
    ring.material.userData.effectOpacity = 'ringOpacity'
    ring.material.userData.baseOpacity = effect.base.ringOpacity
    ring.rotation.x = Math.PI / 2
    ring.userData.spin = index % 2 === 0 ? 1 : -1
    group.add(ring)
  })

  scanRing = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.34, maxAxis * 0.0046, 12, 160),
    setBaseMaterialOptions(new THREE.MeshBasicMaterial({
      color: effect.colors.scanRing,
      transparent: true,
      opacity: effect.base.scanOpacity,
      blending: getBlendingMode(effect.base.blending),
      depthWrite: false,
    })),
  )
  scanRing.material.userData.effectColor = 'scanRing'
  scanRing.material.userData.effectOpacity = 'scanOpacity'
  scanRing.material.userData.baseOpacity = effect.base.scanOpacity
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
      color: effect.colors.radial,
      transparent: true,
      opacity: effect.base.radialOpacity,
      blending: getBlendingMode(effect.base.blending),
      depthWrite: false,
    })),
  )
  radialLines.material.userData.effectColor = 'radial'
  radialLines.material.userData.effectOpacity = 'radialOpacity'
  radialLines.material.userData.baseOpacity = effect.base.radialOpacity
  group.add(radialLines)

  return group
}

const loadModel = async () => {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(new URL('../008.glb', import.meta.url).href)
  const maxAxis = centerScene(gltf.scene)
  modelMaxAxis = maxAxis
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

  const modelSize = box.getSize(new THREE.Vector3())
  neuralGlowGroup = createNeuralGlowNetwork(maxAxis, modelSize)
  brainRoot.add(neuralGlowGroup)

  applyFeatureVisibility()
  applySelectionPreset()
  fitCameraToObject(brainModel)
  status.value = '008.glb 已加载，Memory Bear 风格蓝色脑光效果运行中'
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
  const effect = getEffect()

  scene = new THREE.Scene()
  scene.background = new THREE.Color(effect.scene.background)
  scene.fog = effect.scene.fog.type === 'exp2'
    ? new THREE.FogExp2(effect.scene.fog.color, effect.scene.fog.density)
    : new THREE.Fog(effect.scene.fog.color, effect.scene.fog.near, effect.scene.fog.far)

  camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 1000)
  camera.position.set(4, 2, 6)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height)
  renderer.setClearColor(effect.scene.clear, 1)
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

  scene.add(new THREE.HemisphereLight('#e7f6ff', '#071328', 0.94))

  const keyLight = new THREE.DirectionalLight('#ffffff', 0.92)
  keyLight.position.set(4, 5, 6)
  scene.add(keyLight)

  const cyanRim = new THREE.DirectionalLight(effect.colors.rim, 1.4)
  cyanRim.position.set(-5, 2.4, -3)
  scene.add(cyanRim)

  const cyanPoint = new THREE.PointLight(effect.colors.neural, 2.4, 14)
  cyanPoint.position.set(0.6, -0.2, 2.6)
  scene.add(cyanPoint)

  const bluePoint = new THREE.PointLight('#3678ff', 1.1, 16)
  bluePoint.position.set(-2.4, 1.2, -3)
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

  neuralLineMaterials.forEach((material, index) => {
    material.opacity = (index % 4 === 0 ? 0.66 : 0.44) + Math.sin(elapsed * 1.6 + index) * 0.08
  })

  neuralSparkSprites.forEach((sprite) => {
    const twinkle = 0.5 + 0.5 * Math.sin(elapsed * 2.5 + sprite.userData.phase)
    const scale = sprite.userData.baseScale * (0.92 + twinkle * 0.16)
    sprite.scale.set(scale, scale, scale)
    sprite.material.opacity = sprite.userData.baseOpacity * (0.66 + twinkle * 0.3)
  })

  neuralTravelSignals.forEach((signal) => {
    const power = 0.72 + 0.28 * Math.sin(elapsed * 5.2 + signal.phase)
    signal.sprites.forEach(({ sprite, gap }, trailIndex) => {
      const progress = (elapsed * signal.speed + signal.offset - gap + 1) % 1
      const fade = 1 - trailIndex * 0.25
      sprite.position.copy(signal.curve.getPointAt(progress))
      sprite.material.opacity = sprite.userData.baseOpacity * fade * power
    })
  })

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
    scanRing.material.opacity = scanRing.material.userData.baseOpacity * (1 - phase)
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
  glowSpriteTexture?.dispose()
  starSpriteTexture?.dispose()
  renderer?.domElement.removeEventListener('pointerdown', handleCanvasPointerDown)
  renderer?.domElement.removeEventListener('pointerup', handleCanvasPointerUp)
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <main class="viewer-page" :class="activeEffect.pageClass">
    <aside class="effect-switcher" aria-label="效果切换">
      <button
        v-for="effect in effectPresets"
        :key="effect.key"
        class="effect-switcher__button"
        :class="{ 'effect-switcher__button--active': effect.key === activeEffectKey }"
        type="button"
        @click="setActiveEffect(effect.key)"
      >
        <span>{{ effect.label }}</span>
        <small>{{ effect.description }}</small>
      </button>
    </aside>
    <section class="viewer-shell" aria-label="008 GLB 分区展示页">
      <div class="stage-row">
        <div ref="canvasHost" class="canvas-host" aria-label="008 GLB 白底分区大脑预览" />

      </div>
    </section>
  </main>
</template>
