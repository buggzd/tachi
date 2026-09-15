import unittest
from collect_presentation_trial import current_temperatures


class PresentationThermalTests(unittest.TestCase):
    def test_ignores_cached_temperatures_and_keeps_current_whitelisted_sensors(self):
        text = ('Cached temperatures:\n\tTemperature{mValue=99, mType=0, mName=CPU0, mStatus=0}\n'
                'Current temperatures from HAL:\n\tTemperature{mValue=52, mType=0, mName=CPU0, mStatus=0}\n'
                '\tTemperature{mValue=48, mType=9, mName=nsp0, mStatus=0}\n'
                '\tTemperature{mValue=60, mType=0, mName=private-name, mStatus=0}\n'
                'Other section:\n\tTemperature{mValue=80, mType=0, mName=CPU0, mStatus=0}\n')
        self.assertEqual([52, 48], [r['value'] for r in current_temperatures(text)])
        self.assertNotIn('private-name', str(current_temperatures(text)))

    def test_does_not_substitute_cache_when_hal_section_is_missing(self):
        self.assertEqual([], current_temperatures('Cached temperatures:\nTemperature{mValue=99, mType=0, mName=CPU0, mStatus=0}'))


if __name__ == '__main__':
    unittest.main()
