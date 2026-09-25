// esbuild.mjs loads .wasm files as their bytes (the `binary` loader).
declare module '*.wasm' {
  const bytes: Uint8Array
  export default bytes
}
