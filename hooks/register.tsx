/* @jsx h */
import type { Register } from 'claude-code'
import { DEFAULTS, applyCommand, readConfig, type Config } from './breath/config.ts'
import { cycleMs, cyclesDone, exerciseOf, pickExercise, type ExerciseKey } from './breath/exercises.ts'
import { pickStyle, type Style } from './breath/shapes.ts'

// The hooks module. While a turn runs it mounts ./breathe.tsx above the prompt (the band's
// `isWorking` prop is the trigger, so the band appears when Claude starts and goes when Claude
// stops) and reads the breath's phase into the spinner line. /breathe changes the settings,
// kept in $.store.

const BAND_ROWS = 9 // seven rows of picture, the phase line, the exercise name

let config: Config = DEFAULTS
// the running turn: when it started and which style and exercise it drew
let turn: { startedAt: number; style: Style; exercise: ExerciseKey } | undefined
let lastStyle: Style | undefined
let lastExercise: ExerciseKey | undefined
// the breath the band last posted, for the spinner
let phase: { word: string; exercise: string } | undefined

const log = ($: { ui: { log: (text: string) => void } }, what: string) => (err: unknown) => $.ui.log(`mindful-claude: ${what}: ${err}`)

// how far into the breath a turn is: the breath starts when the delay ends, on an inhale
const breathMs = (t: NonNullable<typeof turn>, now: number) => now - t.startedAt - config.delay * 1000
const finished = (t: NonNullable<typeof turn>, now: number) => cyclesDone(exerciseOf(t.exercise), breathMs(t, now), config.cycles)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const saved = await $.store.get('config').catch(log($, 'store read failed'))
    config = readConfig(saved)
    await $.command.register({
      name: 'breathe',
      description: 'Breathing exercises above the prompt while Claude works: on, off, hrv, sigh, box, 478, style, delay (mindful-claude)',
      argumentHint: '[on | off | hrv | sigh | box | 478 | style <name> | delay <s> | help]',
      immediate: true,
    }).catch(log($, '/breathe not registered'))
    return r
  })

  on('command.run', { command: 'breathe' }, async ($, e) => {
    const applied = applyCommand(config, e.args)
    if (applied.config !== config) {
      // a new exercise mid-turn shows at once, as before the per-turn pick
      if (turn && applied.config.exercise !== config.exercise) turn.exercise = pickExercise(applied.config.exercise, turn.exercise)
      config = applied.config
      await $.store.set('config', config).catch(log($, 'store write failed'))
      $.ui.invalidate('ui.render')
    }
    return { text: applied.text }
  })

  on('turn.start', async ($, e, next) => {
    const style = pickStyle(config.style, lastStyle)
    const exercise = pickExercise(config.exercise, lastExercise)
    lastStyle = style
    lastExercise = exercise
    turn = { startedAt: await $.clock.now(), style, exercise }
    phase = undefined
    // the band is drawn from a delay on: wake the render hook when it has passed
    if (config.delay > 0) $.clock.after(config.delay * 1000, () => $.ui.invalidate('ui.render'))
    // and when the last cycle ends, to take it down
    // ponytail: timed at turn start; a mid-turn /breathe cycles with the spinner off waits for the next redraw
    if (config.cycles > 0) $.clock.after(config.delay * 1000 + config.cycles * cycleMs(exerciseOf(exercise)), () => $.ui.invalidate('ui.render'))
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    turn = undefined
    phase = undefined
    $.ui.invalidate('ui.render')
    return r
  })

  // the band posts its phase whenever the line changes (once a second): the spinner reads it
  on('ui.message', async ($, e, next) => {
    const data = e.data as { word?: unknown; exercise?: unknown } | null
    if (typeof data?.word === 'string' && typeof data.exercise === 'string') {
      phase = { word: data.word, exercise: data.exercise }
      if (config.spinner) $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // the band needs a Client, which only the terminal draws; a survey keeps the band
    if (e.surface !== 'terminal' || !config.enabled || !e.props.isWorking || e.props.hasSurvey) return next(e)
    const now = await $.clock.now()
    // a turn the hook saw start; else one that is working anyway (started before the plugin loaded)
    const running = turn ?? (turn = { startedAt: now, style: pickStyle(config.style, lastStyle), exercise: pickExercise(config.exercise, lastExercise) })
    const elapsedMs = breathMs(running, now)
    if (elapsedMs < 0 || finished(running, now)) return next(e)
    const { Box, Client } = $.ui.resolve(e)
    const rows = Math.min(BAND_ROWS, e.props.maxRows)
    if (rows < 1) return next(e)
    // the key names the turn: one instance per turn, remounted when the settings change mid-turn
    const key = `breathe:${running.startedAt}:${running.exercise}:${running.style}`
    return (
      <Box flexDirection="column">
        <Client key={key} module="./breathe.tsx" width={e.viewport?.columns ?? 80} height={rows}
          props={{ exercise: running.exercise, style: running.style, elapsedMs }} />
        {await next(e)}
      </Box>
    )
  })

  // the spinner's word becomes the breath: `✻ Breathe in 4s…`
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!config.enabled || !config.spinner || !phase || (turn && finished(turn, await $.clock.now()))) return next(e)
    return next({ ...e, props: { ...e.props, message: phase.word } })
  })
}
