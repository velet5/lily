// Generates data/completions.json from the installed LilyPond (DECISIONS D8, D21).
//
//   node scripts/gen-completions.mjs                     lilypond from PATH
//   node scripts/gen-completions.mjs /path/to/lilypond   a specific binary
//   LILYPOND=/path/to/lilypond npm run gen:completions   the same, through npm
//
// A developer task, never run by the extension. LilyPond runs a Scheme block
// that dumps what it knows as raw JSON (Texinfo untouched) into a temp
// directory; everything else - Texinfo to Markdown, signatures, sorting - is
// done here. test/intellisense/data.test.ts checks the committed result.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(repoRoot, 'data', 'completions.json')

// The reserved words of the lexer (lily/lily-lexer.cc). They are not Scheme
// values, so the binary cannot list them; the set is closed and changes about
// once a decade. `buildData` drops any that the binary reports as something else.
const KEYWORDS = {
  accepts: 'In a context definition: lets contexts of the named type be nested in this one.',
  addlyrics: 'Attaches the lyrics that follow to the preceding music, one syllable per note.',
  alias: 'In a context definition: lets this context also answer to the named context type.',
  alternative: 'The alternative endings of the preceding `\\repeat`.',
  book: 'Groups scores and markups into one output file.',
  bookpart: 'A part of a `\\book` that starts on a new page.',
  change: 'Moves the current voice to another existing staff: `\\change Staff = "left"`.',
  chordmode: 'Reads the following music as chord names (`c:m7`).',
  chords: 'Shorthand for `\\new ChordNames \\chordmode`.',
  consists: 'In a context definition or `\\with` block: adds an engraver or performer.',
  context: 'Finds or creates a context; in `\\layout` or `\\midi`, opens a context definition.',
  default: 'The default value, as in `\\key \\default` or `\\set … = \\default`.',
  defaultchild: 'In a context definition: the context created implicitly below this one.',
  denies: 'In a context definition: the opposite of `\\accepts`.',
  description: 'In a context definition: its documentation string.',
  drummode: 'Reads the following music as drum names (`bd`, `sn`, `hh`).',
  drums: 'Shorthand for `\\new DrumStaff \\drummode`.',
  etc: 'Ends a partial music function call or markup that is being given a name.',
  figuremode: 'Reads the following music as figured bass (`<6 4>`).',
  figures: 'Shorthand for `\\new FiguredBass \\figuremode`.',
  header: 'Titles and other metadata: `title`, `composer`, `tagline`, …',
  include: 'Reads another file at this point.',
  layout: 'Settings for the printed output of a score; inside `\\score` it also requests print output.',
  lyricmode: 'Reads the following input as lyrics syllables.',
  lyrics: 'Shorthand for `\\new Lyrics \\lyricmode`.',
  lyricsto: 'Aligns the lyrics that follow to the notes of the named voice.',
  markup: 'Formatted text.',
  markuplist: 'A list of markups, which may be broken across pages.',
  midi: 'Inside `\\score`: requests MIDI output, and holds its settings.',
  name: 'In a context definition: the name of the context type.',
  new: 'Creates a new context: `\\new Staff { … }`, `\\new Voice = "melody" { … }`.',
  notemode: 'Reads the following input as ordinary notes; the way back from another input mode.',
  override: 'Changes a property of a layout object: `\\override NoteHead.color = #red`.',
  paper: 'Page size, margins, spacing and other page layout settings.',
  remove: 'In a context definition or `\\with` block: removes an engraver or performer.',
  repeat: 'Repeated music: `\\repeat volta 2 { … }`; types `volta`, `unfold`, `percent`, `tremolo`, `segno`.',
  rest: 'After a pitch: prints a rest at that pitch, `c4\\rest`.',
  revert: 'Undoes an `\\override`: `\\revert NoteHead.color`.',
  score: 'One piece of music with its `\\layout` and `\\midi` blocks.',
  sequential: 'The long form of `{ … }`: music expressions one after another.',
  set: 'Sets a context property: `\\set Staff.instrumentName = "Flute"`.',
  simultaneous: 'The long form of `<< … >>`: music expressions at the same time.',
  tempo: 'A tempo indication: `\\tempo "Allegro" 4 = 120`.',
  type: 'In a context definition: the translator group type.',
  unset: 'Returns a context property to its default: `\\unset Staff.instrumentName`.',
  version: 'The LilyPond version the file was written for; `convert-ly` relies on it.',
  with: 'Settings for the context being created: `\\new Staff \\with { … }`.',
}

// Runs inside LilyPond. Only strings, lists and alists are dumped, so the JSON
// writer needs nothing else. Identifiers are found the way D8 verified: in the
// file's own module and in the modules it uses.
const PROBE = String.raw`\version "2.20.0"
#(begin
  (use-modules (ice-9 format))
  (define out (open-output-file "probe.json" #:encoding "UTF-8"))
  (define (json-string s)
    (display #\" out)
    (string-for-each
      (lambda (c)
        (cond ((char=? c #\") (display "\\\"" out))
              ((char=? c #\\) (display "\\\\" out))
              ((char<? c #\space) (format out "\\u~4,'0x" (char->integer c)))
              (else (display c out))))
      s)
    (display #\" out))
  ;; value := string | symbol | #t | #f | (list value ...) | (obj (key . value) ...)
  (define (json v)
    (cond ((string? v) (json-string v))
          ((symbol? v) (json-string (symbol->string v)))
          ((boolean? v) (display (if v "true" "false") out))
          ((and (pair? v) (eq? (car v) 'obj))
           (display "{" out)
           (let loop ((rest (cdr v)) (first #t))
             (if (pair? rest)
                 (begin
                   (if (not first) (display "," out))
                   (json (caar rest)) (display ":" out) (json (cdar rest))
                   (loop (cdr rest) #f))))
           (display "}" out))
          ((list? v)
           (display "[" out)
           (let loop ((rest v) (first #t))
             (if (pair? rest)
                 (begin
                   (if (not first) (display "," out))
                   (json (car rest))
                   (loop (cdr rest) #f))))
           (display "]" out))
          (else (json-string ""))))
  (define (text v) (if (string? v) v ""))
  (define (safe thunk) (catch #t thunk (lambda args #f)))
  (define (predicate-name pred)
    (or (safe (lambda () (type-name pred)))
        (safe (lambda () (symbol->string (procedure-name pred))))
        "value"))
  (define (doc-of proc) (text (safe (lambda () (procedure-documentation proc)))))

  (define bindings '())
  (define (scan module)
    (module-for-each
      (lambda (sym var)
        (if (variable-bound? var) (set! bindings (cons (cons sym (variable-ref var)) bindings))))
      module))
  (scan (current-module))
  (for-each scan (module-uses (current-module)))

  (define (signature-of sig)
    (map (lambda (arg)
           (if (pair? arg)
               (list 'obj (cons 'type (predicate-name (car arg))) (cons 'optional #t))
               (list 'obj (cons 'type (predicate-name arg)) (cons 'optional #f))))
         sig))
  (define functions
    (filter-map
      (lambda (b)
        (and (ly:music-function? (cdr b))
             (let ((sig (ly:music-function-signature (cdr b))))
               (list 'obj
                 (cons 'name (car b))
                 (cons 'returns (predicate-name (if (pair? (car sig)) (caar sig) (car sig))))
                 (cons 'args (signature-of (cdr sig)))
                 (cons 'doc (doc-of (ly:music-function-extract (cdr b))))))))
      bindings))

  (define music->lily-string (safe (lambda () (@ (lily display-lily) music->lily-string))))
  (define (context-mod-doc mod)
    (let ((entry (assq 'description (map (lambda (m) (if (pair? m) m (cons m #f)))
                                         (ly:get-context-mods mod)))))
      (if (and entry (pair? (cdr entry))) (text (cadr entry)) "")))
  (define identifiers
    (filter-map
      (lambda (b)
        (let ((v (cdr b)))
          (cond ((ly:music? v)
                 (list 'obj
                   (cons 'name (car b))
                   (cons 'type (ly:music-property v 'name))
                   (cons 'expansion
                     (text (and music->lily-string (safe (lambda () (music->lily-string v))))))))
                ((ly:context-mod? v)
                 (list 'obj
                   (cons 'name (car b))
                   (cons 'type 'ContextMod)
                   (cons 'doc (or (safe (lambda () (context-mod-doc v))) ""))))
                ((ly:duration? v)
                 (list 'obj (cons 'name (car b)) (cons 'type 'Duration)))
                (else #f))))
      bindings))

  (define (markup-commands predicate suffix)
    (let ((found '()))
      (module-for-each
        (lambda (sym var)
          (if (and (variable-bound? var) (predicate (variable-ref var)))
              (let ((name (symbol->string sym)) (proc (variable-ref var)))
                (if (string-suffix? suffix name)
                    (set! found
                      (cons (list 'obj
                              (cons 'name (string-drop-right name (string-length suffix)))
                              (cons 'args
                                (map (lambda (pred)
                                       (list 'obj (cons 'type (predicate-name pred)) (cons 'optional #f)))
                                     (or (safe (lambda () (markup-command-signature proc))) '())))
                              (cons 'doc (doc-of proc)))
                            found))))))
        (resolve-module '(lily)))
      found))

  (define contexts
    (map (lambda (entry)
           (let ((def (cdr entry)))
             (list 'obj
               (cons 'name (car entry))
               (cons 'doc (text (ly:context-def-lookup def 'description)))
               (cons 'aliases (ly:context-def-lookup def 'aliases))
               (cons 'accepts (ly:context-def-lookup def 'accepts)))))
         (ly:output-find-context-def $defaultlayout)))

  (define grobs
    (map (lambda (entry)
           (let ((meta (assq-ref (cdr entry) 'meta)))
             (list 'obj
               (cons 'name (car entry))
               (cons 'doc (text (assq-ref meta 'description)))
               (cons 'interfaces (assq-ref meta 'interfaces))
               (cons 'defaults (delq 'meta (map car (cdr entry)))))))
         all-grob-descriptions))

  (define interfaces
    (hash-map->list
      (lambda (name value)
        (list 'obj (cons 'name name) (cons 'properties (caddr value))))
      (ly:all-grob-interfaces)))

  (define (properties names doc-key type-key)
    (map (lambda (name)
           (let ((type (object-property name type-key)))
             (list 'obj
               (cons 'name name)
               (cons 'type (if (procedure? type) (predicate-name type) ""))
               (cons 'doc (text (object-property name doc-key))))))
         names))

  (json
    (list 'obj
      (cons 'version (lilypond-version))
      (cons 'functions functions)
      (cons 'identifiers identifiers)
      (cons 'markup (markup-commands markup-function? "-markup"))
      (cons 'markupList (markup-commands markup-list-function? "-markup-list"))
      (cons 'contexts contexts)
      (cons 'grobs grobs)
      (cons 'interfaces interfaces)
      (cons 'grobProperties (properties all-user-grob-properties 'backend-doc 'backend-type?))
      (cons 'contextProperties
        (properties all-user-translation-properties 'translation-doc 'translation-type?))))
  (close-port out))
`

/** Runs the probe with `binary` and returns what it dumped. */
export function probe(binary) {
  const dir = mkdtempSync(join(tmpdir(), 'lily-gen-'))
  try {
    writeFileSync(join(dir, 'probe.ly'), PROBE)
    const run = spawnSync(binary, ['--loglevel=WARNING', '-dno-print-pages', 'probe.ly'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, LANGUAGE: 'en' },
    })
    if (run.error) throw new Error(`Cannot run ${binary}: ${run.error.message}`)
    if (run.status !== 0) throw new Error(`${binary} failed (exit ${run.status}):\n${run.stderr}`)
    return JSON.parse(readFileSync(join(dir, 'probe.json'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- Texinfo ---------------------------------------------------------------

const BLOCKS_AS_CODE = ['lilypond', 'example', 'smallexample', 'verbatim', 'lisp', 'smalllisp']
const INLINE_CODE = ['code', 'samp', 'file', 'command', 'option', 'env', 'kbd', 'key', 'indicateurl']
const INLINE_ITALIC = ['var', 'emph', 'dfn', 'i', 'slanted', 'cite']
const INLINE_BOLD = ['strong', 'b']
const INLINE_PLAIN = [
  'ref', 'xref', 'pxref', 'iref', 'rinternals', 'ruser', 'rlearning', 'rglos', 'rprogram',
  'rextend', 'rcontrib', 'rlsr', 'notation', 'r', 'sc', 't', 'w', 'math', 'asis', 'url', 'uref',
] // prettier-ignore
const SYMBOLS = { dots: '…', tie: ' ', copyright: '©', minus: '−', result: '⇒', bullet: '•', TeX: 'TeX' }

/** LilyPond's docstrings are Texinfo; hovers and completion items show Markdown. */
export function texinfoToMarkdown(texinfo) {
  // Escaped braces step aside, so that `[^{}]` below can find a command's argument.
  let text = texinfo.replace(/\r\n?/g, '\n').replace(/@\{/g, '\u0001').replace(/@\}/g, '\u0002')
  // Things that only make sense in the printed manual.
  text = text.replace(/^@(?:cindex|funindex|kindex|c|comment|noindent|need|sp|page)\b.*\n?/gm, '')
  text = text.replace(/@(iftex|tex|ignore|ifhtml|html)\n[\s\S]*?@end \1\n?/g, '')
  text = text.replace(/^@(?:end )?(?:ifnottex|ifnothtml|ifinfo|quotation|format|display|group|indentedblock|multitable)\b.*\n?/gm, '')

  // Code blocks leave the text first, so nothing below touches their contents.
  const blocks = []
  const block = new RegExp(`@(${BLOCKS_AS_CODE.join('|')})\\b(.*)\\n([\\s\\S]*?)@end \\1`, 'g')
  text = text.replace(block, (_, name, _options, body) => {
    const language = name === 'lilypond' ? 'lilypond' : name.endsWith('lisp') ? 'scheme' : ''
    // Code has no emphasis: `@var{x}` is x, `@dots{}` an ellipsis.
    const code = body.replace(/\s+$/, '').replace(/@([A-Za-z]+)\{([^{}]*)\}/g, (_, name, arg) => SYMBOLS[name] ?? arg)
    blocks.push(`\`\`\`${language}\n${unescape(code)}\n\`\`\``)
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`
  })

  // Tables and lists: `@item x` becomes a bullet, `@table @code` formats its items.
  const lists = []
  text = text
    .split('\n')
    .map((line) => {
      const open = /^@(table|vtable|ftable|itemize|enumerate)\b\s*(.*)$/.exec(line)
      if (open) {
        lists.push({ table: open[1].endsWith('table'), format: open[2].replace(/^@/, '').trim() })
        return ''
      }
      if (/^@end (?:table|vtable|ftable|itemize|enumerate)\b/.test(line)) {
        lists.pop()
        return ''
      }
      const item = /^@(?:itemx?|headitem)\b\s*(.*)$/.exec(line)
      if (!item) return line
      item[1] = item[1].replace(/\s*@tab\s*/g, ' — ')
      const list = lists.at(-1)
      if (!list?.table) return `- ${item[1]}`.trimEnd()
      return `- ${list.format && list.format !== 'asis' ? `@${list.format}{${item[1]}}` : item[1]}:`
    })
    .join('\n')

  // Inline commands, innermost first, so nesting needs no parser.
  const inline = /@([A-Za-z]+)\{([^{}]*)\}/
  for (let match = inline.exec(text); match; match = inline.exec(text)) {
    text = text.slice(0, match.index) + inlineMarkdown(match[1], match[2]) + text.slice(match.index + match[0].length)
  }

  text = unescape(text)
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text
    .replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)])
    .replace(/\u0001/g, '{')
    .replace(/\u0002/g, '}')
}

function inlineMarkdown(name, body) {
  if (name in SYMBOLS) return SYMBOLS[name]
  if (INLINE_CODE.includes(name)) return body ? `\`${body.replace(/`/g, "'")}\`` : ''
  if (INLINE_ITALIC.includes(name)) return body ? `*${body}*` : ''
  if (INLINE_BOLD.includes(name)) return body ? `**${body}**` : ''
  if (name === 'q') return `‘${body}’`
  if (name === 'qq') return `“${body}”`
  if (INLINE_PLAIN.includes(name)) return body.split(',')[0].trim()
  return body
}

function unescape(text) {
  return text.replace(/@([@{}.:!? ])/g, (_, char) => (char === ':' ? '' : char))
}

// --- Shaping ---------------------------------------------------------------

/** What a `\name` token can look like; drops `\\`, `\~`, `\[` and Scheme-only names. */
const COMMAND_NAME = /^[A-Za-z]+(?:[-_][A-Za-z]+)*$/
/** Hyphens are for markup commands; `ZERO-DURATION` and the like are Scheme constants. */
const IDENTIFIER_NAME = /^[A-Za-z]+$/
/** Longer expansions say nothing a hover can show (`\voiceOne` is 20 lines). */
const MAX_EXPANSION_LINES = 8

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

function signature(args) {
  return args.map((arg) => (arg.optional ? `[${arg.type}]` : `(${arg.type})`)).join(' ')
}

function functionKind(returns) {
  if (returns === 'music') return 'music function'
  if (returns === 'void') return 'void function'
  if (returns === 'post event' || returns === 'event') return 'event function'
  return 'scheme function'
}

/** `ArticulationEvent` is an "articulation"; containers of settings are just predefined commands. */
function identifierKind(type) {
  if (type === 'ContextMod') return 'context modification'
  if (type === 'Duration') return 'duration'
  if (type === 'AbsoluteDynamicEvent') return 'dynamic'
  if (!type.endsWith('Event')) return 'predefined command'
  return type.slice(0, -'Event'.length).replace(/(?<=[a-z])(?=[A-Z])/g, ' ').toLowerCase()
}

function expansionOf(name, expansion) {
  const lines = expansion.trim().split('\n').map((line) => line.trimEnd())
  // `{ … }` around a single setting is noise; `\f` expanding to `\f` is no news.
  const inner = lines.length > 2 && lines[0] === '{' && lines.at(-1) === '}' ? lines.slice(1, -1) : lines
  const body = inner.filter((line) => line.trim()).map((line) => line.replace(/^ {2}/, ''))
  if (body.length === 0 || body.length > MAX_EXPANSION_LINES) return undefined
  if (body.length === 1 && body[0] === `\\${name}`) return undefined
  // `#<hash-table 10ac3fd20 …>` is no LilyPond, and its address differs from run to run.
  if (body.some((line) => line.length > 100 || line.includes('%{') || line.includes('#<'))) return undefined
  return body.join('\n')
}

/** Drops keys whose value is empty, so the JSON stays small and diffs stay readable. */
function compact(entry) {
  return Object.fromEntries(
    Object.entries(entry).filter(
      ([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0),
    ),
  )
}

/** Raw probe output to the shape `src/intellisense/data.ts` declares. */
export function buildData(raw) {
  const commands = new Map()
  const add = (entry) => {
    if (COMMAND_NAME.test(entry.name) && !commands.has(entry.name)) commands.set(entry.name, compact(entry))
  }
  // First come, first kept: what the binary defines wins over the keyword table,
  // and a music function over a markup command of the same name (`\override`
  // is a keyword and a markup command, `\tuplet` only a function).
  for (const fn of raw.functions) {
    add({
      name: fn.name,
      kind: 'function',
      detail: functionKind(fn.returns),
      signature: signature(fn.args),
      doc: texinfoToMarkdown(fn.doc),
    })
  }
  for (const id of raw.identifiers.filter((id) => IDENTIFIER_NAME.test(id.name))) {
    add({
      name: id.name,
      kind: 'music',
      detail: identifierKind(id.type),
      doc: texinfoToMarkdown(id.doc ?? ''),
      expansion: expansionOf(id.name, id.expansion ?? ''),
    })
  }
  for (const [name, doc] of Object.entries(KEYWORDS)) add({ name, kind: 'keyword', detail: 'keyword', doc })
  for (const [list, detail] of [[raw.markup, 'markup command'], [raw.markupList, 'markup list command']]) { // prettier-ignore
    for (const cmd of list) {
      const entry = {
        name: cmd.name,
        kind: 'markup',
        detail,
        signature: signature(cmd.args),
        doc: texinfoToMarkdown(cmd.doc),
      }
      // A name that is both (`\override`, `\score`) keeps its first meaning and
      // gains the markup one, which the providers show inside `\markup`.
      const taken = commands.get(cmd.name)
      if (taken) taken.markup = compact({ detail, signature: entry.signature, doc: entry.doc })
      else add(entry)
    }
  }

  const property = (p) => compact({ name: p.name, type: p.type, doc: texinfoToMarkdown(p.doc) })
  const userGrobProperties = new Set(raw.grobProperties.map((p) => p.name))
  return {
    lilypond: raw.version,
    commands: [...commands.values()].sort(byName),
    contexts: raw.contexts
      .map((c) => compact({ name: c.name, doc: texinfoToMarkdown(c.doc), aliases: c.aliases, accepts: c.accepts }))
      .sort(byName),
    grobs: raw.grobs
      .map((g) =>
        compact({
          name: g.name,
          doc: texinfoToMarkdown(g.doc),
          interfaces: [...g.interfaces].sort(),
          defaults: g.defaults.filter((name) => userGrobProperties.has(name)).sort(),
        }),
      )
      .sort(byName),
    // Internal properties are not for `\override`; only the user ones are kept.
    interfaces: raw.interfaces
      .map((i) => ({ name: i.name, properties: i.properties.filter((name) => userGrobProperties.has(name)).sort() }))
      .sort(byName),
    grobProperties: raw.grobProperties.map(property).sort(byName),
    contextProperties: raw.contextProperties.map(property).sort(byName),
  }
}

/** One entry per line: a regenerated file diffs by entry, and stays greppable. */
function serialize(data) {
  const parts = Object.entries(data).map(([key, value]) =>
    Array.isArray(value)
      ? `  ${JSON.stringify(key)}: [\n${value.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')}\n  ]`
      : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  )
  return `{\n${parts.join(',\n')}\n}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const binary = process.argv[2] ?? process.env.LILYPOND ?? 'lilypond'
  const data = buildData(probe(binary))
  writeFileSync(outFile, serialize(data))
  const count = (kind) => data.commands.filter((command) => command.kind === kind).length
  console.log(
    `LilyPond ${data.lilypond}: ${count('function')} functions, ${count('music')} predefined commands, ` +
      `${count('keyword')} keywords, ${count('markup')} markup commands, ${data.contexts.length} contexts, ` +
      `${data.grobs.length} grobs, ${data.grobProperties.length} grob properties, ` +
      `${data.contextProperties.length} context properties -> ${outFile}`,
  )
}
