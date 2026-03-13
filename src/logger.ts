import * as vscode from 'vscode'

let outputChannel: vscode.OutputChannel | undefined

export function initLogger(): vscode.OutputChannel {
  outputChannel = vscode.window.createOutputChannel('Review Helper')
  return outputChannel
}

function getChannel(): vscode.OutputChannel | undefined {
  return outputChannel
}

function timestamp(): string {
  return new Date().toISOString()
}

export function logInfo(message: string): void {
  getChannel()?.appendLine(`[${timestamp()}] [INFO] ${message}`)
}

export function logWarn(message: string): void {
  getChannel()?.appendLine(`[${timestamp()}] [WARN] ${message}`)
}

export function logError(message: string): void {
  getChannel()?.appendLine(`[${timestamp()}] [ERROR] ${message}`)
}

export function logDebug(message: string): void {
  getChannel()?.appendLine(`[${timestamp()}] [DEBUG] ${message}`)
}
