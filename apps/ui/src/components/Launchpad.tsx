import { useEffect, useMemo, useRef, useState } from 'react'
import type { EffortLevel, HarnessCommand, PermissionMode } from '@shared'
import { allowFileDrop, caretAtPoint, dropImageToken, imageToken, isLongPaste, sortFiles, syncImageTokens, transferFiles } from '../attachments.ts'
import { useDocuments } from './Documents.tsx'
import { PromptField } from './PromptField.tsx'
import { useComposerDraft } from '../drafts.ts'
import { IconBrain, IconClose, IconModel, IconShield } from './Icons.tsx'
import { AttachButton } from './AttachButton.tsx'
import {
  effortCapability,
  findModelChoice,
  modelChoices,
  modelName,
  modelWithEffort,
  effortOptions,
  permissionModeOptions,
  readModel,
} from '../models.ts'
import type { Draft, State } from '../store.ts'
import {
  agentDefaultsFor,
  attachmentUrl,
  capsErrorFor,
  capsFor,
  closeDraft,
  ensureCaps,
  fetchCommands,
  getState,
  harnessUpdateError,
  inspectHarness,
  launchDraft,
  modelsWhy,
  newTerminal,
  notify,
  serverCaps,
  takesImages,
  updateDraft,
  updateHarnessAdapter,
  uploadAttachment,
} from '../store.ts'
import { baseName, HarnessMark } from './Chrome.tsx'
import { FolderPicker } from './Files.tsx'
import { IconAgent, IconCaret, IconCheck, IconFolder, IconImport, IconSend, IconSpinner, IconTerminal } from './Icons.tsx'
import { openImport } from './ImportSessions.tsx'
import { MenuTrigger, Select } from './Menu.tsx'
import { MicButton } from './Mic.tsx'
import { Lightbox } from './Overlays.tsx'
import { useAutosizeTextarea } from '../useAutosizeTextarea.ts'
import { useOverflowFade } from '../useOverflowFade.ts'

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept Edits',
  auto: 'Auto',
  manual: 'Manual',
  plan: 'Plan Only',
  bypassPermissions: 'Bypass All',
}

/**
 * A brand new tab.
 *
 * It asks one question — agent or terminal — and then gets out of the way. The
 * answer is fixed for that tab: a terminal is created immediately (there is
 * nothing to configure), while an agent keeps the inline composer, where the
 * first thing you type is the first thing the session does.
 */
export function Launchpad({ state, draft }: { state: State; draft: Draft }) {
  // A launch the server refuses leaves what was typed on the draft
  // (`pendingPrompt`). Seeding from it is what hands the prompt back: the tab
  // stops saying "launching", and the words come back into the box instead of
  // disappearing with a session that was never created.
  // Kept per tab (see `drafts.ts`): switching away and back, or reloading,
  // brings back what was written and pasted here.
  const { text, setText, attachments, setAttachments, documents, setDocuments } = useComposerDraft(draft.id, draft.pendingPrompt ?? '')
  const docs = useDocuments(documents, setDocuments, (value) => insertAtCaret(value))
  // The chooser ("What do you want to open?") never starts on the folder
  // picker: with every tab closed, that screen is the front door, and a picker
  // over it read as "pick a workspace" instead of "what do you want".
  const [picker, setPicker] = useState(Boolean(draft.needsFolder) && draft.kind !== null)
  /** The folder picked in this chooser, which only this screen has seen. */
  const [chosen, setChosen] = useState<{ path: string; host: string | null } | null>(null)
  const [uploading, setUploading] = useState(0)
  const [zoom, setZoom] = useState<number | null>(null)
  const [updatingHarness, setUpdatingHarness] = useState(false)
  const area = useAutosizeTextarea(text)
  const controlsLane = useOverflowFade<HTMLDivElement>()
  // The catalog of the machine this tab will run on — its own CLIs, its own
  // logins — not the one of whichever machine happens to be on screen.
  const caps = capsFor(state, draft.host)
  const server = serverCaps(state)
  const where = draft.host ?? 'this machine'
  // A scan that is still running, a scan that failed, and a machine with nothing
  // installed are three different things, and the picker says which one it is.
  const failure = capsErrorFor(state, draft.host) ?? caps?.probeError ?? null
  const scanning = !caps && !failure
  // A streamed harness needs an adapter; a TUI-only one (Freebuff) needs none,
  // because it opens as the terminal tab it is. Both belong in this list.
  const harnesses = useMemo(
    () => (caps?.harnesses ?? []).filter((harness) => harness.installed && (harness.wired || harness.tui)),
    [caps],
  )
  const harness = harnesses.find((item) => item.id === draft.harness) ?? harnesses[0]
  const updateError = harness ? harnessUpdateError(state, harness.id, draft.host) : null
  // Wired harnesses whose binary is not on this machine, so the empty state can
  // name the exact thing to install instead of hinting at four alternatives.
  const missing = useMemo(
    () => (caps?.harnesses ?? []).filter((item) => item.wired && !item.installed),
    [caps],
  )

  // `/` works here too: the first message is often exactly a skill you want to
  // run, and it should be pickable before the session exists, not after.
  const [commands, setCommands] = useState<HarnessCommand[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const slashList = useRef<HTMLDivElement>(null)

  // The machine may have been picked before we ever asked about it (a tab
  // restored on a server, a folder opened from the palette): ask now, so the
  // harness list is that machine's and not an empty one.
  useEffect(() => ensureCaps(draft.host), [draft.host])

  useEffect(() => {
    let alive = true
    void fetchCommands(harness?.id ?? draft.harness, draft.cwd, draft.host).then((list) => {
      if (alive) setCommands(list)
    })
    return () => {
      alive = false
    }
  }, [harness?.id, draft.harness, draft.cwd, draft.host])

  const slashQuery = text.startsWith('/') && !text.includes(' ') ? text.slice(1).toLowerCase() : null
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery))),
    [slashQuery, commands],
  )
  const slashOpen = slashMatches.length > 0

  useEffect(() => setSlashIndex(0), [slashQuery])

  useEffect(() => {
    setSlashIndex((value) => Math.min(value, Math.max(0, slashMatches.length - 1)))
    slashList.current?.querySelector('.slash-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex, slashMatches.length])

  const insertCommand = (name: string) => {
    setText(`/${name} `)
    area.current?.focus()
  }

  useEffect(() => {
    if (draft.kind === 'agent') area.current?.focus()
  }, [draft.kind])

  /**
   * The prompt of a refused launch, handed back.
   *
   * `pendingId` is dropped the moment the server refuses, and `pendingPrompt`
   * outlives it by exactly this long. The screen may never have unmounted — in
   * which case what is already in the box is the same text and wins — so the
   * seeded value is only used when the box is empty. Clearing it afterwards is
   * what makes this happen once rather than on every later render.
   */
  useEffect(() => {
    const held = draft.pendingPrompt
    if (!held || draft.pendingId) return
    setText((current) => (current.trim() ? current : held))
    area.current?.focus()
    updateDraft(draft.id, { pendingPrompt: undefined })
  }, [draft.pendingPrompt, draft.pendingId, draft.id])

  useEffect(() => {
    // A harness may disappear (uninstalled): keep the draft launchable.
    if (harnesses.length && !harnesses.some((item) => item.id === draft.harness)) {
      updateDraft(draft.id, { harness: harnesses[0]!.id })
    }
  }, [harnesses, draft.harness, draft.id])

  const go = () => {
    // An edited document still uploading would go out as its old version.
    if (docs.busy) return
    // Pictures first, so `[image:N]` is still the Nth attachment.
    const all = [...attachments, ...documents]
    launchDraft(draft.id, text.trim() || undefined, all.length ? all : undefined)
  }

  const insertAtCaret = (snippet: string) => {
    const caret = area.current?.selectionStart
    setText((current) => {
      const at = caret ?? current.length
      return `${current.slice(0, at)}${snippet}${current.slice(at)}`
    })
  }

  /**
   * The first message can carry images too: the bytes are uploaded here and the
   * session is created with them, so a screenshot dropped before the session
   * exists is not lost.
   */
  const addImages = (files: File[]) => {
    // Asked of the model the draft is about to run, not of the harness: only the
    // model knows whether it can read the image.
    const verdict = takesImages(state, draft.harness, draft.model, draft.host)
    if (!verdict.ok) {
      notify('error', verdict.why ?? 'this model does not take images')
      return
    }
    const first = attachments.length + uploading + 1
    insertAtCaret(files.map((_, index) => imageToken(first + index)).join(' '))
    setUploading((count) => count + files.length)
    files.forEach((file, index) => {
      uploadAttachment(file, file.name || `pasted-${first + index}.png`)
        .then((ref) => setAttachments((list) => [...list, ref]))
        .catch((error: unknown) => {
          notify('error', error instanceof Error ? error.message : String(error))
          setText((current) => dropImageToken(current, first + index))
        })
        .finally(() => setUploading((count) => count - 1))
    })
  }

  /** Pictures go in as `[image:N]` chips, text files as document tiles. */
  const attachFiles = (files: File[]) => {
    const { images, documents: texts } = sortFiles(files)
    if (images.length) addImages(images)
    if (texts.length) docs.addFiles(texts)
    return images.length + texts.length > 0
  }

  /** A long paste becomes a document rather than a wall of text in the box. */
  const paste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachFiles(transferFiles(event.clipboardData))) {
      event.preventDefault()
      return
    }
    const pasted = event.clipboardData.getData('text/plain')
    if (!isLongPaste(pasted)) return
    event.preventDefault()
    docs.addPaste(pasted)
  }

  /** A dropped image lands where it was dropped, like a pasted one. */
  const drop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    const files = transferFiles(event.dataTransfer)
    const { images, documents: texts } = sortFiles(files)
    if (!images.length && !texts.length) return
    event.preventDefault()
    const area = event.currentTarget
    area.focus()
    const at = caretAtPoint(area, event.clientX, event.clientY)
    if (at !== null) area.setSelectionRange(at, at)
    attachFiles(files)
  }

  const removeAttachment = (index: number) => {
    setAttachments((list) => list.filter((_, position) => position !== index))
    setText((current) => dropImageToken(current, index + 1))
  }

  /**
   * Typing, with the images kept in step: the token and the picture are one thing
   * in two places, so deleting any part of a token deletes both.
   */
  const editText = (value: string) => {
    const synced = syncImageTokens(value, attachments.length, uploading)
    if (!synced) {
      setText(value)
      return
    }
    setAttachments((list) => synced.kept.map((number) => list[number - 1]!).filter(Boolean))
    setText(synced.text)
  }

  /**
   * A terminal needs no form, so it opens straight away: in the folder picked in
   * this chooser when there is one, and otherwise in the machine's home. The
   * folder the draft inherited from the last workspace is *not* a choice made
   * here — it is not on screen — so a terminal does not quietly start in it.
   */
  const startTerminal = () => {
    closeDraft(draft.id)
    void newTerminal(
      getState(),
      chosen ? { cwd: chosen.path, host: chosen.host } : { host: draft.host },
    )
  }

  /**
   * The models this harness offers, read as rows worth reading (see `models.ts`),
   * and the efforts the chosen one can be asked for — a catalog that encodes the
   * effort in its ids gets no separate effort flag, so picking one rewrites the id.
   */
  const draftChoices = useMemo(() => {
    const list = [...(harness?.models ?? [])]
    // A model remembered from the last session on this harness may not be in the
    // catalog we just read — a version retired, a machine with a different
    // install. It is still the value that will be sent, so it gets a row, read
    // as a name rather than printed as the id (see `modelName`).
    if (draft.model && !findModelChoice(modelChoices(list), draft.model)) {
      list.unshift({ id: draft.model, label: modelName(draft.model) })
    }
    return modelChoices(list)
  }, [harness, draft.model, state.version])
  const draftChosen = useMemo(() => {
    return findModelChoice(draftChoices, draft.model) ?? draftChoices.find((choice) => choice.isDefault)
  }, [draftChoices, draft.model])
  const selectedDraftModel = useMemo(
    () => (draft.model ? readModel({ id: draft.model, label: draft.model }) : undefined),
    [draft.model],
  )
  const draftEffort = useMemo(
    () => effortCapability(harness?.models ?? [], draftChosen?.base ?? ''),
    [draftChosen, harness, state.version],
  )
  const draftEfforts = draftEffort.levels
  const draftEffortsKnown = Boolean(draftChosen) && draftEffort.known
  const draftEffortsFixed = Boolean(draftChosen) && draftEffort.fixed
  const wantedDraftEffort = selectedDraftModel?.effort ?? draft.effort ?? draftChosen?.defaultEffort ?? ''
  const draftEffortValue = draftEfforts.includes(wantedDraftEffort) ? wantedDraftEffort : ''

  // The in-app explorer, rendered by both branches: a new tab that has no folder
  // yet asks for one here, and the folder control on the form can open it too.
  // Which machine it browses is the top-left selector's business — not another
  // picker inside the picker.
  const folderPicker = picker ? (
    <FolderPicker
      value={draft.cwd}
      host={draft.host}
      onPick={(path, host) => {
        setChosen({ path, host })
        updateDraft(draft.id, { cwd: path, host, needsFolder: false })
        setPicker(false)
      }}
      onClose={() => setPicker(false)}
    />
  ) : null

  // A new tab is only a question: agent or terminal.
  if (draft.kind === null) {
    return (
      <div className="launchpad choose-launchpad">
        <div className="launchpad-inner">
          <h1 className="launchpad-title">What do you want to open?</h1>
          <p className="launchpad-sub">
            {draft.host
              ? `Start an agent or open a terminal on ${draft.host}.`
              : 'Start an agent or open a terminal on this machine.'}
          </p>
          <div className="choose-row">
            <button type="button" className="choose-card" onClick={() => updateDraft(draft.id, { kind: 'agent' })}>
              <span className="choose-card-top">
                <span className="choose-icon"><IconAgent size={19} /></span>
                <span className="choose-shortcut"><kbd>⌘</kbd><kbd>D</kbd></span>
              </span>
              <span className="choose-title">Agent</span>
              <span className="choose-sub">
                {harnesses.length
                  ? harnesses
                      .slice(0, 3)
                      .map((item) => item.label)
                      .join(', ')
                  : scanning
                    ? `Checking agents on ${where}…`
                    : failure
                      ? `Could not load agents on ${where}`
                      : `No agents detected on ${where}`}
              </span>
            </button>
            <button type="button" className="choose-card" onClick={() => void startTerminal()}>
              <span className="choose-card-top">
                <span className="choose-icon"><IconTerminal size={19} /></span>
                <span className="choose-shortcut"><kbd>⌘</kbd><kbd>T</kbd></span>
              </span>
              <span className="choose-title">Terminal</span>
              <span className="choose-sub">
                {draft.host ? `A shell on ${draft.host}, in tmux` : 'Opens right here, in tmux'}
              </span>
            </button>
          </div>
          {/* The machine is chosen in the top-left selector and the two cards
              follow it — asking again here was a second copy of one decision. */}
          {folderPicker}
        </div>
      </div>
    )
  }

  const tuiHarness = Boolean(harness?.tui)

  return (
    <div className="launchpad">
      <div className="launchpad-inner">
        <h1 className="launchpad-title">What should we build?</h1>
        <p className="launchpad-sub">
          {tuiHarness ? (
            <>
              {harness?.label} is a terminal UI with no headless mode, so this opens a real terminal tab running it.
            </>
          ) : harness ? (
            <>
              {harness.label}
              {harness.version ? ` ${harness.version}` : ''} in <span className="mono">{draft.cwd}</span>
            </>
          ) : scanning ? (
            <>
              <IconSpinner size={15} className="spin" /> Scanning <span className="mono">{where}</span> for harnesses…
            </>
          ) : failure ? (
            <>Could not read the harnesses on <span className="mono">{where}</span>.</>
          ) : (
            'No harness is installed yet.'
          )}
        </p>

        {harness?.update?.status === 'available' ? (
          <div className="harness-health update">
            <span>
              Update available: <strong>{harness.update.installedVersion}</strong> → <strong>{harness.update.latestVersion}</strong>
            </span>
            {harness.update.updateCommand ? (
              <button
                type="button"
                disabled={updatingHarness}
                title={harness.update.updateCommand}
                onClick={() => {
                  setUpdatingHarness(true)
                  void updateHarnessAdapter(harness.id, draft.host).finally(() => setUpdatingHarness(false))
                }}
              >
                {updatingHarness ? <><IconSpinner size={13} className="spin" /> Updating…</> : 'Update now'}
              </button>
            ) : null}
          </div>
        ) : harness?.update?.status === 'unknown' ? (
          <div className="harness-health warn">Update check unavailable: {harness.update.detail}</div>
        ) : null}
        {updateError ? <p className="harness-update-error" role="alert">Update failed: {updateError}</p> : null}

        <div className="launchpad-anchor">
          {slashOpen ? (
            <div className="slash-menu">
              <div className="slash-inner">
                <div className="menu-title">
                  {harness?.label ?? 'Harness'} commands &amp; skills · {slashMatches.length}
                </div>
                <div className="slash-list" ref={slashList}>
                  {slashMatches.map((command, index) => (
                    <button
                      key={command.name}
                      className={`slash-item${index === slashIndex ? ' sel' : ''}`}
                      onMouseEnter={() => setSlashIndex(index)}
                      onClick={() => insertCommand(command.name)}
                    >
                      {command.kind === 'skill' ? <span className="slash-kind">skill</span> : null}
                      <span className="slash-name mono">/{command.name}</span>
                      <span className="slash-desc">{command.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
          <div className="launchpad-field">
            {attachments.length || uploading || documents.length || docs.busy ? (
              <div className="attach-strip">
                {attachments.map((attachment, index) => (
                  <div className="attach" key={attachment.id}>
                    <img
                      src={attachmentUrl(attachment)}
                      alt={attachment.name}
                      title={attachment.name}
                      onClick={() => setZoom(index)}
                    />
                    <span className="attach-tag mono">{index + 1}</span>
                    <button
                      className="attach-remove"
                      title={`Remove ${attachment.name}`}
                      onClick={() => removeAttachment(index)}
                    >
                      <IconClose size={10} strokeWidth={2.2} />
                    </button>
                  </div>
                ))}
                {docs.tiles}
                {uploading || docs.busy ? <div className="attach pending">uploading…</div> : null}
              </div>
            ) : null}
            <PromptField
              ref={area}
              rows={2}
              value={text}
              spellCheck={false}
              onPaste={paste}
              onDrop={drop}
              onDragOver={allowFileDrop}
              ready={attachments.length}
              placeholder={
                harness
                  ? `Ask ${harness.label} anything, or describe the task`
                  : scanning
                    ? `Scanning ${where} for harnesses…`
                    : 'Install a harness to start a session'
              }
              onChange={(event) => editText(event.target.value)}
              onKeyDown={(event) => {
                if (slashOpen) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setSlashIndex((value) => Math.min(slashMatches.length - 1, value + 1))
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setSlashIndex((value) => Math.max(0, value - 1))
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setText('')
                    return
                  }
                  if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                    event.preventDefault()
                    insertCommand(slashMatches[slashIndex]!.name)
                    return
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  go()
                }
              }}
            />
          <div className="launchpad-row">
            <div className="composer-controls launchpad-controls" aria-label="Session setup" ref={controlsLane}>
            <WorkspaceMenu
              state={state}
              draft={draft}
              onPick={(path) => {
                setChosen({ path, host: draft.host })
                updateDraft(draft.id, { cwd: path, needsFolder: false })
              }}
              onOpenFolder={() => setPicker(true)}
            />
            <Select
              value={draft.harness}
              title="Harness"
              // Nothing to pick from while the machine is being scanned, and
              // nothing to pick from when it has nothing: either way the chip
              // says so instead of offering an empty list.
              disabled={scanning}
              placeholder={scanning ? 'Scanning…' : 'No Harness'}
              options={harnesses.map((item) => ({
                value: item.id,
                label: item.label,
                icon: <HarnessMark harness={item.id} kind="agent" size={14} />,
                hint: item.tui ? 'Opens A Terminal Tab' : undefined,
              }))}
              // A model id means nothing to another CLI, so switching harness
              // also switches to whatever that harness was last used with.
              onChange={(value) => {
                const harness = value as Draft['harness']
                const remembered = agentDefaultsFor(state, harness)
                updateDraft(draft.id, {
                  harness,
                  model: remembered.model ?? null,
                  effort: remembered.effort ?? null,
                  permissionMode: remembered.permissionMode ?? draft.permissionMode,
                })
              }}
            />
            <Select
              value={draftChoices.length ? (draftChosen?.id ?? '') : (draft.model ?? '')}
              icon={<IconModel size={15} />}
              footerAction={harness && !harness.tui ? {
                label: 'Refresh models & version',
                onClick: () => {
                  notify('info', `Refreshing ${harness.label} in the background…`)
                  void inspectHarness(harness.id, draft.host)
                },
              } : undefined}
              // The label is the readable name; the exact id stays one hover away.
              title={`${harness?.modelsNote ?? 'Model'}${draft.model ? `\n${draft.model}` : ''}`}
              width={380}
              placeholder="Default Model"
              // The harness list already carries its own default row; adding
              // another one here produced two identical "default" entries. When
              // it carries nothing, the row says why instead of looking like the
              // whole catalog.
              options={
                draftChoices.length
                  ? draftChoices.map((choice) => ({
                      value: choice.id,
                      label: choice.label,
                      suffix: choice.suffix ?? undefined,
                    }))
                  : [{ value: '', label: 'Default Model', hint: modelsWhy(state, draft.harness, draft.host) ?? undefined }]
              }
              onChange={(value) => {
                const next = draftChoices.find((choice) => choice.id === value || choice.base === value)
                const allowed = next ? effortCapability(harness?.models ?? [], next.base).levels : []
                const current = selectedDraftModel?.effort ?? draft.effort
                const keep = current && allowed.includes(current) ? current : null
                const effective = keep ?? (next?.encodedEffort ? (allowed[0] ?? null) : null)
                updateDraft(draft.id, {
                  model: next?.encodedEffort ? modelWithEffort(next, effective) : (value || null),
                  effort: (next?.encodedEffort ? null : keep) as EffortLevel | null,
                })
              }}
            />
            <Select
              value={draftEffortValue}
              title={draftEfforts.length ? `Reasoning effort this model offers: ${draftEfforts.join(', ')}` : 'Reasoning effort'}
              icon={<IconBrain size={15} />}
              options={effortOptions({ levels: draftEfforts, fixed: draftEffortsFixed }, Boolean(draftChosen?.encodedEffort))}
              disabled={!draftEffortsKnown || draftEffortsFixed}
              onChange={(value) => {
                // Where the catalog puts the effort in the model id, that id is
                // what the harness is asked for.
                if (draftEfforts.length && draftChosen?.encodedEffort) {
                  updateDraft(draft.id, { model: modelWithEffort(draftChosen, value || null) })
                  return
                }
                updateDraft(draft.id, { effort: (value || null) as EffortLevel | null })
              }}
            />
            <Select
              value={draft.permissionMode}
              icon={<IconShield size={15} />}
              title="Tool approvals"
              // Only the modes the harness will honour, as published for the
              // machine this tab will run on: `manual` and `auto` were offered
              // everywhere and meant something nowhere.
              options={permissionModeOptions(draft.harness, draft.permissionMode, harness?.permissionModes).map((mode) => ({
                value: mode,
                label: PERMISSION_LABEL[mode],
              }))}
              onChange={(value) => updateDraft(draft.id, { permissionMode: value as PermissionMode })}
            />
            </div>
            <div className="composer-actions">
            <AttachButton onFiles={attachFiles} />
            <MicButton
              voice={server?.voice}
              onText={(value) => setText((current) => (current ? `${current.trimEnd()} ${value}` : value))}
            />
            <button
              className="send"
              onClick={go}
              disabled={(!text.trim() && !attachments.length && !documents.length) || docs.busy > 0 || !draft.cwd || !harness}
              title="Start the session (↵)"
            >
              <IconSend />
            </button>
            </div>
          </div>
          {!draft.cwd ? (
            <div className="workspace-required" id={`workspace-required-${draft.id}`} role="status">
              Choose A Workspace To Enable Send
            </div>
          ) : null}
          </div>
        </div>

        {folderPicker}

        {zoom !== null ? <Lightbox images={attachments} index={zoom} onClose={() => setZoom(null)} /> : null}
        {docs.viewer}

        {!harnesses.length ? (
          <p className="launchpad-note">
            {failure ? (
              <>
                No harness could be read on <span className="mono">{where}</span> — {failure}
              </>
            ) : scanning ? (
              <>
                <IconSpinner size={15} className="spin" /> Looking for a harness on{' '}
                <span className="mono">{where}</span>…
              </>
            ) : (
              <>
                No agent harness found on {where}. Install{' '}
                <span className="mono">
                  {(missing.length
                    ? missing.map((item) => item.bin)
                    : ['claude', 'cmd', 'opencode', 'codex-acp', 'gemini']
                  ).join(', ')}
                </span>{' '}
                and reopen this tab.
              </>
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** How many recent folders the workspace menu offers before "Open folder…". */
const RECENT_WORKSPACES = 6

/** `/Users/me/code/app` → `~/code/app`: the part of a path worth reading. */
function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/**
 * The folders this machine has run sessions in, most recently used first, with
 * the draft's own folder always among them so the check mark has a row.
 */
function recentWorkspaces(state: State, host: string | null, current: string): string[] {
  const lastUsed = new Map<string, number>()
  for (const session of Object.values(state.sessions)) {
    if (session.host !== host || !session.cwd) continue
    lastUsed.set(session.cwd, Math.max(lastUsed.get(session.cwd) ?? 0, session.updatedAt))
  }
  const recent = [...lastUsed.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cwd]) => cwd)
    .slice(0, RECENT_WORKSPACES)
  return current && !recent.includes(current) ? [current, ...recent.slice(0, RECENT_WORKSPACES - 1)] : recent
}

/**
 * The folder chip: recent workspaces to switch to in one click, then the two
 * things you do with a folder that is not in the list — open another one, or
 * bring existing sessions of this one into sedano.
 */
function WorkspaceMenu({
  state,
  draft,
  onPick,
  onOpenFolder,
}: {
  state: State
  draft: Draft
  onPick: (path: string) => void
  onOpenFolder: () => void
}) {
  const recent = recentWorkspaces(state, draft.host, draft.cwd)
  return (
    <MenuTrigger
      className="select-wrap workspace-menu"
      width={320}
      title={draft.cwd ? `Where the agent works\n${draft.cwd}` : 'Choose a workspace before sending'}
      trigger={(open) => (
        <span className={`chip-select workspace-select${!draft.cwd ? ' missing' : ''}`}>
          <span className="chip-icon"><IconFolder size={15} /></span>
          <span className="chip-label">{baseName(draft.cwd) || draft.cwd || 'No Workspace'}</span>
          <span className={`caret${open ? ' open' : ''}`}>
            <IconCaret size={17} />
          </span>
        </span>
      )}
    >
      {(close) => (
        <>
          {recent.length ? <div className="menu-title">Recent workspaces</div> : null}
          {recent.map((path) => (
            <button
              key={path}
              type="button"
              className={`menu-item${path === draft.cwd ? ' current' : ''}`}
              title={path}
              onClick={() => {
                close()
                if (path !== draft.cwd) onPick(path)
              }}
            >
              <IconFolder size={15} className="menu-item-glyph" />
              <span className="menu-item-name">{baseName(path) || path}</span>
              <span className="menu-item-meta">{tildePath(path)}</span>
              <span className="spacer" />
              {path === draft.cwd ? <IconCheck size={14} className="check" /> : null}
            </button>
          ))}
          {recent.length ? <div className="menu-sep" /> : null}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              close()
              onOpenFolder()
            }}
          >
            <IconFolder size={15} className="menu-item-glyph" />
            <span className="menu-item-name">Open folder…</span>
          </button>
          <button
            type="button"
            className="menu-item"
            disabled={!draft.cwd}
            title={draft.cwd ? 'Import sessions of this folder (archived, or from any harness)' : 'Choose a workspace first'}
            onClick={() => {
              close()
              openImport({ cwd: draft.cwd, host: draft.host })
            }}
          >
            <IconImport size={15} className="menu-item-glyph" />
            <span className="menu-item-name">Import sessions…</span>
          </button>
        </>
      )}
    </MenuTrigger>
  )
}
