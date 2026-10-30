import { describe, expect, test } from 'bun:test'
import { openMailDatabase } from '../db/mail-client'
import { createSendBodiesRepo } from '../db/send-bodies'
import { TEMPLATE_IDS } from '../emails/registry'
import { redactRendered, storeSendBody } from './send-body'

const rendered = { html: '<b>482913</b> and 482913', text: '482913 / 482913' }

describe('redactRendered', () => {
  test('replaces every occurrence in html and text', () => {
    expect(redactRendered(rendered, ['482913'])).toEqual({
      html: '<b>[redacted]</b> and [redacted]',
      text: '[redacted] / [redacted]',
    })
  })

  test('ignores empty secrets and leaves the rest untouched', () => {
    expect(redactRendered(rendered, [''])).toEqual(rendered)
    expect(redactRendered(rendered, [])).toEqual(rendered)
  })
})

describe('storeSendBody', () => {
  function setup() {
    return createSendBodiesRepo(openMailDatabase(':memory:'))
  }

  test("stores a registered template's body with its secrets redacted", () => {
    const bodies = setup()

    storeSendBody({
      sendBodies: bodies,
      sendId: 's1',
      rendered,
      templateId: TEMPLATE_IDS.shutterflowCode,
      templateProps: { kind: 'sign-in', code: '482913', expiresInMinutes: 10 },
    })

    expect(bodies.get('s1')).toMatchObject({
      html: '<b>[redacted]</b> and [redacted]',
      text: '[redacted] / [redacted]',
    })
  })

  test('stores a template without secrets verbatim', () => {
    const bodies = setup()

    storeSendBody({
      sendBodies: bodies,
      sendId: 's1',
      rendered,
      templateId: TEMPLATE_IDS.fppSender,
      templateProps: {},
    })
    storeSendBody({ sendBodies: bodies, sendId: 's2', rendered })

    expect(bodies.get('s1')).toMatchObject(rendered)
    expect(bodies.get('s2')).toMatchObject(rendered)
  })

  test('does not store a secret-bearing template without its props', () => {
    const bodies = setup()
    const lines: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => void lines.push(args)
    try {
      storeSendBody({
        sendBodies: bodies,
        sendId: 's1',
        rendered,
        templateId: TEMPLATE_IDS.shutterflowCode,
      })
      storeSendBody({
        sendBodies: bodies,
        sendId: 's2',
        rendered,
        templateId: TEMPLATE_IDS.shutterflowCode,
        templateProps: null,
      })
    } finally {
      console.error = original
    }

    expect(bodies.get('s1')).toBeNull()
    expect(bodies.get('s2')).toBeNull()
    expect(JSON.stringify(lines)).not.toContain('482913')
  })

  test('does not store when the secret is empty or not a string', () => {
    const bodies = setup()
    const lines: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => void lines.push(args)
    try {
      for (const [sendId, code] of [
        ['s1', ''],
        ['s2', undefined],
        ['s3', 482913],
      ] as const) {
        storeSendBody({
          sendBodies: bodies,
          sendId,
          rendered,
          templateId: TEMPLATE_IDS.shutterflowCode,
          templateProps: { kind: 'sign-in', code, expiresInMinutes: 10 },
        })
      }
    } finally {
      console.error = original
    }

    for (const id of ['s1', 's2', 's3']) expect(bodies.get(id)).toBeNull()
    expect(lines).toHaveLength(3)
    expect(JSON.stringify(lines)).not.toContain('482913')
  })

  test('a failing repo is logged without the body and never thrown', () => {
    const lines: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => void lines.push(args)
    try {
      expect(() =>
        storeSendBody({
          sendBodies: {
            save: () => {
              throw new Error('SQLITE_BUSY 482913')
            },
          },
          sendId: 's1',
          rendered,
        }),
      ).not.toThrow()
    } finally {
      console.error = original
    }

    expect(lines).toHaveLength(1)
    expect(JSON.stringify(lines)).not.toContain('482913')
  })
})
