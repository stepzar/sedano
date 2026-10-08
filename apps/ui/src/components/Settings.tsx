import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Capabilities,
  HarnessId,
  HarnessInfo,
  HostStatus,
  MachineColorId,
  UnhandledEvent,
  VoiceCatalogModel,
  VoiceEngine,
  VoiceModelFile,
  VoiceProvider,
  VoiceStatus,
} from '@shared'
import { HARNESS_LABEL, MACHINE_COLORS } from '@shared'
import type { FontChoice, State, ThemeChoice } from '../store.ts'
import {
  DEFAULT_TRANSFER_PROMPT_TEMPLATE,
  THEME_CHOICES,
  apiHttp,
  availableFonts,
  capsErrorFor,
  checkHost,
  colorForMachine,
  confirmDialog,
  defaultAppearance,
  ensureCaps,
  fontAvailable,
  harnessUpdateError,
  inspectHarness,
  loadCaps,
  notify,
  rawCapsFor,
  refreshVoice,
  refreshLimits,
  serverCaps,
  setHarnessEnabled,
  setHost,
  setMachineColor,
  setVoice,
  updateSettings,
  isPhoneProfile,
  updateHarnessAdapter,
  voiceModelAction,
} from '../store.ts'
import { IconChevron, IconSearch } from './Icons.tsx'
import { useMobile } from '../mobile.ts'
import { RemoteAccessPanel } from './RemoteAccess.tsx'
import { useIsLocal } from '../remoteClient.ts'
import { HarnessMark } from './Chrome.tsx'
import { Select } from './Menu.tsx'
import { UpdateSettings } from './UpdatePill.tsx'
import '../settings.css'
import '../machine.css'

/**
 * Settings, organised the way a settings window should be: sections on the
 * left, one search that covers every row, and each row saying what it changes.
 * Nothing lives in here that belongs to a tab (workspaces, presets).
 *
 * Two of these panels are lists of things that were *detected* rather than
 * configured — the machines and their harnesses, the dictation engines — and
 * they follow one rule: show what was found, say what is wrong with what was
 * not, and never claim a change the server has not confirmed. Every switch here
 * is driven by the catalog the server publishes, so a refused command leaves the
 * control exactly where it was.
 */
interface Row {
  id: string
  section: SectionId
  label: string
  /** A few words at most; empty when the label says it all. */
  help: string
  /** Extra words the search matches, since the visible text is kept short. */
  keywords?: string
  control: React.ReactNode
  /** The control is a panel of its own: it goes under the text, full width. */
  wide?: boolean
}

interface HarnessSyncStatus {
  running: boolean
  mode: 'check' | 'upgrade'
  startedAt: number | null
  finishedAt: number | null
  completed: number
  total: number
  queued: boolean
  failures: Array<{ machine: string; harness: string; detail: string }>
  /** Whether the hourly background check runs at all (a Settings switch). */
  automatic?: boolean
}

/** One explicit control for every enabled machine, independent of the picker. */
function HarnessSyncControl() {
  const [status, setStatus] = useState<HarnessSyncStatus | null>(null)
  const read = async () => {
    try {
      const response = await fetch(apiHttp('/api/harness-sync'))
      if (response.ok) setStatus(await response.json() as HarnessSyncStatus)
    } catch { /* the ordinary offline banner already covers a disconnected server */ }
  }
  useEffect(() => {
    void read()
    const timer = setInterval(() => { void read() }, 3_000)
    return () => clearInterval(timer)
  }, [])

  const start = async (mode: 'check' | 'upgrade') => {
    if (mode === 'upgrade' && !await confirmDialog({
      title: 'Update all installed harnesses?',
      body: 'Sedano will update available releases on this computer and every enabled server. Running sessions keep their current processes; new sessions use the updated tools.',
      confirmLabel: 'Update all',
    })) return
    try {
      const response = await fetch(apiHttp('/api/harness-sync'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      const body = await response.json() as HarnessSyncStatus & { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Could not start the sync')
      setStatus(body)
      notify('info', body.queued ? 'Sync queued after the current scan.' : 'Sync running in the background.')
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }
  const setAutomatic = async (automatic: boolean) => {
    try {
      const response = await fetch(apiHttp('/api/harness-sync'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ automatic }),
      })
      if (response.ok) setStatus(await response.json() as HarnessSyncStatus)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }
  const last = status?.finishedAt ? new Date(status.finishedAt).toLocaleString() : 'never'
  return (
    <div className="harness-sync">
      <div className="harness-sync-actions">
        <button type="button" onClick={() => void start('check')}>Refresh models &amp; versions</button>
        <button type="button" onClick={() => void start('upgrade')}>Update all available</button>
      </div>
      {status ? (
        <label className="harness-sync-auto">
          <Switch
            on={status.automatic !== false}
            label="Check automatically"
            onClick={() => void setAutomatic(status.automatic === false)}
          />
          <span className="set-item-why">
            Check automatically, at start and hourly: runs each CLI and <span className="mono">npm view</span> here and on every enabled server.
          </span>
        </label>
      ) : null}
      <div className="set-item-why" aria-live="polite">
        {status?.running
          ? `${status.mode === 'upgrade' ? 'Updating' : 'Checking'} in background · ${status.completed}/${status.total || '…'} harnesses${status.queued ? ' · another sync queued' : ''}`
          : `Last check: ${last}`}
      </div>
      {status?.failures.length ? (
        <details className="harness-sync-issues">
          <summary>{status.failures.length} check{status.failures.length === 1 ? '' : 's'} need attention</summary>
          {status.failures.map((failure, index) => (
            <div key={`${failure.machine}:${failure.harness}:${index}`}>
              {failure.machine} · {failure.harness}: {failure.detail}
            </div>
          ))}
        </details>
      ) : null}
    </div>
  )
}

interface UsageReader {
  id: HarnessId
  on: boolean
  endpoint: string
  credential: string
}

/**
 * The usage readers that send a stored credential to a vendor, one switch
 * each, off until turned on. Each says exactly what it reads and where it
 * sends it, and the switch moves only once the server has confirmed.
 */
function UsageReaders() {
  const [readers, setReaders] = useState<UsageReader[] | null>(null)
  const apply = async (init?: RequestInit) => {
    try {
      const response = await fetch(apiHttp('/api/usage-readers'), init)
      const body = (await response.json()) as { readers?: UsageReader[]; error?: string }
      if (!response.ok || !body.readers) throw new Error(body.error ?? 'the server did not answer')
      setReaders(body.readers)
    } catch (error) {
      notify('error', `Usage readers: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  useEffect(() => {
    void apply()
  }, [])
  if (!readers) return null
  return (
    <div className="usage-readers">
      {readers.map((reader) => (
        <div key={reader.id} className="usage-reader">
          <div className="usage-reader-text">
            <div>Read {HARNESS_LABEL[reader.id]} usage</div>
            <div className="set-item-why">
              Reads {reader.credential} and sends it to {reader.endpoint}.
            </div>
          </div>
          <Switch
            on={reader.on}
            label={`Read ${HARNESS_LABEL[reader.id]} usage`}
            onClick={() =>
              void apply({
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: reader.id, on: !reader.on }),
              })
            }
          />
        </div>
      ))}
    </div>
  )
}

type SectionId = 'appearance' | 'interface' | 'dictation' | 'machines' | 'sessions' | 'remote' | 'advanced'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'interface', label: 'Interface' },
  { id: 'dictation', label: 'Dictation' },
  { id: 'machines', label: 'Machines' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'remote', label: 'Remote access' },
  { id: 'advanced', label: 'Advanced' },
]

function Segment<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="segment">
      {options.map((option) => (
        <button
          key={option.value}
          className={value === option.value ? 'on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A number you nudge, not a slider you hunt for.
 *
 * Sliders are lovely for a value you want to feel and wrong for a size you want
 * to set: the handle covers a range, the number has to be read off the side, and
 * one pixel of drag moves it. Two buttons and the number say exactly what can be
 * done, and the ± shortcuts still work.
 */
function Step({
  value,
  step,
  min,
  max,
  suffix,
  onChange,
}: {
  value: number
  step: number
  min: number
  max: number
  suffix?: string
  onChange: (value: number) => void
}) {
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)) * 10) / 10
  return (
    <div className="step">
      <button className="ghost tiny" onClick={() => onChange(clamp(value - step))} disabled={value <= min} title={`Smaller (${-step}${suffix ?? ''})`}>
        −
      </button>
      <span className="step-value mono">
        {value}
        {suffix}
      </span>
      <button className="ghost tiny" onClick={() => onChange(clamp(value + step))} disabled={value >= max} title={`Bigger (+${step}${suffix ?? ''})`}>
        +
      </button>
    </div>
  )
}

function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button className={`switch${on ? ' on' : ''}`} onClick={onClick} role="switch" aria-checked={on} aria-label={label}>
      <span className="knob" />
    </button>
  )
}

/** Bytes as a size a person reads, for the model files. */
function fileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/**
 * A command the app will not run for you.
 *
 * Shown as text, selectable, with no button beside it. Installing a package or
 * pulling half a gigabyte of model is work that belongs in a terminal the user
 * is watching — and a button that kicked it off invisibly, with no output and no
 * way to stop it, would be a worse answer than the line itself.
 */
function Command({ children }: { children: string }) {
  return (
    <div className="set-command">
      <code>{children}</code>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Machines                                                            */
/* ------------------------------------------------------------------ */

/** The reachability dot: four states, and "never asked" is one of them. */
function reachDot(status: HostStatus | undefined): { className: string; text: string } {
  if (!status?.enabled) return { className: 'set-dot unknown', text: 'Not enabled' }
  if (status.reach === null) return { className: 'set-dot unknown', text: 'Never checked' }
  if (status.reach === 'ok') return { className: 'set-dot ok', text: 'Reachable' }
  if (status.reach === 'timeout') return { className: 'set-dot warn', text: 'Timed out' }
  if (status.reach === 'permission') return { className: 'set-dot bad', text: 'Permission refused' }
  if (status.reach === 'not_found') return { className: 'set-dot warn', text: 'Command not found' }
  if (status.reach === 'unreachable') return { className: 'set-dot bad', text: 'Unreachable' }
  return { className: 'set-dot bad', text: 'Command failed' }
}

/**
 * The harnesses of one machine, with a switch each.
 *
 * `installed` and `enabled` are two different columns and both are shown: a CLI
 * that is not on this machine has no switch to offer, and one that is there but
 * hidden has a switch that is off. Nothing is removed from the list — a row you
 * turned off is the only way to turn it back on.
 */
function HarnessList({ state, caps, host, scanning }: { state: State; caps: Capabilities | null; host: string | null; scanning: boolean }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!caps) {
    return <div className="set-item-why">Reading what this machine has installed…</div>
  }
  if (caps.probeError) {
    return <div className="set-item-why">Could not look: {caps.probeError}</div>
  }
  const offerable = (harness: HarnessInfo): boolean => harness.installed && (harness.wired || harness.tui === true)
  return (
    <>
      {scanning ? <div className="set-item-why">Scanning installed tools…</div> : null}
      {caps.harnesses.map((harness) => {
        const can = offerable(harness)
        const on = can && harness.enabled !== false
        return (
          <div className={`set-item${can ? '' : ' absent'}`} key={harness.id}>
            <div className="set-item-text">
              <div className="set-item-name">
                <HarnessMark harness={harness.id} kind="agent" size={14} />
                {HARNESS_LABEL[harness.id] ?? harness.label}
              </div>
              <div className="set-item-why">
                {!harness.installed
                  ? `Not installed (${harness.bin})`
                  : !harness.wired && !harness.tui
                    ? 'Not supported yet'
                    : `${harness.bin}${harness.version ? ` · ${harness.version}` : ''}${harness.tui ? ' · opens as a terminal tab' : ''}${harness.update?.status === 'available' ? ` · ${harness.update.installedVersion} → ${harness.update.latestVersion}` : ''}`}
              </div>
              {harnessUpdateError(state, harness.id, host) ? (
                <div className="set-item-why update-error" role="alert">
                  Update failed: {harnessUpdateError(state, harness.id, host)}
                </div>
              ) : null}
            </div>
            {can ? <div className="set-harness-actions">
              {harness.update?.status === 'available' ? (
                <button type="button" className="ghost tiny" disabled={busy !== null}
                  title={harness.update.updateCommand ?? undefined}
                  onClick={() => {
                    setBusy(harness.id)
                    void updateHarnessAdapter(harness.id, host).finally(() => setBusy(null))
                  }}>{busy === harness.id ? 'Updating…' : 'Update now'}</button>
              ) : (
                <button type="button" className="ghost tiny" disabled={busy !== null}
                  onClick={() => {
                    setBusy(harness.id)
                    void inspectHarness(harness.id, host).finally(() => setBusy(null))
                  }}>{busy === harness.id ? 'Checking…' : 'Check updates'}</button>
              )}
              <Switch on={on} label={`Offer ${harness.label}`} onClick={() => setHarnessEnabled(host, harness.id, !on)} />
            </div> : null}
          </div>
        )
      })}
    </>
  )
}

/**
 * The colour one machine is recognised by.
 *
 * A named menu rather than a grid of anonymous dots. Every value here is one
 * somebody has checked against both themes (see `MACHINE_COLORS`), and a hex
 * anybody can type is a hex nobody can guarantee is visible. Nothing moves on
 * the click — the server broadcasts the new map and the ring follows that, the
 * same rule the harness switches follow. The name is deliberately visible in
 * the trigger: colour is recognition, never the only way to understand a
 * choice.
 */
function ColorPicker({ state, host }: { state: State; host: string | null }) {
  const current = colorForMachine(state, host)
  return (
    <div className="set-item">
      <div className="set-item-text">
        <div className="set-item-name">
          Colour
          <span className="machine-swatch-name">{current.label}</span>
        </div>
      </div>
      <Select
        value={current.id}
        title="Machine Colour"
        width={200}
        align="end"
        options={MACHINE_COLORS.map((colour) => ({ value: colour.id, label: colour.label }))}
        onChange={(id) => setMachineColor(host, id as MachineColorId)}
      />
    </div>
  )
}

/** One machine: this computer, or an ssh host you may enable. */
function MachineCard({
  state,
  host,
  status,
}: {
  state: State
  host: string | null
  status?: HostStatus
}) {
  const [open, setOpen] = useState(host === null)
  const [checking, setChecking] = useState(false)
  const enabled = host === null || Boolean(status?.enabled)
  const caps = rawCapsFor(state, host)
  const failed = capsErrorFor(state, host)
  const [scanning, setScanning] = useState(open && enabled && !caps)
  const scanStartedFrom = useRef(caps)

  const scan = (): void => {
    scanStartedFrom.current = caps
    setScanning(true)
    loadCaps(host)
  }
  // The catalog of a server costs an SSH round trip, so it is only asked for
  // when the card is opened — never on the way past.
  useEffect(() => {
    if (open && enabled && !caps) {
      scanStartedFrom.current = caps
      setScanning(true)
      ensureCaps(host)
    }
  }, [open, enabled, host, caps])
  // A forced scan returns a new catalog even when its contents did not change.
  // Keep the old rows visible while it runs, then stop the progress state only
  // when that new answer (or a bounded failure) actually arrives.
  useEffect(() => {
    if (scanning && (caps !== scanStartedFrom.current || failed)) setScanning(false)
  }, [caps, failed, scanning])
  // For a server the second line is whether it answered; this machine is
  // trivially reachable, so it says the thing that is actually worth knowing.
  const found = caps?.harnesses.filter((harness) => harness.installed && (harness.wired || harness.tui)) ?? []
  const dot = scanning
    ? { className: 'set-dot unknown', text: 'Scanning harnesses…' }
    : host === null
      ? {
          className: 'set-dot ok',
          text: caps ? `${found.filter((harness) => harness.enabled !== false).length} Of ${found.length} Offered` : 'Scanning…',
        }
      : reachDot(status)

  return (
    <div className="set-card">
      <div className="set-card-head">
        {/* The machine's own mark, so the card is recognisable as the thing the
            tabs and the selector are marked with. */}
        <span
          className="machine-dot"
          style={{ ['--machine' as string]: `var(--machine-${colorForMachine(state, host).id})` } as React.CSSProperties}
          aria-hidden
        />
        <span className={dot.className} title={status?.detail ?? dot.text} />
        <span className={host === null ? 'set-title' : 'set-title mono'}>{host ?? 'This Computer'}</span>
        <span className="set-sub">{dot.text}</span>
        <span className="set-spacer" />
        {open && enabled ? (
          <button className="ghost tiny" disabled={scanning} title="Scan installed harnesses again" onClick={scan}>
            {scanning ? 'Scanning…' : 'Refresh'}
          </button>
        ) : null}
        {host !== null && enabled ? (
          <button
            className="ghost tiny"
            disabled={checking}
            title={`Connect to ${host} once and report what happens`}
            onClick={() => {
              setChecking(true)
              void checkHost(host).finally(() => setChecking(false))
            }}
          >
            {checking ? 'Checking…' : 'Check'}
          </button>
        ) : null}
        {host !== null ? (
          <Switch
            on={enabled}
            label={`Allow ${host}`}
            onClick={() => void setHost(host, !enabled)}
          />
        ) : null}
        {enabled ? (
          <button className="ghost tiny" onClick={() => setOpen(!open)} title={open ? 'Hide harnesses' : 'Show harnesses'}>
            {open ? 'Hide' : 'Harnesses'}
          </button>
        ) : null}
      </div>
      {status?.detail && status.reach !== null && status.reach !== 'ok' ? (
        <div className="set-card-body">
          <div className="set-item-why">{status.detail}</div>
        </div>
      ) : null}
      {enabled ? (
        <div className="set-card-body">
          {/* Outside the harness disclosure on purpose: choosing a colour must
              not cost the SSH round trip that reading the catalog does. */}
          <ColorPicker state={state} host={host} />
        </div>
      ) : null}
      {open && enabled ? (
        <div className="set-card-body">
          <HarnessList state={state} caps={caps} host={host} scanning={scanning} />
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Dictation                                                           */
/* ------------------------------------------------------------------ */

function EngineCard({ engine, active }: { engine: VoiceEngine; active: boolean }) {
  return (
    <div className="set-card">
      <div className="set-card-head">
        <span className={`set-dot ${engine.ready ? 'ok' : 'bad'}`} />
        <span className="set-title">{engine.label}</span>
        <span className="set-sub">{engine.ready ? (active ? 'In use' : 'Available') : 'Unavailable'}</span>
      </div>
      <div className="set-card-body">
        <div className="set-item">
          <div className="set-item-text">
            <div className="set-item-why">{engine.detail}</div>
            {engine.missing ? <div className="set-item-why">{engine.missing}</div> : null}
          </div>
        </div>
        {engine.install ? (
          <>
            <div className="set-item-why">To install, run:</div>
            <Command>{engine.install}</Command>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** One row of the model list: an official model, or a file on disk the catalog does not know. */
interface ModelRow {
  key: string
  label: string
  hint: string
  bytes: number
  path: string | null
  entry: VoiceCatalogModel | null
}

function modelRows(engine: VoiceEngine | undefined): ModelRow[] {
  const catalog = engine?.catalog ?? []
  const known = new Set(catalog.map((entry) => entry.file))
  const official = catalog.map((entry) => ({
    key: entry.file,
    label: entry.label,
    hint: `${entry.hint}${entry.multilingual ? ' · multilingual' : ''}${entry.recommended ? ' · recommended' : ''}`,
    bytes: entry.bytes,
    path: entry.path,
    entry,
  }))
  const extra = (engine?.models ?? [])
    .filter((file: VoiceModelFile) => !known.has(file.label))
    .map((file) => ({ key: file.path, label: file.label, hint: 'On this machine', bytes: file.bytes, path: file.path, entry: null }))
  return [...official, ...extra]
}

const DOWNLOAD_PREFIX = 'download:'

/**
 * Pick, download and delete whisper.cpp models.
 *
 * The dropdown switches instantly between downloaded models (the next
 * recording uses the new one), so two models can be compared back to back
 * with the "last transcription" line underneath. Picking a model that is not
 * here starts its download; the list below shows progress and deletes.
 */
function WhisperModels({ voice, onPick }: { voice: VoiceStatus | undefined; onPick: (path: string) => void }) {
  const engine = voice?.engines?.find((candidate) => candidate.id === 'whisper-cli')
  const rows = modelRows(engine)
  const downloading = rows.some((row) => row.entry?.download && row.entry.download.state !== 'failed')

  // Fresh numbers when the panel opens; then once a second while a file downloads.
  useEffect(() => {
    void refreshVoice()
  }, [])
  useEffect(() => {
    if (!downloading) return
    const timer = window.setInterval(() => void refreshVoice(), 1000)
    return () => clearInterval(timer)
  }, [downloading])

  const download = (file: string) => void voiceModelAction({ action: 'download', file })
  const remove = async (row: ModelRow): Promise<void> => {
    if (!row.path) return
    const ok = await confirmDialog({
      title: `Delete ${row.label}?`,
      body: `${fileSize(row.bytes)} are freed. You can download it again later.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) void voiceModelAction({ action: 'delete', path: row.path })
  }

  const options = rows.map((row) => ({
    value: row.path ?? `${DOWNLOAD_PREFIX}${row.key}`,
    label: row.label,
    hint: row.hint,
    suffix: row.path ? fileSize(row.bytes) : `Download · ${fileSize(row.bytes)}`,
  }))
  const last = voice?.lastRun

  return (
    <div className="set-card voice-models">
      <div className="set-card-head">
        <span className="set-title">Model in use</span>
        <Select
          value={voice?.model ?? ''}
          options={options}
          title="Dictation model"
          width={440}
          align="end"
          placeholder="No model yet"
          onChange={(value) => (value.startsWith(DOWNLOAD_PREFIX) ? download(value.slice(DOWNLOAD_PREFIX.length)) : onPick(value))}
        />
      </div>
      <div className="set-card-body">
        <div className="set-item-why voice-last-run">
          {last
            ? `Last transcription took ${(last.ms / 1000).toFixed(1)} s for ${last.audioSeconds.toFixed(1)} s of audio · ${last.model}`
            : 'No transcription since the server started.'}
        </div>
        {rows.map((row) => {
          const job = row.entry?.download ?? null
          const inUse = Boolean(row.path && voice?.model === row.path)
          const percent = job ? Math.floor((job.received / Math.max(job.total, 1)) * 100) : 0
          return (
            <div className="set-item" key={row.key}>
              <div className="set-item-text">
                <div className="set-item-name">{row.label}</div>
                <div className="set-item-why">{row.hint}</div>
                {job && job.state !== 'failed' ? (
                  <div className="voice-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: `${percent}%` }} />
                  </div>
                ) : null}
                {job?.state === 'failed' ? <div className="set-item-why update-error">{job.error}</div> : null}
              </div>
              <span className="set-size">
                {job?.state === 'downloading'
                  ? `${percent}% of ${fileSize(job.total)}`
                  : job?.state === 'verifying'
                    ? 'Verifying…'
                    : fileSize(row.bytes)}
              </span>
              {row.path ? (
                <>
                  <button
                    className={inUse ? '' : 'ghost tiny'}
                    onClick={() => onPick(row.path!)}
                    title={inUse ? 'This is the model in use' : `Use ${row.label}`}
                  >
                    {inUse ? 'In Use' : 'Use'}
                  </button>
                  <button className="ghost tiny" onClick={() => void remove(row)} title={`Delete ${row.label}`}>
                    Delete
                  </button>
                </>
              ) : job && job.state !== 'failed' ? (
                <button
                  className="ghost tiny"
                  onClick={() => void voiceModelAction({ action: 'cancel', file: row.key })}
                  title="Stop and discard this download"
                >
                  Cancel
                </button>
              ) : (
                <button className="ghost tiny" onClick={() => download(row.key)} title={`Download ${row.label}`}>
                  {job?.state === 'failed' ? 'Retry' : 'Download'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Fonts                                                               */
/* ------------------------------------------------------------------ */

/**
 * A typeface picker and the escape hatch beside it.
 *
 * The list is short and every entry has been checked against this machine's
 * fonts, so nothing on offer is a name that would silently fall back. The field
 * underneath is for a font you have that the list does not know: it is checked
 * the same way and refused with a reason rather than accepted and ignored.
 */
function FontPicker({
  value,
  fonts,
  onChange,
}: {
  value: string | null
  fonts: FontChoice[]
  onChange: (family: string | null) => void
}) {
  const [typed, setTyped] = useState('')
  const known = fonts.some((font) => font.family === value)
  const options = [
    { value: '', label: 'System Default', hint: 'What the app ships with' },
    ...fonts.map((font) => ({ value: font.family, label: font.label, hint: font.note })),
    // A font typed in by hand is kept in the list, so the picker still shows
    // what is selected instead of falling back to "System Default".
    ...(value && !known ? [{ value, label: value, hint: fontAvailable(value) ? 'Typed in · found on this machine' : 'Not on this machine · the default is used' }] : []),
  ]
  return (
    <>
      <Select
        value={value ?? ''}
        options={options}
        title="Typeface"
        // Font names and their notes are useful only when they are readable.
        // A 260px menu was narrower than common macOS family names and clipped
        // the description beside them.
        width={420}
        align="end"
        onChange={(next) => onChange(next || null)}
      />
      <div className="set-font-custom">
        <input
          placeholder="Or type a font you have installed"
          value={typed}
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            const family = typed.trim()
            if (!family) return
            if (!fontAvailable(family)) {
              notify('error', `“${family}” is not a font this machine can render — nothing changed`)
              return
            }
            onChange(family)
            setTyped('')
          }}
        />
        <button
          className="ghost tiny"
          disabled={!typed.trim()}
          onClick={() => {
            const family = typed.trim()
            if (!fontAvailable(family)) {
              notify('error', `“${family}” is not a font this machine can render — nothing changed`)
              return
            }
            onChange(family)
            setTyped('')
          }}
        >
          Use
        </button>
      </div>
    </>
  )
}

/** The conversation font doing the job it has: prose beside code. */
function ContentPreview() {
  return (
    <div className="set-preview">
      <div className="set-preview-prose">
        The agent read <code>src/server/handler.ts</code> and changed how an order is checked, so an
        empty cart is turned away before it reaches the database.
        <pre>
          <code>{'export function isValidOrder(order) {\n  return order.items.length > 0\n}'}</code>
        </pre>
      </div>
    </div>
  )
}

/** The interface font doing its job: a tab, a session row, a status line. */
function ChromePreview() {
  return (
    <div className="set-preview">
      <div className="set-preview-chrome">
        <div className="set-preview-tabs">
          <span className="set-preview-tab on">Refactor The Transport</span>
          <span className="set-preview-tab">bash — devbox</span>
        </div>
        <div className="set-preview-session">
          <b>Make the settings honest</b>
          <span className="set-preview-meta">Claude Code · claude-opus-4-6 · 12 minutes ago</span>
        </div>
        <span className="set-preview-status">3 Sessions · 2 Workspaces · 1 Running</span>
      </div>
    </div>
  )
}

/**
 * Protocol messages a harness sent that sedano does not map yet. The server
 * keeps the list (live sightings, and new types in an installed version's
 * schema); the capabilities carry it, and it is asked for again when Settings
 * opens so the list is current. Hidden entirely when there is nothing to say.
 */
function UnhandledEvents({ known }: { known: UnhandledEvent[] }) {
  const [events, setEvents] = useState<UnhandledEvent[]>(known)
  useEffect(() => {
    let alive = true
    void fetch(apiHttp('/api/unhandled'))
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { events?: UnhandledEvent[] } | null) => {
        if (alive && body?.events) setEvents(body.events)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  if (!events.length) return null
  return (
    <ul className="unhandled-list">
      {events.map((event) => (
        <li key={`${event.protocol}:${event.harness}:${event.key}`} title={`First seen ${new Date(event.firstSeen).toLocaleString()} · last ${new Date(event.lastSeen).toLocaleString()}`}>
          <span className="mono">{event.key}</span>
          <span className="unhandled-meta">
            {event.harness}
            {event.version ? ` ${event.version}` : ''} · {event.source === 'live' ? `seen ${event.count}×` : 'in its schema'}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function SettingsDialog({ state, onClose }: { state: State; onClose: () => void }) {
  const [section, setSection] = useState<SectionId>('appearance')
  const [query, setQuery] = useState('')
  // Remote access is managed from the Mac only: the server refuses these
  // endpoints to a paired phone, so the section appears only once the server
  // has confirmed this page is local.
  const remote = !useIsLocal()
  // On a phone: a list of sections, then one section with a Back button — a
  // sideways strip of tabs above a long page was where scrolling got lost.
  const mobile = useMobile()
  const phone = isPhoneProfile()
  const [detail, setDetail] = useState(false)
  const { settings } = state
  // Hosts, presets and dictation are the server's own: the same whichever
  // machine is on screen.
  const caps = serverCaps(state)
  const voice: VoiceStatus | undefined = caps?.voice
  // What the user asked for, which is not what it resolved to. The control has
  // to show the value it sets, or clicking it looks like it did nothing: with
  // `auto` chosen and whisper.cpp installed, `provider` reads `whisper-cli`, so
  // the button that lit up was never the button that was pressed.
  const configured: VoiceProvider = voice?.configured ?? 'auto'
  const engines = voice?.engines ?? []
  // The optional server is advanced plumbing, not a prerequisite. Keep it out
  // of an ordinary on-device setup; if somebody explicitly selects/configures
  // it, its diagnostic card appears again.
  const visibleEngines = engines.filter(
    (engine) => engine.id !== 'openai' || configured === 'openai' || Boolean(engine.endpoint),
  )

  const changeVoice = async (patch: Parameters<typeof setVoice>[0]): Promise<void> => {
    const status = await setVoice(patch)
    if (!status) return
    notify(status.ready ? 'success' : 'warning', status.ready ? `Dictation ready — ${status.detail}` : `Not ready — ${status.detail}`)
  }

  // Every candidate in ~/.ssh/config, with what is known about it. The server is
  // the only source: an entry it does not list cannot be enabled at all.
  const hostStatus: HostStatus[] =
    caps?.hostStatus ??
    (caps?.availableHosts ?? []).map((host) => ({
      host,
      enabled: (caps?.hosts ?? []).includes(host),
      reach: null,
      detail: null,
      checkedAt: null,
    }))

  const uiFonts = useMemo(() => availableFonts('ui'), [])
  const contentFonts = useMemo(() => availableFonts('content'), [])

  const rows: Row[] = [
    ...(phone
      ? [{
          id: 'appearance-device',
          section: 'appearance' as const,
          label: 'This phone',
          help: 'Applies to this phone only.',
          control: <span className="chip">Phone profile</span>,
        }]
      : []),
    {
      id: 'theme',
      section: 'appearance',
      label: 'Theme',
      help: '',
      keywords: 'light dark system',
      control: (
        <Select
          value={settings.theme}
          options={THEME_CHOICES}
          title="Theme"
          width={160}
          align="end"
          onChange={(value) => updateSettings({ theme: value as ThemeChoice })}
        />
      ),
    },
    {
      id: 'ui-typeface',
      section: 'appearance',
      label: 'Interface typeface',
      help: 'Sidebar, tabs, status bar.',
      keywords: 'font',
      wide: true,
      control: (
        <>
          <FontPicker
            value={settings.uiFont ?? null}
            fonts={uiFonts}
            onChange={(family) => updateSettings({ uiFont: family })}
          />
          <ChromePreview />
        </>
      ),
    },
    {
      id: 'content-typeface',
      section: 'appearance',
      label: 'Conversation typeface',
      help: 'Code stays monospace.',
      keywords: 'font messages composer',
      wide: true,
      control: (
        <>
          <FontPicker
            value={settings.contentFont ?? null}
            fonts={contentFonts}
            onChange={(family) => updateSettings({ contentFont: family })}
          />
          <ContentPreview />
        </>
      ),
    },
    {
      id: 'content-font',
      section: 'appearance',
      label: `Conversation text — ${settings.contentFontSize}px`,
      help: '⌘ + / ⌘ −',
      keywords: 'font size zoom',
      control: (
        <Step
          value={settings.contentFontSize}
          step={0.5}
          min={10}
          max={28}
          suffix="px"
          onChange={(value) => updateSettings({ contentFontSize: value })}
        />
      ),
    },
    {
      id: 'ui-font',
      section: 'appearance',
      label: `Interface text — ${settings.uiFontSize}px`,
      help: '⌥ ⌘ + / ⌥ ⌘ −',
      keywords: 'font size zoom',
      control: (
        <Step
          value={settings.uiFontSize}
          step={0.5}
          min={9}
          max={20}
          suffix="px"
          onChange={(value) => updateSettings({ uiFontSize: value })}
        />
      ),
    },
    {
      id: 'sidebar',
      section: 'interface',
      label: 'Sidebar',
      help: '⌘ B',
      keywords: 'rail workspaces sessions',
      control: (
        <Switch
          on={settings.railVisible}
          label="Sidebar"
          onClick={() => updateSettings({ railVisible: !settings.railVisible })}
        />
      ),
    },
    {
      id: 'thinking',
      section: 'interface',
      label: 'Show reasoning',
      help: '',
      keywords: 'thinking',
      control: (
        <Switch
          on={settings.showThinking}
          label="Show reasoning"
          onClick={() => updateSettings({ showThinking: !settings.showThinking })}
        />
      ),
    },
    {
      id: 'compact',
      section: 'interface',
      label: 'Collapse finished turns',
      help: 'One line per turn.',
      keywords: 'compact',
      control: (
        <Switch
          on={settings.compactTurns}
          label="Collapse finished turns"
          onClick={() => updateSettings({ compactTurns: !settings.compactTurns })}
        />
      ),
    },
    {
      id: 'chime',
      section: 'interface',
      label: 'Chime when a turn finishes',
      help: '',
      keywords: 'sound notification',
      control: (
        <Switch
          on={settings.chimeOnDone}
          label="Chime when a turn finishes"
          onClick={() => updateSettings({ chimeOnDone: !settings.chimeOnDone })}
        />
      ),
    },
    {
      id: 'cost',
      section: 'interface',
      label: 'Show estimated cost',
      help: 'Only meaningful on API billing.',
      keywords: 'price dollar tokens',
      control: (
        <Switch
          on={settings.showCost}
          label="Show estimated cost"
          onClick={() => updateSettings({ showCost: !settings.showCost })}
        />
      ),
    },
    // Only when dictation cannot work: then the engine card says what is
    // missing and the command that installs it. A working engine is not news.
    ...(voice?.ready
      ? []
      : [{
          id: 'voice-engines',
          section: 'dictation' as const,
          label: 'Engine',
          help: 'Not ready.',
          keywords: 'whisper speech voice install',
          wide: true,
          control: visibleEngines.length ? (
            <>
              {visibleEngines.map((engine) => (
                <EngineCard key={engine.id} engine={engine} active={voice?.provider === engine.id} />
              ))}
            </>
          ) : (
            <div className="set-item-why">This server is too old to report its engines.</div>
          ),
        }]),
    {
      id: 'voice-model',
      section: 'dictation',
      label: 'Model',
      help: '',
      keywords: 'whisper download',
      wide: true,
      control: <WhisperModels voice={voice} onPick={(path) => void changeVoice({ model: path, provider: 'whisper-cli' })} />,
    },
    {
      id: 'voice-language',
      section: 'dictation',
      label: 'Spoken language',
      help: 'A fixed language is faster.',
      keywords: 'italian english auto',
      control: (
        <Segment<string>
          value={voice?.language ?? 'auto'}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'it', label: 'Italiano' },
            { value: 'en', label: 'English' },
          ]}
          onChange={(value) => void changeVoice({ language: value })}
        />
      ),
    },
    {
      id: 'voice-sounds',
      section: 'dictation',
      label: 'Dictation sounds',
      help: '',
      keywords: 'beep',
      control: (
        <Switch
          on={settings.dictationSounds !== false}
          label="Dictation sounds"
          onClick={() => updateSettings({ dictationSounds: settings.dictationSounds === false })}
        />
      ),
    },
    {
      id: 'harness-sync',
      section: 'machines',
      label: 'Harness updates',
      help: 'Checked daily.',
      keywords: 'models versions upgrade',
      wide: true,
      control: <HarnessSyncControl />,
    },
    {
      id: 'machines-list',
      section: 'machines',
      label: 'Machines',
      help: 'Hosts from ~/.ssh/config.',
      keywords: 'ssh servers harnesses colour color',
      wide: true,
      control: (
        <>
          <MachineCard state={state} host={null} />
          {hostStatus.length === 0 ? (
            <div className="set-item-why">
              No <span className="mono">Host</span> entries in ~/.ssh/config.
            </div>
          ) : (
            hostStatus.map((status) => (
              <MachineCard key={status.host} state={state} host={status.host} status={status} />
            ))
          )}
        </>
      ),
    },
    {
      id: 'sessions-transfer-prompt',
      section: 'sessions',
      label: 'Transfer handoff prompt',
      help: 'Fields: {sourceHarness} {sourceSession} {summary} {remaining}',
      keywords: 'template',
      wide: true,
      control: (
        <div className="transfer-template-setting">
          <textarea
            value={settings.transferPromptTemplate ?? DEFAULT_TRANSFER_PROMPT_TEMPLATE}
            spellCheck={false}
            onChange={(event) => updateSettings({ transferPromptTemplate: event.target.value })}
          />
          <div className="row">
            <span className="spacer" />
            <button
              className="ghost tiny"
              disabled={(settings.transferPromptTemplate ?? DEFAULT_TRANSFER_PROMPT_TEMPLATE) === DEFAULT_TRANSFER_PROMPT_TEMPLATE}
              onClick={() => updateSettings({ transferPromptTemplate: DEFAULT_TRANSFER_PROMPT_TEMPLATE })}
            >
              Restore Default
            </button>
          </div>
        </div>
      ),
    },
    ...(remote
      ? []
      : [{
          id: 'remote-access',
          section: 'remote' as const,
          label: 'iPhone and other devices',
          help: 'Over your private Tailscale network.',
          keywords: 'phone tailscale pair',
          wide: true,
          control: <RemoteAccessPanel />,
        }]),
    {
      id: 'advanced-usage-readers',
      section: 'advanced',
      label: 'Account usage readers',
      help: 'Off by default: each sends a stored credential to its vendor.',
      keywords: 'quota limits usage credentials token keychain api key claude command code',
      wide: true,
      control: <UsageReaders />,
    },
    {
      id: 'advanced-updates',
      section: 'advanced',
      label: 'Version',
      help: '',
      keywords: 'update updates upgrade release about',
      wide: true,
      control: <UpdateSettings />,
    },
    {
      id: 'advanced-limits',
      section: 'advanced',
      label: 'Usage limits',
      help: '',
      keywords: 'quota',
      control: (
        <button onClick={() => refreshLimits(true)} title="Ask the harness right now">
          Refresh now
        </button>
      ),
    },
    {
      id: 'advanced-rescan',
      section: 'advanced',
      label: 'Installed software',
      help: 'After installing a tool.',
      keywords: 'harnesses scan',
      control: (
        <button onClick={() => loadCaps(null)} title="Scan this computer again">
          Scan again
        </button>
      ),
    },
    ...(caps?.unhandledEvents?.length
      ? [{
          id: 'advanced-unhandled',
          section: 'advanced' as const,
          label: `Unhandled events (${caps.unhandledEvents.length})`,
          help: 'Not shown yet; kept for later.',
          control: <UnhandledEvents known={caps.unhandledEvents} />,
        }]
      : []),
    {
      id: 'advanced-reset',
      section: 'advanced',
      label: 'Type scales',
      help: 'Resets sizes and typefaces.',
      keywords: 'font appearance defaults',
      control: (
        <button
          onClick={() => {
            updateSettings(defaultAppearance())
          }}
        >
          Reset to defaults
        </button>
      ),
    },
  ]

  const needle = query.trim().toLowerCase()
  const matches = (row: Row): boolean =>
    !needle ||
    row.label.toLowerCase().includes(needle) ||
    row.help.toLowerCase().includes(needle) ||
    Boolean(row.keywords?.includes(needle)) ||
    row.section.includes(needle)

  const visible = rows.filter(matches)
  const counts = useMemo(() => {
    const map = new Map<SectionId, number>()
    for (const row of visible) map.set(row.section, (map.get(row.section) ?? 0) + 1)
    return map
  }, [visible])

  const sections = remote ? SECTIONS.filter((item) => item.id !== 'remote') : SECTIONS
  const shown = needle ? sections.filter((item) => counts.has(item.id)) : sections
  const activeSection = counts.has(section) ? section : (shown[0]?.id ?? 'appearance')

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className={`settings${mobile ? (detail ? ' mobile-detail' : ' mobile-list') : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="settings-nav">
          {mobile ? (
            <header className="settings-head settings-list-head">
              <h2>Settings</h2>
              <span className="spacer" />
              <button className="ghost" onClick={onClose}>
                Done
              </button>
            </header>
          ) : null}
          <div className="settings-search">
            <IconSearch size={16} />
            <input
              autoFocus={!mobile}
              placeholder="Search settings"
              value={query}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="settings-nav-list">
            {shown.map((item) => (
              <button
                key={item.id}
                className={`settings-nav-item${activeSection === item.id ? ' on' : ''}`}
                onClick={() => {
                  setSection(item.id)
                  setDetail(true)
                }}
              >
                <span>{item.label}</span>
              </button>
            ))}
            {shown.length === 0 ? <div className="settings-empty">No setting matches “{query}”.</div> : null}
          </div>
        </aside>

        <section className="settings-pane">
          <header className="settings-head">
            {mobile ? (
              <button className="ghost settings-back" onClick={() => setDetail(false)} aria-label="Back to all settings">
                <IconChevron size={16} className="back-chevron" /> Settings
              </button>
            ) : null}
            <h2>{SECTIONS.find((item) => item.id === activeSection)?.label}</h2>
            <span className="spacer" />
            <button className="ghost" onClick={onClose}>
              Done
            </button>
          </header>
          <div className="settings-rows">
            {visible
              .filter((row) => row.section === activeSection)
              .map((row) => (
                <div className={`settings-row${row.wide ? ' wide' : ''}`} key={row.id}>
                  <div className="settings-text">
                    <div className="settings-label">{row.label}</div>
                    {row.help ? <p className="settings-help">{row.help}</p> : null}
                  </div>
                  <div className="settings-control">{row.control}</div>
                </div>
              ))}
          </div>
        </section>
      </div>
    </div>
  )
}
