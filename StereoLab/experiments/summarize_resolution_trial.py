"""Summarize a sanitized NativeVideoLab JSONL trace, without averaging rolling windows.

Use a single foreground playback run per trace. Reject pauses, seeks, missing
seconds and counter resets within the ready interval instead of hiding them in
a purported continuous throughput measurement. Input must already exclude RGB
probes, source URLs and unstructured logcat messages.
"""
import argparse
import json
import math
from pathlib import Path
import statistics


def summarize(rows, warmup_ms=15000):
    active = [r for r in rows if r['state'] == 'playing'
              and r['depth']['state'] == 'ready' and r['depth']['render']['valid']]
    if not active:
        raise ValueError('No playing, ready, valid depth interval')
    for previous, current in zip(active, active[1:]):
        dt = current['elapsedMs'] - previous['elapsedMs']
        dp = current['positionMs'] - previous['positionMs']
        du = current['depth']['render']['uploads'] - previous['depth']['render']['uploads']
        if not 0 < dt < 2500 or abs(dp - dt) > 300 or du < 0:
            raise ValueError('Discontinuous playback; split the trace before summarizing')
    start = active[0]['elapsedMs']
    active = [r for r in active if r['elapsedMs'] >= start + warmup_ms]
    if len(active) < 2:
        raise ValueError('Insufficient post-warmup samples')
    first, last = active[0], active[-1]
    duration = (last['elapsedMs'] - first['elapsedMs']) / 1000
    render = last['depth']['render']
    ages = sorted(r['depth']['render']['ageMs'] for r in active)
    return dict(
        shape=[render['depthWidth'], render['depthHeight']], rows=len(active),
        durationSeconds=duration,
        depthHz=(render['uploads'] - first['depth']['render']['uploads']) / duration,
        positionAdvanceMs=last['positionMs'] - first['positionMs'],
        ageMedianMs=statistics.median(ages),
        ageP95Ms=ages[math.ceil(.95 * len(ages)) - 1],
        lastWindowWorker=last['depth']['worker'], lastWindowRender=render,
        lastWindowReadback=last['readback'],
        limits='Rate and age exclude the first 15s of playing+ready by default. '
               'Stage values are the final rolling windows, possibly including startup. '
               'Depth age is wall clock, not media PTS mismatch. '
               'GPU overlaps CPU stages; these are not display frame-rate measurements.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trace', type=Path)
    parser.add_argument('--warmup-ms', type=int, default=15000)
    args = parser.parse_args()
    if args.warmup_ms < 0:
        parser.error('warmup must be nonnegative')
    rows = [json.loads(line) for line in args.trace.read_text().splitlines() if line.strip()]
    print(json.dumps(summarize(rows, args.warmup_ms), indent=2))
