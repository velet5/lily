// esbuild.mjs loads .wasm files as their bytes (the `binary` loader). Only
// small ones belong in a bundle, as base64: the engine's are fetched by URL
// from engine/manifest.json, compiled while they stream and kept in the cache
// (src/web/engine/, chapter 08 of docs/research/wasm-engine).
declare module '*.wasm' {
  const bytes: Uint8Array
  export default bytes
}
