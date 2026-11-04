// The approval card for a call that uses secrets (pure, so it can be tested). Every use asks, with no
// "Allow for this session": the card names the secrets and where they go, and warns when one is written to disk.
import type { ApprovalRequest } from '../shared/protocol';
import { secretLine, type SecretUse } from './secretsCore';

const KIND: Record<string, ApprovalRequest['kind']> = {
  run_command: 'command', ssh_command: 'ssh', write_file: 'write', edit_file: 'edit', open_url: 'open', mcp_call: 'mcp',
};

export function secretApprovalRequest(info: { title: string; detail: string }, toolName: string, use: SecretUse): Omit<ApprovalRequest, 'id'> {
  return {
    kind: KIND[toolName] ?? 'mcp',
    title: 'Wants to ' + info.title.charAt(0).toLowerCase() + info.title.slice(1),
    detail: info.detail,
    secrets: use.names,
    secretLine: secretLine(use),
    secretWarning: use.warning,
    noSession: true,
  };
}
