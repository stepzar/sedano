import { useEffect, useMemo, useState } from 'react'
import type { EffortLevel, HarnessId, PermissionMode, SessionSummary } from '@shared'
import { HARNESS_LABEL } from '@shared'
import type { State } from '../store.ts'
import {
  agentDefaultsFor,
  capsErrorFor,
  capsFor,
  ensureCaps,
  harnessUpdateError,
  inspectHarness,
  launchTransfer,
  updateHarnessAdapter,
} from '../store.ts'
import {
  effortCapability,
  findModelChoice,
  modelChoices,
  modelWithEffort,
  effortOptions,
  permissionModeOptions,
  readModel,
} from '../models.ts'
import { buildTransferPrompt } from '../transfer.ts'
import { HarnessMark } from './Chrome.tsx'
import { Select } from './Menu.tsx'

const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'Ask Normally',
  acceptEdits: 'Accept Edits',
  auto: 'Auto Approve',
  manual: 'Ask Every Time',
  plan: 'Plan Only',
  bypassPermissions: 'Bypass Permissions',
}

export function TransferDialog({
  state,
  session,
  onClose,
}: {
  state: State
  session: SessionSummary
  onClose: () => void
}) {
  // A transfer continues on the machine and folder that own the source
  // session. There is deliberately no machine/workspace picker here.
  const host = session.host
  const cwd = session.cwd
  const [harnessId, setHarnessId] = useState<HarnessId>(session.harness)
  const [model, setModel] = useState<string | null>(session.model)
  const [effort, setEffort] = useState<EffortLevel | null>(session.effort)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(session.permissionMode)
  const [updatingHarness, setUpdatingHarness] = useState(false)
  const updateError = harnessUpdateError(state, harnessId, host)
  const [prompt, setPrompt] = useState(() =>
    buildTransferPrompt(session, state.events[session.id] ?? [], state.settings.transferPromptTemplate),
  )

  useEffect(() => ensureCaps(host), [host])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const caps = capsFor(state, host)
  // A transfer goes to *another* harness, so the source's own is never offered.
  const harnesses = useMemo(
    () => (caps?.harnesses ?? []).filter((item) =>
      item.id !== 'shell' && item.id !== session.harness && item.installed && item.wired && !item.tui),
    [caps, session.harness, state.version],
  )
  const harness = harnesses.find((item) => item.id === harnessId)

  // The dialog opens on the source harness, which is not a target, and a remote
  // scan may land after it opened: whenever the chosen harness is not in the
  // list, move to the first one that is.
  useEffect(() => {
    if (!caps || harness || !harnesses[0]) return
    const next = harnesses[0]
    const remembered = agentDefaultsFor(state, next.id)
    setHarnessId(next.id)
    setModel(remembered.model ?? null)
    setEffort(remembered.effort ?? null)
    setPermissionMode(remembered.permissionMode ?? 'acceptEdits')
  }, [caps, harness, harnesses, state.defaults])

  const choices = useMemo(() => modelChoices(harness?.models ?? []), [harness, state.version])
  const selected = useMemo(() => {
    return findModelChoice(choices, model) ?? choices.find((choice) => choice.isDefault)
  }, [choices, model])
  const selectedModel = useMemo(() => model ? readModel({ id: model, label: model }) : undefined, [model])
  const modelEffort = useMemo(
    () => effortCapability(harness?.models ?? [], selected?.base ?? ''),
    [harness, selected, state.version],
  )
  const efforts = modelEffort.levels
  const effortsKnown = Boolean(selected) && modelEffort.known
  const effortsFixed = Boolean(selected) && modelEffort.fixed

  // The same harness can expose a different catalog on another machine. Never
  // carry a model, effort or approval flag merely because its string happened
  // to be selected on the source installation.
  useEffect(() => {
    if (!harness) return
    if (model && choices.length && !selected) {
      setModel(null)
      setEffort(null)
      return
    }
    if (selected && effort && (!effortsKnown || !efforts.includes(effort))) {
      setEffort(null)
    }
    if (harness.permissionModes?.length && !harness.permissionModes.includes(permissionMode)) {
      setPermissionMode(harness.permissionModes[0]!)
    }
  }, [choices.length, effort, efforts, effortsKnown, harness, model, permissionMode, selected])

  const ready = Boolean(cwd.trim() && harness && prompt.trim())
  const scanError = capsErrorFor(state, host)

  const chooseHarness = (value: string) => {
    const next = value as HarnessId
    const remembered = agentDefaultsFor(state, next)
    setHarnessId(next)
    setModel(remembered.model ?? null)
    setEffort(remembered.effort ?? null)
    setPermissionMode(remembered.permissionMode ?? 'acceptEdits')
  }

  const chooseModel = (value: string) => {
    const next = choices.find((choice) => choice.id === value || choice.base === value)
    const allowed = next ? effortCapability(harness?.models ?? [], next.base).levels : []
    const current = selectedModel?.effort ?? effort
    const keep = current && allowed.includes(current) ? current : null
    const effective = keep ?? (next?.encodedEffort ? (allowed[0] ?? null) : null)
    setModel(next?.encodedEffort ? modelWithEffort(next, effective) : (value || null))
    setEffort(next?.encodedEffort ? null : keep as EffortLevel | null)
  }

  const submit = () => {
    if (!ready) return
    launchTransfer({ cwd, host, harness: harnessId, model, effort, permissionMode }, prompt)
    onClose()
  }

  return (
    <>
      <div className="overlay transfer-overlay" onMouseDown={onClose}>
        <div className="modal transfer-dialog" onMouseDown={(event) => event.stopPropagation()}>
          <header className="transfer-head">
            <div>
              <h2>Transfer Conversation</h2>
              <p>
                Keep this session and continue in a new one with another harness on this machine.
              </p>
            </div>
            <button className="ghost" onClick={onClose}>Cancel</button>
          </header>

          <div className="transfer-body">
            <div className="transfer-source">
              <span className="transfer-kicker">From</span>
              <strong>{session.title}</strong>
              <span className="transfer-source-harness">
                <HarnessMark harness={session.harness} kind="agent" size={14} />
                {HARNESS_LABEL[session.harness]}
              </span>
              <code>{session.nativeId ?? session.id}</code>
            </div>

            <section className="transfer-section">
              <div className="transfer-section-title">Continue with</div>
              <div className="transfer-grid">
                <label>
                  <span>Harness</span>
                  <Select
                    value={harness ? harnessId : ''}
                    options={harnesses.map((item) => ({
                      value: item.id,
                      label: item.label || HARNESS_LABEL[item.id],
                      icon: <HarnessMark harness={item.id} kind="agent" size={14} />,
                      hint: item.version ?? undefined,
                    }))}
                    onChange={chooseHarness}
                    placeholder={caps ? 'No Harness Available' : 'Scanning…'}
                    disabled={!harnesses.length}
                    width={280}
                  />
                </label>
                <label>
                  <span>Model</span>
                  <Select
                    value={selected?.id ?? ''}
                    footerAction={harness ? {
                      label: 'Refresh models & version',
                      onClick: () => { void inspectHarness(harness.id, host) },
                    } : undefined}
                    options={choices.length
                      ? choices.map((choice) => ({ value: choice.id, label: choice.label, suffix: choice.suffix ?? undefined }))
                      : [{ value: '', label: 'Default Model' }]}
                    onChange={chooseModel}
                    placeholder="Default Model"
                    disabled={!harness}
                    width={360}
                  />
                </label>
                <label>
                  <span>Reasoning</span>
                  <Select
                    value={efforts.includes(selectedModel?.effort ?? effort ?? selected?.defaultEffort ?? '')
                      ? (selectedModel?.effort ?? effort ?? selected?.defaultEffort ?? '') : ''}
                    options={effortOptions({ levels: efforts, fixed: effortsFixed }, Boolean(selected?.encodedEffort))}
                    onChange={(value) => {
                      if (efforts.length) {
                        setModel(modelWithEffort(selected, value || null))
                        if (!selected?.encodedEffort) setEffort((value || null) as EffortLevel | null)
                      } else setEffort((value || null) as EffortLevel | null)
                    }}
                    disabled={!harness || !effortsKnown || effortsFixed}
                    width={220}
                  />
                </label>
                <label>
                  <span>Permissions</span>
                  <Select
                    value={permissionMode}
                    options={permissionModeOptions(harnessId, permissionMode, harness?.permissionModes).map((item) => ({ value: item, label: MODE_LABEL[item] }))}
                    onChange={(value) => setPermissionMode(value as PermissionMode)}
                    disabled={!harness}
                    width={220}
                  />
                </label>
              </div>
              {harness?.update?.status === 'available' ? (
                <div className="harness-health update">
                  <span>Update available: <strong>{harness.update.installedVersion}</strong> → <strong>{harness.update.latestVersion}</strong></span>
                  <button
                    type="button"
                    disabled={updatingHarness}
                    title={harness.update.updateCommand ?? undefined}
                    onClick={() => {
                      setUpdatingHarness(true)
                      void updateHarnessAdapter(harness.id, host).finally(() => setUpdatingHarness(false))
                    }}
                  >
                    {updatingHarness ? 'Updating…' : 'Update now'}
                  </button>
                </div>
              ) : null}
              {updateError ? <p className="transfer-error" role="alert">Update failed: {updateError}</p> : null}
              {scanError ? <p className="transfer-error">Could not inspect this machine: {scanError}</p> : null}
            </section>

            <section className="transfer-section prompt-section">
              <div className="transfer-section-heading">
                <div>
                  <div className="transfer-section-title">Handoff prompt</div>
                  <p>Generated from this conversation. Edit anything before continuing.</p>
                </div>
                <button
                  className="ghost tiny"
                  onClick={() => setPrompt(buildTransferPrompt(session, state.events[session.id] ?? [], state.settings.transferPromptTemplate))}
                >
                  Regenerate
                </button>
              </div>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} spellCheck={false} />
            </section>
          </div>

          <footer className="transfer-actions">
            {!cwd ? <span>This session has no folder.</span> : !harness ? <span>Choose an available harness.</span> : <span />}
            <button className="primary" disabled={!ready} onClick={submit}>Transfer and Continue</button>
          </footer>
        </div>
      </div>
    </>
  )
}
