import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { addExtensionListener, removeExtensionListener } from './event'

export const injectExtensionAPIs = () => {
  interface ExtensionMessageOptions {
    noop?: boolean
    serialize?: (...args: any[]) => any[]
  }

  const invokeExtension = async function (
    fnName: string,
    options: ExtensionMessageOptions = {},
    ...args: any[]
  ) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined

    if (process.env.NODE_ENV === 'development') {
      console.log(fnName, args)
    }

    if (options.noop) {
      console.warn(`${fnName} is not yet implemented.`)
      if (callback) callback()
      return
    }

    if (options.serialize) {
      args = options.serialize(...args)
    }

    let result

    try {
      result = await ipcRenderer.invoke('CHROME_EXT', fnName, ...args)
    } catch (e) {
      // TODO: Set chrome.runtime.lastError?
      console.error(e)
      result = undefined
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(fnName, '(result)', result)
    }

    if (callback) {
      callback(result)
    } else {
      return result
    }
  }

  const electronContext = {
    invokeExtension,
    addExtensionListener,
    removeExtensionListener,
  }

  // Function body to run in the main world.
  // IMPORTANT: This must be self-contained, no closure variable will be included!
  function mainWorldScript() {
    const electron = ((window as any).electron as typeof electronContext) || electronContext

    const invokeExtension = (fnName: string, opts: ExtensionMessageOptions = {}) => (
      ...args: any[]
    ) => electron.invokeExtension(fnName, opts, ...args)

    function imageData2base64(imageData: ImageData) {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return null

      canvas.width = imageData.width
      canvas.height = imageData.height
      ctx.putImageData(imageData, 0, 0)

      return canvas.toDataURL()
    }

    class ExtensionEvent<T extends Function> implements chrome.events.Event<T> {
      constructor(private name: string) {}
      addListener(callback: T) {
        electron.addExtensionListener(this.name, callback)
      }
      removeListener(callback: T) {
        electron.removeExtensionListener(this.name, callback)
      }

      getRules(callback: (rules: chrome.events.Rule[]) => void): void
      getRules(ruleIdentifiers: string[], callback: (rules: chrome.events.Rule[]) => void): void
      getRules(ruleIdentifiers: any, callback?: any) {
        throw new Error('Method not implemented.')
      }
      hasListener(callback: T): boolean {
        throw new Error('Method not implemented.')
      }
      removeRules(ruleIdentifiers?: string[] | undefined, callback?: (() => void) | undefined): void
      removeRules(callback?: (() => void) | undefined): void
      removeRules(ruleIdentifiers?: any, callback?: any) {
        throw new Error('Method not implemented.')
      }
      addRules(
        rules: chrome.events.Rule[],
        callback?: ((rules: chrome.events.Rule[]) => void) | undefined
      ): void {
        throw new Error('Method not implemented.')
      }
      hasListeners(): boolean {
        throw new Error('Method not implemented.')
      }
    }

    class ChromeSetting implements Partial<chrome.types.ChromeSetting> {
      set() {}
      get() {}
      clear() {}
      // onChange: chrome.types.ChromeSettingChangedEvent
    }

    const chrome = window.chrome || {}
    const extensionId = chrome.runtime?.id
    const manifest: chrome.runtime.Manifest =
      (extensionId && chrome.runtime.getManifest()) || ({} as any)

    type DeepPartial<T> = {
      [P in keyof T]?: DeepPartial<T[P]>
    }

    type APIFactoryMap = {
      [apiName in keyof typeof chrome]: {
        shouldInject?: () => boolean
        factory: (base: DeepPartial<typeof chrome[apiName]>) => DeepPartial<typeof chrome[apiName]>
      }
    }

    /**
     * Factories for each additional chrome.* API.
     */
    const apiDefinitions: Partial<APIFactoryMap> = {
      browserAction: {
        shouldInject: () => !!manifest.browser_action,
        factory: (base) => {
          const api = {
            ...base,

            setTitle: invokeExtension('browserAction.setTitle'),
            getTitle: invokeExtension('browserAction.getTitle', { noop: true }),

            setIcon: invokeExtension('browserAction.setIcon', {
              serialize: (details: any) => {
                if (details.imageData) {
                  if (details.imageData instanceof ImageData) {
                    details.imageData = imageData2base64(details.imageData)
                  } else {
                    details.imageData = Object.entries(details.imageData).reduce(
                      (obj: any, pair: any[]) => {
                        obj[pair[0]] = imageData2base64(pair[1])
                        return obj
                      },
                      {}
                    )
                  }
                }

                return [details]
              },
            }),

            setPopup: invokeExtension('browserAction.setPopup'),
            getPopup: invokeExtension('browserAction.getPopup', { noop: true }),

            setBadgeText: invokeExtension('browserAction.setBadgeText'),
            getBadgeText: invokeExtension('browserAction.getBadgeText', {
              noop: true,
            }),

            setBadgeBackgroundColor: invokeExtension('browserAction.setBadgeBackgroundColor'),
            getBadgeBackgroundColor: invokeExtension('browserAction.getBadgeBackgroundColor', {
              noop: true,
            }),

            enable: invokeExtension('browserAction.enable', { noop: true }),
            disable: invokeExtension('browserAction.disable', { noop: true }),

            onClicked: new ExtensionEvent('browserAction.onClicked'),
          }

          return api
        },
      },

      contextMenus: {
        factory: (base) => {
          let menuCounter = 0
          const menuCallbacks: {
            [key: string]: chrome.contextMenus.CreateProperties['onclick']
          } = {}
          const menuCreate = invokeExtension('contextMenus.create')

          const api = {
            ...base,
            create: function (
              createProperties: chrome.contextMenus.CreateProperties,
              callback?: Function
            ) {
              if (typeof createProperties.id === 'undefined') {
                createProperties.id = `${++menuCounter}`
              }
              if (createProperties.onclick) {
                menuCallbacks[createProperties.id] = createProperties.onclick
                delete createProperties.onclick
              }
              menuCreate(createProperties, callback)
              return createProperties.id
            },
            update: invokeExtension('contextMenus.update', { noop: true }),
            remove: invokeExtension('contextMenus.remove'),
            removeAll: invokeExtension('contextMenus.removeAll'),
            onClicked: new ExtensionEvent<
              (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void
            >('contextMenus.onClicked'),
          }

          api.onClicked.addListener((info, tab) => {
            const callback = menuCallbacks[info.menuItemId]
            if (callback && tab) callback(info, tab)
          })

          return api
        },
      },

      cookies: {
        factory: (base) => {
          return {
            ...base,
            get: invokeExtension('cookies.get'),
            getAll: invokeExtension('cookies.getAll'),
            set: invokeExtension('cookies.set'),
            remove: invokeExtension('cookies.remove'),
            getAllCookieStores: invokeExtension('cookies.getAllCookieStores'),
            onChanged: new ExtensionEvent('cookies.onChanged'),
          }
        },
      },

      notifications: {
        factory: (base) => {
          return {
            ...base,
            clear: invokeExtension('notifications.clear'),
            create: invokeExtension('notifications.create'),
            getAll: invokeExtension('notifications.getAll'),
            getPermissionLevel: invokeExtension('notifications.getPermissionLevel'),
            update: invokeExtension('notifications.update'),
            onClicked: new ExtensionEvent('notifications.onClicked'),
          }
        },
      },

      privacy: {
        factory: (base) => {
          return {
            ...base,
            network: {
              networkPredictionEnabled: new ChromeSetting(),
              webRTCIPHandlingPolicy: new ChromeSetting(),
            },
            websites: {
              hyperlinkAuditingEnabled: new ChromeSetting(),
            },
          }
        },
      },

      runtime: {
        factory: (base) => {
          return {
            ...base,
            openOptionsPage: invokeExtension('runtime.openOptionsPage'),
          }
        },
      },

      storage: {
        factory: (base) => {
          return {
            ...base,
            // TODO: provide a backend for browsers to opt-in to
            managed: base.local,
            sync: base.local,
          }
        },
      },

      tabs: {
        factory: (base) => {
          return {
            ...base,
            create: invokeExtension('tabs.create'),
            get: invokeExtension('tabs.get'),
            getCurrent: invokeExtension('tabs.getCurrent'),
            getAllInWindow: invokeExtension('tabs.getAllInWindow'),
            insertCSS: invokeExtension('tabs.insertCSS'),
            query: invokeExtension('tabs.query'),
            reload: invokeExtension('tabs.reload'),
            update: invokeExtension('tabs.update'),
            remove: invokeExtension('tabs.remove'),
            goBack: invokeExtension('tabs.goBack'),
            goForward: invokeExtension('tabs.goForward'),
            onCreated: new ExtensionEvent('tabs.onCreated'),
            onRemoved: new ExtensionEvent('tabs.onRemoved'),
            onUpdated: new ExtensionEvent('tabs.onUpdated'),
            onActivated: new ExtensionEvent('tabs.onActivated'),
          }
        },
      },

      webNavigation: {
        factory: (base) => {
          return {
            ...base,
            getFrame: invokeExtension('webNavigation.getFrame'),
            getAllFrames: invokeExtension('webNavigation.getAllFrames'),
            onBeforeNavigate: new ExtensionEvent('webNavigation.onBeforeNavigate'),
            onCompleted: new ExtensionEvent('webNavigation.onCompleted'),
            onCreatedNavigationTarget: new ExtensionEvent(
              'webNavigation.onCreatedNavigationTarget'
            ),
            onCommitted: new ExtensionEvent('webNavigation.onCommitted'),
            onHistoryStateUpdated: new ExtensionEvent('webNavigation.onHistoryStateUpdated'),
          }
        },
      },

      webRequest: {
        factory: (base) => {
          return {
            ...base,
            onHeadersReceived: new ExtensionEvent('webRequest.onHeadersReceived'),
          }
        },
      },

      windows: {
        factory: (base) => {
          return {
            ...base,
            WINDOW_ID_NONE: -1,
            WINDOW_ID_CURRENT: -2,
            get: invokeExtension('windows.get'),
            getLastFocused: invokeExtension('windows.getLastFocused'),
            getAll: invokeExtension('windows.getAll'),
            create: invokeExtension('windows.create'),
            update: invokeExtension('windows.update'),
            remove: invokeExtension('windows.remove'),
            onCreated: new ExtensionEvent('windows.onCreated'),
            onRemoved: new ExtensionEvent('windows.onRemoved'),
            onFocusChanged: new ExtensionEvent('windows.onFocusChanged'),
          }
        },
      },
    }

    // Create lazy initializers for all APIs
    Object.keys(apiDefinitions).forEach((key: any) => {
      const apiName: keyof typeof chrome = key
      const baseApi = chrome[apiName] as any
      const definition = apiDefinitions[apiName]!

      // Allow APIs to opt-out of being available in this context.
      if (definition.shouldInject && !definition.shouldInject()) return

      Object.defineProperty(chrome, apiName, {
        get: () => {
          const api = definition.factory(baseApi)
          Object.defineProperty(chrome, apiName, {
            value: api,
            writable: true,
            enumerable: true,
            configurable: true,
          })
          return api
        },
        enumerable: true,
        configurable: true,
      })
    })

    // Remove access to internals
    delete (window as any).electron

    Object.defineProperty(window, 'chrome', {
      configurable: false,
      enumerable: true,
      value: chrome,
      writable: true,
    })

    void 0 // no return
  }

  try {
    // Expose extension IPC to main world
    contextBridge.exposeInMainWorld('electron', electronContext)

    // Mutate global 'chrome' object with additional APIs in the main world
    webFrame.executeJavaScript(`(${mainWorldScript}());`)
  } catch {
    // contextBridge threw an error which means we're in the main world so we
    // can just execute our function.
    mainWorldScript()
  }
}
