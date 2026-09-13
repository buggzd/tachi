#!/usr/bin/env python3
"""Summarize sanitized TachiPlaybackTrial rows; windows are recent rolling metrics.

Input must be the diagnostic-only logcat tag, never an unfiltered device log.
This tool does not infer presentation drops from video FPS or GL updates.
"""
import argparse
import json
import math
from pathlib import Path


def percentile(values, p):
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * p) - 1)] if values else None


def summarize(rows):
    first, last = rows[0], rows[-1]
    seconds = (last['elapsedMs'] - first['elapsedMs']) / 1000
    result = {'seconds': seconds, 'samples': len(rows),
              'positionAdvanceSeconds': last.get('position', 0) - first.get('position', 0),
              'maxSampleGapSeconds': max((b['elapsedMs'] - a['elapsedMs']) / 1000
                                         for a, b in zip(rows, rows[1:])) if len(rows) > 1 else 0}
    counters = ['depthComputed', 'uploads', 'decodedFrames', 'droppedFrames',
                'skippedDecoderFrames', 'videoDraws', 'supersededVideoFrames',
                'ptsReleaseMatches', 'ptsDirectMatches', 'ptsMissing',
                'depthPtsSamples', 'depthPtsUnknown', 'depthPtsFuture']
    result['deltas'] = {k: last[k] - first[k] for k in counters if k in first and k in last}
    result['depthHz'] = result['deltas'].get('depthComputed', 0) / seconds if seconds else None
    metrics = ['preprocessMsMean', 'inferenceMsMean', 'inferenceMsP95',
               'queueWaitMsMean', 'queueWaitMsP95', 'captureToWorkerMsMean',
               'captureToUploadMsMean', 'captureToUploadMsP95', 'gpuMeanMs',
               'gpuP95Ms', 'depthPtsLagMeanMs', 'depthPtsLagP95Ms', 'depthPtsLagMaxMs']
    result['rollingSnapshots'] = {}
    for key in metrics:
        values = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
        if values:
            result['rollingSnapshots'][key] = {'median': percentile(values, .5),
                                                'max': max(values), 'last': values[-1]}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log', type=Path)
    parser.add_argument('--source', type=int, required=True)
    args = parser.parse_args()
    rows = []
    for line in args.log.read_text().splitlines():
        if 'TachiPlaybackTrial:' in line:
            line = line.split('TachiPlaybackTrial:', 1)[1]
        elif not line.startswith('{'):
            continue
        row = json.loads(line)
        if row.get('source') == args.source:
            rows.append(row)
    # Split on interruption, absent depth, counter reset, or missing >3 seconds of evidence.
    runs, current = [], []
    for row in rows:
        valid = row.get('status') == 'playing' and row.get('depthState') == 'ready' and row.get('valid') and row.get('stereo')
        gap = current and (row['elapsedMs'] - current[-1]['elapsedMs'] > 3000
                          or row.get('depthComputed', 0) < current[-1].get('depthComputed', 0)
                          or abs((row.get('position', 0) - current[-1].get('position', 0))
                                 - (row['elapsedMs'] - current[-1]['elapsedMs']) / 1000) > 2)
        if not valid or gap:
            if current:
                runs.append(current)
                current = []
        if valid:
            current.append(row)
    if current:
        runs.append(current)
    output = {'source': args.source, 'evidence': 'GL source PTS, not optical latency; snapshot P95 is not whole-run P95',
              'runs': []}
    for run in runs:
        item = summarize(run)
        start = run[0]['elapsedMs']
        item['fiveMinuteWindows'] = []
        for offset in range(0, int(item['seconds']) + 1, 300):
            window = [r for r in run if start + offset * 1000 <= r['elapsedMs'] < start + (offset + 300) * 1000]
            if len(window) > 1:
                item['fiveMinuteWindows'].append({'startSeconds': offset, **summarize(window)})
        output['runs'].append(item)
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
