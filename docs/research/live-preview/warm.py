"""Probe internal Scheme entry points; deliberately not a production worker."""
from benchmark import *
import select

def response(process):
    if not select.select([process.stdout], [], [], 90)[0]:
        raise RuntimeError('Worker timeout')
    value = process.stdout.readline().strip()
    if not value:
        raise RuntimeError('Worker exited: inspect warm stderr')
    return value

if __name__ == '__main__':
    results = []
    for mode in ['fork', 'sequential', 'fork-cache', 'sequential-cache']:
        with (ROOT / f'warm-{mode}-stderr.txt').open('w') as log:
            start = time.perf_counter()
            worker = subprocess.Popen([BINARY, '--svg', '-dpoint-and-click', '--loglevel=WARNING',
                '-o', 'score', '-e', f'(load {json.dumps(str(ROOT / "warm.scm"))})'],
                env=dict(ENV, LILY_PROBE_MODE=mode, **({'LILY_PROBE_CACHE': str(ROOT / 'glyph-cache.scm')} if mode.endswith('-cache') else {})), cwd=ROOT,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
            try:
                assert response(worker) == 'READY'
                startup_ms = round((time.perf_counter() - start) * 1000, 2)
                for name, last in [('small', False), ('medium', False), ('medium', True)]:
                    source = ROOT / f'{name}-{"no-midi" if last else "normal"}.ly'
                    runs = []
                    for repeat in range(4):
                        output = ROOT / 'warm-out' / mode / (name + ('-last8' if last else '')) / str(repeat)
                        if output.exists():
                            import shutil
                            shutil.rmtree(output)
                        output.mkdir(parents=True, exist_ok=True)
                        request = '(' + json.dumps(str(source)) + ' ' + json.dumps(str(output)) + (' #t)\n' if last else ' #f)\n')
                        start = time.perf_counter()
                        worker.stdin.write(request)
                        worker.stdin.flush()
                        answer = response(worker)
                        ms = round((time.perf_counter() - start) * 1000, 2)
                        assert answer == 'DONE 0', answer
                        pages = sorted(output.glob('*.svg'))
                        baseline = ROOT / 'out' / name / ('last8' if last else 'baseline') / '0'
                        references = sorted(baseline.glob('*.svg'))
                        same = len(pages) == len(references) and all(p.read_bytes() == r.read_bytes() for p, r in zip(pages, references))
                        assert pages and same, f'{mode} {name}: output differs from cold process'
                        if repeat:
                            runs.append(dict(ms=ms, pages=len(pages), byte_identical_to_cold=same))
                    row = dict(mode=mode, score=name, last8=last, startup_ms=startup_ms,
                        median_ms=round(statistics.median(r['ms'] for r in runs), 2), runs=runs)
                    results.append(row)
                    print(json.dumps(row), flush=True)
                    (ROOT / 'warm-results.json').write_text(json.dumps(results, indent=2) + '\n')
            finally:
                worker.stdin.close()
                try:
                    worker.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait()
        log_text = (ROOT / f'warm-{mode}-stderr.txt').read_text()
        assert not log_text.strip(), log_text
    (ROOT / 'warm-results.json').write_text(json.dumps(results, indent=2) + '\n')
