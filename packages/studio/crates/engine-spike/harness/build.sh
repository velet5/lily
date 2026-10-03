#!/usr/bin/env bash
# Builds the spike as chapter 08 §1.3 builds the core and leaves it where
# `esbuild.mjs --site` takes an engine from, packages/studio/dist/engine/,
# then builds the site, which bundles engine.worker.js and copies the engine
# under hashed names into dist/site/. Prints each file's raw, gzip and brotli
# bytes. serve.mjs serves the result to the phones.
#
#   TOOLCHAIN   the nightly (default nightly; chapter 08 used 2026-05-24)
#   WASM_OPT    Binaryen's wasm-opt (default: the one on PATH)
#   FONT        emmentaler-20.svg (default: the installed LilyPond's)
#   VARIANT     ia (default): -Cpanic=immediate-abort, build-std, as §1.3;
#               stable: panic = "abort" on stable, with panic strings;
#               simd: ia with +simd128
#   SITE=0      skips the site build
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
studio=$(cd "$here/../../.." && pwd)
TOOLCHAIN=${TOOLCHAIN:-nightly}
WASM_OPT=${WASM_OPT:-wasm-opt}
VARIANT=${VARIANT:-ia}
if [ -z "${FONT:-}" ]; then
  FONT=$(ls "$(dirname "$(realpath "$(command -v lilypond)")")"/../share/lilypond/*/fonts/svg/emmentaler-20.svg | head -1)
fi
# Chapter 00 §1.1's features, as rustc enables them for this target; wasm-opt must be given the same.
FEATURES="--enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types"
MEMORY="-Clink-arg=--max-memory=268435456"

cd "$studio"
case $VARIANT in
  ia | simd)
    flags="-Zunstable-options -Cpanic=immediate-abort $MEMORY"
    if [ "$VARIANT" = simd ]; then flags="$flags -Ctarget-feature=+simd128"; FEATURES="$FEATURES --enable-simd"; fi
    RUSTFLAGS="$flags" cargo "+$TOOLCHAIN" build -q -p lily-engine-spike --lib --profile wasm \
      --target wasm32-unknown-unknown -Zbuild-std=std,core,alloc,panic_abort
    ;;
  stable)
    RUSTFLAGS="$MEMORY" cargo +stable build -q -p lily-engine-spike --lib --profile wasm --target wasm32-unknown-unknown
    ;;
  *) echo "unknown VARIANT $VARIANT" >&2; exit 1 ;;
esac

out=dist/engine
rm -rf "$out" && mkdir -p "$out"
"$WASM_OPT" -Oz $FEATURES --strip-debug --strip-producers \
  target/wasm32-unknown-unknown/wasm/lily_engine_spike.wasm -o "$out/core.wasm"
cp "$here/prelude.scm" "$out/core.image"
node "$here/pack.mjs" "$FONT" > "$out/emmentaler-20.pack"
cat > "$out/manifest.json" <<JSON
{"version":1,"core":{"wasm":"core.wasm","image":"core.image","preload":["emmentaler-20"]},"modules":{"emmentaler-20":{"kind":"pack","file":"emmentaler-20.pack"}}}
JSON

size() { printf "%-22s %8s %8s %8s\n" "$(basename "$1")" "$(wc -c <"$1" | tr -d ' ')" "$(gzip -9c "$1" | wc -c | tr -d ' ')" "$(brotli -q 11 -c "$1" | wc -c | tr -d ' ')"; }
echo "$(rustc "+$([ "$VARIANT" = stable ] && echo stable || echo "$TOOLCHAIN")" -V), $("$WASM_OPT" --version), variant $VARIANT"
printf "%-22s %8s %8s %8s\n" file raw gzip brotli
for f in "$out/core.wasm" "$out/core.image" "$out/emmentaler-20.pack"; do size "$f"; done

if [ "${SITE:-1}" != 0 ]; then
  node esbuild.mjs --site --production >/dev/null 2>&1
  size dist/site/engine.worker.js
fi
