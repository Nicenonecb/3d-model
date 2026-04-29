import { commit8d4ea3fEffect } from './commit8d4ea3f.js'

export const quantumCortexEffect = {
  ...commit8d4ea3fEffect,
  key: 'quantum-cortex',
  label: '自主发挥',
  description: '提交原版 + 光学质感',
  pageClass: 'effect-quantum-cortex',
  features: {
    ...commit8d4ea3fEffect.features,
    sciFiAugmentation: true,
    useEffectSelectionColor: true,
  },
  renderSettings: {
    ...commit8d4ea3fEffect.renderSettings,
    exposure: 0.94,
    bloomStrength: 0.48,
    bloomThreshold: 0.52,
    bloomRadius: 0.32,
  },
  scene: {
    background: '#ffffff',
    clear: '#ffffff',
    fog: { type: 'linear', color: '#ffffff', near: 9, far: 28 },
  },
  colors: {
    ...commit8d4ea3fEffect.colors,
    premiumAura: '#dff3ff',
    premiumCaustic: '#7edcff',
    premiumGlint: '#ffffff',
  },
  sciFi: {
    auraOpacity: 0.36,
    causticOpacity: 0.42,
    glintOpacity: 0.82,
  },
}
