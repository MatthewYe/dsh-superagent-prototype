import unittest

from mathlib.mul import mul


class MulTest(unittest.TestCase):
    def test_multiplies_positive_numbers(self) -> None:
        self.assertEqual(mul(2, 3), 6)

    def test_multiplies_negative_numbers(self) -> None:
        self.assertEqual(mul(-2, 3), -6)

    def test_multiplies_by_zero(self) -> None:
        self.assertEqual(mul(9, 0), 0)


if __name__ == "__main__":
    unittest.main()
