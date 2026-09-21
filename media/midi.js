// MIDI playback for the webviews (DECISIONS D24): a Standard MIDI File parser, a
// small Web Audio synthesizer and the player that schedules one on the other.
// Plain JS, no build step and no dependency (D12). Loaded before preview.js and
// player.js, which find it as `LilyMidi`; test/midi/midi.test.ts loads the same
// file through the CommonJS export, where no AudioContext exists.
;(function () {
  'use strict'

  // ---- Standard MIDI File → notes ----------------------------------------------

  const DEFAULT_TEMPO = 500000 // microseconds per quarter note: 120 bpm
  const DRUMS = 9 // channel 10
  const BEND_RANGE = 200 // cents either way, which is what lilypond's microtones assume

  function fail(message) {
    throw new Error(`Not a playable MIDI file: ${message}.`)
  }

  function text(bytes) {
    return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '').trim()
  }

  /** The events of one MTrk chunk with absolute `tick`s. Sysex is skipped. */
  function readTrack(bytes, start, end) {
    const events = []
    let at = start
    let tick = 0
    let running = 0
    const byte = () => (at < end ? bytes[at++] : fail('a track ends inside an event'))
    const variable = () => {
      let value = 0
      for (let i = 0; i < 4; i++) {
        const next = byte()
        value = value * 128 + (next & 0x7f)
        if (next < 0x80) return value
      }
      return fail('a variable-length number is too long')
    }
    while (at < end) {
      tick += variable()
      let status = byte()
      if (status < 0x80) {
        // Running status: this byte is already data.
        if (running === 0) fail('data without a status byte')
        status = running
        at--
      }
      if (status === 0xff) {
        const type = byte()
        const length = variable()
        if (at + length > end) fail('a meta event runs past its track')
        events.push({ tick, meta: type, data: bytes.subarray(at, at + length) })
        at += length
      } else if (status === 0xf0 || status === 0xf7) {
        at += variable()
      } else {
        running = status
        const kind = status & 0xf0
        const a = byte()
        const b = kind === 0xc0 || kind === 0xd0 ? 0 : byte()
        events.push({ tick, kind, channel: status & 0x0f, a, b })
      }
    }
    return events
  }

  /** Tempo changes as `{ tick, seconds, tempo }`, so ticks convert without a walk from zero. */
  function tempoMap(events, division) {
    const map = [{ tick: 0, seconds: 0, tempo: DEFAULT_TEMPO }]
    for (const event of events) {
      if (event.meta !== 0x51 || event.data.length < 3) continue
      const tempo = (event.data[0] << 16) | (event.data[1] << 8) | event.data[2]
      const last = map[map.length - 1]
      const seconds = last.seconds + ((event.tick - last.tick) * last.tempo) / division / 1e6
      if (event.tick === last.tick) map[map.length - 1] = { ...last, tempo }
      else map.push({ tick: event.tick, seconds, tempo })
    }
    return map
  }

  function secondsAt(map, division, tick) {
    let entry = map[0]
    for (const candidate of map) {
      if (candidate.tick > tick) break
      entry = candidate
    }
    return entry.seconds + ((tick - entry.tick) * entry.tempo) / division / 1e6
  }

  /**
   * Parses `bytes` (a Uint8Array) into what the player needs: `notes` sorted by
   * `time`, each carrying the state of its channel when it began — program,
   * `gain` (volume × expression), `pan` (-1…1), `detune` (cents). Controllers
   * are resolved here, so a change during a note is not heard; the sustain
   * pedal lengthens the notes it holds. Throws on anything that is not a
   * Standard MIDI File with a metrical time division.
   */
  function parseMidi(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4))
    if (bytes.length < 14 || tag(0) !== 'MThd') fail('the MThd header is missing')
    const format = view.getUint16(8)
    const division = view.getUint16(12)
    if (format > 1) fail(`format ${format} is not supported`)
    if (division === 0 || division & 0x8000) fail('SMPTE time division is not supported')

    const chunks = []
    for (let at = 8 + view.getUint32(4); at + 8 <= bytes.length; ) {
      const length = view.getUint32(at + 4)
      const end = Math.min(at + 8 + length, bytes.length)
      // Unknown chunk types are to be skipped, says the standard.
      if (tag(at) === 'MTrk') chunks.push(readTrack(bytes, at + 8, end))
      at = end
    }
    if (chunks.length === 0) fail('it has no tracks')

    // Format 1 keeps the tempo in the first track, and it applies to all of them.
    const tempos = chunks.flat().filter((event) => event.meta === 0x51)
    const map = tempoMap(
      tempos.sort((a, b) => a.tick - b.tick),
      division,
    )
    const seconds = (tick) => secondsAt(map, division, tick)

    // One pass over all tracks in time order: a channel is set up wherever the
    // file likes, and what it then plays may be in another track.
    const events = chunks.flatMap((chunk, track) => chunk.map((event) => ({ ...event, track })))
    events.sort((a, b) => a.tick - b.tick)
    const lastTick = events.length > 0 ? events[events.length - 1].tick : 0

    const notes = []
    const tracks = chunks.map(() => ({ name: '', channels: [], programs: [], notes: 0 }))
    const channels = Array.from({ length: 16 }, () => ({
      program: 0, volume: 100 / 127, expression: 1, pan: 0, detune: 0,
      pedal: false, sounding: new Map(), held: [],
    }))
    const release = (note, tick) => {
      note.duration = Math.max(seconds(tick) - note.time, 0)
    }
    for (const event of events) {
      const track = tracks[event.track]
      if (event.meta === 0x03 && !track.name) track.name = text(event.data)
      if (event.meta !== undefined) continue
      const state = channels[event.channel]
      const on = event.kind === 0x90 && event.b > 0
      if (on || event.kind === 0x80 || event.kind === 0x90) {
        // Two staves that share a channel may hold the same key.
        const id = event.track * 128 + event.a
        const previous = state.sounding.get(id)
        if (previous) {
          state.sounding.delete(id)
          if (state.pedal && !on) state.held.push(previous)
          else release(previous, event.tick)
        }
        if (!on) continue
        const note = {
          time: seconds(event.tick),
          duration: 0,
          track: event.track,
          channel: event.channel,
          key: event.a,
          velocity: event.b / 127,
          program: state.program,
          gain: state.volume * state.expression,
          pan: state.pan,
          detune: state.detune,
        }
        state.sounding.set(id, note)
        notes.push(note)
        track.notes++
        if (!track.channels.includes(event.channel)) track.channels.push(event.channel)
        if (event.channel !== DRUMS && !track.programs.includes(state.program)) {
          track.programs.push(state.program)
        }
      } else if (event.kind === 0xc0) {
        state.program = event.a
      } else if (event.kind === 0xe0) {
        state.detune = ((((event.b << 7) | event.a) - 8192) / 8192) * BEND_RANGE
      } else if (event.kind === 0xb0) {
        if (event.a === 7) state.volume = event.b / 127
        else if (event.a === 11) state.expression = event.b / 127
        else if (event.a === 10) state.pan = Math.max(-1, (event.b - 64) / 63)
        else if (event.a === 64) {
          state.pedal = event.b >= 64
          if (!state.pedal) for (const note of state.held.splice(0)) release(note, event.tick)
        }
      }
    }
    // What the file never switched off lasts to the end.
    for (const state of channels) {
      for (const note of [...state.sounding.values(), ...state.held]) release(note, lastTick)
    }
    // lilypond names the first track after the \header's title, if there is one.
    const title = tracks[0].name === 'control track' ? '' : tracks[0].name

    notes.sort((a, b) => a.time - b.time)
    const lastNote = notes.reduce((end, note) => Math.max(end, note.time + note.duration), 0)
    return {
      format,
      division,
      title,
      tracks,
      notes,
      /** Seconds to the end of the last track, which lilypond puts at the final bar line. */
      duration: Math.max(seconds(lastTick), lastNote),
    }
  }

  // ---- General MIDI --------------------------------------------------------------

  // The names lilypond accepts for `midiInstrument`, in program order.
  const INSTRUMENTS = (
    'acoustic grand,bright acoustic,electric grand,honky-tonk,electric piano 1,electric piano 2,' +
    'harpsichord,clav,celesta,glockenspiel,music box,vibraphone,marimba,xylophone,tubular bells,' +
    'dulcimer,drawbar organ,percussive organ,rock organ,church organ,reed organ,accordion,harmonica,' +
    'concertina,acoustic guitar (nylon),acoustic guitar (steel),electric guitar (jazz),' +
    'electric guitar (clean),electric guitar (muted),overdriven guitar,distorted guitar,' +
    'guitar harmonics,acoustic bass,electric bass (finger),electric bass (pick),fretless bass,' +
    'slap bass 1,slap bass 2,synth bass 1,synth bass 2,violin,viola,cello,contrabass,' +
    'tremolo strings,pizzicato strings,orchestral harp,timpani,string ensemble 1,string ensemble 2,' +
    'synthstrings 1,synthstrings 2,choir aahs,voice oohs,synth voice,orchestra hit,trumpet,trombone,' +
    'tuba,muted trumpet,french horn,brass section,synthbrass 1,synthbrass 2,soprano sax,alto sax,' +
    'tenor sax,baritone sax,oboe,english horn,bassoon,clarinet,piccolo,flute,recorder,pan flute,' +
    'blown bottle,shakuhachi,whistle,ocarina,lead 1 (square),lead 2 (sawtooth),lead 3 (calliope),' +
    'lead 4 (chiff),lead 5 (charang),lead 6 (voice),lead 7 (fifths),lead 8 (bass+lead),' +
    'pad 1 (new age),pad 2 (warm),pad 3 (polysynth),pad 4 (choir),pad 5 (bowed),pad 6 (metallic),' +
    'pad 7 (halo),pad 8 (sweep),fx 1 (rain),fx 2 (soundtrack),fx 3 (crystal),fx 4 (atmosphere),' +
    'fx 5 (brightness),fx 6 (goblins),fx 7 (echoes),fx 8 (sci-fi),sitar,banjo,shamisen,koto,kalimba,' +
    'bagpipe,fiddle,shanai,tinkle bell,agogo,steel drums,woodblock,taiko drum,melodic tom,synth drum,' +
    'reverse cymbal,guitar fret noise,breath noise,seashore,bird tweet,telephone ring,helicopter,' +
    'applause,gunshot'
  ).split(',')

  function instrumentName(program) {
    return INSTRUMENTS[program] ?? `program ${program}`
  }

  /** What a track plays, for the player's list. */
  function trackInstruments(track) {
    const names = track.programs.map(instrumentName)
    if (track.channels.includes(DRUMS)) names.push('drums')
    return names.join(', ')
  }

  // ---- voices ----------------------------------------------------------------------

  // A timbre is a list of harmonic amplitudes and an envelope. `decay` makes a
  // struck or plucked sound, dying away at that rate (seconds to a tenth, for
  // middle C; higher notes die sooner); without it the note is held at `sustain`.
  const VOICES = {
    piano: { harmonics: [1, 0.55, 0.3, 0.16, 0.1, 0.05, 0.03], attack: 0.004, decay: 1.6, release: 0.18, bright: 7 },
    mallet: { harmonics: [1, 0, 0, 0.45, 0, 0, 0, 0, 0, 0.18], attack: 0.002, decay: 0.7, release: 0.3, bright: 12 },
    organ: { harmonics: [1, 0.7, 0.5, 0.35, 0, 0.2, 0, 0.15], attack: 0.012, sustain: 0.8, release: 0.06 },
    pluck: { harmonics: [1, 0.6, 0.4, 0.25, 0.18, 0.1, 0.07, 0.04], attack: 0.003, decay: 1.0, release: 0.12, bright: 6 },
    bass: { harmonics: [1, 0.6, 0.25, 0.12, 0.05], attack: 0.006, decay: 1.4, release: 0.1, bright: 5 },
    strings: { harmonics: [1, 0.55, 0.38, 0.27, 0.2, 0.14, 0.1, 0.07, 0.05], attack: 0.07, sustain: 0.85, release: 0.22 },
    voice: { harmonics: [1, 0.4, 0.22, 0.3, 0.1, 0.04], attack: 0.08, sustain: 0.85, release: 0.25 },
    brass: { harmonics: [1, 0.8, 0.65, 0.5, 0.38, 0.26, 0.17, 0.1, 0.06], attack: 0.035, sustain: 0.8, release: 0.12 },
    reed: { harmonics: [1, 0.12, 0.6, 0.08, 0.35, 0.05, 0.18, 0.03, 0.08], attack: 0.025, sustain: 0.85, release: 0.1 },
    flute: { harmonics: [1, 0.3, 0.08, 0.04], attack: 0.045, sustain: 0.9, release: 0.12 },
    lead: { harmonics: [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12, 0.11, 0.1], attack: 0.01, sustain: 0.75, release: 0.1 },
    pad: { harmonics: [1, 0.35, 0.2, 0.1, 0.05], attack: 0.25, sustain: 0.85, release: 0.6 },
  }

  /** The timbre of a General MIDI program: its family decides, with a few exceptions. */
  function voiceOf(program) {
    if (program === 45 || program === 46) return 'pluck' // pizzicato strings, harp
    if (program === 47) return 'bass' // timpani
    if (program === 55) return 'piano' // orchestra hit
    if (program >= 72 && program <= 79) return 'flute'
    return (
      ['piano', 'mallet', 'organ', 'pluck', 'bass', 'strings', 'voice', 'brass', 'reed', 'flute',
        'lead', 'pad', 'pad', 'pluck', 'mallet', 'pad'][program >> 3] ?? 'piano'
    )
  }

  // Channel 10: `tone` is a sine that drops from `from` to `to` Hz, `noise` a
  // filtered burst. Both die away within `length` seconds.
  const DRUM_SOUNDS = {
    kick: { tone: { from: 150, to: 45 }, length: 0.28, level: 1 },
    snare: { tone: { from: 220, to: 160 }, noise: { type: 'bandpass', frequency: 2200 }, length: 0.2, level: 0.8 },
    tom: { tone: { from: 1, to: 0.6 }, length: 0.32, level: 0.85 },
    hat: { noise: { type: 'highpass', frequency: 7500 }, length: 0.05, level: 0.4 },
    openHat: { noise: { type: 'highpass', frequency: 7000 }, length: 0.35, level: 0.4 },
    cymbal: { noise: { type: 'highpass', frequency: 5000 }, length: 1.2, level: 0.45 },
    click: { noise: { type: 'bandpass', frequency: 3500 }, length: 0.04, level: 0.5 },
  }
  const TOMS = { 41: 80, 43: 100, 45: 125, 47: 150, 48: 180, 50: 215 }

  /** The sound of a General MIDI percussion key, and the pitch of a tom. */
  function drumOf(key) {
    if (key === 35 || key === 36) return { sound: 'kick' }
    if (key === 38 || key === 40) return { sound: 'snare' }
    if (key in TOMS) return { sound: 'tom', pitch: TOMS[key] }
    if (key === 42 || key === 44) return { sound: 'hat' }
    if (key === 46) return { sound: 'openHat' }
    if ([49, 51, 52, 53, 55, 57, 59].includes(key)) return { sound: 'cymbal' }
    return { sound: 'click' }
  }

  function frequencyOf(key, detune = 0) {
    return 440 * 2 ** ((key - 69 + detune / 100) / 12)
  }

  // ---- synthesizer -------------------------------------------------------------------

  const NOTE_LEVEL = 0.35 // one note at full velocity, before the compressor
  const SILENCE = 0.0001 // what an exponential ramp can end on

  /**
   * Plays notes on a BaseAudioContext, an OfflineAudioContext included. Every
   * note is its own oscillator → (filter) → envelope, into a bus per channel
   * that pans, into one compressor so that a full chord does not clip.
   */
  class Synth {
    constructor(context) {
      this.context = context
      this.waves = new Map()
      this.buses = new Map()
      this.output = context.createGain()
      const compressor = context.createDynamicsCompressor()
      // Set as a limiter: a tutti chord is twenty notes at once.
      compressor.threshold.value = -24
      compressor.knee.value = 12
      compressor.ratio.value = 20
      compressor.attack.value = 0.002
      compressor.release.value = 0.2
      this.master = context.createGain()
      this.output.connect(compressor).connect(this.master).connect(context.destination)
      this.open()
    }

    set volume(value) {
      this.master.gain.value = value
    }

    /** Schedules `note` to begin at context time `when`, `skipped` seconds into it. */
    play(note, when, skipped = 0) {
      const remaining = note.duration - skipped
      if (note.channel === DRUMS) {
        if (skipped === 0) this.drum(note, when)
        return
      }
      const voice = VOICES[voiceOf(note.program)]
      // A struck note that is mostly over is not worth starting in the middle.
      if (remaining <= 0 || (voice.decay && skipped > 0.05)) return

      const { context } = this
      const frequency = frequencyOf(note.key, note.detune)
      const peak = NOTE_LEVEL * note.velocity ** 1.5 * note.gain
      // The release takes over from whatever the envelope is doing, so it must
      // begin after the attack: a grace note would otherwise never sound.
      const off = when + Math.max(remaining, voice.attack + 0.01)
      const end = off + voice.release

      const oscillator = context.createOscillator()
      oscillator.setPeriodicWave(this.wave(voice))
      oscillator.frequency.value = frequency

      const envelope = context.createGain()
      const level = envelope.gain
      level.setValueAtTime(0, when)
      level.linearRampToValueAtTime(peak, when + voice.attack)
      if (voice.decay) {
        // High strings ring shorter than low ones.
        const decay = voice.decay * 2 ** ((60 - note.key) / 24)
        level.setTargetAtTime(peak * 0.02, when + voice.attack, decay / 2.3)
      } else {
        level.setTargetAtTime(peak * voice.sustain, when + voice.attack, 0.08)
      }
      level.setTargetAtTime(0, off, voice.release / 4)

      let source = oscillator
      if (voice.bright) {
        // The upper partials of a struck string go first.
        const filter = context.createBiquadFilter()
        filter.type = 'lowpass'
        filter.Q.value = 0.5
        const open = Math.min(frequency * voice.bright * (0.5 + note.velocity), 16000)
        filter.frequency.setValueAtTime(open, when)
        filter.frequency.setTargetAtTime(Math.min(frequency * 2, open), when, 0.35)
        source = oscillator.connect(filter)
      }
      source.connect(envelope).connect(this.bus(note, when))
      oscillator.start(when)
      oscillator.stop(end)
      oscillator.onended = () => envelope.disconnect()
    }

    /** Silences everything scheduled and sounding; later notes go to a new output. */
    stop() {
      const { generation, context } = this
      generation.gain.setTargetAtTime(0, context.currentTime, 0.01)
      // After the fade. A closed or offline context simply never gets here.
      setTimeout(() => generation.disconnect(), 100)
      this.open()
    }

    open() {
      this.generation = this.context.createGain()
      this.generation.connect(this.output)
      this.buses.clear()
    }

    bus(note, when) {
      let bus = this.buses.get(note.channel)
      if (!bus) {
        bus = { node: this.context.createStereoPanner(), pan: undefined }
        bus.node.connect(this.generation)
        this.buses.set(note.channel, bus)
      }
      if (bus.pan !== note.pan) {
        bus.node.pan.setValueAtTime(note.pan, when)
        bus.pan = note.pan
      }
      return bus.node
    }

    wave(voice) {
      if (!this.waves.has(voice)) {
        const imag = new Float32Array([0, ...voice.harmonics])
        this.waves.set(voice, this.context.createPeriodicWave(new Float32Array(imag.length), imag))
      }
      return this.waves.get(voice)
    }

    drum(note, when) {
      const { context } = this
      const { sound, pitch = 1 } = drumOf(note.key)
      const { tone, noise, length, level } = DRUM_SOUNDS[sound]
      const envelope = context.createGain()
      envelope.gain.setValueAtTime(NOTE_LEVEL * 1.6 * level * note.velocity ** 1.5 * note.gain, when)
      envelope.gain.exponentialRampToValueAtTime(SILENCE, when + length)
      envelope.connect(this.bus(note, when))
      const sources = []
      if (tone) {
        const oscillator = context.createOscillator()
        oscillator.frequency.setValueAtTime(tone.from * pitch, when)
        oscillator.frequency.exponentialRampToValueAtTime(tone.to * pitch, when + length)
        oscillator.connect(envelope)
        sources.push(oscillator)
      }
      if (noise) {
        const burst = context.createBufferSource()
        burst.buffer = this.noise()
        burst.loop = true
        const filter = context.createBiquadFilter()
        filter.type = noise.type
        filter.frequency.value = noise.frequency
        burst.connect(filter).connect(envelope)
        sources.push(burst)
      }
      for (const source of sources) {
        source.start(when)
        source.stop(when + length)
      }
      sources[0].onended = () => envelope.disconnect()
    }

    noise() {
      if (!this.noiseBuffer) {
        const { sampleRate } = this.context
        this.noiseBuffer = this.context.createBuffer(1, sampleRate / 2, sampleRate)
        const samples = this.noiseBuffer.getChannelData(0)
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1
      }
      return this.noiseBuffer
    }
  }

  // ---- player -------------------------------------------------------------------------

  const LOOKAHEAD = 0.4 // seconds of notes handed to the audio clock in advance
  const TICK_MS = 50
  const LEAD_IN = 0.06 // between "play" and the first sample, so that beat one is not clipped

  /** Index of the first note that begins at or after `time`. */
  function firstNoteFrom(notes, time) {
    let low = 0
    let high = notes.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (notes[middle].time < time) low = middle + 1
      else high = middle
    }
    return low
  }

  /** `m:ss`, the way a player shows a position. */
  function formatTime(seconds) {
    const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
  }

  /**
   * Plays one parsed file. `state` is 'stopped' (at the start), 'playing' or
   * 'paused'; `onChange` hears of every change of state and, while playing, of
   * the position about ten times a second. The AudioContext is created on the
   * first play(), which a webview only allows once the user has clicked in it:
   * play() resolves with false, and changes nothing, when it was not allowed.
   */
  class Player {
    constructor(options = {}) {
      this.createContext = options.createContext ?? (() => new AudioContext())
      this.onChange = options.onChange ?? (() => {})
      this.midi = undefined
      this.state = 'stopped'
      this.offset = 0 // position of the music at `startedAt`, or while not playing
      this.startedAt = 0
      this.next = 0
      this.timer = undefined
      this.ticks = 0
    }

    get duration() {
      return this.midi?.duration ?? 0
    }

    get position() {
      if (this.state !== 'playing') return this.offset
      const elapsed = Math.max(this.context.currentTime - this.startedAt, 0)
      return Math.min(this.offset + elapsed, this.duration)
    }

    /** Whether the last play() was refused: no sound before a click, says the browser. */
    get suspended() {
      return this.context !== undefined && this.context.state !== 'running'
    }

    /** Replaces the music, stopping what plays; undefined unloads. */
    load(midi) {
      this.halt()
      this.midi = midi
      this.offset = 0
      this.state = 'stopped'
      this.onChange()
    }

    async play() {
      if (!this.midi || this.state === 'playing') return this.state === 'playing'
      this.context ??= this.createContext()
      this.synth ??= new Synth(this.context)
      const attempt = (this.attempt = (this.attempt ?? 0) + 1)
      if (this.context.state !== 'running') {
        // Never settles while a gesture is awaited, so do not wait for longer.
        await Promise.race([
          this.context.resume().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 300)),
        ])
      }
      // Stopped, reloaded or started again while waiting.
      if (attempt !== this.attempt || !this.midi || this.state === 'playing') {
        return this.state === 'playing'
      }
      if (this.context.state !== 'running') return false

      if (this.offset >= this.duration) this.offset = 0
      this.state = 'playing'
      this.startedAt = this.context.currentTime + LEAD_IN
      this.next = firstNoteFrom(this.midi.notes, this.offset)
      // Held notes that a seek landed in.
      for (let i = 0; i < this.next; i++) {
        const note = this.midi.notes[i]
        if (note.time + note.duration > this.offset) {
          this.synth.play(note, this.startedAt, this.offset - note.time)
        }
      }
      this.timer = setInterval(() => this.tick(), TICK_MS)
      this.tick()
      this.onChange()
      return true
    }

    pause() {
      if (this.state !== 'playing') return
      this.offset = this.position
      this.halt()
      this.state = 'paused'
      this.onChange()
    }

    /** Back to the start. */
    stop() {
      this.halt()
      this.offset = 0
      this.state = 'stopped'
      this.onChange()
    }

    /** Moves to `seconds`; what was playing goes on from there. */
    async seek(seconds) {
      const playing = this.state === 'playing'
      this.halt()
      this.offset = Math.min(Math.max(Number(seconds) || 0, 0), this.duration)
      this.state = this.offset === 0 && !playing ? 'stopped' : 'paused'
      if (playing) await this.play()
      else this.onChange()
    }

    /** Frees the audio device; the player cannot be used afterwards. */
    dispose() {
      this.halt()
      this.midi = undefined
      void this.context?.close().catch(() => {})
    }

    halt() {
      this.attempt = (this.attempt ?? 0) + 1
      clearInterval(this.timer)
      this.timer = undefined
      if (this.state === 'playing') this.synth.stop()
    }

    tick() {
      const { notes } = this.midi
      const position = this.position
      if (position >= this.duration) {
        this.stop()
        return
      }
      const horizon = position + LOOKAHEAD
      while (this.next < notes.length && notes[this.next].time < horizon) {
        const note = notes[this.next++]
        this.synth.play(note, this.startedAt + note.time - this.offset)
      }
      if (++this.ticks % 2 === 0) this.onChange()
    }
  }

  const api = {
    parseMidi, instrumentName, trackInstruments, voiceOf, drumOf, frequencyOf,
    firstNoteFrom, formatTime, Synth, Player,
  }
  if (typeof module === 'object') module.exports = api
  else globalThis.LilyMidi = api
})()
