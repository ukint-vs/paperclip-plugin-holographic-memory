declare module "@paperclipai/plugin-sdk" {
  export type PluginContext = Record<string, any>;

  export function definePlugin<T extends Record<string, any>>(plugin: T): T;
  export function defineManifest<T extends Record<string, any>>(manifest: T): T;
}
