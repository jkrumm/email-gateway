import { log } from '../telemetry/log'

// The `send.result` event for one dispatch attempt: template, requesting source
// and outcome only. A failed send is a warning so an alert on severity sees it.
export function emitSendResult({
  template,
  source,
  status,
}: {
  template: string
  source: string
  status: 'sent' | 'failed'
}): void {
  log.event('send.result', { template, source, status }, status === 'failed' ? 'warn' : 'info')
}
