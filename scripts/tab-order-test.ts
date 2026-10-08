import { strict as assert } from 'node:assert'

const storage = new Map<string, string>([
  ['sedano.tabs', JSON.stringify({ '/local': ['a', 'b'], 'vps:/remote': ['c'] })],
  ['sedano.tab-order', JSON.stringify(['c', 'a', 'b', 'closed'])],
])

const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size },
}

Object.assign(globalThis, {
  localStorage,
  window: { location: { protocol: 'http:', host: 'localhost:7788' } },
  location: { protocol: 'http:', host: 'localhost:7788' },
})

const store = await import('../apps/ui/src/store.ts')
const { applyTabOp, asTabOp } = await import('../packages/shared/src/tabs.ts')

assert.deepEqual(store.orderedTabs(), ['c', 'a', 'b'], 'closed tabs are removed while cross-workspace order survives')
store.reorderTab('b', 'c')
assert.deepEqual(store.orderedTabs(), ['b', 'c', 'a'], 'a tab can move before a tab from another workspace')
store.reorderTab('b', 'a', true)
assert.deepEqual(store.orderedTabs(), ['c', 'a', 'b'], 'a tab can move after the last tab')
assert.deepEqual(
  (JSON.parse(storage.get('sedano.open-tabs')!) as Array<{ id: string }>).map((tab) => tab.id),
  ['c', 'a', 'b'],
  'order is persisted',
)

// The rule book the server and every client share.
const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const ids = (tabs: Array<{ id: string }>) => tabs.map((tab) => tab.id)
assert.deepEqual(ids(applyTabOp(list, { op: 'open', tab: { id: 'd' }, after: 'a' })), ['a', 'd', 'b', 'c'], 'open after an anchor')
assert.equal(applyTabOp(list, { op: 'open', tab: { id: 'b' } }), list, 'opening an open tab changes nothing')
assert.deepEqual(ids(applyTabOp(list, { op: 'close', id: 'b' })), ['a', 'c'], 'close')
const moved = applyTabOp(list, { op: 'move', id: 'a', target: 'c', after: true })
assert.deepEqual(ids(moved), ['b', 'c', 'a'], 'move after')
assert.equal(applyTabOp(moved, { op: 'move', id: 'a', target: 'c', after: true }), moved, 'a replayed move is a no-op')
assert.deepEqual(ids(applyTabOp(list, { op: 'replace', from: 'b', to: 's' })), ['a', 's', 'c'], 'replace keeps the spot')
assert.deepEqual(ids(applyTabOp(list, { op: 'replace', from: 'x', to: 's' })), ['a', 'b', 'c', 's'], 'replace of a closed draft still opens the session')
const merged = applyTabOp(list, { op: 'merge', tabs: [{ id: 'z' }, { id: 'b' }, { id: 'y' }] })
assert.deepEqual(ids(merged), ['a', 'z', 'b', 'y', 'c'], 'merge is a union that keeps both orders')
assert.deepEqual(ids(applyTabOp([{ id: 's' }], { op: 'merge', tabs: [{ id: 'n0' }, { id: 's' }, { id: 'n1' }] })), ['n0', 's', 'n1'], 'a tab with nothing before it goes before the one it preceded')
assert.equal(applyTabOp(merged, { op: 'merge', tabs: [{ id: 'z' }, { id: 'b' }, { id: 'y' }] }), merged, 'merging twice changes nothing')
assert.equal(asTabOp({ op: 'open', tab: { id: 3 } }), null, 'a malformed op is refused')
assert.equal(asTabOp({ op: 'nope' }), null, 'an unknown op is refused')

console.log('tab-order-test: PASSED (16 checks)')
