import { vi } from 'vitest'
import { createVSCodeMock } from 'jest-mock-vscode'

vi.mock('vscode', () => {
  const vscode = createVSCodeMock(vi)
  return {
    ...vscode,
    env: {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(''),
      },
      appName: 'Visual Studio Code',
      appRoot: '/app',
      language: 'en',
      machineId: 'test-machine-id',
      sessionId: 'test-session-id',
      shell: '/bin/bash',
      uriScheme: 'vscode',
      uiKind: 1,
      remoteName: undefined,
      isNewAppInstall: false,
      isTelemetryEnabled: false,
      openExternal: vi.fn().mockResolvedValue(true),
      asExternalUri: vi.fn((uri: unknown) => Promise.resolve(uri)),
      createTelemetryLogger: vi.fn(),
    },
  }
})
