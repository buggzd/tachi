import json
import unittest
from summarize_product_liquid import segments_from, summarize


def row(t, pairs, **extra):
    value = dict(status='playing', depthState='ready', valid=True, stereo=True, alignedLiquid=True,
                 elapsedMs=t, pairedFrames=pairs, position=t / 1000, source=1)
    value.update(extra)
    return json.dumps(value)


class ProductLiquidSummaryTests(unittest.TestCase):
    def test_does_not_join_pause_or_log_gap_into_continuous_playback(self):
        segments = segments_from([row(0, 0), row(1000, 24), row(2000, 24, status='paused'),
                                  row(3000, 25), row(4000, 49), row(8000, 60)])
        self.assertEqual([2, 2, 1], [len(s) for s in segments])

    def test_source_change_and_backward_seek_split_windows(self):
        segments = segments_from([row(10000, 0), row(11000, 24), row(12000, 0, source=2),
                                  row(13000, 24, source=2), row(14000, 25, source=2, position=1)])
        self.assertEqual([2, 2, 1], [len(s) for s in segments])

    def test_counts_new_pairs_not_cached_refreshes_and_keeps_long_pts(self):
        rows = segments_from([row(0, 10, cachedPairDraws=0, pairedPtsUs=3_600_000_000),
                              row(1000, 34, cachedPairDraws=60, pairedPtsUs=3_601_000_000)])[0]
        summary = summarize(rows)
        self.assertEqual(24, summary['pairedHz'])
        self.assertEqual(60, summary['counterDeltas']['cachedPairDraws'])
        self.assertEqual(2, summary['pairedPtsAbove1000SecondsSamples'])

    def test_does_not_export_arbitrary_log_identity(self):
        rows = segments_from(['not json', row(0, 0, title='private-name'), row(1000, 24)])
        self.assertNotIn('private-name', json.dumps(summarize(rows[0])))


if __name__ == '__main__':
    unittest.main()
