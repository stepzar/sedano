#!/usr/bin/env bun
/**
 * The transcript follows the answer like a chat: after a prompt is sent it
 * stays at the bottom through the work, the fold of a settled turn and the
 * reply — including content rewritten in place (a prompt going from queued to
 * delivered, an ACP call learning more), which does not change the event
 * count. A reader who scrolled up is left where they are; sending again takes
 * them back down. Chrome and WebKit, against a throwaway store; the frames are
 * fed to the page's own socket handler, so nothing reaches the server.
 *
 *   bun scripts/follow-ui-test.ts
 */
import { chromium, webkit } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { openRichestSession, resolveApp } from './lib/app.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const target = await resolveApp()
try {
  for (const which of ['chromium', 'webkit'] as const) {
    const browser = which === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
    await page.addInitScript(() => {
      const Native = window.WebSocket
      ;(window as any).__ws = []
      window.WebSocket = class extends Native { constructor(...a: any[]) { super(...(a as [string])); (window as any).__ws.push(this) } } as any
    })
    await page.goto(target.url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    await openRichestSession(page)
    const log = await page.evaluate(async () => {
      const w = window as any
      const ws = w.__ws.find((s: WebSocket) => s.url.includes('/api/ws'))
      const push = (msg: unknown) => ws.onmessage({ data: JSON.stringify(msg) })
      const scroller = document.querySelector('.transcript') as HTMLElement
      const gap = () => Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
      const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms))
      const sessionId = (document.querySelector('.tabs .tab.active') as HTMLElement).dataset.tabId!
      let seq = 900000
      const turnId = 'follow-turn'
      const event = (id: string, ev: unknown, extra: Record<string, unknown> = {}) =>
        push({ t: 'event', sessionId, event: { id, sessionId, seq: ++seq, at: Date.now(), turnId, ev, ...extra } })
      const out: Record<string, number> = {}
      scroller.scrollTop = scroller.scrollHeight
      await wait()
      event('follow-prompt', { k: 'user', text: 'a new prompt', delivery: 'queued', promptId: 'fp' })
      await wait()
      event('follow-prompt', { k: 'user', text: 'a new prompt', delivery: 'delivered', promptId: 'fp' })
      await wait()
      out.afterSend = gap()
      for (let i = 0; i < 8; i++) {
        event(`follow-t${i}`, { k: 'tool', toolId: `follow-t${i}`, name: 'Bash', input: { command: `step ${i}` }, summary: `step ${i}` })
        await wait(60)
      }
      await wait()
      out.afterTools = gap()
      let worst = 0
      for (let i = 0; i < 6; i++) {
        event('follow-grow', { k: 'assistant', text: 'growing note '.repeat(30 * (i + 1)) })
        await wait(80)
        worst = Math.max(worst, gap())
      }
      out.whileGrowing = worst
      for (let i = 0; i < 20; i++) {
        push({ t: 'delta', sessionId, agentId: null, turnId, kind: 'text', text: `streamed words ${i}. ` })
        await wait(30)
      }
      await wait()
      out.whileStreaming = gap()
      event('follow-reply', { k: 'assistant', text: 'The final answer.\n\n' + 'A long paragraph of reply. '.repeat(40) })
      event('follow-result', { k: 'result', subtype: 'success', outcome: 'completed', text: '', durationMs: 1000, costUsd: 0 })
      await wait(900)
      out.afterSettle = gap()
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 600)
      await wait()
      const before = scroller.scrollTop
      event('follow-late', { k: 'system', subtype: 'info', text: 'a late line' })
      await wait(400)
      out.readerMoved = Math.round(scroller.scrollTop - before)
      out.pill = document.querySelector('.jump') ? 1 : 0
      event('follow-prompt-2', { k: 'user', text: 'second prompt', delivery: 'delivered' }, { turnId: 'follow-turn-2' })
      await wait()
      out.afterSecondSend = gap()
      return out
    })
    const bottom = (value: number | undefined) => value !== undefined && value < 2
    check(`${which}: a sent prompt is followed`, bottom(log.afterSend), log)
    check(`${which}: tool calls keep it at the bottom`, bottom(log.afterTools), log)
    check(`${which}: content rewritten in place keeps it at the bottom`, bottom(log.whileGrowing), log)
    check(`${which}: streaming keeps it at the bottom`, bottom(log.whileStreaming), log)
    check(`${which}: the settle, fold and reply keep it at the bottom`, bottom(log.afterSettle), log)
    check(`${which}: a reader scrolled up is not moved`, log.readerMoved === 0 && log.pill === 1, log)
    check(`${which}: sending again goes back to the bottom`, bottom(log.afterSecondSend), log)
    await browser.close()
  }
} finally {
  await runCleanups()
}
if (failures.length) {
  console.log(`\nfollow-ui-test: ${failures.length} FAILURES`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nfollow-ui-test: PASSED')
process.exit(0)
