import json
import unittest
from summarize_liquid_fixture import summarize


class FixtureSummaryTests(unittest.TestCase):
    def row(self, time, frames, state='playing'):
        return json.dumps({'elapsedMs': time, 'positionMs': 30000 + time, 'state': state, 'url': 'private',
                           'depth': {'render': {'valid': True, 'stereo': True, 'alignedLiquid': True,
                                               'pairedFrames': frames, 'depthPts': {'unknown': 0, 'future': 0}}}})

    def test_counts_only_continuous_valid_samples_and_drops_identity(self):
        result = summarize([self.row(0, 0), self.row(1000, 24), self.row(2000, 48), self.row(3000, 48, 'paused')])
        self.assertEqual(result['pairedHz'], 24)
        self.assertEqual(result['seconds'], 2)
        self.assertNotIn('private', json.dumps(result))

    def test_counter_reset_splits_segment(self):
        result = summarize([self.row(0, 0), self.row(1000, 24), self.row(2000, 0), self.row(3000, 22), self.row(4000, 44)])
        self.assertEqual(result['pairedHz'], 22)
        self.assertEqual(result['seconds'], 2)

    def test_rejects_empty_valid_window(self):
        with self.assertRaises(ValueError):
            summarize([self.row(0, 0)], 100, 200)
