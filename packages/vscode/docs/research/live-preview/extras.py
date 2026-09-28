"""Measure the SVG cache and validate against ordinary compiler output."""
from benchmark import *

if __name__ == '__main__':
    results = []
    cache_args = ['-e', f'(load {json.dumps(str(ROOT / "glyph-cache.scm"))})']
    for name in ['small', 'medium']:
        runs = []
        for repeat in range(4):
            out = ROOT / 'cache-out' / name / str(repeat)
            result = cold(ROOT / f'{name}-normal.ly', cache_args, out)
            reference = ROOT / 'out' / name / 'baseline' / '0'
            pages = sorted(out.glob('*.svg'))
            assert [p.name for p in pages] == sorted(p.name for p in reference.glob('*.svg'))
            assert all(p.read_bytes() == (reference / p.name).read_bytes() for p in pages)
            result['byte_identical_to_cold'] = True
            if repeat:
                runs.append(result)
        row = dict(score=name, median_ms=statistics.median(r['ms'] for r in runs), runs=runs)
        results.append(row)
        print(json.dumps(row), flush=True)
    (ROOT / 'cache-results.json').write_text(json.dumps(results, indent=2) + '\n')

    trace = cold(ROOT / 'medium-normal.ly', ['-dtime-trace-file'], ROOT / 'trace')
    events = json.loads(next((ROOT / 'trace').glob('*.json')).read_text())
    stack, spans = [], []
    for event in events:
        if event['ph'] == 'B':
            stack.append(event)
        elif event['ph'] == 'E':
            begin = stack.pop()
            spans.append(dict(name=begin['name'], ms=round((event['ts'] - begin['ts']) / 1000, 3), depth=len(stack)))
    trace['spans'] = sorted(spans, key=lambda s: s['ms'], reverse=True)
    (ROOT / 'trace-summary.json').write_text(json.dumps(trace, indent=2) + '\n')

    checks = []
    for relative in ['test/fixtures/simple.ly', 'test/fixtures/hello.ly', 'test/fixtures/pages.ly', 'test/e2e/workspace/score.ly']:
        source = REPO / relative
        ref = ROOT / 'validation' / source.stem / 'baseline'
        out = ROOT / 'validation' / source.stem / 'cache'
        cold(source, [], ref)
        cold(source, cache_args, out)
        files = [p.name for p in ref.iterdir() if p.suffix in ['.svg', '.midi', '.mid']]
        assert files and all((ref / name).read_bytes() == (out / name).read_bytes() for name in files)
        checks.append(dict(source=relative, files=files, byte_identical=True))
    (ROOT / 'validation.json').write_text(json.dumps(checks, indent=2) + '\n')
    print('Fixture SVG and MIDI bytes match.', flush=True)
