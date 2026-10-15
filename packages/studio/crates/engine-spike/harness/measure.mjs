// Runs the harness in Playwright's Chromium and WebKit on this machine, as
// the desktop rows of 09-spike.md: a first visit, then cached visits. Run it
// from a directory where `playwright` is installed, with serve.mjs running.
//
//   node <path>/measure.mjs [url] [visits]     (default http://localhost:8471/, 4)
import { createRequire } from 'node:module'

const { chromium, webkit } = createRequire(`${process.cwd()}/`)('playwright')
const url = process.argv[2] ?? 'http://localhost:8471/'
const visits = Number(process.argv[3] ?? 4)

for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  for (let visit = 1; visit <= visits; visit++) {
    const label = `${name} visit ${visit}`
    await page.goto(`${url}?label=${encodeURIComponent(label)}`)
    const result = await page.waitForFunction(() => window.spikeResult, null, { timeout: 300_000 }).then((h) => h.jsonValue())
    console.log(JSON.stringify(result))
  }
  await browser.close()
}
