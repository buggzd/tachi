import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { transformWithEsbuild } from 'vite'
const { code } = await transformWithEsbuild(await readFile(new URL('../src/browseLayout.ts', import.meta.url), 'utf8'), 'browseLayout.ts', { target: 'es2022' })
const { usesWideBrowseGrid } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('movie grids keep folders and missing metadata in the same poster layout', () => {
  const path = [{ collectionType: 'movies' }]
  assert.equal(usesWideBrowseGrid(true, path, [{ sourceType: 'Movie' }, { sourceType: 'Folder' }, {}]), false)
  assert.equal(usesWideBrowseGrid(true, path, [{ sourceType: 'Folder' }, {}]), false)
  assert.equal(usesWideBrowseGrid(true, [...path, { sourceType: 'Folder' }], [{}]), false)
  assert.equal(usesWideBrowseGrid(true, [{ sourceType: 'Folder' }], [{ sourceType: 'Movie' }, {}]), false)
})

test('library roots and episode browsing retain landscape; series and favorites retain posters', () => {
  assert.equal(usesWideBrowseGrid(true, [], [{ collectionType: 'movies' }]), true)
  assert.equal(usesWideBrowseGrid(true, [{ collectionType: 'tvshows' }], [{}]), false)
  assert.equal(usesWideBrowseGrid(true, [{ collectionType: 'tvshows' }, { sourceType: 'Season' }], [{ sourceType: 'Episode' }, {}]), true)
  assert.equal(usesWideBrowseGrid(true, [{ sourceType: 'Folder' }], [{ sourceType: 'Video' }]), true)
  assert.equal(usesWideBrowseGrid(false, [], [{ sourceType: 'Folder' }]), false)
})
