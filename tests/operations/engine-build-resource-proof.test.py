"""Original build evidence parsing; real Linux containment remains a separate gate."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'engine_resource_proof', Path(__file__).with_name('engine-build-resource-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class OriginalBuildResourceEvidenceTests(unittest.TestCase):
    boundary = f'ENGINE_BUILD_RESOURCE_BOUNDARY=memory:{proof.LIMIT},swap:0,cpu:100000 100000'

    def output(self, peak, boundary=None):
        return f'{boundary if boundary is not None else self.boundary}\nENGINE_BUILD_MEMORY_PEAK_BYTES={peak}\n'

    def test_retains_raw_peak_including_documented_transient_excess(self):
        for peak in (proof.LIMIT - 4096, proof.LIMIT, 671092736):
            with self.subTest(peak=peak):
                receipt = proof.verified_build_resources(self.output(peak))
                self.assertEqual(receipt['engine_build_memory_peak'], peak)
                self.assertEqual(receipt['engine_build_memory_peak_over_limit_bytes'],
                                 max(0, peak - proof.LIMIT))
                self.assertEqual(receipt['engine_build_resource_boundary'],
                                 self.boundary.split('=', 1)[1])

    def test_refuses_changed_memory_limit_even_with_a_small_peak(self):
        for limit in ('max', proof.LIMIT + 4096, proof.LIMIT - 4096, 'unreadable'):
            with self.subTest(limit=limit), self.assertRaisesRegex(RuntimeError, 'exact enforced cgroup limits'):
                proof.verified_build_resources(self.output(1024, self.boundary.replace(
                    f'memory:{proof.LIMIT}', f'memory:{limit}')))

    def test_refuses_swap_or_cpu_drift(self):
        for before, after in [('swap:0', 'swap:4096'), ('swap:0', 'swap:max'),
                              ('cpu:100000 100000', 'cpu:max 100000'),
                              ('cpu:100000 100000', 'cpu:200000 100000')]:
            with self.subTest(after=after), self.assertRaisesRegex(RuntimeError, 'exact enforced cgroup limits'):
                proof.verified_build_resources(self.output(proof.LIMIT, self.boundary.replace(before, after)))

    def test_requires_boundary_from_original_build_output(self):
        for boundary in ('', self.boundary + '\n' + self.boundary,
                         'ENGINE_BUILD_RESOURCE_BOUNDARY=unreadable'):
            with self.subTest(boundary=boundary), self.assertRaisesRegex(RuntimeError, 'exact enforced cgroup limits'):
                proof.verified_build_resources(self.output(proof.LIMIT, boundary))

    def test_refuses_missing_duplicate_or_unreadable_peak(self):
        for peak in ('', '-1', '0', 'NaN', '671092736.0',
                     f'{proof.LIMIT}\nENGINE_BUILD_MEMORY_PEAK_BYTES={proof.LIMIT}'):
            with self.subTest(peak=peak), self.assertRaisesRegex(RuntimeError, 'memory peak'):
                proof.verified_build_resources(self.output(peak))
        with self.assertRaisesRegex(RuntimeError, 'memory peak'):
            proof.verified_build_resources(self.boundary + '\n')


class CompilerHeapProfileTests(unittest.TestCase):
    command = ("RUN ulimit -c 0 && node --max-old-space-size=512 "
               "--max-semi-space-size=4 ./scripts/emit-runtime.mjs "
               "--project tsconfig.emit.json")

    def test_actual_dockerfile_uses_the_qualified_compiler_profile(self):
        profile = proof.verified_compiler_profile((proof.ROOT / 'server/Dockerfile').read_text())
        self.assertEqual(profile, {"old_space_max_mib": 512, "semi_space_max_mib": 4,
                                   "young_generation_max_mib": 12, "project": "tsconfig.emit.json"})

    def test_refuses_the_previous_implicit_young_generation(self):
        with self.assertRaisesRegex(RuntimeError, 'explicit 512 MiB old / 4 MiB semi-space'):
            proof.verified_compiler_profile(self.command.replace('--max-semi-space-size=4 ', ''))

    def test_refuses_changed_limits_project_or_duplicate_compiler(self):
        for command in (self.command.replace('size=512', 'size=768'),
                        self.command.replace('space-size=4 ', 'space-size=8 '),
                        self.command.replace('tsconfig.emit.json', 'tsconfig.json'),
                        self.command.replace('./scripts/emit-runtime.mjs', './node_modules/typescript/bin/tsc'),
                        self.command + '\n' + self.command,
                        self.command + ' --max-semi-space-size=16',
                        '# ' + self.command):
            with self.subTest(command=command), self.assertRaises(RuntimeError):
                proof.verified_compiler_profile(command)


if __name__ == '__main__':
    unittest.main()
