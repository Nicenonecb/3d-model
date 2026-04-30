<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { cleanWhiteEffect } from './effects/cleanWhite.js'

const canvasHost = ref(null)
const selectedMaterialLabel = ref('请选择脑区')
const selectedRegionColor = ref('')

const activeEffect = cleanWhiteEffect

// 内部神经光路固定使用蓝光，保持白底蓝光版本的识别度。
const INTERNAL_GLOW_COLOR = '#4DA8FF'

// GLB 节点名到脑区的稳定映射。点击时只按 mesh 绑定色选中，避免命中点抖动造成颜色跳变。
const REGION_PALETTE = {
  prefrontalCortex: { label: 'Prefrontal cortex', color: '#FF5D34' },
  posteriorFrontalLobe: { label: 'Posterior frontal lobe', color: '#155EEF' },
  parietalLobe: { label: 'Parietal lobe', color: '#2193FF' },
  occipitalLobe: { label: 'Occipital lobe', color: '#9C6FFF' },
  cerebellum: { label: 'Cerebellum', color: '#369F21' },
  brainstem: { label: 'Brainstem', color: '#FF9100' },
  hippocampus: { label: 'Hippocampus', color: '#FF4888' },
  amygdala: { label: 'Amygdala', color: '#E18001' },
}

const REGION_BY_NODE_NAME = {
  zuoeye: REGION_PALETTE.posteriorFrontalLobe,
  youeye: REGION_PALETTE.posteriorFrontalLobe,
  zuodingye: REGION_PALETTE.parietalLobe,
  youdingye: REGION_PALETTE.parietalLobe,
  zuozhenye: REGION_PALETTE.occipitalLobe,
  youzhenye: REGION_PALETTE.occipitalLobe,
  xiaonao: REGION_PALETTE.cerebellum,
  naogan: REGION_PALETTE.brainstem,
  haimati: REGION_PALETTE.hippocampus,
  xingrenhe: REGION_PALETTE.amygdala,
}

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
let selectedMesh
let animationFrame
let resizeObserver
let pointerDown
let glowSpriteTexture
let starSpriteTexture

// Three.js 运行时对象和材质集合，用于批量同步颜色/透明度。
const clock = new THREE.Clock()
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const meshClickTargets = []
const selectedBrainMaterialByColor = new Map()
const animatedMaterials = []
const neuralLineMaterials = []
const neuralSparkSprites = []
const neuralTravelSignals = []
const corticalFlowParticles = []
const brainEdgeMaterials = []
const getEffect = () => activeEffect
const transparentBrainMaterial = createTransparentBrainMaterial()

// 同步后期曝光和 bloom 参数。
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

// 把当前白底蓝光效果应用到已创建的材质；内部神经光路强制保持蓝光。
const applyMaterialPreset = () => {
  const effect = getEffect()
  transparentBrainMaterial.color.set(effect.colors.brain)
  transparentBrainMaterial.emissive.set(effect.colors.brainEmissive)
  transparentBrainMaterial.emissiveIntensity = effect.material.brainEmissiveIntensity
  transparentBrainMaterial.opacity = effect.material.brainOpacity

  brainEdgeMaterials.forEach((material) => {
    material.color.set(effect.colors.brainEdge || effect.colors.fresnel)
    material.opacity = effect.material.edgeOpacity ?? 0.16
  })

  selectedBrainMaterialByColor.forEach((material, color) => {
    material.color.set(color)
    material.emissive.set(color)
    material.emissiveIntensity = effect.material.selectedEmissiveIntensity
    material.opacity = effect.material.selectedOpacity
  })

  animatedMaterials.forEach((material) => {
    material.uniforms?.glowColor?.value.set(effect.colors.fresnel)
  })

  neuralLineMaterials.forEach((material) => {
    material.color.set(INTERNAL_GLOW_COLOR)
  })

  neuralSparkSprites.forEach((sprite) => {
    sprite.material.color.set(INTERNAL_GLOW_COLOR)
    sprite.material.map = sprite.userData.star ? createStarSpriteTexture() : createGlowSpriteTexture()
    sprite.material.needsUpdate = true
  })

  corticalFlowParticles.forEach((particle) => {
    particle.material.color.set(INTERNAL_GLOW_COLOR)
    particle.material.map = createGlowSpriteTexture()
    particle.material.needsUpdate = true
  })

  ;[baseGroup].forEach((group) => {
    group?.traverse((child) => {
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.filter(Boolean).forEach((material) => {
        const colorKey = material.userData?.effectColor
        if (colorKey && material.color) material.color.set(effect.colors[colorKey] || effect.colors.baseRing)
        if (material.blending !== undefined) material.blending = getBlendingMode(effect.base.blending)

        const opacityKey = material.userData?.effectOpacity
        if (!opacityKey) return
        const nextOpacity = effect.base?.[opacityKey] ?? material.userData.baseOpacity
        material.userData.baseOpacity = nextOpacity
        material.opacity = nextOpacity
      })
    })
  })
}

const getDefaultMesh = () => meshClickTargets.find((mesh) => mesh.name === 'zuozhenye') || meshClickTargets[0]

const clearSelectedMesh = () => {
  if (selectedMesh) {
    selectedMesh.material = transparentBrainMaterial
    setMeshFresnelColor(selectedMesh, getEffect().colors.fresnel)
  }
  selectedMesh = null
  selectedRegionColor.value = ''
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
  selectedRegionColor.value = getEffect().colors.neural
  selectedMaterialLabel.value = '蓝色神经光路常态展示'
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
    depthWrite: true,
  })
}

function createSelectedBrainMaterial(color) {
  const effect = getEffect()
  return new THREE.MeshPhysicalMaterial({
    name: `${color} 选中区域材质`,
    color,
    emissive: color,
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
    depthWrite: true,
  })
}

const getSelectedBrainMaterial = (color) => {
  const regionColor = (color || getEffect().colors.selected).toUpperCase()
  if (!selectedBrainMaterialByColor.has(regionColor)) {
    selectedBrainMaterialByColor.set(regionColor, createSelectedBrainMaterial(regionColor))
  }

  return selectedBrainMaterialByColor.get(regionColor)
}

const getRegionDefinition = (meshName) => {
  const region = REGION_BY_NODE_NAME[meshName]
  if (region) return region

  return {
    label: meshName || 'Unknown region',
    color: getEffect().colors.selected,
  }
}

const getRegionForMeshSelection = (mesh) => {
  return {
    label: mesh.userData.regionLabel || mesh.name || '选中区域',
    color: mesh.userData.regionColor || getEffect().colors.selected,
  }
}

// Fresnel 外壳只负责边缘辉光；选中区域时会把对应 shell 的辉光色同步为脑区色。
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
        gl_FragColor = vec4(glowColor * (0.72 + fresnel * 0.9) * pulse, fresnel * 0.22);
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
  shell.userData.isFresnelShell = true
  mesh.add(shell)
}

const addStructuralEdgeLayer = (mesh) => {
  const effect = getEffect()
  const material = setBaseMaterialOptions(new THREE.LineBasicMaterial({
    color: effect.colors.brainEdge || effect.colors.fresnel,
    transparent: true,
    opacity: effect.material.edgeOpacity ?? 0.16,
    depthTest: true,
    depthWrite: false,
  }))
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 28), material)
  edges.name = 'frontend-generated-crisp-edge-layer'
  edges.scale.setScalar(1.003)
  edges.renderOrder = 5
  edges.userData.isStructuralEdgeLayer = true
  brainEdgeMaterials.push(material)
  mesh.add(edges)
}

const setMeshFresnelColor = (mesh, color) => {
  mesh.children.forEach((child) => {
    if (!child.userData.isFresnelShell || !child.material?.uniforms?.glowColor) return
    child.material.uniforms.glowColor.value.set(color)
  })
}

// 普通粒子光斑贴图：中心偏白、外圈蓝色，用于神经节点和流动粒子。
const createGlowSpriteTexture = () => {
  if (glowSpriteTexture) return glowSpriteTexture

  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 62)
  gradient.addColorStop(0, 'rgba(240, 250, 255, 1)')
  gradient.addColorStop(0.18, 'rgba(105, 181, 255, 0.96)')
  gradient.addColorStop(0.42, 'rgba(21, 94, 239, 0.36)')
  gradient.addColorStop(0.82, 'rgba(21, 94, 239, 0)')
  gradient.addColorStop(1, 'rgba(21, 94, 239, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)

  glowSpriteTexture = new THREE.CanvasTexture(canvas)
  glowSpriteTexture.colorSpace = THREE.SRGBColorSpace
  return glowSpriteTexture
}

// 星芒贴图：用于主节点和移动信号头部，让神经光路有更明确的高光节奏。
const createStarSpriteTexture = () => {
  if (starSpriteTexture) return starSpriteTexture

  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 160
  const context = canvas.getContext('2d')
  const gradient = context.createRadialGradient(80, 80, 0, 80, 80, 74)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.98)')
  gradient.addColorStop(0.12, 'rgba(156, 218, 255, 0.96)')
  gradient.addColorStop(0.32, 'rgba(41, 135, 255, 0.44)')
  gradient.addColorStop(0.76, 'rgba(41, 135, 255, 0)')
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
  const material = setBaseMaterialOptions(new THREE.SpriteMaterial({
    map: star ? createStarSpriteTexture() : createGlowSpriteTexture(),
    color: INTERNAL_GLOW_COLOR,
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
  const mainFiber = Boolean(curve.userData?.mainFiber)
  const longRangeFiber = Boolean(curve.userData?.longRangeFiber)
  const localFiber = Boolean(curve.userData?.localFiber)
  const radius = mainFiber ? 0.00135 : longRangeFiber ? 0.00108 : localFiber ? 0.00062 : index % 3 === 0 ? 0.00095 : 0.00074
  const tube = new THREE.TubeGeometry(
    curve,
    112,
    maxAxis * radius,
    8,
    false,
  )
  const material = setBaseMaterialOptions(new THREE.MeshBasicMaterial({
    color: INTERNAL_GLOW_COLOR,
    transparent: true,
    opacity: mainFiber ? 0.82 : longRangeFiber ? 0.68 : localFiber ? 0.3 : index % 4 === 0 ? 0.58 : 0.44,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  }))
  material.userData.baseOpacity = material.opacity
  material.userData.neuralStrong = mainFiber || longRangeFiber || index % 4 === 0
  neuralLineMaterials.push(material)

  const line = new THREE.Mesh(tube, material)
  line.renderOrder = 6
  return line
}

const createTravelSignal = (curve, maxAxis, branchIndex) => {
  // 局部短纤维只做静态结构，不挂移动信号，避免画面过密。
  if (curve.userData?.localFiber) return []

  const sprites = [0, 1, 2].map((trailIndex) => ({
    sprite: createGlowSprite({
      position: curve.getPointAt(0),
      maxAxis,
      scale: 0.03 - trailIndex * 0.005,
      opacity: 1 - trailIndex * 0.1,
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

const seededNoise = (seed) => {
  const value = Math.sin(seed * 91.345) * 9374.43
  return value - Math.floor(value)
}

const createCorticalFlowParticleLayer = (maxAxis, size) => {
  const group = new THREE.Group()
  group.name = 'cortical-front-to-back-flow-layer'

  const lanes = [
    { x: -0.66, y: 0.34, sway: 0.1 },
    { x: -0.42, y: 0.58, sway: 0.12 },
    { x: -0.16, y: 0.78, sway: 0.08 },
    { x: 0.16, y: 0.78, sway: 0.08 },
    { x: 0.42, y: 0.58, sway: 0.12 },
    { x: 0.66, y: 0.34, sway: 0.1 },
    { x: -0.8, y: 0.16, sway: 0.05 },
    { x: 0.8, y: 0.16, sway: 0.05 },
  ]

  const particleCount = 88
  for (let index = 0; index < particleCount; index += 1) {
    const lane = lanes[index % lanes.length]
    const seed = index * 13.17
    const flow = {
      baseX: lane.x + (seededNoise(seed) - 0.5) * 0.08,
      baseY: lane.y + (seededNoise(seed + 1.4) - 0.5) * 0.1,
      sway: lane.sway,
      startZ: 0.78 + seededNoise(seed + 2.5) * 0.08,
      endZ: -0.82 + seededNoise(seed + 3.6) * 0.08,
      speed: 0.045 + seededNoise(seed + 4.7) * 0.035,
      offset: seededNoise(seed + 5.8),
      phase: seededNoise(seed + 6.9) * Math.PI * 2,
      size,
      maxAxis,
    }
    const progress = flow.offset
    const position = brainSpacePoint([
      flow.baseX + Math.sin(progress * Math.PI * 2 + flow.phase) * flow.sway,
      flow.baseY + Math.sin(progress * Math.PI) * 0.08,
      THREE.MathUtils.lerp(flow.startZ, flow.endZ, progress),
    ], size, maxAxis)

    const material = setBaseMaterialOptions(new THREE.SpriteMaterial({
      map: createGlowSpriteTexture(),
      color: INTERNAL_GLOW_COLOR,
      transparent: true,
      opacity: 0.58 + seededNoise(seed + 7.1) * 0.34,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }))
    const particle = new THREE.Sprite(material)
    const particleSize = maxAxis * (0.010 + seededNoise(seed + 8.2) * 0.007)
    particle.position.copy(position)
    particle.scale.set(particleSize, particleSize, particleSize)
    particle.renderOrder = 8
    particle.userData.baseScale = particleSize
    particle.userData.baseOpacity = material.opacity
    particle.userData.corticalFlow = flow
    corticalFlowParticles.push(particle)
    group.add(particle)
  }

  return group
}

const createNeuralGlowNetwork = (maxAxis, size) => {
  const group = new THREE.Group()
  group.name = 'memorybear-style-neural-glow'

  // 从脑干附近的能量核心发散到皮层，形成“树状神经光路”的主体结构。
  const energyCore = [-0.02, -0.32, 0.04]
  const fiberBundles = [
    {
      relay: [-0.18, 0.08, 0.5],
      longRange: true,
      targets: [[-0.68, 0.16, 0.72], [-0.52, 0.38, 0.78], [-0.28, 0.6, 0.74], [-0.04, 0.76, 0.66], [-0.78, -0.02, 0.56], [-0.36, 0.18, 0.86]],
    },
    {
      relay: [0.18, 0.08, 0.5],
      longRange: true,
      targets: [[0.68, 0.16, 0.72], [0.52, 0.38, 0.78], [0.28, 0.6, 0.74], [0.04, 0.76, 0.66], [0.78, -0.02, 0.56], [0.36, 0.18, 0.86]],
    },
    {
      relay: [-0.2, 0.16, -0.55],
      longRange: true,
      targets: [[-0.7, 0.14, -0.72], [-0.58, 0.36, -0.82], [-0.34, 0.58, -0.86], [-0.08, 0.74, -0.76], [-0.78, -0.02, -0.58], [-0.42, 0.18, -0.9]],
    },
    {
      relay: [0.2, 0.16, -0.55],
      longRange: true,
      targets: [[0.7, 0.14, -0.72], [0.58, 0.36, -0.82], [0.34, 0.58, -0.86], [0.08, 0.74, -0.76], [0.78, -0.02, -0.58], [0.42, 0.18, -0.9]],
    },
    {
      relay: [-0.5, 0.08, 0.02],
      targets: [[-0.82, 0.12, 0.18], [-0.78, 0.28, -0.04], [-0.66, 0.44, -0.18], [-0.46, 0.24, 0.28], [-0.74, -0.04, 0.2]],
    },
    {
      relay: [0.5, 0.08, 0.02],
      targets: [[0.82, 0.12, 0.18], [0.78, 0.28, -0.04], [0.66, 0.44, -0.18], [0.46, 0.24, 0.28], [0.74, -0.04, 0.2]],
    },
    {
      relay: [-0.28, 0.34, -0.12],
      targets: [[-0.56, 0.64, -0.22], [-0.36, 0.78, -0.12], [-0.12, 0.82, -0.04], [-0.68, 0.48, 0.06], [-0.48, 0.7, 0.2], [-0.22, 0.58, -0.32], [-0.62, 0.36, -0.34]],
    },
    {
      relay: [0.28, 0.34, -0.12],
      targets: [[0.56, 0.64, -0.22], [0.36, 0.78, -0.12], [0.12, 0.82, -0.04], [0.68, 0.48, 0.06], [0.48, 0.7, 0.2], [0.22, 0.58, -0.32], [0.62, 0.36, -0.34]],
    },
    {
      relay: [0, 0.44, -0.32],
      targets: [[-0.18, 0.78, -0.5], [0.18, 0.78, -0.5], [0, 0.86, -0.34]],
    },
  ]

  const source = createGlowSprite({
    position: brainSpacePoint(energyCore, size, maxAxis),
    maxAxis,
    scale: 0.058,
    opacity: 1,
    phase: 0,
    star: true,
  })
  group.add(source)

  const curves = []
  fiberBundles.forEach((bundle, bundleIndex) => {
    const stemLift = [
      energyCore[0] * 0.72 + bundle.relay[0] * 0.18,
      energyCore[1] * 0.54 + bundle.relay[1] * 0.32 + 0.08,
      energyCore[2] * 0.72 + bundle.relay[2] * 0.18,
    ]
    const trunk = createBranchCurve([energyCore, stemLift, bundle.relay], size, maxAxis)
    trunk.userData = { mainFiber: true, longRangeFiber: Boolean(bundle.longRange) }
    curves.push(trunk)

    const relayGlow = createGlowSprite({
      position: brainSpacePoint(bundle.relay, size, maxAxis),
      maxAxis,
      scale: 0.02,
      opacity: 0.98,
      phase: bundleIndex * 0.7,
      star: true,
    })
    group.add(relayGlow)

    bundle.targets.forEach((target, targetIndex) => {
      const curveIndex = curves.length
      const drift = Math.sin((bundleIndex + 1) * (targetIndex + 2)) * 0.055
      const branchBend = [
        bundle.relay[0] * 0.54 + target[0] * 0.4 + drift,
        bundle.relay[1] * 0.42 + target[1] * 0.5 + 0.08,
        bundle.relay[2] * 0.5 + target[2] * 0.44 + Math.cos(curveIndex * 1.7) * 0.045,
      ]
      const cortexSkim = [
        target[0] * 0.96 + bundle.relay[0] * 0.02,
        target[1] * 0.96 + 0.02,
        target[2] * 0.98 + bundle.relay[2] * 0.02,
      ]
      const branch = createBranchCurve([bundle.relay, branchBend, cortexSkim, target], size, maxAxis)
      branch.userData = { longRangeFiber: Boolean(bundle.longRange) }
      curves.push(branch)
    })

  })

  curves.forEach((curve, index) => {
    group.add(createNeuralLine(curve, maxAxis, index))
    createTravelSignal(curve, maxAxis, index).forEach((sprite) => group.add(sprite))
    if (curve.userData?.mainFiber) return

    const terminal = createGlowSprite({
      position: curve.getPointAt(1),
      maxAxis,
      scale: 0.017 + (index % 3) * 0.002,
      opacity: 0.96,
      phase: index * 0.91,
      star: true,
    })
    group.add(terminal)
  })

  group.add(createCorticalFlowParticleLayer(maxAxis, size))

  return group
}

const prepareBrainModel = (loadedScene) => {
  const meshes = []

  loadedScene.traverse((child) => {
    if (child.isMesh) meshes.push(child)
  })

  meshes.forEach((mesh, index) => {
    const key = `region-${index + 1}`
    const region = getRegionDefinition(mesh.name)
    mesh.name = mesh.name || `脑区 ${index + 1}`
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.material = transparentBrainMaterial
    mesh.renderOrder = 3
    mesh.geometry.computeBoundingBox()
    mesh.userData.regionKey = key
    mesh.userData.regionLabel = region.label
    mesh.userData.regionColor = region.color
    mesh.userData.localBounds = mesh.geometry.boundingBox?.clone()
    meshClickTargets.push(mesh)
    addFresnelShell(mesh)
    addStructuralEdgeLayer(mesh)
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
  const radius = maxAxis * (effect.base.radiusScale ?? 0.66)
  const tubeScale = effect.base.tubeScale ?? 1
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

  ;[0.38, 0.64, 0.9].forEach((scale, index) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * scale, maxAxis * 0.0028 * tubeScale, 10, 160), ringMaterial.clone())
    ring.material.toneMapped = false
    ring.material.color.set(index % 2 === 0 ? effect.colors.baseRing : effect.colors.baseRingAlt)
    ring.material.userData.effectColor = index % 2 === 0 ? 'baseRing' : 'baseRingAlt'
    ring.material.userData.effectOpacity = 'ringOpacity'
    ring.material.userData.baseOpacity = effect.base.ringOpacity
    ring.rotation.x = Math.PI / 2
    ring.userData.spin = index % 2 === 0 ? 1 : -1
    group.add(ring)
  })

  scanRing = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.34, maxAxis * 0.0046 * tubeScale, 12, 160),
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

  if (effect.base.radialOpacity > 0) {
    const radialPositions = []
    for (let index = 0; index < 12; index += 1) {
      const angle = (index / 12) * Math.PI * 2
      const inner = radius * 0.72
      const outer = radius * 0.92
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
  }

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

  const modelSize = box.getSize(new THREE.Vector3())
  neuralGlowGroup = createNeuralGlowNetwork(maxAxis, modelSize)
  brainRoot.add(neuralGlowGroup)

  applyFeatureVisibility()
  applyMaterialPreset()
  applySelectionPreset()
  fitCameraToObject(brainModel)
}

const updatePointerFromEvent = (event) => {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
}

const selectMesh = (mesh) => {
  if (!mesh) return
  if (selectedMesh) {
    selectedMesh.material = transparentBrainMaterial
    setMeshFresnelColor(selectedMesh, getEffect().colors.fresnel)
  }

  const region = getRegionForMeshSelection(mesh)
  const regionColor = region.color || getEffect().colors.selected
  selectedMesh = mesh
  selectedMesh.material = getSelectedBrainMaterial(regionColor)
  setMeshFresnelColor(selectedMesh, regionColor)
  selectedRegionColor.value = regionColor
  selectedMaterialLabel.value = region.label || '选中区域'
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

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3))
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

  const cyanPoint = new THREE.PointLight(INTERNAL_GLOW_COLOR, 2.4, 14)
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3))
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
    const baseOpacity = material.userData.baseOpacity ?? (index % 4 === 0 ? 0.66 : 0.44)
    material.opacity = baseOpacity * (0.9 + Math.sin(elapsed * 1.6 + index) * 0.12)
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

  corticalFlowParticles.forEach((particle, index) => {
    const flow = particle.userData.corticalFlow
    if (!flow) return
    const progress = (elapsed * flow.speed + flow.offset) % 1
    const point = [
      flow.baseX + Math.sin(progress * Math.PI * 2 + flow.phase) * flow.sway,
      flow.baseY + Math.sin(progress * Math.PI) * 0.08,
      THREE.MathUtils.lerp(flow.startZ, flow.endZ, progress),
    ]
    particle.position.copy(brainSpacePoint(point, flow.size, flow.maxAxis))

    const headGlow = Math.sin(progress * Math.PI)
    const twinkle = 0.5 + 0.5 * Math.sin(elapsed * 3.2 + flow.phase)
    const scale = particle.userData.baseScale * (0.82 + headGlow * 0.35 + twinkle * 0.1)
    particle.scale.set(scale, scale, scale)
    particle.material.opacity = particle.userData.baseOpacity * (0.58 + headGlow * 1.02)
    particle.renderOrder = 8 + (index % 3)
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
    <section class="viewer-shell" aria-label="008 GLB 分区展示页">
      <div class="stage-row">
        <div ref="canvasHost" class="canvas-host" aria-label="008 GLB 白底分区大脑预览">
          <div class="region-readout" aria-live="polite">
            <span
              class="region-readout__swatch"
              :style="{ backgroundColor: selectedRegionColor || '#155EEF' }"
            />
            <span class="region-readout__copy">
              <strong>{{ selectedMaterialLabel }}</strong>
              <small>{{ selectedRegionColor || '点击脑区查看颜色' }}</small>
            </span>
          </div>
        </div>

      </div>
    </section>
  </main>
</template>
