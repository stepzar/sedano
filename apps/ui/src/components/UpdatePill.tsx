import { useEffect, useState } from 'react'
import { confirmDialog, notify } from '../store.ts'
import {
  canUpdate,
  checkForUpdate,
  currentVersion,
  installUpdate,
  restartToUpdate,
  startUpdateChecks,
  useUpdate,
} from '../updater.ts'
import { IconDownload, IconRefresh, IconWarning } from './Icons.tsx'
import '../update.css'

async function confirmRestart(version: string): Promise<void> {
  const ok = await confirmDialog({
    title: `Restart on Sedano ${version}?`,
    body: 'Sedano quits and opens again on the new version. Sessions and their history are kept; a turn still running may be interrupted.',
    confirmLabel: 'Restart',
  })
  if (ok) await restartToUpdate()
}

/**
 * The one place an update shows itself: a small pill in the corner, absent
 * until there is something to do. It never installs or restarts on its own.
 */
export function UpdatePill() {
  const update = useUpdate()
  useEffect(() => startUpdateChecks(), [])
  if (!canUpdate()) return null

  if (update.phase === 'available') {
    return (
      <button className="update-pill" onClick={() => void installUpdate()} title={`Download and install Sedano ${update.version}`}>
        <IconDownload size={13} />
        <span>Update to {update.version}</span>
      </button>
    )
  }
  if (update.phase === 'installing') {
    return (
      <div className="update-pill busy" role="status">
        <span>Updating{update.percent === null ? '…' : ` ${update.percent}%`}</span>
      </div>
    )
  }
  if (update.phase === 'ready') {
    return (
      <button className="update-pill ready" onClick={() => void confirmRestart(update.version)} title={`Sedano ${update.version} is installed`}>
        <IconRefresh size={13} />
        <span>Restart to update</span>
      </button>
    )
  }
  if (update.phase === 'error') {
    const retry = update.during === 'install' ? installUpdate : checkForUpdate
    return (
      <button className="update-pill error" onClick={() => void retry()} title={`${update.message}\n\nClick to try again.`} role="alert">
        <IconWarning size={13} />
        <span>{update.during === 'check' ? 'Update check failed' : 'Update failed'}</span>
      </button>
    )
  }
  return null
}

/** Settings → Advanced: what is running, and a check on demand. */
export function UpdateSettings() {
  const update = useUpdate()
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    void currentVersion().then(setVersion)
  }, [])

  const check = async () => {
    const result = await checkForUpdate()
    if (result.phase === 'current') notify('info', version ? `Sedano ${version} is the latest version.` : 'This is the latest version.')
    else if (result.phase === 'error') notify('error', `Could not check for updates: ${result.message}`)
  }

  const status = (() => {
    switch (update.phase) {
      case 'checking':
        return 'Checking…'
      case 'current':
        return `Up to date · checked ${new Date(update.checkedAt).toLocaleTimeString()}`
      case 'available':
        return `Sedano ${update.version} is available.`
      case 'installing':
        return `Installing ${update.version}…`
      case 'ready':
        return `Sedano ${update.version} is installed; restart to use it.`
      case 'error':
        return `Last ${update.during} failed: ${update.message}`
      default:
        return ''
    }
  })()

  return (
    <div className="update-settings">
      <div className="update-settings-row">
        <span className="update-version">{version ? `Sedano ${version}` : 'Sedano'}</span>
        {!canUpdate() ? null : update.phase === 'available' ? (
          <button type="button" onClick={() => void installUpdate()}>Install {update.version}</button>
        ) : update.phase === 'ready' ? (
          <button type="button" onClick={() => void confirmRestart(update.version)}>Restart to update</button>
        ) : (
          <button type="button" disabled={update.phase === 'checking' || update.phase === 'installing'} onClick={() => void check()}>
            Check for updates
          </button>
        )}
      </div>
      {canUpdate() ? (
        <div className={`set-item-why${update.phase === 'error' ? ' update-error' : ''}`} aria-live="polite">
          {status || 'Checked automatically every few hours.'}
        </div>
      ) : (
        <div className="set-item-why">Updates come with the Mac app.</div>
      )}
    </div>
  )
}
