#!/usr/bin/env python3
"""Whitelisted fixture summary. Excludes media identity and unrelated input fields."""
import argparse
import json
from pathlib import Path
from summarize_product_liquid import stats


def summarize(lines, start=30, end=210):
    segments, current = [], []
    for line in lines:
        try:
            row = json.loads(line[line.index('{'):])
            render = row['depth']['render']
            valid = (row['state'] == 'playing' and render.get('valid') is True
                     and render.get('stereo') is True and render.get('alignedLiquid') is True
                     and start * 1000 <= row['positionMs'] <= end * 1000)
        except (ValueError, KeyError, TypeError):
            continue
        if current and (not valid or row['elapsedMs'] - current[-1]['elapsedMs'] > 2500
                        or row['elapsedMs'] <= current[-1]['elapsedMs']
                        or row['positionMs'] < current[-1]['positionMs']
                        or render['pairedFrames'] < current[-1]['depth']['render']['pairedFrames']):
            segments.append(current)
            current = []
        if valid:
            current.append(row)
    if current:
        segments.append(current)
    if not segments:
        raise ValueError('No valid segment')
    rows = max(segments, key=lambda s: s[-1]['elapsedMs'] - s[0]['elapsedMs'])
    a, b = rows[0], rows[-1]
    ar, br = a['depth']['render'], b['depth']['render']
    seconds = (b['elapsedMs'] - a['elapsedMs']) / 1000
    counters = {k: br[k] - ar[k] for k in ['pairedFrames', 'pairRenderUpdates', 'cachedPairDraws',
                                         'videoDraws', 'supersededVideoFrames'] if k in ar and k in br}
    paths = {'inference': ('worker', 'inferenceMs'), 'captureToWorker': ('scheduling', 'captureToWorkerMs'),
             'captureToUpload': ('render', 'timings', 'captureToUploadMs'),
             'captureToDraw': ('render', 'pairDrawTimings', 'pairCaptureToDrawMs'),
             'liquidSubmit': ('render', 'gpuLiquidCompletion', 'submitMs')}
    metrics = {}
    for name, path in paths.items():
        values = []
        for row in rows:
            value = row['depth']
            for key in path:
                value = value.get(key, {})
            if isinstance(value.get('mean'), (int, float)):
                values.append(value['mean'])
        metrics[name] = stats(values)
    return {'scope': 'Longest continuous valid fixture segment in requested media window. Stage statistics describe sampled rolling means; not physical presentation or full product playback.',
            'samples': len(rows), 'seconds': seconds,
            'firstMediaSeconds': a['positionMs'] / 1000, 'lastMediaSeconds': b['positionMs'] / 1000,
            'pairedHz': counters.get('pairedFrames', 0) / seconds if seconds else None,
            'counterDeltas': counters, 'sampledRollingMeansMs': metrics,
            'sampledVideoLagMs': stats([r['depth']['render']['pairedVideoLagUs'] / 1000 for r in rows
                                        if r['depth']['render'].get('pairedVideoLagUs', -1) >= 0]),
            'ptsCounterDeltas': {k: br['depthPts'][k] - ar['depthPts'][k] for k in ['unknown', 'future']},
            'configuration': {k: br[k] for k in ['depthWidth', 'depthHeight', 'eyeTargetWidth', 'captureSlots',
                                                'depthTargetHz', 'liquidFusedRounds', 'liquidCacheSamples',
                                                'captureBeforeLiquid'] if k in br}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log', type=Path)
    parser.add_argument('--start', type=float, default=30)
    parser.add_argument('--end', type=float, default=210)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if not 0 <= args.start < args.end:
        parser.error('invalid media window')
    result = summarize(args.log.read_text(errors='replace').splitlines(), args.start, args.end)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'seconds': result['seconds'], 'pairedHz': result['pairedHz']}))
