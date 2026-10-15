# 07 — MIDI output and playback within mobile audio limits

Chapter 07 of the investigation into an engine of our own (chapter 00 sets
the budgets and the test set, chapter 01 maps LilyPond's source, chapters
02–06 design the parser, the Scheme interpreter, the music model, the layout
and the SVG and PDF output). It describes how LilyPond makes MIDI (§1),
counts what the 30 scores of chapter 00 and a supplement of 12 MIDI tests
play (§2), designs the performers: tempo, dynamics, articulations, repeats
and instruments (§3), and the MIDI writer, checked against LilyPond's own
files byte for byte (§4). It then measures and plans playback on the phones:
the synthesizer's cost, iOS's audio unlock and silent switch, interruptions
and background tabs, latency, and what a sound font would cost (§5). It
records no decision about the engine; D56 (step 11) will. Two small changes
to `packages/common/web/midi.js` that the phones need now were made with
this chapter, and are recorded in D24 (§5.3, §5.4).

Everything refers to LilyPond at tag `v2.26.0` (commit
`3596756be0fac1f81066a99d2054329212172b2d`). **[measured]** marks what was
taken on 2026-10-03 on the M1 Max of chapter 00 with `GNU LilyPond 2.26.0
(running Guile 3.0)` of Homebrew, Node 24.14, Playwright 1.59.1 with its
headless Chromium 147.0.7727.15 and WebKit 26.4, rustc 1.97 for the writer
probe, and brotli 1.2 at `-q 11`. The recipes are in Appendix A. KB is
1,000 bytes. Projections onto the phones use chapter 00's factors (× 1/0.45
for the Android reference's CPU, × 1/0.3 for the floor, × 1.5 for wasm). The
browser's own audio rendering is native code, so the 1.5 does not apply to
it. Facts about browsers that were not measured here are cited. Where no
primary source was found they are marked *unconfirmed*, and step 10 has to
try them on the devices.

## 1. How LilyPond makes MIDI

Chapter 01 §3.8 lists the 28 files (4,568 lines) of family I. A `\midi`
block is its own translation of the music. It is not a by-product of the
layout's.

1. **Translation.** The iterators of chapter 04 feed stream events to the
   `\midi` contexts of `ly/performer-init.ly`. These are fewer than the
   layout's: T29's 59 MIDI contexts consist of 242 translators, against the
   layout's 2,060 (chapter 04 §2.2). A context that only a `\layout`
   defines, such as T29's and T30's custom staves, does not exist there.
   LilyPond warns and plays such music in default contexts.
2. **Performers make audio items.** `Note_performer` makes an `Audio_note`
   per note event. Its length comes from the event and from each
   articulation's `midi-length` procedure; the articulations'
   `midi-extra-velocity` is summed. A grace note shortens the note before
   it. `Tie_performer` adds a tied note's length to the first note of the
   tie and leaves the others with length 0. `Dynamic_performer` gives every
   note a volume: from the last absolute dynamic through
   `dynamicAbsoluteVolumeFunction` (`absolute-volume-alist` in
   `ly/midi-init.ly`: `ppppp` 0.25 … `fffff` 0.95, `sf` 1.0), and through
   `instrumentEqualizer` or `midiMinimumVolume`/`midiMaximumVolume`. A
   hairpin's notes get volumes interpolated toward the next dynamic. Spans
   wait in a queue until it is known (§3.4). `Tempo_performer`,
   `Time_signature_performer`, `Key_performer`, `Lyric_performer`,
   `Mark_performer`, `Piano_pedal_performer` and `Midi_control_change` items
   (pan, balance, expression, reverb, chorus, from `Staff.midi…`
   properties) make the rest. `Beat_performer` is written in Scheme
   (`scm/scheme-performers.scm`). It is in no default context.
3. **Staves become tracks.** `Staff_performer` gathers the items of a staff
   into an `Audio_staff` per voice, or one per staff. It names it
   `"<staff id>:<voice id>"`, picks a channel by `midiChannelMapping`
   (`staff` by default, from a counter shared by all staves of the
   performance, skipping channel 10) and turns `midiInstrument` into a
   program change by `instrument-names-alist` (`scm/midi.scm`, 153 names,
   drum kits flagged for channel 10). `Score_performer` collects the
   staves into a `Performance`, after a control track
   (`Control_track_performer`) that holds the tempo, the time signature
   and a "creator" text.
4. **The file.** `Midi_walker` sorts each staff's items by time (stably)
   and writes them at 384 ticks a quarter. Each note-on queues its note-off
   in a priority queue. A note of a key that already sounds in the track
   ends the sounding one, or is merged into it when both begin at the same
   moment (`midiMergeUnisons` off). Note-offs are note-ons with velocity 0,
   and no running status is used. `write-performances-midis` (`scm/midi.scm`)
   writes one file per `\midi` performance: `<base>.midi`, `<base>-1.midi`, …

What the engine must match is C2 of chapter 00 (now with velocities, §4.3).
`timing.ly`'s playback map (D26) comes from the same translation, so it
stays exact as long as the performers see the same moments.

## 2. What the test set plays

### 2.1 The files

**[measured]**: chapter 00's reference capture (every score gets a `\midi`),
each `.midi` read by an SMF walker of its own and by `parseMidi`
(`census.mjs`, Appendix A). *Ch* is the channels used. *Velocities* is the
range and number of distinct note-on velocities. *CC* lists controller
number:count. *Meta* counts meta events (the end of track left out).
*Poly* is the most notes sounding at once (without release tails), and
*Peak/s* the most note-ons in any one second.

| ID | Bytes | Tracks | Ch | Notes | Velocities | Programs | CC | Bend | Meta | Seconds | Poly | Peak/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | 155 | 2 | 1 | 6 | 90 (1) | | | | text 2, tempo 1, time 1 | 8.0 | 1 | 1 |
| T02 | 538 | 4 | 2 | 26 | 90 (1) | | | | text 2, name 2, lyric 17, tempo 1, time 1, key 2 | 15.0 | 2 | 3 |
| T05 | 970 | 2 | 1 | 105 | 90 (1) | | | | text 2, tempo 1, time 1 | 112.0 | 7 | 7 |
| T07 | 783 | 3 | 1 | 74 | 90 (1) | 0 | | | text 2, instr 2, tempo 1, time 1 | 8.0 | 4 | 11 |
| T12 | 1,291 | 2 | 1 | 134 | 90 (1) | | | | text 2, name 1, tempo 1, time 1 | 107.6 | 3 | 4 |
| T18 | 245 | 2 | 1 | 16 | 43–101 (8) | | | | text 2, tempo 1, time 1 | 16.0 | 1 | 1 |
| T22 | 715 | 3 | 2 | 56 | 90 (1) | 25 | | | text 2, name 2, instr 2, tempo 1, time 1, key 2 | 17.6 | 8 | 12 |
| T24 | 3,928 | 4 | 3 | 453 | 90 (1) | | | | text 2, name 4, tempo 1, time 1, key 3 | 52.0 | 4 | 11 |
| T25 | 1,155 | 4 | 3 | 117 | 90–127 (6) | | | | text 2, name 3, tempo 1, time 1 | 9.0 | 8 | 17 |
| T26 | 349 | 4 | 2 | 21 | 62–101 (5) | | | | text 2, name 3, tempo 1, time 3 | 6.0 | 3 | 9 |
| T28 | 1,303 | 3 | 2 | 144 | 90–127 (16) | | | | text 2, name 1, tempo 1, time 3 | 15.0 | 5 | 27 |
| T29 | 4,043 | 27 | 13 | 384 | 62–125 (41) | | | | text 2, name 26, tempo 1, time 2, key 19 | 5.9 | 29 | 181 |
| T30 | 2,362 | 6 | 4 | 235 | 69–90 (2) | | | | text 2, name 2, lyric 14, tempo 1, time 1, key 4 | 27.0 | 4 | 15 |
| **All 30** | 23,938 | 115 | | 2,107 | | | none | none | | | | |

The 17 scores not shown are like T01: one velocity (90), no program, at most
a few names, lyrics (T04 10, T20 32, T23 57) and keys. A file is 128 bytes
(T14) to 4.0 KB (T29), 24 KB for all 30, and no file uses running status.

### 2.2 What the performers hear

**[measured]**: a Score-level performer added to every `\midi` (`perf.ly`,
Appendix A) counts the stream events below the Score by class, the
articulations and dynamics by name, and the `\set`s of the properties the
performers read. Scores with nothing in a column but notes are left out.
*Artic. heard* are those with a `midi-extra-velocity` or a `midi-length`
in `ly/script-init.ly` (accent 20, marcato 40, staccato 4 and at most half
the note or 0.5 s, staccatissimo 6 and 1/8 s, portato 3/4). *Silent* are
the others (fermata, trill, …), which MIDI does not play. *midi… set* counts
`\set`s of `midi*`, `instrumentTransposition` and the two volume functions.

| ID | Notes | Rests | Ties | Dynamics | Hairpins | Artic. heard | Silent | Breaths | Tempo | Key | Lyrics | midi… set | Graces | Volta starts | Tremolos |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T02 | 26 | · | · | · | · | · | · | · | · | 2 | 17 | · | · | · | · |
| T07 | 74 | 8 | · | · | · | · | · | · | · | · | · | · | · | 1 | · |
| T09 | 23 | · | · | · | · | · | 1 | · | · | · | · | · | 14 | · | · |
| T10 | 11 | · | · | · | · | · | · | · | · | · | · | · | · | 3 | · |
| T12 | 138 | 4 | 2 | · | · | · | · | · | · | · | · | · | 6 | · | · |
| T15 | 2 | 1 | · | · | · | · | · | 5 | · | · | · | · | · | · | · |
| T18 | 16 | · | · | 5 | 6 | · | · | · | · | · | · | 2 | · | · | · |
| T22 | 66 | · | 6 | · | · | · | 2 | · | · | 2 | · | 2 | 16 | · | · |
| T24 | 487 | 13 | 31 | · | · | · | 9 | · | 4 | 4 | · | · | · | 4 | · |
| T25 | 127 | 1 | · | · | 2 | 1 | · | · | · | · | · | · | 2 | · | · |
| T26 | 26 | 7 | 5 | 19 | · | · | · | · | · | · | · | · | · | · | · |
| T28 | 144 | 5 | · | 18 | 5 | · | · | · | 1 | · | · | · | · | · | · |
| T29 | 398 | 128 | 10 | 47 | 38 | 136 | · | · | 2 | 19 | · | 7 | · | · | 13 |
| T30 | 240 | 22 | 5 | 2 | · | · | 3 | · | 4 | 4 | 14 | · | · | · | · |
| **All 30** | 2,215 | 203 | 61 | 91 | 51 | 137 | 15 | 5 | 11 | 35 | 132 | 11 | 40 | 8 | 13 |

### 2.3 A supplement for MIDI

The 30 scores were chosen for notation (chapter 00 §4), and §2.1 shows that
MIDI hardly touches them. There is no controller, pedal, pitch bend or
tempo change in any of them, only two program changes (T07's kit and
T22's guitar), and the orchestra of T29 plays on the piano. Its staves name
their instruments with `instrumentName`, which the equalizer reads, but set
no `midiInstrument`. A supplement from LilyPond's
own `input/regression/` (fetched as chapter 00 fetches groups B and C)
covers each performer that the 30 do not reach:

| ID | File | Covers | Bytes | Notes | What its MIDI holds **[measured]** |
| --- | --- | --- | --- | --- | --- |
| M01 | `midi/tempo.ly` | `Tempo_performer` | 159 | 0 | 7 tempo events |
| M02 | `midi/pan-position.ly` | `Midi_control_change`, instruments | 253 | 2 | programs 68, 70; CC 10 and 42 (pan, MSB and LSB) ×8 |
| M03 | `midi-pedal.ly` | `Piano_pedal_performer` | 262 | 16 | CC 64, 66, 67 ×2 each |
| M04 | `midi-microtone.ly` | pitch bend for microtones | 171 | 5 | 4 pitch bends |
| M05 | `midi/repeat-segno.ly` | `Mark_performer`, segno repeats | 302 | 12 | 6 markers |
| M06 | `midi/staff-map-instrument.ly` | `midiChannelMapping = #'instrument`, staccato | 553 | 38 | 5 staff tracks on one channel |
| M07 | `midi-volume-equaliser.ly` | `instrumentEqualizer`, 11 instruments | 654 | 11 | 10 programs, velocities 57–101 |
| M08 | `midi/crescendo-return-crescendo.ly` | the hairpin state machine | 146 | 4 | velocities 86–127 |
| M09 | `midi/beat-structure-by-metronome-8-8.ly` | the metronome field of time signatures | 425 | 32 | 4 time signatures |
| M10 | `midi/articulate-accel.ly` | `articulate.ly`: tempo from text | 630 | 40 | 21 tempo events |
| M11 | `midi-grace.ly` | grace notes shortening their note | 136 | 3 | |
| M12 | `midi/partcombine.ly` | `\partCombine` in MIDI | 378 | 20 | 4 staff tracks |

None of the 42 needs `Beat_performer` or `Drum_note_performer`'s
`drumPitchTable` beyond T07. They are the C2 corpus of milestone M5 (§7),
alongside the 30.

What it says:

- **MIDI is small next to the page.** At most 4 KB a file, and 0.2–31.7 ms
  of LilyPond's translation per score (chapter 04 §2.2), against 15–456 ms
  for the whole book. Projected onto the Android reference (× 1/0.45 × 1.5)
  that is at most about 105 ms (T29), after the page is shown (§3.8).
- **Three things make most of the bytes**: notes (2,107 note-ons, each with
  its off), track names and lyrics. 2,215 note events become 2,107
  note-ons: ties merge 61 notes, and unisons begun together in one track
  merge 47 more.
- **Dynamics are what C2 must learn first.** Eight of the 30 have more than
  one velocity, through 91 dynamics, 51 hairpins and 137 accents and
  staccatos. Everything else in the 30 is one velocity, one tempo and no
  program.
- **Repeats are not unfolded** in LilyPond's MIDI: T10's `\repeat volta` is
  played once (11 notes for 11 note events), and T19 and M05 unfold through
  `\unfoldRepeats` or `articulate.ly`. The same is wanted from the engine:
  changing it would break C2 and D26's map.

## 3. The performers

### 3.1 On the translator framework

Performers are translators on chapter 04 §9's framework: classes declared in
Rust with their listened event classes, woken only when they have work,
and making audio items instead of grobs. An audio item is the writer's
input of §4. A note is start tick, length, channel, key and velocity, and
anything else is a channel message or meta event with its tick. A staff's
items are a `Vec` in announce order. Chapter 04 §9.3 already puts the
playback map's performer (D26) there, built in, with `timing.ly` kept as the
test that Scheme performers work.

LilyPond's 16 C++ performers port to Rust one for one. They are small (90
to 508 lines, 2,902 in all, 1,286 of them in four files: `Dynamic_performer`,
`Staff_performer`, `Tie_performer` and `Note_performer`). Their Scheme
hooks are values of context properties and stay Scheme:
`dynamicAbsoluteVolumeFunction`, `instrumentEqualizer`, `midi-length`
procedures in articulations, `Beat_performer`. The defaults are recognised
by identity and run in Rust; a user's own procedure is called through
chapter 03's interpreter. The tables (`instrument-names-alist`,
`absolute-volume-alist`, `instrument-equalizer-alist`) stay in `ly/` and
`scm/` as LilyPond has them. A copy compiled into Rust serves the defaults
while a score has not redefined them. The probe of §4.2 includes one: 210
lines, of which 177 are the three tables.

| LilyPond | Does | Reached by | In the engine |
| --- | --- | --- | --- |
| `Score_performer`, `Control_track_performer` | the performance; the control track (creator text, tempo, time signature) | all | Rust |
| `Staff_performer` | tracks per staff or voice, names, channels, programs, the initial controllers | all; M02, M06, M07 | Rust |
| `Note_performer` | notes; `midi-length`, `midi-extra-velocity`; graces shorten the note before; breaths shorten | all; T09, T15, T29, M11 | Rust, defaults of `script-init.ly` built in |
| `Drum_note_performer` | drum notes through `drumPitchTable` | T07 | Rust |
| `Tie_performer` | ties merged into the first note | T12, T22–T30 | Rust |
| `Dynamic_performer` | velocities, hairpins, equalizer | T18, T25, T26, T28–T30; M07, M08 | Rust (§3.4) |
| `Tempo_performer` | tempo changes | M01, M10 | Rust |
| `Time_signature_performer`, `Key_performer` | time and key signatures | all | Rust |
| `Lyric_performer` | lyric meta events | T02, T04, T20, T23, T30 | Rust |
| `Mark_performer` | marker meta events for marks, segni, codas | M05 | Rust |
| `Piano_pedal_performer` | CC 64, 66, 67 | M03 | Rust |
| `Midi_cc_performer` and `Midi_control_change` | pan, balance, expression, reverb, chorus as 14-bit controllers | M02 | Rust |
| `Beam_performer`, `Slur_performer` | melisma for lyrics (no audio) | lyrics scores | Rust, shared with chapter 04 §13's N7 |
| `Beat_performer` | accents on beats | none | Scheme, as LilyPond has it |
| `articulate.ly` | rewrites the music before it is performed | T19, M10 | Scheme (968 lines), a library part of chapter 03 §6 |

### 3.2 Tempo

The control track starts at `tempoWholesPerMinute`, which is 60 quarters a
minute by default (`FF 51 03 0F 42 40` in every file of §2.1 without
`\tempo`). A `\tempo` with a metronome mark writes a tempo event at its
moment. One with text only writes nothing, so T24's four tempo events and
T29's two make one tempo each. Gradual tempo changes exist only through
`articulate.ly` (M10's 21 tempo events), which runs in Scheme. The engine
needs no tempo logic beyond the property and the event.

### 3.3 Articulations

The 51 articulations of `script-init.ly` are music; five of them carry MIDI
properties. Accent and marcato carry only a `midi-extra-velocity`. Portato,
staccato and staccatissimo carry a `midi-length` lambda, which
`Note_performer` calls with the length and the context (through
`seconds->moment` for the last two), and the last two a velocity as well. The engine evaluates these lambdas in Rust when
the procedure is the one `script-init.ly` defined, which it knows by
identity after init (chapter 03's snapshot), and through the interpreter
otherwise. Breathing signs shorten the note before by `breathe::midi-length`
(`scm/define-music-callbacks.scm`), the same way. Ornaments (trills, turns,
mordents) are silent in LilyPond's MIDI and stay so; `articulate.ly`
realises them when a score includes it.

### 3.4 Dynamics

`Dynamic_performer` is the largest performer (508 lines) and the only one
with a look-ahead. A hairpin's notes are not given volumes when they are
performed. Spans wait in two queues (`depart`, `return`) until the next
absolute dynamic, or the end, decides the target. A target that goes the
wrong way, or none at all, is replaced by a departure volume of 7 % to 25 %
of the volume range beyond the start. Notes keep a pointer to their span and
read the volume when the file is written, which is where `Midi_note` makes
the velocity: `volume × 127 + extra`, clamped to 127 (`midi-item.cc`).

Ported as is, with two consequences for the engine:

- **An edit can change velocities before it.** Changing the dynamic after a
  hairpin changes the hairpin's notes, and inserting a note in it changes
  the span's share of the hairpin's length. Recomputing only from the edit
  forward would be wrong (§3.8).
- **Velocities are resolved at writing**, so the audio items hold a span
  index and the writer asks the dynamics table. This is the same late
  binding as LilyPond's, with an index in place of a pointer.

### 3.5 Repeats

Volta repeats are played once, as written (§2.3). Unfolding is done to the
music before translation, by `\unfoldRepeats` (a music function in
`music-functions-init.ly`; `unfold-repeats` in `scm/music-functions.scm`
wraps volta, segno, percent and tremolo repeats as `UnfoldedRepeatedMusic`),
or by `articulate.ly`'s `\articulate`. The
engine adds nothing here. Its iterators already handle `\repeat unfold`
(chapter 04 §8), and a tree changed by a music function is a new tree,
which chapter 04 §10.1 re-translates.

### 3.6 Instruments and channels

`midiInstrument` names a program by `instrument-names-alist`, and
`percussion?` sends drum kits to channel 10. `Staff_performer` keeps the
channel counter in **static** C++ variables shared by every staff of the
performance and reset when the last staff ends. So the channel of a staff
depends on how many staves were made before it (T29: 26 tracks on 13
channels, M06: 5 tracks on one channel with `midiChannelMapping =
#'instrument`). The engine keeps this counter in the performance, not in a
static, and lets each track keep its first channel, as LilyPond does.

### 3.7 Equalizer and the default velocity

Without dynamics a note has `dynamic-default-volume` 0.71 (velocity 90).
`equalize_volume` maps every volume through the instrument's range. It uses
`midiMinimumVolume`/`midiMaximumVolume` when set, else
`instrumentEqualizer` of `midiInstrument`, else of `instrumentName`, else of
"piano". **[measured]**: with `midiMaximumVolume = 0.9` added to every
Score, 29 of the 30 scores change every velocity. T18 changes none, because
it sets both properties in its Staff. Velocities are therefore context
properties all the way down, and C2 must compare them (§4.3).

### 3.8 What an edit recomputes

A performance is short (chapter 04 §2.2: 0.2–31.7 ms in LilyPond). Three
properties of it reach across the whole score: dynamics look ahead (§3.4),
channels are counted across staves (§3.6), and a tempo change moves every
second after it. So the engine re-performs the **whole** score after an
edit, with chapter 04's translator framework and none of its checkpoints,
and:

- **after the page**, not in B6. The worker posts the page first, then
  performs, writes the file and the playback map, and posts them, as the
  extension's preview does with LilyPond's files today (D24, D26).
- **only when they are wanted**: while the score is being played, when its
  `.midi` or map is asked for (Export MIDI, D54; the playback map while the
  playhead is shown), or once at idle after the first page of a score with a
  `\midi` block. An edit while stopped marks the performance stale and does
  nothing more.
- **cancellable** between timesteps, as chapter 04 §8 cancels translation
  (B8): a newer edit drops a running performance.
- **unchanged bytes are not sent again** (D24), so a layout-only edit does
  not reload the player.

Re-performing from a checkpoint (chapter 04 §10.2) is a later optimisation,
if step 10 shows T29's projected 105 ms matters while playing. D45's player
already reloads and seeks back when the music changes during playback.

## 4. The MIDI file

### 4.1 What LilyPond writes

Read from the 42 files of §2 **[measured]**:

- `MThd` with format 1, one track per staff after the control track, and
  division 384.
- The control track opens with two text events, `creator: ` and `LilyPond
  2.26.0` padded with spaces to 30 bytes, then the time signature (`FF 58`,
  with MIDI clocks per metronome click from the beat structure, M09) and the
  tempo.
- A staff track opens with its name (`FF 03`, `"<staff id>:<voice id>"`,
  left out when both ids are empty), the instrument name (`FF 04`) and the program change when `midiInstrument` is
  set, and the initial controllers.
- Note-on, then note-on with velocity 0 as the note-off. Every event has
  its status byte (no running status). The end of track comes at the
  score's end plus `midiSkipOffset`.

### 4.2 The writer, as a probe

`probe/src/lib.rs` (Appendix A, 253 lines of Rust, `no_std` with `alloc`)
writes a performance, given as staves of audio items in announce order, the
way `Midi_walker` does:

- a stable sort by tick;
- the stop queue, with LilyPond's unison rules: a note of a key that sounds
  ends it, and one begun at the same tick merges into it;
- variable-length deltas;
- the end of track at the staff's end.

LilyPond's `PQueue` is `std::push_heap` and `std::pop_heap` with `greater`.
Which of several note-offs at one tick comes first is therefore decided by
the C++ library's heap algorithm. The probe has libc++'s, which Homebrew's
macOS build is linked with: `__sift_up`, and the Floyd pop of LLVM 16 and
later.

**[measured]**: each of the 42 reference files was read back into the items
it was written from (each note-on paired with its off, every other event
kept in file order) and written again (`roundtrip`, Appendix A).

| | Files | Byte for byte | Differ |
| --- | --- | --- | --- |
| T01–T30 | 30 | 27 | T24, T25, T27 |
| M01–M12 | 12 | 12 | — |

In the three that differ, the same events are written, and only the order
of note-offs at one tick changes: T24 has 2 such pairs, T27 1, T25 4. All
three merged unisons (§2.2's notes less ties less note-ons: 3, 10 and 24
notes). A merge leaves an `ignore`d entry in LilyPond's heap, which changes
the heap's shape, and a file cannot tell where those entries were. T12, T22
and T29 merged some too (2, 4 and 4) and still came out equal, so this is
an inference, not a proof: given the performers' own items, with the merged
notes in them, the writer should make the three as well (M1's test, §7). The older libc++ pop (a plain sift-down) gives the same 39.
libstdc++'s heap, which a Linux build of LilyPond uses, was not tried. It
may order such ties differently, so byte equality with LilyPond is a goal
per platform, not a portable one.

Its cost **[measured]**: 46 µs native for T29, 1.4 ms for all 42 files in
wasm under Node (each from its item list, after instantiation). Built for
`wasm32-unknown-unknown` with opt-level `z`, LTO, one codegen unit,
`panic = "abort"`, a bump allocator and the tables of §3.1, it is
**21,262 bytes, 8,183 with brotli**. The wasm build writes the same 39 files
byte for byte. That is 39 bytes of wasm and 15 of brotli per line of Rust.

The performers of §3.1 are 2,902 lines of C++, and the audio items they
make about 380 more. Assuming they port to 2,000–2,500 lines of Rust at the probe's density, the MIDI part of the
engine is projected at **80–100 KB of wasm, 30–40 KB with brotli**. That is
far inside B2's 150 KB for "MIDI performers", even before chapter 08
decides whether it is a module of its own. The translator framework it
runs on is the core's (chapter 04 §9) and is not counted here.

### 4.3 Checking it

- **C2 with velocities.** Chapter 00's comparator compared notes by file,
  track, channel, key, program, time and duration, and left velocities out,
  although `parseMidi` keeps them (`velocity`, over 127). The key now has
  `Math.round(velocity × 127)` as well, and chapter 00 §5.2 and Appendix A
  say so. **[measured]**, with §3.7's `midiMaximumVolume` change against the
  plain capture: the old key scores 1.0 on all 30 scores, and the new one
  0.0 on the 29 whose velocities changed (1.0 on T18).
- **C2b, the bytes.** Since the writer can match LilyPond's bytes (§4.2),
  each `.midi` is also compared byte for byte, with the creator text left
  out. This is a Goal, not a Must, because of the heap ties. A difference
  that remains after normalising the order of note-offs at one tick is a bug.
- **D26's map.** C1 compares the playback map's events. The engine's built-in
  map performer (chapter 04 §9.3) and `timing.ly` run side by side in the
  tests and must agree.

### 4.4 The Rust MIDI code the apps already have

Lily Studio has Rust that reads and changes MIDI. Since D55 it is in
`packages/studio/crates/session` (`lily-session`, shared by the app and the
web server's workers):

- **`midi_export.rs`** (D54) walks the chunks of a file and drops the `MTrk`
  chunks of muted parts, keeping every other byte. Its chunk walk and the
  probe's are the same code, so the engine's MIDI crate (`no_std` with
  `alloc`, no tokio) holds the SMF reader and writer, and `midi_export.rs`
  calls it once the engine is a dependency of `lily-session`. Until then it
  stays as it is: it works on any SMF, LilyPond's or the engine's.
- **D54's gap closes.** D54 does not write the instruments chosen in the
  Parts fold, because that means rewriting events. With the engine, Export
  MIDI can perform the score with the chosen program on each staff, as if
  `midiInstrument` were set, and write it. Muting still drops tracks.
- **`playback.rs`** (D45) keeps each score's playback setup with parts keyed
  by track index, which moves a setting to another part when a staff is
  added above it (D45's *Not done*). The engine knows which staff context
  each track came from, and the track name (`"<staff id>:<voice id>"`). A
  setup keyed by that name, with the index as a fallback, would survive such
  an edit. That is a change to `clean()`'s accepted keys and to the
  renderer's `mixMidi`, for when the engine feeds the studio.
- **The extension** has no Rust, and its player takes the same bytes.

The interface to both apps stays what LilyPond gives them today: `.midi`
files in the order `write-performances-midis` writes them, and the
`.timing.json` map. The preview, `midi.js`, D45's parts, D51's latency and
D54's export then work on the engine's output unchanged. That includes
Studio on the web (D55) when its page runs the engine (chapter 08).

## 5. Playback on the phones

Playback is not the engine's job: it hands over a `.midi` file. But the
music must be heard on the phones of chapter 00 §1, so this section checks
what plays it there: `packages/common/web/midi.js` (D24), 29.3 KB and 8.6 KB
with brotli, loaded by the page and not the worker. A Web Audio context
exists only in a window, so the player stays on the main thread.

### 5.1 The synthesizer's cost

`midi.js` makes every note an oscillator with a periodic wave, a gain
envelope and, for struck and plucked voices, a low-pass filter, into a
panner per channel and one limiter. It plays no samples, so there is no
sound font to download (D24).

**[measured]** (`render.mjs`, Appendix A): every file of §2 rendered through
`Synth` into an `OfflineAudioContext` at 48 kHz stereo, median of three.
*Schedule* is the time to create every note's nodes. *RTF* is seconds of
music per second of rendering.

| ID | Notes | Music s | Chromium: schedule ms | render ms | RTF | WebKit: render ms | RTF | Peak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T02 | 26 | 16.0 | 1.3 | 138 | 116 | 90 | 178 | 0.47 |
| T05 | 105 | 113.0 | 3.4 | 2,204 | 51 | 1,311 | 86 | 0.55 |
| T12 | 134 | 108.6 | 4.4 | 1,850 | 59 | 941 | 115 | 0.45 |
| T24 | 453 | 53.0 | 12.5 | 3,160 | 17 | 1,700 | 31 | 0.51 |
| T25 | 117 | 10.0 | 3.9 | 267 | 37 | 176 | 57 | 0.60 |
| T29 | 384 | 6.9 | 10.7 | 428 | 16 | 293 | 24 | 0.68 |
| T30 | 235 | 28.0 | 6.5 | 1,031 | 27 | 576 | 49 | 0.55 |
| M07 | 11 | 12.0 | 1.9 | 43 | 282 | 26 | 462 | 0.38 |

A synthetic tutti finds where it stops keeping up: *n* notes held together
for 10 s, as the piano (oscillator, filter, envelope) and as strings
(oscillator, envelope).

| Notes at once | Chromium piano RTF | strings | WebKit piano | strings |
| --- | --- | --- | --- | --- |
| 8 | 89.8 | 184.3 | 105.8 | 211.5 |
| 32 | 27.8 | 77.2 | 30.5 | 74.8 |
| 64 | 14.7 | 45.9 | 15.8 | 40.7 |
| 128 | 7.5 | 24.6 | 7.8 | 21.5 |
| 256 | 3.8 | 13.4 | 4.0 | 10.9 |

What it says:

- **One held piano note costs 0.11 % of an M1 core** in either engine
  (1/(3.8 × 256)), and a string note 0.03 %. Projected onto the Android
  reference that is 0.25 % and 0.07 %, and onto the floor 0.38 % and
  0.11 %.
- **The heaviest score is light.** T29, with 29 notes at once and 181 a
  second, renders at 16× real time in Chromium: 6 % of an M1 core, so
  about 14 % of the Android reference's and 21 % of the floor's. T24 is the
  same. An audio thread is safe below about half a core, so the synthesizer
  has room for 4–7 times the corpus's polyphony: about 130 piano notes at
  once on the floor, 200 on the reference.
- **The limiter holds.** The loudest peak is T29's 0.68, never above 1, as
  D24 measured for a 20-note chord.
- Offline rendering is not the real-time audio thread: on a phone, buffer
  sizes, priority and thermal throttling decide whether it glitches. Step 10
  plays T24 and T29 on the devices and listens. Chrome's
  `AudioContext.playoutStats` (fallback frames) might count glitches, but
  that is *unconfirmed* for Android.

### 5.2 Scheduling on the main thread

`Player` schedules 0.4 s of notes ahead of the audio clock every 50 ms.
**[measured]**: Chromium creates a note's nodes in about 28 µs (T24: 453
notes in 12.5 ms; T29: 384 in 10.7 ms). WebKit took 4 ms for T24's 453
notes, but its clock in these runs ticked in whole milliseconds. The worst
tick is the first after a seek, which schedules 0.4 s at once: at T29's
peak of 181 notes a second, 73 notes, 2.0 ms on the M1, about 4.5 ms on the
Android reference and 7 ms on the floor. A steady tick schedules about 9
notes. Both stay far below B7's 50 ms. The other way round, the page's own
long tasks delay the player's timer. With 0.4 s ahead, a task of up to 350
ms is not heard. Chapter 06 §3.4 keeps a page's insertion near 30 ms.

### 5.3 Unlocking audio on iOS, and the silent switch

Facts, from WebKit's source and bug tracker and MDN's compatibility data:

- An `AudioContext` makes sound only after a user gesture with transient
  activation: `touchend`, `pointerup` (not from a mouse), `click`,
  `keydown`, not `touchstart`
  ([WebKit `AudioContext.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp),
  [HTML's activation-triggering events](https://html.spec.whatwg.org/multipage/interaction.html#activation-triggering-input-event),
  [WebKit bug 149367](https://bugs.webkit.org/show_bug.cgi?id=149367)). A
  context created earlier starts `suspended` and can be `resume()`d in a
  later gesture. Chrome is the same
  ([autoplay policy](https://developer.chrome.com/blog/autoplay)). The
  unprefixed `AudioContext` is in Safari since 14.1, so `webkitAudioContext`
  is not needed.
- Safari plays Web Audio as `ambient` sound by default. It is **silent while
  the iPhone's ring switch is on silent**. `navigator.audioSession.type =
  'playback'` (Safari 16.4, iOS WKWebView too) makes it heard through the
  switch on iOS 17 and later
  ([WebKit bug 237322](https://bugs.webkit.org/show_bug.cgi?id=237322),
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Audio_Session_API)).
  The older trick of a looping silent `<audio>` element broke in 2023 (same
  bug).

`midi.js` already met the first point: `Player` creates and resumes its
context in `play()`, which the ▶ button's click calls synchronously, and
says `blocked` when it was refused (D24). The second is the change made with
this chapter: **the first `play()` sets `navigator.audioSession.type` to
`playback`** where it exists, before the context is made. Elsewhere nothing
changes. Without it an iPhone on silent, which is how many are carried,
plays nothing and shows no error.

### 5.4 Interruptions, background tabs and the locked screen

- **Interruptions.** Safari has an `interrupted` context state, entered
  during a phone call, Siri, when another app takes the audio, and when the
  page is hidden or the screen locks. It is now in the Web Audio
  specification, and Chrome 136 has it on desktop and Android
  ([spec](https://webaudio.github.io/web-audio-api/#dom-audiocontextstate-interrupted),
  [explainer](https://github.com/MicrosoftEdge/MSEdgeExplainers/blob/main/AudioContextInterruptedState/explainer.md)).
  The audio clock stops. Before this chapter `Player` went on ticking
  against a frozen clock, showing *playing* while nothing played. Now
  **when the context leaves `running` under a playing `Player`, it pauses**
  where the music was. The UI shows ▶, and the next ▶, a gesture, resumes.
  Two open WebKit bugs remain: after switching apps on iOS 17.5–17.6, and
  when another app plays on iOS 18, the state stays `running` while
  nothing is heard ([276016](https://bugs.webkit.org/show_bug.cgi?id=276016),
  [283419](https://bugs.webkit.org/show_bug.cgi?id=283419)). The reported
  workaround, `suspend()` then `resume()` on the next gesture whatever the
  state says, needs a device to test (step 10) and was not made.
- **Background and the locked screen, iOS.** With the default `ambient`
  session the context pauses when Safari is no longer active
  ([bug 220879](https://bugs.webkit.org/show_bug.cgi?id=220879)). With
  `playback` it keeps playing in the background and with the screen locked
  from iOS 17.5, and it becomes the "Now Playing" app, with
  `navigator.mediaSession`'s metadata and play/pause from the lock screen
  ([bug 261554](https://bugs.webkit.org/show_bug.cgi?id=261554)). Whether
  `Player`'s `setInterval` keeps firing there is *unconfirmed*. If it does
  not, the music stops 0.4 s after the screen locks, and it must be tried on
  the iPhone (step 10). If it stops, the fix is to schedule much further
  ahead while `document.hidden`. `Synth` handles a whole score at once
  (T24's 453 notes in 12.5 ms, §5.2).
- **Background, Chrome.** Hidden tabs have their timers run at most once a
  second, and after five minutes once a minute. **Audible pages are exempt,
  Web Audio included**
  ([background tabs](https://developer.chrome.com/blog/background_tabs),
  [Chrome 88](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)),
  so the 50 ms tick survives a background tab while music plays. Chrome on
  Android stops loading background tabs after five minutes, and Energy
  Saver freezes pages that are hidden *and silent*, so a playing page is
  exempt from both
  ([freezing](https://developer.chrome.com/blog/freezing-on-energy-saver)).
  Whether Web Audio goes on with Chrome itself in the background or the
  screen off on Android is *unconfirmed*, and Web Audio alone gets no media
  notification there
  ([2015](https://developer.chrome.com/blog/media-notifications/), current
  behaviour *unconfirmed*).
- **Lock-screen controls** are worth adding to the apps' players once step
  10 has confirmed background playback: `navigator.mediaSession` with the
  score's title and play/pause bound to `Player`. That is a change to the
  studio's and the preview's player wiring, not to the engine.

### 5.5 Latency

D51 shows what is heard by subtracting `outputLatency + baseLatency` from the
audio clock. `baseLatency` is in Chrome 58 and Safari 14.1; `outputLatency`
is in Chrome 102 (Android too) and Safari 18.4, per MDN's compatibility
data (*unconfirmed* in Safari's release notes). On Safari 17 and 18.0–18.3
`outputLatency` is missing, and `Player` counts it as 0, as D51 decided for
browsers that do not report it. Marks then run ahead by the output's latency.
Android documents up to 45 ms for devices with the `low_latency` feature
([Android audio latency](https://developer.android.com/ndk/guides/audio/audio-latency)).
Bluetooth adds 150–300 ms by secondary sources (*unconfirmed*). Step 10
reads both properties on the phones, wired and Bluetooth, and checks the
marks against the sound.

### 5.6 Sound fonts

A sampled sound would be nicer than oscillators. What it costs:

| Set | Download | License |
| --- | --- | --- |
| FluidR3_GM (`.sf2`) | 148 MB | MIT |
| GeneralUser GS 2.0.3 (`.sf2`) | 32.3 MB | permissive, its own (bundling allowed) |
| GeneralUser GS as `.sf3` (SpessaSynth's bundle) | 8.4 MB | as above |
| MuseScore_General (`.sf2` / `.sf3`) | 215.6 MB / 39.9 MB | MIT |
| TimGM6mb (`.sf2`) | 5.7 MiB | GPL-2 |
| One piano, WebAudioFont (GeneralUser / FluidR3) | 0.96 / 1.24 MB of JS | per source set |
| One piano, Tone.js Salamander (30 MP3s, one per minor third) | 2.0 MB | CC-BY 3.0 |
| One piano, gleitz's FluidR3 renders (88 MP3s) | 1.97 MB | CC-BY 3.0 |

Sources: [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts),
[GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS),
[TimGM6mb (Debian)](https://metadata.ftp-master.debian.org/changelogs/main/t/timgm6mb-soundfont/stable_copyright),
[MuseScore_General](https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/),
[WebAudioFont](https://github.com/surikov/webaudiofont),
[Tone.js samples](https://github.com/Tonejs/audio/tree/master/salamander),
[SpessaSynth](https://github.com/spessasus/SpessaSynth).

What it says:

- **A General MIDI set does not fit.** Even the smallest compressed full
  set is 8.4 MB, five times B1's whole core, and B2 allows 60 KB for a music
  font. A full set is out on phones.
- **Memory decides more than download.** Decoded samples are float32: one
  second of mono at 48 kHz is 192 KB, stereo 384 KB. Thirty piano samples
  of 4 s in stereo come to 46 MB of decoded audio, more than a third of
  B4's L Must for the engine (128 MB) on top of it, and iOS gives a reloaded page about 300 MB for
  everything (chapter 00 §1). A pack must be mono, trimmed and sparse:
  30 × 3 s mono is 17 MB.
- **The corpus wants almost only a piano.** The 30 scores use program 0
  (a piano) on every channel but T07's kit and T22's guitar. T29's orchestra
  only names its instruments, which needs a `midiInstrument` to be played as
  one, and M07's 10 programs are the most of the 42.

So the oscillator synthesizer stays the default (0 bytes of samples, D24).
A sampled piano may come later as an **optional pack**: loaded on a user's
choice, cached for offline use like the engine's modules (chapter 08),
within 1 MB to download (Must) and 16 MB decoded (Must; Goal 8 MB). It is
mono, one sample per minor third or major third, in a format that
`decodeAudioData` takes everywhere (MP3; AAC), with a license that allows
bundling (CC-BY with credit, MIT). It is a feature of the apps' player,
like D45's parts, and none of the engine's business. Other General MIDI
families stay synthesized.

## 6. Budgets

Proposed for step 11 to confirm; times on chapter 00's Android reference.

| What | Must | Goal | Now |
| --- | --- | --- | --- |
| B2: the MIDI part (performers and writer), brotli | 150 KB | 40 KB | writer and tables 8.2 KB (§4.2); 30–40 KB projected with the performers |
| Performance and file after an edit, off B6: T29 | 300 ms | 100 ms | LilyPond 31.7 ms on the M1, ≈ 105 ms projected |
| Performance cancelled after a newer edit (B8) | 50 ms | 20 ms | between timesteps, as chapter 04 §8 |
| C2 (notes with velocities) on the 30 and M01–M12 | 1.0 | 1.0 | not yet; the comparator is ready (§4.3) |
| C2b: files equal to LilyPond's, creator text left out | — | all 42, ties at one tick normalised | the writer: 39 of 42 as is (§4.2) |
| Main thread: one scheduling tick (part of B7) | 10 ms | 5 ms | T29 worst tick ≈ 4.5 ms projected (§5.2) |
| Audio thread at the corpus's peak polyphony, Android floor | 50 % of a core | 25 % | T29 ≈ 21 % projected from offline rendering (§5.1) |
| Sound heard with the iPhone on silent | yes | yes | `audioSession` set (§5.3); not tried on a phone |
| Optional sample pack: download, decoded | 1 MB, 16 MB | 0.5 MB, 8 MB | none; oscillators only (§5.6) |

## 7. The ordered steps

| Step | What | Checked by |
| --- | --- | --- |
| M1 | The SMF crate: the writer of §4.2 (stop queue, unisons, libc++'s heap), the chunk reader `midi_export.rs` will share | the 39 files byte for byte from their items; a merged-unison case of its own |
| M2 | Performance framework on chapter 04's translators: `Score_`, `Staff_` (tracks, names, the channel counter), `Control_track_`, `Note_`, `Tie_`, `Key_`, `Time_signature_`, `Lyric_performer`, `Beam_` and `Slur_performer` for melismata; defaults of `performer-init.ly` | C2 on the 22 scores with one velocity; C2b; C1 against `timing.ly` |
| M3 | `Dynamic_performer` with its queues, the equalizer and `midiMinimumVolume`/`midiMaximumVolume`; `midi-extra-velocity`; `midi-length` and breaths, defaults in Rust and others through chapter 03 | C2 on T18, T25, T26, T28, T29, T30, M07, M08, M11 |
| M4 | Controllers and tempo: `Midi_control_change` (14-bit pan, balance, expression, reverb, chorus), `Piano_pedal_`, `Tempo_performer`, pitch bend for microtones | M01–M04 |
| M5 | Marks, drums, channel mappings: `Mark_`, `Drum_note_performer` with `drumPitchTable`, `midiChannelMapping` `instrument` and `voice`, part combining; `Beat_performer` as Scheme | T07, M05, M06, M09, M12, and a test of its own for `Beat_performer` |
| M6 | `\unfoldRepeats` and `articulate.ly` as a library part (chapter 03 §6) | T19, M10 |
| M7 | Host: perform after the page, lazily, cancellable; the same-bytes check; `.midi` and the map posted as today; Export MIDI with the Parts fold's instruments (D54) | the extension's preview tests and the studio's playback tests on the engine's output |
| M8 | Phones, with step 10: silent switch, interruption, background and screen lock, latency, polyphony at T24 and T29 | §5's *unconfirmed* points, each tried on the iPhone and the Android reference |

M1 can be built now, independently of everything else. M2 needs chapter 04's
N5 (translators) and N7 (lyrics). M3 is the bulk of C2. M8's playback
questions do not wait for the engine: they are about `midi.js`, which plays
LilyPond's files today.

## 8. What later chapters take from here

| Chapter | Takes |
| --- | --- |
| 08 build | the MIDI part as a module loaded at idle after the first page or on the first ▶ (8.2 KB measured, 30–40 KB projected, §4.2); `no_std` with `alloc` and no panic strings, as the probe; the performance runs in the engine's worker and posts bytes to the page, which plays them; an optional sample pack cached like the modules (§5.6) |
| 09 phone timings | step 10's crate need not perform; on the phones, play LilyPond's T02, T24 and T29 through `midi.js` and record: sound with the silent switch on, after a call and after switching apps, with the screen locked and in the background (iOS and Android), `outputLatency` and `baseLatency` wired and on Bluetooth, glitches at T29's polyphony and with a 128-note tutti |
| 11 roadmap, D56 | steps M1–M8; the budgets of §6; C2 with velocities and C2b; whole re-performance after the page (§3.8); oscillators as the default sound with an optional sample pack (§5.6); M01–M12 as the MIDI supplement of the test set |

## Appendix A: recipes

The LilyPond checkout, the 30 scores and `capture.ly` are chapter 00's;
`corpus.tsv` lists `ID path` for them and `mset.tsv` for M01–M12 (paths into
`input/regression/`). Scripts run from one directory, `$S`.

**Captures** (§2.1, §4): `capture.sh <tsv> <out> [settings.ly]` is chapter
00 §5.1's command per score, with `capture.ly` or the settings file given.

```sh
./capture.sh corpus.tsv $S/ref && ./capture.sh mset.tsv $S/mref
{ cat capture.ly; echo '\midi { \context { \Score midiMaximumVolume = 0.9 } }'; } > pert.ly
./capture.sh corpus.tsv $S/pert $S/pert.ly    # §3.7, §4.3
node census.mjs ref; node census.mjs mref     # §2.1
node c2.mjs ref pert                          # §4.3: C2 without and with velocities
```

`census.mjs` walks each `MTrk` itself (status bytes, running status, meta
types, controllers, bends) and takes durations, polyphony and the peak rate
from `parseMidi`'s notes (`/^[TM]\d\d$/` directories). `c2.mjs` is chapter
00's `same` over two note keys, with and without
`Math.round(n.velocity * 127)`.

**What the performers hear** (§2.2): `perf.ly`, run as
`PERF_OUT=<out>/<id>/perf.tsv lilypond -dno-print-pages
-dinclude-settings=perf.ly`, then `node perftable.mjs <out>`, which sums
the classes into the table's columns:

```lilypond
%% Chapter 07's census: chapter 00's capture, plus a Score performer in every
%% \midi that counts the stream events the performers hear, by class, and the
%% properties that the performers read set with \set; PERF_OUT names the file.
\include "/abs/path/to/capture.ly"
#(begin
  (define perf-port (open-file (or (getenv "PERF_OUT") "perf.out") "a"))
  (define (perf-line . xs)
    (display (string-join (map (lambda (x) (if (string? x) x (format #f "~a" x))) xs) "\t") perf-port)
    (newline perf-port) (force-output perf-port))
  (define (Perf_census_performer context)
    (let ((counts (make-hash-table)))
      (define (count! k) (hash-set! counts k (1+ (hash-ref counts k 0))))
      (make-performer
       ((initialize performer)
        (ly:add-listener
         (lambda (event)
           (let ((class (car (ly:event-property event 'class))))
             (count! class)
             (when (eq? class 'SetProperty)
               (count! (string-append "set " (symbol->string (ly:event-property event 'symbol)))))
             (when (eq? class 'articulation-event)
               (count! (format #f "articulation ~a" (ly:event-property event 'articulation-type))))
             (when (eq? class 'absolute-dynamic-event)
               (count! (format #f "dynamic ~a" (ly:event-property event 'text))))))
         (ly:context-events-below context) 'StreamEvent))
       ((finalize performer)
        (hash-for-each (lambda (k v) (perf-line k v)) counts)))))
)
\midi { \context { \Score \consists #Perf_census_performer } }
```

**The writer probe** (§4.2): a crate with `crate-type = ["rlib", "cdylib"]`,
release profile `opt-level = "z"`, `lto = true`, `codegen-units = 1`,
`panic = "abort"`, `strip = true`. `src/tables.rs` is generated from
`scm/midi.scm` and `ly/midi-init.ly`. `src/wasm.rs` adds a bump allocator, a
panic handler and the export `lily_midi_write(input, len, out) -> len` over
a little-endian item list. `src/bin/roundtrip.rs` reads each file back into
items (a note-on paired with the next velocity-0 note-on of its channel and
key; every other event but the end of track kept with its tick), writes it
again, compares, and saves the item list for `wasm.mjs`, which does the
same through the wasm build.

```sh
cargo build --release && ./target/release/roundtrip ../ref/*/*.midi ../mref/*/*.midi
cargo build --release --target wasm32-unknown-unknown --lib
brotli -q 11 -c target/wasm32-unknown-unknown/release/midi_probe.wasm | wc -c
node wasm.mjs ../ref/*/*.midi ../mref/*/*.midi
```

The part of `src/lib.rs` that decides the bytes:

```rust
fn walk(staff: &Staff, out: &mut Vec<u8>) {
    // A stable sort by time, as Midi_walker's std::stable_sort.
    let mut order: Vec<usize> = (0..staff.items.len()).collect();
    order.sort_by_key(|&i| staff.items[i].tick());
    let mut w = Walker { out, last: 0, queue: Vec::new() };
    for &i in &order {
        let item = &staff.items[i];
        w.stop_notes(item.tick(), &staff.items);
        match *item {
            Item::Note { len: 0, .. } => {}
            Item::Note { tick, len, key, .. } => w.start_note(i, tick, tick + len, key, &staff.items),
            Item::Raw { tick, bytes } => w.event(tick, bytes),
        }
    }
    w.stop_notes(u32::MAX, &staff.items);
    let end = staff.end.max(w.last);
    w.event(end, b"\xff\x2f\x00");
}

impl Walker<'_> {
    fn start_note(&mut self, index: usize, now: u32, mut stop: u32, key: u8, items: &[Item]) {
        // One key sounds once per track: a new note ends the one that sounds,
        // or, begun together with it, is merged into it (midiMergeUnisons off).
        for i in 0..self.queue.len() {
            let queued = self.queue[i];
            let Item::Note { tick, key: k, .. } = items[queued.note] else { continue };
            if queued.ignore || k != key {
                continue;
            }
            if tick == now {
                if queued.tick < stop {
                    self.queue[i].ignore = true;
                    heap::push(&mut self.queue, Off { tick: stop, note: queued.note, ignore: false });
                }
                return;
            }
            stop = stop.max(queued.tick);
            self.note(now, &items[queued.note], false);
            self.queue[i].ignore = true;
            break;
        }
        heap::push(&mut self.queue, Off { tick: stop, note: index, ignore: false });
        self.note(now, &items[index], true);
    }

    fn stop_notes(&mut self, until: u32, items: &[Item]) {
        while let Some(first) = self.queue.first().copied() {
            if first.tick > until {
                break;
            }
            heap::pop(&mut self.queue);
            if !first.ignore {
                self.note(first.tick, &items[first.note], false);
            }
        }
    }
}
```

`heap::push` is libc++'s `__sift_up` and `heap::pop` its Floyd pop
(`__floyd_sift_down`, then `__sift_up` of the moved last element), both with
`greater` on the tick, as `flower/include/pqueue.hh` calls them. A `classic`
feature swaps in the pre-LLVM-16 sift-down pop.

**The synthesizer** (§5.1): `render.mjs` loads `midi.js` into a blank page
of Playwright's Chromium and WebKit and, for each file, schedules every note
with `new Synth(ctx).play(note, note.time)` on an
`OfflineAudioContext(2, ⌈(duration + 1) × 48000⌉, 48000)`, times the
scheduling and `startRendering()`, and takes the peak sample. The tutti
plays *n* notes of 10 s from time 0, keys `36 + (7i mod 60)`, velocity 0.7,
program 0 or 48.

**The player's session and pause** (§5.3, §5.4): `session.mjs` opens a page
with a button whose click calls `Player.play()` on T02's file in each
engine, waits 1.5 s, then `await player.context.suspend()`, and reads the
player's state, the context's state, `navigator.audioSession?.type` and the
position: Chromium `playing`/`running`/none, then `paused` at 1.444 s;
WebKit `playing`/`running`/`playback`, then `paused` at 1.444 s.
