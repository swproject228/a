import unittest
from datetime import date

from doubler import (
    doubling_years,
    format_duration,
    format_money,
    month_after,
    parse_number,
    plural,
    simulate,
)


class SimulateTest(unittest.TestCase):
    def test_deposit_without_topups(self):
        milestones = simulate(1000, 13, doublings=2)
        # ln 2 / ln(1 + 0.13 / 12) ≈ 64.3 месяца -> удвоение на 65-м месяце
        self.assertEqual([m.month for m in milestones], [65, 129])
        self.assertEqual([m.target for m in milestones], [2000, 4000])
        self.assertTrue(all(m.contributed == 1000 for m in milestones))

    def test_topups_without_interest(self):
        milestones = simulate(1000, 0, monthly_topup=1000, doublings=3)
        self.assertEqual([m.month for m in milestones], [1, 3, 7])
        self.assertEqual([m.interest for m in milestones], [0, 0, 0])

    def test_several_targets_in_one_month(self):
        milestones = simulate(1000, 0, monthly_topup=10_000, doublings=3)
        self.assertEqual([m.month for m in milestones], [1, 1, 1])
        self.assertEqual([m.target for m in milestones], [2000, 4000, 8000])

    def test_never_doubles(self):
        self.assertEqual(simulate(1000, 0), [])

    def test_doubling_years(self):
        self.assertAlmostEqual(doubling_years(13), 5.36, places=2)
        self.assertIsNone(doubling_years(0))


class FormattingTest(unittest.TestCase):
    def test_plural(self):
        forms = ("год", "года", "лет")
        self.assertEqual(plural(1, *forms), "год")
        self.assertEqual(plural(3, *forms), "года")
        self.assertEqual(plural(5, *forms), "лет")
        self.assertEqual(plural(11, *forms), "лет")
        self.assertEqual(plural(21, *forms), "год")

    def test_format_duration(self):
        self.assertEqual(format_duration(0), "0 мес.")
        self.assertEqual(format_duration(5), "5 мес.")
        self.assertEqual(format_duration(12), "1 год")
        self.assertEqual(format_duration(65), "5 лет 5 мес.")

    def test_format_money(self):
        self.assertEqual(format_money(1234567.4), "1 234 567 ₽")

    def test_month_after(self):
        self.assertEqual(month_after(date(2026, 10, 7), 3), "январь 2027")
        self.assertEqual(month_after(date(2026, 12, 1), 12), "декабрь 2027")

    def test_parse_number(self):
        self.assertEqual(parse_number("1 000"), 1000)
        self.assertEqual(parse_number("13,5"), 13.5)
        with self.assertRaises(ValueError):
            parse_number("много")


if __name__ == "__main__":
    unittest.main()
