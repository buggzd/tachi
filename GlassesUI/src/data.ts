export type MediaKind = '电影' | '剧集' | '合集' | '课程' | '文件夹' | '视频'

export type MediaItem = {
  id: string
  title: string
  original?: string
  sortName?: string
  aliases?: string[]
  subtitle: string
  kind: MediaKind
  year?: string
  duration?: string
  rating?: string
  progress?: number
  art: number
  favorite?: boolean
  watched?: boolean
  unwatched?: number
  folder?: boolean
  resolution?: string
  overview?: string
  tagline?: string
  officialRating?: string
  genres?: string[]
  studios?: string[]
  people?: Array<{ name: string; role: string; type: string }>
  path?: string
  dateCreated?: string
  sourceType?: string
  mediaType?: string
  collectionType?: string
  parentId?: string
  seriesId?: string
  seasonId?: string
  indexNumber?: number
  parentIndexNumber?: number
  runtimeTicks?: number
  lastPlayedDate?: string
  playbackPositionTicks?: number
  primaryImageAspectRatio?: number
  imageUrl?: string
  coverUrl?: string
  backdropUrl?: string
  logoUrl?: string
  videoCodec?: string
  audioCodec?: string
  container?: string
  width?: number
  height?: number
  bitrate?: number
  canPlay?: boolean
}

export type MediaShelf = {
  id: string
  title: string
  eyebrow: string
  items: MediaItem[]
  library?: boolean
}

export const featured: MediaItem = {
  id: 'echoes',
  title: '深海回声',
  original: 'ECHOES OF THE ABYSS',
  subtitle: '当记忆比身体更久远，我们该如何证明自己存在过？',
  kind: '剧集',
  year: '2026',
  duration: '52 分钟',
  rating: '8.7',
  progress: 38,
  art: 0,
  favorite: true,
  resolution: '4K · HDR',
}

export const mediaItems: MediaItem[] = [
  { id: 'echoes', title: '深海回声', original: 'ECHOES OF THE ABYSS', subtitle: 'S01 E03 · 潮汐记忆', kind: '剧集', year: '2026', duration: '52 分钟', rating: '8.7', progress: 38, art: 0, favorite: true, resolution: '4K' },
  { id: 'pale-blue', title: '苍蓝之后', original: 'AFTER PALE BLUE', subtitle: '一场无人知晓的返航', kind: '电影', year: '2025', duration: '2 小时 06 分', rating: '8.3', art: 1, resolution: '4K' },
  { id: 'glass-signal', title: '玻璃信号', original: 'GLASS SIGNAL', subtitle: 'S02 E07 · 无声频段', kind: '剧集', year: '2026', duration: '47 分钟', rating: '9.1', progress: 67, art: 2, favorite: true, unwatched: 3, resolution: 'HDR' },
  { id: 'northline', title: '北境线', original: 'THE NORTH LINE', subtitle: '在极昼消失以前', kind: '电影', year: '2024', duration: '1 小时 54 分', rating: '7.9', progress: 16, art: 3, resolution: '1080P' },
  { id: 'aether', title: '以太花园', original: 'AETHER GARDEN', subtitle: '自然纪录片 · 第 4 集', kind: '剧集', year: '2025', duration: '44 分钟', rating: '9.3', art: 4, favorite: true, unwatched: 1, resolution: '4K' },
  { id: 'white-noise', title: '白噪之城', original: 'CITY OF WHITE NOISE', subtitle: '所有灯光都有记忆', kind: '电影', year: '2026', duration: '2 小时 19 分', rating: '8.5', art: 5, resolution: '4K' },
  { id: 'membrane', title: '薄膜宇宙', original: 'MEMBRANE', subtitle: 'S01 E01 · 边界', kind: '剧集', year: '2025', duration: '58 分钟', rating: '8.9', art: 6, unwatched: 8, resolution: 'HDR' },
  { id: 'rain-archive', title: '雨幕档案', original: 'RAIN ARCHIVE', subtitle: '修复版 · 导演剪辑', kind: '电影', year: '2023', duration: '2 小时 31 分', rating: '8.1', art: 7, watched: true, favorite: true, resolution: '4K' },
  { id: 'liminal', title: '临界漫游', original: 'LIMINAL DRIFT', subtitle: '第 12 章 · 时间曲面', kind: '课程', year: '2026', duration: '36 分钟', progress: 72, art: 8, resolution: '1080P' },
  { id: 'tide', title: '潮汐目录', original: 'TIDAL CATALOGUE', subtitle: '影像收藏 · 24 部', kind: '合集', year: '2026', art: 9, unwatched: 12 },
  { id: 'field-notes', title: '野外笔记', subtitle: '普通视频与素材 · 36 项', kind: '文件夹', art: 10, folder: true },
  { id: 'lecture', title: '影像叙事课', subtitle: '课程与讲座 · 18 项', kind: '文件夹', art: 11, folder: true },
]

export const shelves = [
  { title: '我的媒体', eyebrow: 'LIBRARIES', ids: ['field-notes', 'tide', 'lecture', 'echoes'] },
  { title: '继续观看', eyebrow: 'RESUME', ids: ['echoes', 'glass-signal', 'northline', 'liminal'] },
  { title: '下一集', eyebrow: 'UP NEXT', ids: ['glass-signal', 'aether', 'membrane', 'echoes'] },
  { title: '最近添加', eyebrow: 'JUST IN', ids: ['white-noise', 'pale-blue', 'aether', 'rain-archive', 'northline'] },
  { title: '科幻 · 意识边界', eyebrow: 'CURATED GENRE', ids: ['membrane', 'echoes', 'glass-signal', 'white-noise', 'pale-blue'] },
]

export const episodes = [
  { number: '01', title: '潮声以前', duration: '51 分钟', progress: 100, art: 3 },
  { number: '02', title: '下潜者', duration: '49 分钟', progress: 100, art: 5 },
  { number: '03', title: '潮汐记忆', duration: '52 分钟', progress: 38, art: 0 },
  { number: '04', title: '玻璃海床', duration: '55 分钟', progress: 0, art: 7 },
  { number: '05', title: '逆流', duration: '48 分钟', progress: 0, art: 2 },
]

export function byId(id: string) {
  return mediaItems.find((item) => item.id === id) ?? featured
}
