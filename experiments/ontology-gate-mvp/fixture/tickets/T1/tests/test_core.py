import unittest

from mathlib.core import add


class AddTest(unittest.TestCase):
    def test_adds_positive_numbers(self) -> None:
        self.assertEqual(add(2, 3), 5)

    def test_adds_negative_numbers(self) -> None:
        self.assertEqual(add(-2, -3), -5)

    def test_adds_zero(self) -> None:
        self.assertEqual(add(0, 7), 7)


if __name__ == "__main__":
    unittest.main()
