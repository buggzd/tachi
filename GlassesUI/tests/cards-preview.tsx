import React from 'react'
import { createRoot } from 'react-dom/client'
import { MediaCard } from '../src/App'
import { getCardShape } from '../src/browseLayout'
import type { MediaItem } from '../src/data'
import { applyUiTheme } from '../../SharedUI/theme.mjs'
import '../src/styles.css'
import '../../SharedUI/simpleUI.css'
import '../src/simpleUI.css'
applyUiTheme(new URLSearchParams(location.search).get('theme') === 'simpleUI' ? 'simpleUI' : 'liquid-glass')
const noop = () => {}
const groups = [
  { name: 'collections', ratios: [2 / 3, 2 / 3, undefined] },
  { name: 'landscape', ratios: [16 / 9, 16 / 9, undefined] },
  { name: 'square', ratios: [1, 1, undefined] },
  { name: 'banner', ratios: [5.4, 5.4, undefined] },
]
createRoot(document.getElementById('root')!).render(<main style={{ padding: 40 }}>
  {groups.map(group => {
    const items: MediaItem[] = group.ratios.map((ratio, index) => ({
      id: `${group.name}-${index}`, title: index === 2 ? '缺失封面元数据' : '封面比例预览', subtitle: '合集',
      kind: '合集', sourceType: index === 2 ? 'Folder' : 'BoxSet', folder: true, art: index,
      primaryImageAspectRatio: ratio,
      imageUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#355364"/><circle cx="300" cy="360" r="170" fill="#9cb1a3"/></svg>')}`,
    }))
    const shape = getCardShape(items)
    return <section key={group.name} data-group={group.name} data-shape={shape}>
      <h2>{group.name}</h2>
      <div className="media-grid" style={{ gridTemplateColumns: 'repeat(3, 240px)', gap: 24, marginBottom: 40 }}>
        {items.map(item => <MediaCard key={item.id} item={item} shape={shape} onOpen={noop} onPreview={noop} />)}
      </div>
    </section>
  })}
</main>)
