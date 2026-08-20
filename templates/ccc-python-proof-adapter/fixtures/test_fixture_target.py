"""Fixture target: a PASSING task suite with ONE planted negative control.

The system-under-test here is deliberately tiny: a fail-closed `parse_port`
helper. Positive cases prove correct parsing; the clause test pins the
error-refusal behavior; the planted negative control `negctrl_garbage`
asserts that garbage input IS refused — i.e. it demonstrates the
negative-control path end-to-end (control passes iff the refusal fires).
"""

import unittest


def parse_port(raw):
    """Return an int port in 1..65535 or raise ValueError (fail-closed)."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("port is required")
    port = int(raw.strip())
    if not 1 <= port <= 65535:
        raise ValueError("port out of range")
    return port


class PositiveCases(unittest.TestCase):
    def test_case_parses_plain_port(self):
        self.assertEqual(parse_port("443"), 443)

    def test_case_parses_padded_port(self):
        self.assertEqual(parse_port(" 8443 "), 8443)

    def test_case_rejects_zero_port(self):
        with self.assertRaises(ValueError):
            parse_port("0")

    def test_case_rejects_blank_port(self):
        with self.assertRaises(ValueError):
            parse_port("  ")


class ClauseTests(unittest.TestCase):
    def test_clause_parse_accepts_valid_port(self):
        self.assertEqual(parse_port("80"), 80)

    def test_clause_bounds_refuse_out_of_range(self):
        with self.assertRaises(ValueError):
            parse_port("70000")
        with self.assertRaises(ValueError):
            parse_port("-1")


class NegativeControls(unittest.TestCase):
    def test_negctrl_garbage_input_is_refused(self):
        """PLANTED NEGATIVE CONTROL: garbage must be REFUSED, never accepted.

        If parse_port stopped raising (fail-open regression), this control
        FAILS, the wrapper refuses with negative_control_not_closed, and the
        proof does not pass. Control passes == refusal path demonstrated.
        """
        with self.assertRaises(ValueError):
            parse_port("not-a-port")
