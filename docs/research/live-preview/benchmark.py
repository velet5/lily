"""Research probe: fresh LilyPond processes, not editor end-to-end latency."""
import json
import os
from pathlib import Path
import platform
import random
import statistics
import subprocess
import time

ROOT = Path(__file__).resolve().parent
REPO = Path(os.environ.get('LILY_RESEARCH_REPO', Path.cwd())).resolve()
BINARY = os.environ.get('LILYPOND_PATH', 'lilypond')
ENV = dict(os.environ, LANGUAGE='en')

def generated(staves, bars, minimal=False, midi=True):
    music = ' '.join(["c8( d e f) g4-. e |", "d4 f a2 |", "g8 f e d c2 |", "e4 g c,2 |"] * (bars // 4))
    staff = '\\new Staff \\relative c\' { \\time 4/4 ' + music + ' }\n'
    paper = '\\paper { page-breaking = #ly:minimal-breaking }\n' if minimal else ''
    return ('\\version "2.26.0"\n\\header { tagline = ##f }\n' + paper +
            '\\score { <<\n' + staff * staves + '>> \\layout {}\n' +
            ('\\midi { \\tempo 4 = 100 }\n' if midi else '') + '}\n')

def prepare():
    sources = {}
    for name, staves, bars in [('small', 1, 8), ('medium', 2, 64)]:
        for variant in ['normal', 'minimal', 'no-midi']:
            p = ROOT / f'{name}-{variant}.ly'
            p.write_text(generated(staves, bars, variant == 'minimal', variant != 'no-midi'))
            sources[name, variant] = p
    return sources

def cold(source, extra, output):
    if output.exists():
        import shutil
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    args = [BINARY, '--loglevel=WARNING', '--svg', '-dpoint-and-click', *extra,
            '-o', str(output / 'score'), str(source)]
    start = time.perf_counter()
    run = subprocess.run(args, env=ENV, cwd=source.parent, capture_output=True, text=True, timeout=90)
    elapsed = (time.perf_counter() - start) * 1000
    (output / 'stderr.txt').write_text(run.stderr)
    if run.returncode or run.stderr.strip():
        raise RuntimeError(f'{args}: {run.returncode}: {run.stderr[:500]} (full stderr saved)')
    pages = list(output.glob('*.svg'))
    if not pages:
        raise RuntimeError(f'No SVG: {args}')
    svgs = ''.join(p.read_text() for p in pages)
    return dict(ms=round(elapsed, 2), pages=len(pages), bytes=sum(p.stat().st_size for p in pages),
                links=svgs.count('textedit:'), currentColor='currentColor' in svgs)

if __name__ == '__main__':
    sources = prepare()
    variants = [('baseline', 'normal', []), ('minimal', 'minimal', []),
                ('no-midi', 'no-midi', []), ('no-links', 'normal', ['-dno-point-and-click']),
                ('cairo', 'normal', ['-dbackend=cairo']),
                ('last8', 'no-midi', ['-dlast=R1*8'])]
    results = []
    for name in ['small', 'medium']:
        # One unmeasured run of every case, then three shuffled measured rounds.
        for mode, variant, extra in variants:
            cold(sources[name, variant], extra, ROOT / 'out' / name / mode / 'warmup')
        runs = {mode: [] for mode, _, _ in variants}
        rng = random.Random(20260921)
        for repeat in range(3):
            order = variants[:]
            rng.shuffle(order)
            for mode, variant, extra in order:
                runs[mode].append(cold(sources[name, variant], extra,
                                      ROOT / 'out' / name / mode / str(repeat)))
        for mode, _, _ in variants:
            row = dict(score=name, mode=mode, median_ms=round(statistics.median(r['ms'] for r in runs[mode]), 2), runs=runs[mode])
            results.append(row)
            print(json.dumps(row), flush=True)
        (ROOT / 'results.json').write_text(json.dumps(dict(
            date='2026-09-21', platform=platform.platform(),
            version=subprocess.check_output([BINARY, '--version'], text=True).splitlines()[0],
            method='Fresh process; warm filesystem caches; one warmup per case; three measured runs in shuffled rounds; no editor overhead.',
            results=results), indent=2) + '\n')
