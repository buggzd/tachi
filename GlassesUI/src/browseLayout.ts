import type { MediaItem } from './data'

/** One aspect ratio per grid, even when Jellyfin returns folders or partial metadata. */
export function usesWideBrowseGrid(library: boolean, path: readonly MediaItem[], items: readonly MediaItem[]) {
  if (!library) return false
  if (!path.length) return true
  if (items.some(item => item.sourceType === 'Movie' || item.sourceType === 'Series')) return false
  // Episodes and seasons retain their existing landscape browsing layout.
  const parent = path.at(-1)
  if (parent?.sourceType === 'Series' || parent?.sourceType === 'Season') return true
  if (path.some(item => item.collectionType === 'movies' || item.collectionType === 'tvshows')) return false
  return true
}
