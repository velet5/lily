// The spike's font pack (src/font.rs): the glyphs of src/layout.rs's GLYPHS,
// cut from LilyPond's emmentaler-20.svg, one per line: name, advance, path.
//   node pack.mjs <emmentaler-20.svg> > emmentaler-20.pack
import { readFileSync } from 'node:fs'

const names = [...readFileSync(new URL('../src/layout.rs', import.meta.url), 'utf8')
  .match(/pub const GLYPHS[^;]+;/)[0].matchAll(/"([^"]+)"/g)].map((m) => m[1])
const font = readFileSync(process.argv[2], 'utf8')
const lines = names.map((name) => {
  const glyph = font.match(new RegExp(`<glyph glyph-name="${name.replace('.', '\\.')}"[^>]*?horiz-adv-x="(\\d+)"[^>]*?d="([^"]*)"`, 's'))
  if (!glyph) throw new Error(`${name} is not in ${process.argv[2]}`)
  return `${name}\t${glyph[1]}\t${glyph[2].replace(/\s+/g, ' ')}`
})
process.stdout.write(lines.join('\n') + '\n')
