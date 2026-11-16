import unittest

from mathlib.core import add
from mathlib.mul import mul
from mathlib.pow import power


class IntegrationTest(unittest.TestCase):
    def test_composes_operations(self) -> None:
        self.assertEqual(add(mul(2, 3), power(2, 3)), 14)


if __name__ == "__main__":
    unittest.main()
