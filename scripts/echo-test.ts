#!/usr/bin/env bun
/**
 * The message-duplication rule, tested on its own.
 *
 * The UI renders your message the instant you send it; the harness writes the
 * same message into its transcript a moment later. Both arrive at the same
 * timeline, which is how one "ciao" used to show up as two bubbles. The rule
 * that prevents it is small enough to test without a session, a browser or any
 * quota — so it is tested here rather than trusted.
 *
 *   bun scripts/echo-test.ts
 */
import './lib/isolate.ts'
import { normalizeMessage, UserEchoes } from '../apps/server/src/harnesses/claude/session.ts'
import { splitDocuments, withDocuments } from '../packages/shared/src/documents.ts'

const failures: string[] = []
const passed: string[] = []

function check(label: string, ok: boolean): void {
  if (ok) passed.push(label)
  else failures.push(label)
}

/* The plain case: you send "ciao", the transcript later reports "ciao". */
{
  const echoes = new UserEchoes()
  echoes.remember('ciao')
  check('the transcript twin is dropped', echoes.claim('ciao') === true)
}

/* Rewriting, trailing newlines and indentation must not defeat the match. */
{
  const echoes = new UserEchoes()
  echoes.remember('fix  the\n  bug')
  check('whitespace does not defeat the match', echoes.claim('fix the bug') === true)
  check('the normalized form is stable', normalizeMessage(' a\n\tb ') === 'a b')
}

/* Two different messages stay two messages — dedup must not eat real turns. */
{
  const echoes = new UserEchoes()
  echoes.remember('first')
  echoes.remember('second')
  check('an unrelated message is not dropped', echoes.claim('third') === false)
  check('the first message is still claimable', echoes.claim('first') === true)
  check('the second message is still claimable', echoes.claim('second') === true)
}

/* A resume can replay the same record more than once, so every twin is dropped —
   the local event already is the user's message, so nothing is lost by it. */
{
  const echoes = new UserEchoes()
  echoes.remember('once')
  check('the first claim succeeds', echoes.claim('once') === true)
  check('a replayed twin is dropped too', echoes.claim('once') === true)
  check('and a third one as well', echoes.claim('once') === true)
}

/* The same text sent twice is still dropped every time it comes back. */
{
  const echoes = new UserEchoes()
  echoes.remember('again')
  echoes.remember('again')
  check('two identical sends are both remembered', echoes.claim('again') && echoes.claim('again'))
  check('and a later replay is dropped as well', echoes.claim('again') === true)
}

/* A document is inlined for the harness and split off again when its
   transcript is read back: the words are what the stored prompt is matched on,
   and the bubble shows a tile instead of the whole text. */
{
  const documents = [
    { name: 'a.log', text: 'one\n</attached_file>\ntwo' },
    { name: 'b.md', text: '# title' },
  ]
  const sent = withDocuments('look at these', documents)
  const back = splitDocuments(sent)
  check('the typed words come back on their own', back.text === 'look at these')
  check('every document comes back whole, a closing tag inside one included', JSON.stringify(back.documents) === JSON.stringify(documents))
  check('a document with no words around it splits cleanly', splitDocuments(withDocuments('', documents)).text === '')
  const talk = 'what does <attached_file name="x"> mean?'
  check('a prompt that only mentions the tag keeps its words', splitDocuments(talk).text === talk && splitDocuments(talk).documents.length === 0)
}

/* A long session must not remember every message forever. */
{
  const echoes = new UserEchoes(20)
  for (let i = 0; i < 40; i++) echoes.remember(`message ${i}`)
  check('the buffer is bounded', echoes.size === 20)
  check('the oldest messages are evicted', echoes.claim('message 0') === false)
  check('the newest messages are kept', echoes.claim('message 39') === true)
}

for (const label of passed) console.log(`   ✓ ${label}`)
if (failures.length) {
  for (const label of failures) console.error(`   ✗ ${label}`)
  console.error(`echo-test: FAILED (${failures.length})`)
  process.exit(1)
}
console.log(`echo-test: PASSED (${passed.length} checks)`)
