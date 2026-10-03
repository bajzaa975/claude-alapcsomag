export type PaneId = 'nightrun'

declare module 'claude-code' {
  interface PluginState {
    'nightrun-pane': { isOpen: boolean }
  }
}
