#!/usr/bin/env python3
"""Collect one explicitly selected SurfaceFlinger layer, plus safe thermal fields.

Select the player's BLAST SurfaceView layer from `adb shell dumpsys SurfaceFlinger
--list`. Run separately from the diagnostic-only TachiPlaybackTrial log collector.
The three timestamps retain the platform's desired/present/ready ordering.
No unrelated layer names, account details, battery serials or network data are saved.
"""
import argparse
import json
import re
import shlex
import subprocess
import time
from pathlib import Path


def current_temperatures(thermal):
    marker = 'Current temperatures from HAL:'
    if marker not in thermal:
        return []
    section = re.split(r'\n(?=\S)', thermal.split(marker, 1)[1], maxsplit=1)[0]
    return [dict(value=float(v), type=int(t), name=n, status=int(status))
            for v, t, n, status in re.findall(
                r'Temperature\{mValue=([\d.]+), mType=(\d+), mName=(battery|skin|CPU\d+|GPU\d+|nsp\d+), mStatus=(\d+)\}', section)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', default='adb')
    parser.add_argument('--serial', help='Explicit ADB transport when multiple devices are listed')
    parser.add_argument('--interval', type=float, default=2.0, help='Seconds between polls; 1 reduces 128-frame history gaps')
    parser.add_argument('--layer', required=True)
    parser.add_argument('--seconds', type=int, default=1500)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 3600:
        parser.error('seconds must be between 1 and 3600')

    if not .25 <= args.interval <= 5:
        parser.error('interval must be between 0.25 and 5 seconds')
    adb = [args.adb] + (['-s', args.serial] if args.serial else [])

    def shell(command):
        return subprocess.check_output(adb + ['shell', command], text=True, timeout=12)

    start = time.monotonic()
    next_thermal = 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as out:
        while time.monotonic() - start < args.seconds:
            elapsed = time.monotonic() - start
            row = {'elapsedSeconds': round(elapsed, 3), 'pollIntervalSeconds': args.interval}
            try:
                lines = shell('dumpsys SurfaceFlinger --latency ' + shlex.quote(args.layer)).strip().splitlines()
                row['refreshNs'] = int(lines[0])
                row['frames'] = [list(map(int, line.split())) for line in lines[1:] if len(line.split()) == 3]
                if elapsed >= next_thermal:
                    thermal = shell('dumpsys thermalservice')
                    battery = shell('dumpsys battery')
                    match = re.search(r'Thermal Status: (\d+)', thermal)
                    row['thermalStatus'] = int(match[1]) if match else None
                    row['temperatureSource'] = 'currentHAL'
                    row['temperatures'] = current_temperatures(thermal)
                    for key in ['temperature', 'level', 'status', 'AC powered', 'USB powered']:
                        match = re.search(r'^\s*' + re.escape(key) + r': ([\d]+|true|false)$', battery, re.M)
                        if match:
                            row['battery_' + key] = match[1]
                    next_thermal = elapsed + 30
            except (subprocess.SubprocessError, ValueError, IndexError, OSError) as error:
                row['error'] = type(error).__name__
            out.write(json.dumps(row) + '\n')
            out.flush()
            time.sleep(args.interval)


if __name__ == '__main__':
    main()
