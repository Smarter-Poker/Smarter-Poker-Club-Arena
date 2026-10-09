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

    def test_disposable_builder_retains_limits_and_source_refs(self):
        from unittest.mock import patch
        import tempfile
        with tempfile.TemporaryDirectory() as temp, patch.object(proof, 'run') as run:
            proof.prepare_cached_builder(Path(temp) / 'buildkitd.toml')
            config = (Path(temp) / 'buildkitd.toml').read_text()
            self.assertIn('[registry."docker.io"]\n  mirrors = ["mirror.gcr.io"]', config)
            self.assertIn('max-parallelism = 1', config)
            args = run.call_args_list[-1].args[0]
            for value in (f'memory={proof.LIMIT}', f'memory-swap={proof.LIMIT}',
                          'cpu-period=100000', 'cpu-quota=100000', 'restart-policy=no'):
                self.assertIn(value, args)
            self.assertIn('image=mirror.gcr.io/moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8', args)
            self.assertEqual(proof.NODE, 'mirror.gcr.io/library/node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5')

    def test_retains_raw_peak_including_documented_transient_excess(self):
        for peak in (proof.LIMIT - 4096, proof.LIMIT, proof.LIMIT + 4096):
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
        for peak in ('', '-1', '0', 'NaN', f'{proof.LIMIT + 4096}.0',
                     f'{proof.LIMIT}\nENGINE_BUILD_MEMORY_PEAK_BYTES={proof.LIMIT}'):
            with self.subTest(peak=peak), self.assertRaisesRegex(RuntimeError, 'memory peak'):
                proof.verified_build_resources(self.output(peak))
        with self.assertRaisesRegex(RuntimeError, 'memory peak'):
            proof.verified_build_resources(self.boundary + '\n')


if __name__ == '__main__':
    unittest.main()
