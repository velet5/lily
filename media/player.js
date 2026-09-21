// MIDI viewer webview script (DECISIONS D24). Plain JS, no build step (D12); the
// message types are PlayerHostMessage / PlayerWebviewMessage in
// src/midi/player.ts. media/midi.js is loaded before it and makes the sound.
;(function () {
  'use strict'

  const { parseMidi, trackInstruments, formatTime, Player } = LilyMidi

  const vscode = acquireVsCodeApi()
  const titleEl = document.getElementById('title')
  const summaryEl = document.getElementById('summary')
  const noteEl = document.getElementById('note')
  const tracksEl = document.getElementById('tracks')
  const playButton = document.getElementById('midi-play')
  const stopButton = document.getElementById('midi-stop')
  const seekEl = document.getElementById('midi-seek')
  const timeEl = document.getElementById('midi-time')

  const CLICK_TO_PLAY =
    'Click ▶︎ to play: VS Code lets a page make sound only after a click in it.'
  const SEEK_STEPS = Number(seekEl.max)

  /** The base64 that is loaded: a file rewritten with the same music plays on. */
  let loaded = null
  let problem = ''
  /** The host asked for sound before the user had clicked here. */
  let blocked = false
  /** While the slider is dragged it shows where the drag is, not where the music is. */
  let seeking = false
  let reported = ''

  const player = new Player({ onChange: showPlayback })

  function times(position) {
    return `${formatTime(position)} / ${formatTime(player.duration)}`
  }

  function showPlayback() {
    const { state, position, duration } = player
    const playing = state === 'playing'
    const ready = player.midi !== undefined
    playButton.disabled = stopButton.disabled = seekEl.disabled = !ready
    playButton.textContent = playing ? '❚❚' : '▶︎'
    playButton.title = playing ? 'Pause (Space)' : 'Play (Space)'
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play')
    timeEl.textContent = ready ? times(position) : ''
    if (!seeking) seekEl.value = String(duration > 0 ? Math.round((position / duration) * SEEK_STEPS) : 0)
    const note = problem || (blocked ? CLICK_TO_PLAY : '')
    noteEl.hidden = !note
    noteEl.textContent = note
    noteEl.classList.toggle('error', problem !== '')

    // The host hears of states, not of every tenth of a second.
    const report = { type: 'playback', state, duration, blocked }
    if (JSON.stringify(report) === reported) return
    reported = JSON.stringify(report)
    vscode.postMessage({ ...report, position })
  }

  /** `gesture`: the user clicked or typed here, which is what allows sound at all. */
  async function play(gesture) {
    if (!player.midi) return
    const started = await player.play()
    blocked = !started && !gesture && player.suspended
    showPlayback()
  }

  function togglePlayback(gesture) {
    if (player.state === 'playing') player.pause()
    else void play(gesture)
  }

  /** Everything here comes from the file, so it is only ever set as text. */
  function showTracks(midi) {
    const rows = midi.tracks
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => track.notes > 0)
      .map(({ track, index }) => {
        const row = document.createElement('tr')
        // lilypond writes `instrument:voice`, and mostly there is no instrument name.
        const name = track.name.replace(/^:|:$/g, '') || `Track ${index + 1}`
        for (const value of [name, trackInstruments(track), track.notes]) {
          row.insertCell().textContent = String(value)
        }
        return row
      })
    tracksEl.tBodies[0].replaceChildren(...rows)
    tracksEl.hidden = rows.length === 0
  }

  function load(message) {
    const data = message.type === 'midi' ? message.data : null
    if (data !== null && data === loaded) return
    loaded = data
    problem = message.type === 'error' ? message.message : ''
    let midi
    try {
      if (data) midi = parseMidi(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)))
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    titleEl.textContent = midi?.title || message.name
    summaryEl.textContent = midi
      ? [midi.title ? message.name : '', formatTime(midi.duration), `${midi.notes.length} notes`]
          .filter(Boolean)
          .join(' · ')
      : ''
    showTracks(midi ?? { tracks: [] })
    player.load(midi)
  }

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'midi' || data.type === 'error') load(data)
    else if (data.type === 'playback') {
      if (data.action === 'stop') player.stop()
      else if (data.action === 'play') void play(false)
      else togglePlayback(false)
    }
  })

  playButton.addEventListener('click', () => togglePlayback(true))
  stopButton.addEventListener('click', () => player.stop())
  seekEl.addEventListener('input', () => {
    seeking = true
    timeEl.textContent = times((seekEl.value / SEEK_STEPS) * player.duration)
  })
  seekEl.addEventListener('change', () => {
    seeking = false
    void player.seek((seekEl.value / SEEK_STEPS) * player.duration)
  })

  window.addEventListener('keydown', (event) => {
    // On a button, Space presses that button.
    if (event.key !== ' ' || event.repeat || event.target instanceof HTMLButtonElement) return
    event.preventDefault()
    togglePlayback(true)
  })

  showPlayback()
  vscode.postMessage({ type: 'ready' })
})()
