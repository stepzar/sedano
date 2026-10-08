/**
 * Directory listing, for the folder picker and the file panel.
 *
 * The server is already limited to loopback plus an `Origin` check, and every
 * session it runs can read the whole filesystem through a shell — this endpoint
 * therefore grants nothing new. It stays deliberately read-only and returns one
 * level at a time, so a listing is never a tree walk of your home directory.
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { Transport, type DirItem } from './transport.ts'
import { requireHost } from './hosts.ts'

export interface DirEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  /** True for dotfiles, so the UI can de-emphasise them. */
  hidden: boolean
}

export interface DirListing {
  path: string
  name: string
  parent: string | null
  entries: DirEntry[]
}

export function homeDirectory(): string {
  return process.env.HOME ?? homedir()
}

/**
 * Where a shell belongs on a machine when the caller has no folder in mind: the
 * home of the machine that will run it, not of the one asking.
 *
 * Throws when the host cannot be asked. It used to hand back an empty string and
 * let the caller "fall back", which in practice meant a remote terminal opened in
 * a path that exists on this laptop and nowhere else — a failure dressed up as an
 * answer. An unreachable machine has no home to offer and says so.
 */
export function homeFor(host: string | null): string {
  if (!host) return homeDirectory()
  return new Transport(requireHost(host)!).home()
}

export function listDirectory(target: string): DirListing {
  const path = resolve(target)
  const stat = statSync(path)
  if (!stat.isDirectory()) throw new Error(`${path} is not a directory`)

  const entries: DirEntry[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    // Symlinks are resolved so a link to a directory browses like a directory.
    let isDirectory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(resolve(path, entry.name)).isDirectory()
      } catch {
        isDirectory = false
      }
    }
    entries.push({
      name: entry.name,
      path: resolve(path, entry.name),
      kind: isDirectory ? 'dir' : 'file',
      hidden: entry.name.startsWith('.'),
    })
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })

  const parent = dirname(path)
  return {
    path,
    name: basename(path) || path,
    parent: parent === path ? null : parent,
    entries,
  }
}

/**
 * The same listing, on an SSH host. An empty path starts at the host's home, so
 * the picker opens where the work is on that machine — the local home directory
 * would be a lie it cannot navigate.
 *
 * The paths are the host's own (POSIX), so they are kept verbatim rather than
 * run through the local `resolve`.
 */
export function listDirectoryRemote(host: string, target: string): DirListing {
  // The allowlist is checked here as well as at the endpoint: this function is
  // reachable from more than one caller and none of them may pick the machine.
  const transport = new Transport(requireHost(host)!)
  const path = target || transport.home()
  return remoteListing(path, transport.listDir(path))
}

function remoteListing(path: string, items: DirItem[]): DirListing {
  const entries: DirEntry[] = items.map((item) => ({
    name: item.name,
    path: path.endsWith('/') ? `${path}${item.name}` : `${path}/${item.name}`,
    kind: item.dir ? 'dir' : 'file',
    hidden: item.hidden,
  }))

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })

  const parent = dirname(path)
  return {
    path,
    name: basename(path) || path,
    parent: parent === path ? null : parent,
    entries,
  }
}

/** Local or remote, chosen by whether a host was given. */
export function listDirectoryFor(host: string | null, target: string): DirListing {
  return host ? listDirectoryRemote(host, target) : listDirectory(target || homeDirectory())
}

/**
 * The same, for the HTTP endpoints. A remote listing is one or two ssh round
 * trips, and the synchronous version held the whole server — every socket and
 * stream — for as long as a slow host took to answer the picker.
 */
export async function listDirectoryForAsync(host: string | null, target: string): Promise<DirListing> {
  if (!host) return listDirectory(target || homeDirectory())
  const transport = new Transport(requireHost(host)!)
  const path = target || (await transport.homeAsync())
  return remoteListing(path, await transport.listDirAsync(path))
}

export async function homeForAsync(host: string | null): Promise<string> {
  if (!host) return homeDirectory()
  return new Transport(requireHost(host)!).homeAsync()
}
