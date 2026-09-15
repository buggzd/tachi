#!/usr/bin/env python3
"""Summarize whitelisted TachiPlaybackTrial data; never copy arbitrary log text."""
import argparse
import json
import math
import statistics
from pathlib import Path


def stats(values):
    values = sorted(v for v in values if isinstance(v, (int, float)) and math.isfinite(v))
    if not values:
        return None
    return dict(count=len(values), mean=statistics.mean(values), median=statistics.median(values),
                p95=values[max(0, math.ceil(len(values) * .95) - 1)], min=values[0], max=values[-1])


def segments_from(lines):
    segments, current = [], []
    for line in lines:
        try:
            row = json.loads(line[line.index('{'):])
        except (ValueError, TypeError):
            continue
        if not isinstance(row, dict):
            continue
        valid = (row.get('status') == 'playing' and row.get('depthState') == 'ready'
                 and row.get('valid') is True and row.get('stereo') is True
                 and row.get('alignedLiquid') is True
                 and all(isinstance(row.get(k), (int, float)) for k in ['elapsedMs', 'pairedFrames', 'position']))
        if current and (not valid or not 0 <= row['elapsedMs'] - current[-1]['elapsedMs'] <= 2500
                        or row.get('source') != current[-1].get('source')
                        or row['pairedFrames'] < current[-1]['pairedFrames']
                        or row['position'] < current[-1]['position'] - 2):
            segments.append(current)
            current = []
        if valid:
            current.append(row)
    if current:
        segments.append(current)
    return segments


def summarize(rows):
    a, b = rows[0], rows[-1]
    seconds = (b['elapsedMs'] - a['elapsedMs']) / 1000
    counters = ['pairedFrames', 'decodedFrames', 'droppedFrames', 'supersededVideoFrames',
                'ptsMissing', 'depthPtsUnknown', 'depthPtsFuture', 'captureCandidates',
                'captureCadenceSkips', 'captureFenceSkips', 'captureSlotSkips', 'captureSubmitted',
                'captureRetryAttempts', 'captureRetrySubmitted', 'cachedPairDraws', 'pairRenderUpdates']
    delta = {k: b[k] - a[k] for k in counters if k in a and k in b}
    metrics = ['inferenceMsMean', 'inferenceMsP95', 'queueWaitMsMean', 'captureToWorkerMsMean',
               'captureToUploadMsMean', 'captureToUploadMsP95', 'gpuMeanMs', 'gpuP95Ms',
               'liquidsubmitMsMean', 'liquidfenceObservedMsMean', 'ageMs', 'playerMinusPairedMs']
    return {'samples': len(rows), 'seconds': seconds, 'firstElapsedMs': a['elapsedMs'],
            'lastElapsedMs': b['elapsedMs'], 'firstMediaSeconds': a['position'], 'lastMediaSeconds': b['position'],
            'pairedHz': delta.get('pairedFrames', 0) / seconds if seconds else None,
            'counterDeltas': delta,
            'sampledRollingStatistics': {k: stats([r[k] for r in rows if k in r]) for k in metrics},
            'sampledVideoLagMs': stats([r['pairedVideoLagUs'] / 1000 for r in rows if r.get('pairedVideoLagUs', -1) >= 0]),
            'sampledBufferAheadSeconds': stats([r['buffered'] - r['position'] for r in rows if 'buffered' in r]),
            'subtitleErrorSamples': sum(r.get('subtitleError') is True for r in rows),
            'pairedPtsAbove1000SecondsSamples': sum(r.get('pairedPtsUs', 0) > 1_000_000_000 for r in rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    segments = segments_from(args.log.read_text(errors='replace').splitlines())
    if not segments:
        raise SystemExit('No valid playing segment')
    rows = max(segments, key=lambda s: s[-1]['elapsedMs'] - s[0]['elapsedMs'])
    buckets = {}
    for row in rows:
        bucket = int((row['elapsedMs'] - rows[0]['elapsedMs']) // 60_000)
        buckets.setdefault(bucket, []).append(row)
    result = {'scope': 'Longest continuous playing/ready/valid/stereo/aligned segment; gaps >2.5 s, source changes, backward seeks and counter resets split segments. Statistics of exported rolling means/P95 are not per-frame distributions. Software PTS is not optical or audio latency.',
              'segmentCount': len(segments), 'longest': summarize(rows),
              'minuteWindows': [dict(minute=k, **summarize(v)) for k, v in buckets.items() if len(v) > 1]}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'seconds': result['longest']['seconds'], 'pairedHz': result['longest']['pairedHz']}))


if __name__ == '__main__':
    main()
