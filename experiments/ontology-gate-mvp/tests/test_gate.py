import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ontology_gate.gate import GateError, GateResult, check, find_binary
from ontology_gate.scenarios import TBOX, build_scenarios, frontier_for, run_all


def _binary() -> Path | None:
    try:
        return find_binary()
    except GateError:
        return None


BINARY = _binary()


@unittest.skipUnless(BINARY, "open-ontologies binary not available")
class ScenarioMatrixTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workdir = Path(tempfile.mkdtemp(prefix="ontology-gate-test-"))
        cls.results = run_all(cls.workdir)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.workdir, ignore_errors=True)

    def test_every_scenario_matches_expectations(self) -> None:
        for result in self.results:
            with self.subTest(scenario=result.scenario.name):
                self.assertEqual(result.failures, [])
                self.assertEqual(result.gate.exit_code, result.scenario.expected_exit)

    def test_happy_gate_conforms(self) -> None:
        happy = next(r for r in self.results if r.scenario.name == "happy")
        self.assertEqual(happy.gate.exit_code, 0)
        self.assertTrue(happy.gate.conforms)

    def test_indeterminate_result_is_not_a_pass(self) -> None:
        # Exit code 2 and conforms:null must never be treated as a pass.
        self.assertFalse(GateResult(exit_code=2, conforms=None).passed)
        self.assertFalse(GateResult(exit_code=1, conforms=False).passed)
        self.assertTrue(GateResult(exit_code=0, conforms=True).passed)

    def test_uncompilable_shape_makes_gate_fail_closed(self) -> None:
        # v2.1.0 does not compile sh:node; the gate must surface exit 2.
        shapes = self.workdir / "node-shapes.ttl"
        shapes.write_text(
            """@prefix ex: <https://example.org/ontology-gate#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:Inner a sh:NodeShape ;
  sh:property [ sh:path ex:commit ; sh:minCount 1 ] .
ex:TicketShape a sh:NodeShape ;
  sh:targetClass ex:Ticket ;
  sh:node ex:Inner .
""",
            encoding="utf-8",
        )
        happy = next(r for r in self.results if r.scenario.name == "happy")
        result = check(happy.scenario.spec.to_ttl(), TBOX, shapes)
        self.assertEqual(result.exit_code, 2)
        self.assertFalse(result.passed)
        self.assertTrue(any("skipped constraint" in item for item in result.warnings))

    def test_frontier_respects_unfinished_blockers(self) -> None:
        scenarios = build_scenarios(self.workdir / "frontier")
        spec = scenarios[0].spec
        spec.ticket("T1").state = "done"
        spec.ticket("T2").state = "done"
        spec.ticket("T3").state = "todo"
        spec.ticket("T4").state = "todo"
        ready = frontier_for(spec)
        self.assertEqual([item["id"] for item in ready], ["T3"])


if __name__ == "__main__":
    unittest.main()
