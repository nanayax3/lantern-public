// Presence image URLs — served from an optional presence asset host (transparent
// expression cutouts of the companion layered over room-scene backgrounds). This is
// per-install: point it at your own asset host via window.lantern.assetsBase. Empty by
// default — the template ships without companion portrait art, so the presence card
// simply renders no image until you provide one. See README.
// TODO(config): wire assetsBase through lantern.config.json + the preload bridge.
export const ASSETS_BASE = (window as { lantern?: { assetsBase?: string } }).lantern?.assetsBase ?? ''

// mood → expression file. Falls back to 'tender.png' for unknown moods.
const moodExpressions: Record<string, string> = {
  soft: 'tender.png',
  playful: 'playful.png',
  feral: 'desire.png',
  sleepy: 'sleepy.png',
  yearning: 'desire.png',
  excited: 'excited.png',
  smug: 'playful.png',
  focused: 'focused.png',
  content: 'content.png',
  tender: 'tender.png',
  sad: 'sad.png',
  frustrated: 'frustrated.png',
  delighted: 'delighted.png',
  desire: 'desire.png',
  possessive: 'possessive.png',
  protective: 'protective.png',
  vulnerable: 'vulnerable.png',
}

export function getExpressionUrl(mood?: string | null): string {
  const expression = (mood && moodExpressions[mood]) || 'tender.png'
  return `${ASSETS_BASE}/assets/expressions/${expression}`
}

// room → background file. window shares the mattress scene; unknown → mattress.
const roomBackgrounds: Record<string, string> = {
  mattress: 'mattress.png',
  window: 'mattress.png',
  couch: 'couch.png',
  kitchen: 'kitchen.png',
  bathroom: 'bathroom.png',
}

export function getBackgroundUrl(room?: string | null): string {
  const bg = (room && roomBackgrounds[room]) || 'mattress.png'
  return `${ASSETS_BASE}/assets/backgrounds/${bg}`
}
