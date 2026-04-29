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
import { quantumCortexEffect } from './effects/quantumCortex.js'

const canvasHost = ref(null)
const status = ref('正在加载 008.glb')
const selectedMaterialLabel = ref('请选择脑区')
const selectedRegionColor = ref('')
const regionTabs = ref([])
const activeRegionKey = ref('')
const effectPresets = [cleanWhiteEffect, commit8d4ea3fEffect, quantumCortexEffect]
const activeEffectKey = ref(cleanWhiteEffect.key)
const activeEffect = computed(() => effectPresets.find((effect) => effect.key === activeEffectKey.value) || cleanWhiteEffect)
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
const FRONTAL_NODE_NAMES = new Set(['zuoeye', 'youeye'])

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
let sciFiAugmentationGroup
let modelMaxAxis
let selectedMesh
let animationFrame
let resizeObserver
let pointerDown
let glowSpriteTexture
let starSpriteTexture
let premiumAuraTexture
let premiumCausticTexture

const clock = new THREE.Clock()
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const meshClickTargets = []
const meshByRegionKey = new Map()
const selectedBrainMaterialByColor = new Map()
const animatedMaterials = []
const neuralLineMaterials = []
const neuralSparkSprites = []
const neuralTravelSignals = []
const corticalFlowParticles = []
const sciFiAccentObjects = []
const getEffect = () => activeEffect.value
const transparentBrainMaterial = createTransparentBrainMaterial()

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

  selectedBrainMaterialByColor.forEach((material, color) => {
    material.color.set(color)
    material.emissive.set(color)
    material.emissiveIntensity = effect.material.selectedEmissiveIntensity
    material.opacity = effect.material.selectedOpacity
  })

  animatedMaterials.forEach((material) => {
    material.uniforms?.glowColor?.value.set(effect.colors.fresnel)
  })

  neuralLineMaterials.forEach((material, index) => {
    material.color.set(index % 4 === 0 ? effect.colors.neuralStrong : effect.colors.neural)
  })

  neuralSparkSprites.forEach((sprite) => {
    sprite.material.color.set(sprite.userData.star ? effect.colors.neuralStrong : effect.colors.neural)
  })

  corticalFlowParticles.forEach((particle, index) => {
    particle.material.color.set(index % 5 === 0 ? effect.colors.neuralStrong : effect.colors.neural)
  })

  ;[baseGroup, sciFiAugmentationGroup].forEach((group) => {
    group?.traverse((child) => {
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.filter(Boolean).forEach((material) => {
        const colorKey = material.userData?.effectColor
        if (colorKey && material.color) material.color.set(effect.colors[colorKey] || effect.colors.baseRing)
        if (material.blending !== undefined) material.blending = getBlendingMode(effect.base.blending)

        const opacityKey = material.userData?.effectOpacity
        if (!opacityKey) return
        const nextOpacity = effect.sciFi?.[opacityKey] ?? effect.base?.[opacityKey] ?? material.userData.baseOpacity
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
  activeRegionKey.value = ''
  selectedRegionColor.value = ''
}

const applyFeatureVisibility = () => {
  if (neuralGlowGroup) neuralGlowGroup.visible = getEffect().features.neuralNetwork
  if (sciFiAugmentationGroup) sciFiAugmentationGroup.visible = Boolean(getEffect().features.sciFiAugmentation)
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
    depthWrite: false,
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

const getRegionForMeshSelection = (mesh, hitPoint) => {
  let region
  if (hitPoint && FRONTAL_NODE_NAMES.has(mesh.name) && mesh.userData.localBounds) {
    const localPoint = mesh.worldToLocal(hitPoint.clone())
    const { min, max } = mesh.userData.localBounds
    const prefrontalCutoff = min.z + (max.z - min.z) * 0.5
    region = localPoint.z >= prefrontalCutoff
      ? REGION_PALETTE.prefrontalCortex
      : REGION_PALETTE.posteriorFrontalLobe
  } else {
    region = {
      label: mesh.userData.regionLabel || mesh.name || '选中区域',
      color: mesh.userData.regionColor || getEffect().colors.selected,
    }
  }

  if (getEffect().features.useEffectSelectionColor) {
    return {
      ...region,
      color: getEffect().colors.selected,
    }
  }

  return region
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
  shell.userData.isFresnelShell = true
  mesh.add(shell)
}

const setMeshFresnelColor = (mesh, color) => {
  mesh.children.forEach((child) => {
    if (!child.userData.isFresnelShell || !child.material?.uniforms?.glowColor) return
    child.material.uniforms.glowColor.value.set(color)
  })
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

const createPremiumAuraTexture = () => {
  if (premiumAuraTexture) return premiumAuraTexture

  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const context = canvas.getContext('2d')

  const gradient = context.createRadialGradient(256, 240, 18, 256, 240, 242)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.78)')
  gradient.addColorStop(0.22, 'rgba(126, 220, 255, 0.32)')
  gradient.addColorStop(0.52, 'rgba(77, 168, 255, 0.12)')
  gradient.addColorStop(1, 'rgba(77, 168, 255, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 512, 512)

  const shaft = context.createLinearGradient(210, 0, 302, 512)
  shaft.addColorStop(0, 'rgba(255, 255, 255, 0)')
  shaft.addColorStop(0.42, 'rgba(255, 255, 255, 0.34)')
  shaft.addColorStop(0.58, 'rgba(126, 220, 255, 0.18)')
  shaft.addColorStop(1, 'rgba(255, 255, 255, 0)')
  context.fillStyle = shaft
  context.beginPath()
  context.moveTo(206, 0)
  context.lineTo(306, 0)
  context.lineTo(376, 512)
  context.lineTo(136, 512)
  context.closePath()
  context.fill()

  premiumAuraTexture = new THREE.CanvasTexture(canvas)
  premiumAuraTexture.colorSpace = THREE.SRGBColorSpace
  return premiumAuraTexture
}

const createPremiumCausticTexture = () => {
  if (premiumCausticTexture) return premiumCausticTexture

  const canvas = document.createElement('canvas')
  canvas.width = 768
  canvas.height = 384
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, canvas.width, canvas.height)

  const glow = context.createRadialGradient(384, 192, 12, 384, 192, 230)
  glow.addColorStop(0, 'rgba(126, 220, 255, 0.22)')
  glow.addColorStop(0.48, 'rgba(77, 168, 255, 0.08)')
  glow.addColorStop(1, 'rgba(77, 168, 255, 0)')
  context.fillStyle = glow
  context.fillRect(0, 0, canvas.width, canvas.height)

  context.lineCap = 'round'
  ;[
    [92, 178, 218, 86, 362, 118, 532, 86],
    [146, 246, 288, 186, 458, 232, 638, 172],
    [236, 292, 326, 218, 476, 308, 590, 250],
    [184, 134, 300, 168, 408, 70, 606, 122],
    [274, 188, 360, 142, 452, 168, 566, 130],
  ].forEach(([x1, y1, cx1, cy1, cx2, cy2, x2, y2], index) => {
    context.strokeStyle = index % 2 === 0
      ? 'rgba(126, 220, 255, 0.42)'
      : 'rgba(255, 255, 255, 0.5)'
    context.lineWidth = index % 2 === 0 ? 2.2 : 1.4
    context.beginPath()
    context.moveTo(x1, y1)
    context.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2)
    context.stroke()
  })

  premiumCausticTexture = new THREE.CanvasTexture(canvas)
  premiumCausticTexture.colorSpace = THREE.SRGBColorSpace
  return premiumCausticTexture
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
    color: mainFiber || longRangeFiber || index % 4 === 0 ? effect.colors.neuralStrong : effect.colors.neural,
    transparent: true,
    opacity: mainFiber ? 0.62 : longRangeFiber ? 0.52 : localFiber ? 0.22 : index % 4 === 0 ? 0.42 : 0.31,
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
  if (curve.userData?.localFiber) return []

  const sprites = [0, 1, 2].map((trailIndex) => ({
    sprite: createGlowSprite({
      position: curve.getPointAt(0),
      maxAxis,
      scale: 0.03 - trailIndex * 0.005,
      opacity: 0.82 - trailIndex * 0.18,
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
  const effect = getEffect()
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
      color: index % 5 === 0 ? effect.colors.neuralStrong : effect.colors.neural,
      transparent: true,
      opacity: 0.28 + seededNoise(seed + 7.1) * 0.24,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }))
    const particle = new THREE.Sprite(material)
    const particleSize = maxAxis * (0.008 + seededNoise(seed + 8.2) * 0.006)
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
    opacity: 0.92,
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
      opacity: 0.72,
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
      opacity: 0.82,
      phase: index * 0.91,
      star: true,
    })
    group.add(terminal)
  })

  group.add(createCorticalFlowParticleLayer(maxAxis, size))

  return group
}

const createPremiumLightPlane = ({ maxAxis, texture, colorKey, opacityKey, position, rotation, scale, renderOrder = 4 }) => {
  const effect = getEffect()
  const material = setBaseMaterialOptions(new THREE.MeshBasicMaterial({
    map: texture,
    color: effect.colors[colorKey] || effect.colors.premiumAura,
    transparent: true,
    opacity: effect.sciFi?.[opacityKey] ?? 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }))
  material.userData.effectColor = colorKey
  material.userData.effectOpacity = opacityKey
  material.userData.baseOpacity = material.opacity

  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
  plane.position.set(position.x * maxAxis, position.y * maxAxis, position.z * maxAxis)
  plane.rotation.set(rotation.x, rotation.y, rotation.z)
  plane.scale.set(scale.x * maxAxis, scale.y * maxAxis, 1)
  plane.renderOrder = renderOrder
  plane.userData.basePosition = plane.position.clone()
  plane.userData.floatPhase = position.phase || 0
  sciFiAccentObjects.push(plane)
  return plane
}

const createPremiumGlint = ({ maxAxis, position, scale, phase }) => {
  const effect = getEffect()
  const material = setBaseMaterialOptions(new THREE.SpriteMaterial({
    map: createStarSpriteTexture(),
    color: effect.colors.premiumGlint || '#ffffff',
    transparent: true,
    opacity: effect.sciFi?.glintOpacity ?? 0.8,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  }))
  material.userData.effectColor = 'premiumGlint'
  material.userData.effectOpacity = 'glintOpacity'
  material.userData.baseOpacity = material.opacity

  const sprite = new THREE.Sprite(material)
  const size = maxAxis * scale
  sprite.position.set(position.x * maxAxis, position.y * maxAxis, position.z * maxAxis)
  sprite.scale.set(size, size, size)
  sprite.renderOrder = 10
  sprite.userData.baseScale = size
  sprite.userData.baseOpacity = material.opacity
  sprite.userData.phase = phase
  sprite.userData.premiumGlint = true
  sciFiAccentObjects.push(sprite)
  return sprite
}

const createSciFiAugmentation = (maxAxis) => {
  const effect = getEffect()
  const group = new THREE.Group()
  group.name = 'quantum-cortex-premium-optics'

  group.add(createPremiumLightPlane({
    maxAxis,
    texture: createPremiumAuraTexture(),
    colorKey: 'premiumAura',
    opacityKey: 'auraOpacity',
    position: { x: 0.08, y: 0.16, z: -0.24, phase: 0.2 },
    rotation: { x: 0.06, y: -0.18, z: -0.04 },
    scale: { x: 1.2, y: 1.05 },
    renderOrder: 1,
  }))

  group.add(createPremiumLightPlane({
    maxAxis,
    texture: createPremiumCausticTexture(),
    colorKey: 'premiumCaustic',
    opacityKey: 'causticOpacity',
    position: { x: 0, y: -0.52, z: 0.08, phase: 1.4 },
    rotation: { x: -Math.PI / 2, y: 0, z: -0.04 },
    scale: { x: 0.96, y: 0.42 },
    renderOrder: 4,
  }))

  ;[
    [{ x: -0.3, y: 0.34, z: 0.26 }, 0.04, 0.1],
    [{ x: 0.18, y: 0.48, z: 0.16 }, 0.032, 1.2],
    [{ x: 0.42, y: 0.12, z: 0.22 }, 0.028, 2.1],
    [{ x: -0.02, y: -0.08, z: 0.34 }, 0.03, 3.3],
  ].forEach(([position, scale, phase]) => {
    group.add(createPremiumGlint({ maxAxis, position, scale, phase }))
  })

  group.visible = Boolean(effect.features.sciFiAugmentation)
  return group
}

const prepareBrainModel = (loadedScene) => {
  const meshes = []

  loadedScene.traverse((child) => {
    if (child.isMesh) meshes.push(child)
  })

  regionTabs.value = meshes.map((mesh, index) => {
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
    meshByRegionKey.set(key, mesh)
    addFresnelShell(mesh)

    return {
      key,
      label: region.label,
      detail: mesh.name,
      color: region.color,
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

  sciFiAugmentationGroup = createSciFiAugmentation(maxAxis)
  brainModel.add(sciFiAugmentationGroup)

  applyFeatureVisibility()
  applyMaterialPreset()
  applySelectionPreset()
  fitCameraToObject(brainModel)
  status.value = '008.glb 已加载，Memory Bear 风格蓝色脑光效果运行中'
}

const updatePointerFromEvent = (event) => {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
}

const selectMesh = (mesh, hitPoint) => {
  if (!mesh) return
  if (selectedMesh) {
    selectedMesh.material = transparentBrainMaterial
    setMeshFresnelColor(selectedMesh, getEffect().colors.fresnel)
  }

  const region = getRegionForMeshSelection(mesh, hitPoint)
  const regionColor = region.color || getEffect().colors.selected
  selectedMesh = mesh
  selectedMesh.material = getSelectedBrainMaterial(regionColor)
  setMeshFresnelColor(selectedMesh, regionColor)
  activeRegionKey.value = mesh.userData.regionKey || ''
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
  if (hit?.object) selectMesh(hit.object, hit.point)
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
    particle.material.opacity = particle.userData.baseOpacity * (0.36 + headGlow * 0.72)
    particle.renderOrder = 8 + (index % 3)
  })

  if (baseGroup) {
    baseGroup.rotation.y += delta * 0.12
    baseGroup.children.forEach((child) => {
      if (child.userData.spin) child.rotation.z += delta * child.userData.spin * 0.18
    })
  }

  if (sciFiAugmentationGroup?.visible) {
    sciFiAccentObjects.forEach((object, index) => {
      const phase = object.userData.phase ?? object.userData.floatPhase ?? index
      if (object.userData.premiumGlint) {
        const twinkle = 0.5 + 0.5 * Math.sin(elapsed * 2.8 + phase)
        const scale = object.userData.baseScale * (0.78 + twinkle * 0.34)
        object.scale.set(scale, scale, scale)
        object.material.opacity = object.userData.baseOpacity * (0.42 + twinkle * 0.48)
        return
      }

      if (object.userData.basePosition) {
        object.position.y = object.userData.basePosition.y + Math.sin(elapsed * 0.72 + phase) * 0.012 * modelMaxAxis
        object.material.opacity = object.material.userData.baseOpacity * (0.86 + Math.sin(elapsed * 1.1 + phase) * 0.08)
      }
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
  premiumAuraTexture?.dispose()
  premiumCausticTexture?.dispose()
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
