import unittest

from mathlib.pow import power


class PowerTest(unittest.TestCase):
    def test_square(self) -> None:
        self.assertEqual(power(3, 2), 9)

    def test_zero_exponent(self) -> None:
        self.assertEqual(power(5, 0), 1)

    def test_negative_exponent(self) -> None:
        self.assertEqual(power(2, -1), 0.5)


if __name__ == "__main__":
    unittest.main()
