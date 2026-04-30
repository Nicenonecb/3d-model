export const cleanWhiteEffect = {
  key: 'clean-white',
  label: '白底蓝光',
  description: '当前白底、神经光路版本',
  pageClass: 'effect-clean-white',
  // 功能开关控制 Three.js 中哪些展示层可见。
  features: {
    neuralNetwork: true,
    autoSelectDefaultMesh: false,
  },
  camera: {
    distanceMultiplier: 1.38,
  },
  renderSettings: {
    exposure: 0.96,
    bloomStrength: 0.24,
    bloomThreshold: 0.68,
    bloomRadius: 0.08,
  },
  scene: {
    background: '#ffffff',
    clear: '#ffffff',
    fog: { type: 'linear', color: '#ffffff', near: 9, far: 28 },
  },
  colors: {
    // neural/neuralStrong 保留为配置语义；实际内部光路在 App.vue 中统一使用蓝光。
    neural: '#4DA8FF',
    neuralStrong: '#dff3ff',
    rim: '#8ccfff',
    baseDisc: '#155EEF',
    baseRing: '#4DA8FF',
    baseRingAlt: '#F8FCFF',
    scanRing: '#FFFFFF',
    radial: '#9edfff',
    fresnel: '#9fd6ff',
    brainEdge: '#5daeff',
    selected: '#066fff',
    selectedEmissive: '#0768ff',
    brain: '#b8ddff',
    brainEmissive: '#155EEF',
  },
  // 全脑透明材质和选中区域材质的核心参数。
  material: {
    brainOpacity: 0.5,
    brainEmissiveIntensity: 0.055,
    edgeOpacity: 0.22,
    selectedOpacity: 0.86,
    selectedEmissiveIntensity: 0.28,
  },
  // 底部全息底座：半径、环线、扫描环和径向线的可视参数。
  base: {
    radiusScale: 0.44,
    tubeScale: 0.92,
    blending: 'normal',
    discOpacity: 0.2,
    ringOpacity: 0.56,
    scanOpacity: 0.68,
    radialOpacity: 0,
  },
}
