import type { MediaItem } from './data'

export type CardShape = 'portrait' | 'square' | 'backdrop' | 'banner'
export type CardLayoutContext = 'auto' | 'libraries' | 'resume' | 'next-up' | 'episodes'

export const cardAspectRatios: Record<CardShape, number> = {
  portrait: 2 / 3, square: 1, backdrop: 16 / 9, banner: 1000 / 185,
}

/** Jellyfin Web's automatic card shape: median primary-image ratio, snapped to
 * standard ratios. Missing images follow their group, never a DTO type guess.
 * Web's library shortcuts and playback/episode rails explicitly use backdrops.
 */
export function getCardShape(items: readonly MediaItem[], context: CardLayoutContext = 'auto'): CardShape {
  if (context !== 'auto') return 'backdrop'
  const ratios = items.map(item => item.primaryImageAspectRatio)
    .filter((ratio): ratio is number => typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0)
    .sort((a, b) => a - b)
  if (!ratios.length) return 'square'
  const middle = Math.floor(ratios.length / 2)
  let ratio = ratios.length % 2 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2
  for (const [standard, tolerance] of [[2 / 3, .15], [16 / 9, .2], [1, .15], [4 / 3, .15]]) {
    if (Math.abs(ratio - standard) <= tolerance) { ratio = standard; break }
  }
  return ratio >= 3 ? 'banner' : ratio >= 1.33 ? 'backdrop' : ratio > .8 ? 'square' : 'portrait'
}
