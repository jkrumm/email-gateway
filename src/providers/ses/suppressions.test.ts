import {
  DeleteSuppressedDestinationCommand,
  ListSuppressedDestinationsCommand,
} from '@aws-sdk/client-sesv2'
import { describe, expect, test } from 'bun:test'
import { createSesSuppressions, isSuppressionNotFound, SUPPRESSION_PAGE_SIZE } from './suppressions'

function fakeClient(response: object) {
  const commands: unknown[] = []
  return {
    commands,
    client: {
      send: async (command: unknown) => {
        commands.push(command)
        return response
      },
    } as never,
  }
}

describe('createSesSuppressions', () => {
  test('list() maps the summaries and the next token', async () => {
    const fake = fakeClient({
      SuppressedDestinationSummaries: [
        {
          EmailAddress: 'a@example.com',
          Reason: 'BOUNCE',
          LastUpdateTime: new Date('2026-10-01T08:00:00.000Z'),
        },
        { EmailAddress: '', Reason: 'BOUNCE' },
      ],
      NextToken: 'next-1',
    })

    const page = await createSesSuppressions({ client: fake.client }).list()

    expect(page).toEqual({
      data: [
        {
          email: 'a@example.com',
          reason: 'BOUNCE',
          lastUpdate: '2026-10-01T08:00:00.000Z',
        },
      ],
      nextCursor: 'next-1',
    })
  })

  test('list() caps the page size and forwards the reason and cursor', async () => {
    const fake = fakeClient({})
    const suppressions = createSesSuppressions({ client: fake.client })

    await suppressions.list()
    await suppressions.list({ reason: 'COMPLAINT', cursor: 'tok' })

    const [first, second] = fake.commands as ListSuppressedDestinationsCommand[]
    expect(first).toBeInstanceOf(ListSuppressedDestinationsCommand)
    expect(first!.input).toEqual({ PageSize: SUPPRESSION_PAGE_SIZE })
    expect(second!.input).toEqual({
      PageSize: SUPPRESSION_PAGE_SIZE,
      Reasons: ['COMPLAINT'],
      NextToken: 'tok',
    })
  })

  test('an empty list has no cursor', async () => {
    const page = await createSesSuppressions({
      client: fakeClient({}).client,
    }).list()

    expect(page).toEqual({ data: [], nextCursor: null })
  })

  test('remove() sends DeleteSuppressedDestinationCommand', async () => {
    const fake = fakeClient({})

    await createSesSuppressions({ client: fake.client }).remove('a@example.com')

    expect(fake.commands[0]).toBeInstanceOf(DeleteSuppressedDestinationCommand)
    expect((fake.commands[0] as DeleteSuppressedDestinationCommand).input).toEqual({
      EmailAddress: 'a@example.com',
    })
  })
})

describe('isSuppressionNotFound', () => {
  test("matches SES's NotFoundException by name only", () => {
    const notFound = new Error('not on the list')
    notFound.name = 'NotFoundException'

    expect(isSuppressionNotFound(notFound)).toBe(true)
    expect(isSuppressionNotFound(new Error('boom'))).toBe(false)
    expect(isSuppressionNotFound('NotFoundException')).toBe(false)
  })
})
