import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { transformWithEsbuild } from 'vite'
const { code } = await transformWithEsbuild(await readFile(new URL('../src/browseLayout.ts', import.meta.url), 'utf8'), 'browseLayout.ts', { target: 'es2022' })
const { getCardShape, cardAspectRatios } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const covers = (...ratios) => ratios.map(primaryImageAspectRatio => ({ primaryImageAspectRatio }))

test('collection and folder types cannot turn portrait covers into landscape cards', () => {
  for (const sourceType of ['BoxSet', 'Folder', 'Movie', 'Series', undefined]) {
    assert.equal(getCardShape([{ sourceType, primaryImageAspectRatio: 2 / 3 }, { sourceType }]), 'portrait')
    assert.equal(getCardShape([{ sourceType, primaryImageAspectRatio: 16 / 9 }]), 'backdrop')
  }
})

test('Web median keeps missing metadata and outlier covers consistent with their wall', () => {
  assert.equal(getCardShape(covers(.667, undefined, .667, 1.778)), 'portrait')
  assert.equal(getCardShape(covers(1.778, undefined, .667, 1.778)), 'backdrop')
  assert.equal(getCardShape(covers(.667, 1.778)), 'backdrop')
  assert.equal(getCardShape(covers(1, 1, undefined)), 'square')
  assert.equal(getCardShape(covers(5.4)), 'banner')
  assert.equal(cardAspectRatios.banner, 1000 / 185)
})

test('Web standard-ratio snapping is applied before shape thresholds', () => {
  assert.equal(getCardShape(covers(.81)), 'portrait')
  assert.equal(getCardShape(covers(.82)), 'square')
  assert.equal(getCardShape(covers(1.2)), 'backdrop')
  assert.equal(getCardShape(covers(1.1)), 'square')
})

test('invalid and absent image metadata use Web square fallback, not a media-type guess', () => {
  assert.equal(getCardShape([]), 'square')
  assert.equal(getCardShape(covers(undefined, 0, -1, NaN, Infinity, '0.667')), 'square')
  assert.equal(getCardShape([{ sourceType: 'Movie' }, { sourceType: 'BoxSet' }]), 'square')
})

test('explicit Web library and playback rails retain landscape presentation', () => {
  for (const context of ['libraries', 'resume', 'next-up', 'episodes']) {
    assert.equal(getCardShape(covers(.667), context), 'backdrop')
  }
})
