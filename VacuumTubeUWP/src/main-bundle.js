(function () {
    if (window.VacuumTubeUWPLoaded) {
        console.log('[VacuumTubeUWP] Already loaded, skipping duplicate injection.');
        return;
    }
    window.VacuumTubeUWPLoaded = true;

    console.log('[VacuumTubeUWP] Initializing Master Bundle...');

    // 1. THE MODULE REGISTRY
    // This stores the 'exports' of each file so they can find each other
    const modules = {};

    // 2. THE CUSTOM REQUIRE ENGINE
    const require = (path) => {
        const name = path.split('/').pop().replace('.js', '');
        if (modules[name]) return modules[name];
        console.warn(`[VacuumTubeUWP] Module not found in bundle: ${name}`);
        return {};
    };

    // 3. UTILITY DEFINITIONS
    // Paste the original contents of your util files here.
    // Wrap each one in this small helper:

    // --- util/config.js ---
    modules['config'] = (function (require) {
        const module = { exports: {} };
        let sharedConfig = { adblock: true, sponsorblock: true, dislikes: true, controller_support: true };

        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.addEventListener('message', event => {
                if (event.data && event.data.type === 'config-update') {
                    const newConfig = event.data.config;
                    for (let key in sharedConfig) delete sharedConfig[key];
                    for (let key in newConfig) sharedConfig[key] = newConfig[key];
                    console.log('[VacuumTubeUWP] Config synced from UWP');
                }
            });
        }

        module.exports = {
            get: () => sharedConfig,
            set: (newConfig) => {
                if (window.chrome && window.chrome.webview) {
                    window.chrome.webview.postMessage({ type: 'set-config', config: newConfig });
                }
                for (let key in sharedConfig) delete sharedConfig[key];
                for (let key in newConfig) sharedConfig[key] = newConfig[key];
            }
        };
        return module.exports;
    })(require);

    // --- util/functions.js ---
    // Define this first because xhrModifiers requires it!
    modules['functions'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        async function waitForSelector(selector) {
            return new Promise((resolve) => {
                let observer = new MutationObserver(() => {
                    let el = document.querySelector(selector)
                    if (el) {
                        resolve(el)
                        observer.disconnect()
                    }
                })

                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true
                })

                let el = document.querySelector(selector)
                if (el) {
                    resolve(el)
                    observer.disconnect()
                }
            });
        }

        async function waitForCondition(func) {
            return await new Promise((resolve) => {
                if (func()) return resolve();

                let interval = setInterval(() => {
                    if (!func()) return;

                    clearInterval(interval)
                    resolve()
                }, 10)
            });
        }

        function deepMerge(current, updates) {
            for (key of Object.keys(updates)) {
                if (!current.hasOwnProperty(key) || typeof updates[key] !== 'object') {
                    if (updates[key] === '__DELETE__') {
                        delete current[key];
                    } else {
                        current[key] = updates[key]
                    }
                } else {
                    deepMerge(current[key], updates[key])
                }
            }

            return current;
        }

        module.exports = {
            waitForSelector,
            waitForCondition,
            deepMerge
        }

        return module.exports;
    })(require);

    // --- util/xhrModifiers.js ---
    modules['xhrModifiers'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //overrides xmlhttprequest to be able to modify responses, used for dearrow support (the benefit to this over jsonModifiers is that since you're doing it from the response itself, you can use async stuff)
        const functions = require('functions')

        const responseModifiers = []
        const requestModifiers = []
        const OriginalXMLHttpRequest = window.XMLHttpRequest;

        let blocked = false;

        window.XMLHttpRequest = function () { //i've lost track of what's going on in here at this point, but it works
            const xhr = new OriginalXMLHttpRequest()
            const originalOpen = xhr.open;
            const originalSend = xhr.send;

            xhr.open = async function (method, url) {
                this._method = method;
                this._url = url;

                if (blocked) {
                    await functions.waitForCondition(() => !blocked)
                }

                return originalOpen.apply(this, arguments);
            }

            xhr.send = async function (body) {
                if (blocked) {
                    await functions.waitForCondition(() => !blocked)
                }

                for (let modifier of requestModifiers) {
                    try {
                        let modified = await modifier(xhr._url, body)
                        body = modified;
                    } catch (err) {
                        console.error('an xhr request modifier failed', err)
                        continue;
                    }
                }

                return originalSend.apply(this, [body]);
            }

            let readyStateHandler = null;
            let loadHandler = null;

            async function modifyResponse() {
                if (xhr.responseType !== '' && xhr.responseType !== 'text') return;

                if (xhr._modifiedAlready || xhr.readyState !== 4) return;
                xhr._modifiedAlready = true;

                let modifiedText = xhr.responseText;

                for (let modifier of responseModifiers) {
                    try {
                        let modified = await modifier(xhr._url, modifiedText)
                        if (modified === undefined) continue;

                        modifiedText = modified;
                    } catch (err) {
                        console.error('an xhr response modifier failed', err)
                        continue;
                    }
                }

                Object.defineProperty(xhr, 'responseText', {
                    get() {
                        return modifiedText;
                    }
                })

                Object.defineProperty(xhr, 'response', {
                    get() {
                        return modifiedText;
                    }
                })
            }

            Object.defineProperty(xhr, 'onreadystatechange', {
                get() {
                    return readyStateHandler;
                },
                set(handler) {
                    readyStateHandler = async function () {
                        if (xhr.readyState === 4) {
                            await modifyResponse()
                        }

                        handler.apply(xhr, arguments)
                    }

                    xhr.addEventListener('readystatechange', readyStateHandler)
                }
            })

            Object.defineProperty(xhr, 'onload', {
                get() {
                    return loadHandler;
                },
                set(handler) {
                    loadHandler = async function () {
                        await modifyResponse()
                        handler.apply(xhr, arguments)
                    }

                    xhr.addEventListener('load', loadHandler)
                }
            })

            const originalAddEventListener = xhr.addEventListener;
            xhr.addEventListener = function (type, listener) {
                if (type === 'load') {
                    let wrapped = async function () {
                        await modifyResponse()
                        listener.apply(xhr, arguments)
                    }

                    return originalAddEventListener.call(this, type, wrapped);
                }

                return originalAddEventListener.apply(this, arguments);
            }

            return xhr;
        }

        function addResponseModifier(func) {
            responseModifiers.push(func)
        }

        function addRequestModifier(func) {
            requestModifiers.push(func)
        }

        function block() {
            blocked = true;
        }

        function unblock() {
            blocked = false;
        }

        module.exports = {
            addResponseModifier,
            addRequestModifier,
            block,
            unblock
        }

        return module.exports;
    })(require);

    // --- util/jsonModifiers.js ---
    modules['jsonModifiers'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //overriding json.parse so that when it parses innertube responses, we can manipulate it to remove ads and similar purposes
        const modifiers = []
        const jsonParse = JSON.parse;

        JSON.parse = (...args) => {
            let json = jsonParse.apply(this, args)

            try {
                if (typeof json === 'object') {
                    for (let modifier of modifiers) {
                        json = modifier(json)
                    }
                }

                return json;
            } catch (err) {
                console.error('a json modifier failed', err)
                return json; //just to be safe, return what we have
            }
        }

        function addModifier(func) {
            modifiers.push(func)
        }

        module.exports = {
            addModifier
        }

        return module.exports;
    })(require);

    // --- util/configOverrides.js ---
    modules['configOverrides'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //helper functions for overriding internal youtube configs (env, ytcfg, window.environment, and tectonicConfig)
        const functions = require('functions')

        const ytcfgOverrides = []
        const environmentOverrides = []
        const tectonicConfigOverrides = []

        function overrideEnv(key, value) {
            let params = new URLSearchParams(window.location.search)

            key = String(key)
            value = String(value)

            let existing = params.has(key)
            if (existing) {
                if (value === existing) return;
                params.delete(key)
            }

            params.set(key, value)

            let newUrl = window.location.pathname + '?' + params.toString()
            history.replaceState(null, '', newUrl)
        }

        let ytcfgInterval = setInterval(() => {
            if (!window.ytcfg) return;
            if (ytcfgOverrides.length === 0) return;

            while (ytcfgOverrides.length > 0) {
                let override = ytcfgOverrides.shift()
                functions.deepMerge(window.ytcfg.data_, override)
                window.ytcfg.set(window.ytcfg.data_)
            }
        })

        let environmentInterval = setInterval(() => {
            if (!window.environment) return;
            if (environmentOverrides.length === 0) return;

            while (environmentOverrides.length > 0) {
                let override = environmentOverrides.shift()
                functions.deepMerge(window.environment, override)
            }
        })

        let tectonicConfigInterval = setInterval(() => {
            if (!window.tectonicConfig) return;
            if (tectonicConfigOverrides.length === 0) return;

            while (tectonicConfigOverrides.length > 0) {
                let override = tectonicConfigOverrides.shift()
                functions.deepMerge(window.tectonicConfig, override)
            }
        })

        module.exports = {
            overrideEnv,
            ytcfgOverrides,
            environmentOverrides,
            tectonicConfigOverrides
        }

        return module.exports;
    })(require);

    // --- util/controller.js ---
    modules['controller'] = (function (require) {
        const module = { exports: {} };

        // --- Minimal EventEmitter Replacement (Since we don't have tseep) ---
        class EventEmitter {
            constructor() { this.events = {}; }
            on(event, listener) {
                if (!this.events[event]) this.events[event] = [];
                this.events[event].push(listener);
            }
            emit(event, data) {
                if (this.events[event]) this.events[event].forEach(l => l(data));
            }
        }

        const emitter = new EventEmitter();
        const buttonRepeatInterval = 100;
        const buttonRepeatDelay = 500;
        const pressedButtons = {};
        let buttonRepeatTimeout;
        let focused = true;

        // --- REPLACING ELECTRON FOCUS WITH WEB FOCUS ---
        window.addEventListener('focus', () => { focused = true; });
        window.addEventListener('blur', () => { focused = false; });

        // Rest of the original logic starts here
        requestAnimationFrame(pollGamepads);

        function pollGamepads() {
            const gamepads = navigator.getGamepads();
            for (let index in pressedButtons) {
                if (!gamepads[index]) pressedButtons[index] = null;
            }

            const steamInput = gamepads.find(g => g && g.id.endsWith('(STANDARD GAMEPAD Vendor: 28de Product: 11ff)'));
            if (steamInput) {
                handleGamepad(steamInput);
            } else {
                for (let gamepad of gamepads) {
                    if (gamepad && gamepad.connected) handleGamepad(gamepad);
                }
            }
            requestAnimationFrame(pollGamepads);
        }

        function handleGamepad(gamepad) {
            const index = gamepad.index;
            if (!pressedButtons[index]) pressedButtons[index] = {};

            // Buttons
            for (let i = 0; i < gamepad.buttons.length; i++) {
                let code = i;
                let button = gamepad.buttons[i];
                let buttonWasPressed = pressedButtons[index][i];

                if (button.pressed && !buttonWasPressed) {
                    pressedButtons[index][i] = true;
                    buttonDown(code);
                    stopKeyRepeat();
                    buttonRepeatTimeout = setTimeout(() => startButtonRepeat(code), buttonRepeatDelay);
                } else if (!button.pressed && buttonWasPressed) {
                    pressedButtons[index][i] = false;
                    buttonUp(code);
                    stopKeyRepeat();
                }
            }

            // Axes (Sticks)
            for (let i = 0; i < gamepad.axes.length; i++) {
                let axisValue = gamepad.axes[i];
                let axisIndex = i + gamepad.buttons.length;
                let axisWasPressed = pressedButtons[index][axisIndex];
                let code = null;

                if (i === 0) { // left stick X
                    if (axisValue > 0.5) code = 1013; else if (axisValue < -0.5) code = 1011;
                } else if (i === 1) { // left stick Y
                    if (axisValue > 0.5) code = 1014; else if (axisValue < -0.5) code = 1012;
                } else if (i === 3) { // right stick X
                    if (axisValue > 0.5) code = 1017; else if (axisValue < -0.5) code = 1015;
                } else if (i === 4) { // right stick Y
                    if (axisValue > 0.5) code = 1018; else if (axisValue < -0.5) code = 1016;
                }

                if (code) {
                    if (!axisWasPressed) {
                        pressedButtons[index][axisIndex] = true;
                        buttonDown(code);
                        stopKeyRepeat();
                        buttonRepeatTimeout = setTimeout(() => startButtonRepeat(code), buttonRepeatDelay);
                    }
                } else if (axisWasPressed) {
                    pressedButtons[index][axisIndex] = false;
                    buttonUp(null); // original code used code here, but it's null
                    stopKeyRepeat();
                }
            }
        }

        function buttonDown(code) {
            if (!focused) return;
            emitter.emit('down', { code });
        }

        function buttonUp(code) {
            if (!focused) return;
            emitter.emit('up', { code });
        }

        function startButtonRepeat(code) {
            stopKeyRepeat();
            buttonRepeatTimeout = setInterval(() => buttonDown(code), buttonRepeatInterval);
        }

        function stopKeyRepeat() {
            clearInterval(buttonRepeatTimeout);
            clearTimeout(buttonRepeatTimeout);
        }

        module.exports = emitter;
        return module.exports;
    })(require);

    // --- util/css.js ---
    modules['css'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const functions = require('functions')

        let injectedStyles = {}
        let ready = false;
        let observer;

        async function injectStyle(id, text) {
            await functions.waitForCondition(() => ready)

            const styleId = `vt-${id}`

            const existingStyle = document.getElementById(styleId)
            if (existingStyle) {
                existingStyle.remove()
            }

            const style = document.createElement('style')
            style.id = styleId;
            style.type = 'text/css'
            style.textContent = text;

            injectedStyles[id] = style;

            reinjectStylesheets()
        }

        function deleteStyle(id) {
            const styleId = `vt-${id}`
            const style = document.getElementById(styleId)

            delete injectedStyles[id];

            if (style) {
                style.remove()
            }
        }

        function reinjectStylesheets() {
            observer.disconnect() //so we don't pick up our own changes

            for (let style of Object.values(injectedStyles)) {
                document.head.appendChild(style) //if it's already in there, it just gets moved to the bottom
            }

            observer.observe(document.head, { childList: true })
        }

        async function main() {
            await functions.waitForCondition(() => !!document.head)

            observer = new MutationObserver(() => {
                reinjectStylesheets()
            })

            observer.observe(document.head, { childList: true }) //any time a new element is added to head, reinject everything so that stylesheets are constantly taking priority over ones added by youtube

            ready = true;
        }

        main()

        module.exports = {
            inject: injectStyle,
            delete: deleteStyle
        }

        return module.exports;
    })(require);

    // --- util/localeProvider.js ---
    modules['localeProvider'] = (function (require) {
        const module = { exports: {} };
        const functions = require('functions');

        // FIX 1: Initialize with a default object immediately.
        // This prevents the "Cannot read properties of undefined" crash if fetch is slow or fails.
        let locale = {
            generic: {
                settings: "Settings",
                close: "Close",
                save: "Save Settings"
            },
            tabs: {
                adblock: "Adblock",
                sponsorblock: "SponsorBlock",
                dislikes: "Return Dislike",
                controller: "Controller"
            }
        };

        const localeBaseUrl = "https://VacuumTubeUWP.local/locale/";

        functions.waitForCondition(() => !!window.ytcfg)
            .then(async () => {
                try {
                    const lang = window.ytcfg.data_.HL || 'en';
                    const broadLang = lang.split('-')[0];

                    // FIX 2: Check if response is OK before calling .json()
                    // This prevents the "TypeError: Failed to fetch" from stopping the boot process
                    const baseResponse = await fetch(`${localeBaseUrl}en.json`);
                    if (baseResponse.ok) {
                        const baseLocale = await baseResponse.json();

                        let partialLocale = {};
                        try {
                            let langResponse = await fetch(`${localeBaseUrl}${lang}.json`);
                            if (!langResponse.ok && lang !== 'en') {
                                langResponse = await fetch(`${localeBaseUrl}${broadLang}.json`);
                            }

                            if (langResponse && langResponse.ok) {
                                partialLocale = await langResponse.json();
                            }
                        } catch (e) {
                            console.warn(`[VacuumTubeUWP] Extra locale for ${lang} not found.`);
                        }

                        // Merge remote data into our default fallback
                        locale = functions.deepMerge(locale, baseLocale, partialLocale);
                        console.log('[VacuumTubeUWP] Locales synchronized.');
                    }
                } catch (err) {
                    console.error('[VacuumTubeUWP] Locale Sync Failed - Using built-in fallback.', err);
                }
            });

        // FIX 3: Since we now have a default 'locale' object, 
        // we don't need to block the app from starting.
        async function waitUntilAvailable() {
            return true;
        }

        function getLocale() {
            return locale;
        }

        module.exports = {
            waitUntilAvailable,
            getLocale
        };

        return module.exports;
    })(require);

    // --- util/patchFunction.js ---
    modules['patchFunction'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //generic function patcher
        function patchFunction(obj, func, modifier) {
            let originalFunc = obj[func]

            let patched = function (...args) {
                return modifier.call(this, originalFunc, ...args);
            }

            obj[func] = patched;
        }

        module.exports = patchFunction;

        return module.exports;
    })(require);

    // --- util/resolveCommandModifiers.js ---
    modules['resolveCommandModifiers'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //overriding youtube's resolveCommand so we can have unlimited power (mainly for hooking into settings and ui)
        const inputModifiers = []
        const outputModifiers = []

        let globalResolveCommand;

        let interval = setInterval(() => { //try over and over again to find it (shouldn't take long)
            for (let key in window._yttv) {
                if (window._yttv[key]?.instance?.resolveCommand) {
                    let resolveCommand = window._yttv[key].instance.resolveCommand;
                    globalResolveCommand = (command) => { //for some reason, this function doesn't work unless i do it like this (instead of just setting it directly to the actual function)
                        return window._yttv[key].instance.resolveCommand(command);
                    }

                    window._yttv[key].instance.resolveCommand = function (command) {
                        for (let modifier of inputModifiers) {
                            command = modifier(command)
                            if (command === false) return true; //blocking, doesn't allow internal handler to get to it
                        }

                        let output = resolveCommand.apply(this, [command])

                        for (let modifier of outputModifiers) {
                            output = modifier(output)
                        }

                        return output;
                    }

                    clearInterval(interval)
                    return;
                }
            }
        }, 100)

        function addInputModifier(func) {
            inputModifiers.push(func)
        }

        function addOutputModifier(func) {
            outputModifiers.push(func)
        }

        module.exports = {
            resolveCommand: (command) => {
                if (globalResolveCommand) {
                    return globalResolveCommand(command);
                } else {
                    throw new Error('resolveCommand doesn\'t exist yet, probably called too early');
                }
            },
            addInputModifier,
            addOutputModifier
        }

        return module.exports;
    })(require);

    // --- util/ui.js ---
    modules['ui'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const rcMod = require('resolveCommandModifiers')

        /**
         * Creates a toast in the top right using YouTube UI
         * @param {string} title - The title (top text) of the toast
         * @param {string} subtitle - The subtitle (bottom text) of the toast
         * @returns {void}
         */
        function toast(title, subtitle) {
            let toastCommand = {
                openPopupAction: {
                    popupType: 'TOAST',
                    popup: {
                        overlayToastRenderer: {
                            title: {
                                simpleText: title
                            },
                            subtitle: {
                                simpleText: subtitle
                            }
                        }
                    }
                }
            };

            rcMod.resolveCommand(toastCommand)
        }

        /**
         * Creates a popup menu configuration object for YouTube UI rendering
         * @param {Object} options - The options for the popup menu
         * @param {string} options.title - The title text to display in the popup header
         * @param {Array} options.items - Array of menu items to display in the popup
         * @param {number} [options.selectedIndex=0] - The index of the initially selected item (defaults to 0)
         * @returns {Object} A nested object structure containing the popup menu configuration
         */
        function popupMenu(options) {
            return {
                openPopupAction: {
                    popup: {
                        overlaySectionRenderer: {
                            dismissalCommand: {
                                signalAction: {
                                    signal: 'POPUP_BACK'
                                }
                            },
                            overlay: {
                                overlayTwoPanelRenderer: {
                                    actionPanel: {
                                        overlayPanelRenderer: {
                                            header: {
                                                overlayPanelHeaderRenderer: {
                                                    title: {
                                                        simpleText: options.title
                                                    }
                                                }
                                            },
                                            content: {
                                                overlayPanelItemListRenderer: {
                                                    selectedIndex: options.selectedIndex || 0,
                                                    items: options.items,
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            };
        }

        /**
         * Creates a link object with specified configuration for a compact link renderer
         * @param {Object} options - Configuration options for the link
         * @param {string} options.title - The title text to display for the link
         * @param {string} [options.icon] - Optional icon type to display as secondary icon
         * @param {boolean} [options.closeMenu] - If true, adds a command to close popup menu
         * @param {Function} [options.callback] - Optional callback function to execute when link is clicked
         * @param {Function} [options.createSubMenu] - Optional function that returns submenu configuration
         * @returns {Object} Link configuration object with compactLinkRenderer structure
         */
        function link(options) {
            return {
                compactLinkRenderer: {
                    title: {
                        simpleText: options.title
                    },
                    secondaryIcon: options.icon ? { iconType: options.icon } : undefined,
                    serviceEndpoint: {
                        commandExecutorCommand: {
                            get commands() {
                                return [
                                    options.closeMenu
                                        ? {
                                            signalAction: {
                                                signal: 'POPUP_BACK'
                                            }
                                        }
                                        : undefined,
                                    options.callback
                                        ? {
                                            signalAction: {
                                                get signal() {
                                                    options.callback()
                                                    return 'UNKNOWN';
                                                }
                                            }
                                        }
                                        : undefined,
                                    options.createSubMenu
                                        ? options.createSubMenu()
                                        : undefined
                                ].filter(Boolean)
                            }
                        }
                    }
                }
            };
        }

        module.exports = {
            toast,
            popupMenu,
            link
        }

        return module.exports;
    })(require);


    // 4. MODULE DEFINITIONS
    // Now paste your actual feature modules.

    // --- modules/adblock.js ---
    modules['adblock'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const jsonMod = require('jsonModifiers');
        const xhrModifiers = require('xhrModifiers');
        const configManager = require('config');

        // This is a helper function that returns the latest sharedConfig object
        const getConfig = () => configManager.get();

        module.exports = () => {
            xhrModifiers.addResponseModifier((url, text) => {
                // CALL the function with () to get the object, then check .adblock
                if (!getConfig().adblock) return;

                if (!url.startsWith('/youtubei/v1/browse') && !url.startsWith('/youtubei/v1/search')) {
                    return;
                }

                let json = JSON.parse(text);

                if (url.startsWith('/youtubei/v1/browse')) {
                    let homeFeed = json.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer;
                    if (!homeFeed || !homeFeed.contents) return;

                    homeFeed.contents = homeFeed.contents.filter(r => !r.adSlotRenderer && !r.promoShelfRenderer && !r.shelfRenderer?.tvhtml5Metadata?.hideLogo);

                    for (let feed of homeFeed.contents) {
                        let horizontal = feed?.shelfRenderer?.content?.horizontalListRenderer;
                        if (!horizontal?.items) continue;
                        horizontal.items = horizontal.items.filter(i => !i.adSlotRenderer);
                    }
                } else if (url.startsWith('/youtubei/v1/search')) {
                    let searchFeed = json.contents?.sectionListRenderer;
                    if (!searchFeed || !searchFeed.contents) return;

                    for (let feed of searchFeed.contents) {
                        let horizontal = feed?.shelfRenderer?.content?.horizontalListRenderer;
                        if (!horizontal?.items) continue;
                        horizontal.items = horizontal.items.filter(i => !i.adSlotRenderer);
                    }
                }

                return JSON.stringify(json);
            });

            // video ads modifier
            jsonMod.addModifier((json) => {
                // CALL with () here too
                if (!getConfig().adblock) return json;

                if (json.adPlacements) json.adPlacements = [];
                if (json.adSlots) json.adSlots = [];

                return json;
            });

            // shorts ads modifier
            jsonMod.addModifier((json) => {
                // CALL with () here too
                if (!getConfig().adblock) return json;

                if (json?.entries && Array.isArray(json.entries)) {
                    json.entries = json.entries.filter(e => !e?.command?.reelWatchEndpoint?.adClientParams?.isAd);
                }

                return json;
            });
        };

        return module.exports;
    })(require);

    // --- modules/sponsorblock.js ---
    modules['sponsorblock'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        // --- Dependencies ---
        const ui = require('ui');
        const localeProvider = require('localeProvider');
        const configManager = require('config');
        const getConfig = () => configManager.get();

        // --- Minimal SponsorBlock API Replacement ---
        // Since we don't have the npm package, we fetch from the API directly
        class SponsorBlock {
            constructor(uuid) { this.uuid = uuid || 'VacuumTubeUWP-user'; }
            async getSegments(videoId, categories) {
                const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${videoId}&categories=${JSON.stringify(categories)}`;
                try {
                    const response = await fetch(url);
                    if (response.status === 200) return await response.json();
                    return [];
                } catch (e) { return []; }
            }
        }

        module.exports = async () => {
            await localeProvider.waitUntilAvailable();
            let locale = localeProvider.getLocale();

            // Use live config for the UUID
            let sponsorBlock = new SponsorBlock(getConfig().sponsorblock_uuid);
            let sponsorBlockSegments = [];

            let activeVideoId = 0;
            let attachVideoTimeout = null;
            let activeVideo = null;

            const attachToVideo = function () {
                clearTimeout(attachVideoTimeout);
                attachVideoTimeout = null;

                activeVideo = document.querySelector('video');
                if (!activeVideo) {
                    attachVideoTimeout = setTimeout(attachToVideo, 100);
                    return;
                }

                console.log("[VacuumTubeUWP] Sponsorblock attached to video:", activeVideoId);
                activeVideo.addEventListener('timeupdate', checkForSponsorSkip);
            };

            const checkForSponsorSkip = function () {
                // LIVE CONFIG CHECK
                const currentConfig = getConfig();
                if (!currentConfig.sponsorblock || !activeVideo || sponsorBlockSegments.length === 0) return;

                if (activeVideo.paused) return;

                let matchingSegment = sponsorBlockSegments.filter((v) => {
                    // Skip if within the first 2 seconds of the segment
                    return activeVideo.currentTime > v.startTime
                        && activeVideo.currentTime < v.startTime + 2
                        && activeVideo.currentTime < v.endTime;
                }).sort((x, y) => x.startTime - y.startTime);

                if (matchingSegment.length === 0) return;

                console.log("[VacuumTubeUWP] Skipping sponsor segment...");
                activeVideo.currentTime = matchingSegment[0].endTime;

                // Trigger visual toast
                if (locale && locale.sponsorblock) {
                    ui.toast('VacuumTubeUWP', locale.sponsorblock.sponsor_skipped);
                }
            };

            // Listen for YouTube navigation (YouTube TV uses hash-based routing)
            window.addEventListener('hashchange', () => {
                if (!getConfig().sponsorblock) return;

                const pageUrl = new URL(location.hash.substring(1), location.href);

                if (pageUrl.pathname === '/watch') {
                    const videoId = pageUrl.searchParams.get('v');
                    const categories = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic'];

                    sponsorBlock.getSegments(videoId, categories).then((segments) => {
                        sponsorBlockSegments = segments;
                        activeVideoId = videoId;
                        attachToVideo();
                    });
                } else {
                    activeVideo = null;
                    activeVideoId = 0;
                    sponsorBlockSegments = [];
                    if (attachVideoTimeout != null) {
                        clearTimeout(attachVideoTimeout);
                        attachVideoTimeout = null;
                    }
                }
            });
        };

        return module.exports;
    })(require);

    // --- modules/block-sign-in-popup.js ---
    modules['block-sign-in-popup'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const rcMod = require('resolveCommandModifiers')

        module.exports = () => {
            rcMod.addInputModifier((c) => {
                if (c.openPopupAction?.uniqueId === 'playback-cap') return false;
                return c;
            })
        }

        return module.exports;
    })(require);

    // --- modules/controller-support.js ---
    modules['controller-support'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        // --- Dependencies ---
        const controller = require('controller');
        const ui = require('ui');
        const localeProvider = require('localeProvider');
        const configManager = require('config');
        const getConfig = () => configManager.get();

        module.exports = async () => {
            const gamepadKeyCodeMap = {
                0: 13,   // a -> enter
                1: 27,   // b -> escape
                2: 170,  // x -> asterisk (search)
                4: 115,  // left bumper -> f4 (back)
                5: 116,  // right bumper -> f5 (forward)
                6: 113,  // left trigger -> f2 (seek backwards)
                7: 114,  // right trigger -> f3 (seek forwards)
                8: 13,   // select -> enter
                9: 13,   // start -> enter
                11: 'vt-settings', // r3 -> (toggle overlay)
                12: 38,  // dpad up -> arrow key up
                13: 40,  // dpad down -> arrow key down
                14: 37,  // dpad left -> arrow key left
                15: 39,  // dpad right -> arrow key right

                1012: 38,  // left stick up
                1014: 40,  // left stick down
                1011: 37,  // left stick left
                1013: 39   // left stick right
            };

            const fallbackKeyCode = 135;
            let hasPressedButton = false;

            // --- STEAM CHECK REPLACEMENT ---
            // In WebView2, we don't have an easy 'is-steam' check unless we pass it from C#.
            // For now, we'll assume standard Windows environment.
            // If you want to support this, you'd send a message from C# to JS.
            const isSteam = false;

            if (isSteam) {
                setTimeout(async () => {
                    if (!hasPressedButton) {
                        await localeProvider.waitUntilAvailable();
                        const locale = localeProvider.getLocale();
                        ui.toast('VacuumTubeUWP', locale.general.steam_controller_notice);
                    }
                }, 5000);
            }

            controller.on('down', (e) => {
                hasPressedButton = true;
                let keyCode = gamepadKeyCodeMap[e.code];
                if (!keyCode) keyCode = fallbackKeyCode;
                simulateKeyDown(keyCode);
            });

            controller.on('up', (e) => {
                let keyCode = gamepadKeyCodeMap[e.code];
                if (!keyCode) keyCode = fallbackKeyCode;
                simulateKeyUp(keyCode);
            });

            function simulateKeyDown(keyCode) {
                if (!getConfig().controller_support) return;

                if (keyCode === 'vt-settings') {
                    // Look for your settings module or global toggle
                    const settings = require('settings');
                    if (typeof settings === 'function') {
                        settings();
                    }
                    return;
                }

                // DISPATCH TO WINDOW: YouTube TV's Leanback framework (Cobalt/TVHTML5)
                // usually listens to the window object.
                window.dispatchEvent(new KeyboardEvent('keydown', {
                    keyCode: keyCode,
                    which: keyCode,
                    bubbles: true,
                    cancelable: true,
                    view: window
                }));
            }

            function simulateKeyUp(keyCode) {
                // LIVE CONFIG CHECK
                if (!getConfig().controller_support) return;

                if (keyCode === 'vt-settings') return;

                let event = new KeyboardEvent('keyup', {
                    keyCode: keyCode,
                    which: keyCode,
                    bubbles: true
                });
                document.dispatchEvent(event);
            }
        };

        return module.exports;
    })(require);

    // --- modules/css-patches.js ---
    modules['css-patches'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const cssUtil = require('css');

        module.exports = async () => {
            try {
                // We fetch the CSS file from your WebAssets folder via the virtual host
                const response = await fetch('http://VacuumTubeUWP.local/style.css');
                if (response.ok) {
                    const text = await response.text();

                    // Inject the CSS using the utility we wrapped earlier
                    cssUtil.inject('patches', text);
                    console.log('[VacuumTubeUWP] CSS Patches injected successfully');
                } else {
                    console.error('[VacuumTubeUWP] Failed to load style.css:', response.status);
                }
            } catch (err) {
                console.error('[VacuumTubeUWP] Error loading CSS patches:', err);
            }
        };

        return module.exports;
    })(require);

    // --- modules/dearrow.js ---
    modules['dearrow'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        // dearrow support (https://dearrow.ajay.app/)
        const xhrModifiers = require('xhrModifiers');
        const configManager = require('config');

        // Helper for live updates
        const getConfig = () => configManager.get();

        const cache = {};

        async function getBranding(id) {
            if (id in cache) return cache[id];

            try {
                let res = await fetch(`https://sponsor.ajay.app/api/branding?videoID=${id}`);
                if (res.status === 404) return null;
                if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

                let data = await res.json();
                cache[id] = data;
                return data;
            } catch (e) {
                return null;
            }
        }

        function getThumbnail(id) {
            return `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${id}`;
        }

        module.exports = () => {
            xhrModifiers.addResponseModifier(async (url, text) => {
                // LIVE CONFIG CHECK: Use getConfig() here
                if (!getConfig().dearrow) return;

                if (
                    !url.startsWith('/youtubei/v1/browse') &&
                    !url.startsWith('/youtubei/v1/search') &&
                    !url.startsWith('/youtubei/v1/next')
                ) {
                    return;
                }

                let json = JSON.parse(text);
                let items = [];

                // --- JSON Parsing Logic (Unchanged from original) ---
                if (json.continuationContents?.horizontalListContinuation || json.continuationContents?.gridContinuation) {
                    if (json.continuationContents.horizontalListContinuation?.items) {
                        items = json.continuationContents.horizontalListContinuation.items;
                    } else if (json.continuationContents.gridContinuation?.items) {
                        items = json.continuationContents.gridContinuation.items;
                    }
                    if (!items) return;
                } else {
                    let contents = [];
                    if (url.startsWith('/youtubei/v1/browse')) {
                        if (json.contents?.tvBrowseRenderer?.content?.tvSecondaryNavRenderer?.sections) {
                            let tvSecondaryNavRenderer = json.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer;
                            for (let section of tvSecondaryNavRenderer.sections) {
                                if (!section.tvSecondaryNavSectionRenderer?.tabs) continue;
                                let tab = section.tvSecondaryNavSectionRenderer.tabs[0];
                                contents = tab.tabRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer?.contents;
                            }
                        } else if (json.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer?.contents) {
                            contents = json.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents;
                        } else if (json.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.gridRenderer) {
                            contents = [json.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content];
                        } else if (json.continuationContents?.tvSurfaceContentContinuation?.content?.sectionListRenderer?.contents) {
                            contents = json.continuationContents.tvSurfaceContentContinuation.content.sectionListRenderer.contents;
                        }
                    } else if (url.startsWith('/youtubei/v1/search')) {
                        contents = json.contents?.sectionListRenderer?.contents;
                    } else if (url.startsWith('/youtubei/v1/next')) {
                        contents = json.contents?.singleColumnWatchNextResults?.pivot?.sectionListRenderer?.contents;
                    }

                    if (!contents) return;

                    for (let content of contents) {
                        let someItems;
                        if (content.shelfRenderer) {
                            someItems = content.shelfRenderer.content.horizontalListRenderer?.items;
                        } else if (content.gridRenderer) {
                            someItems = content.gridRenderer.items;
                        }
                        if (!someItems) continue;
                        items = [...items, ...someItems];
                    }
                }

                // --- Branding Application Logic ---
                let promises = [];
                for (let item of items) {
                    if (!item.tileRenderer) continue;
                    if (item.tileRenderer.contentType !== 'TILE_CONTENT_TYPE_VIDEO') continue;

                    let id = item.tileRenderer.contentId;
                    promises.push((async () => {
                        try {
                            if (!item.tileRenderer.metadata) return;

                            let branding = await getBranding(id);
                            if (!branding) return;

                            // Title Replacement
                            let goodTitle = branding.titles.find(t => t.locked || t.votes >= 0);
                            if (goodTitle) {
                                let words = goodTitle.title.split(' ');
                                words = words.map(w => w.startsWith('>') ? w.slice(1) : w);
                                let title = words.join(' ');
                                item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText = title;
                            }

                            // Thumbnail Replacement
                            let newThumbnail = getThumbnail(id);
                            item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url = newThumbnail;
                        } catch (err) {
                            console.error('[VacuumTubeUWP] DeArrow branding failed:', err);
                        }
                    })());
                }

                if (promises.length > 0) {
                    await Promise.all(promises);
                }

                return JSON.stringify(json);
            });
        };

        return module.exports;
    })(require);

    // --- modules/disable-direct-sign-in.js ---
    modules['disable-direct-sign-in'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //"Sign in with your remote" is very buggy and broken in VacuumTube (sometimes breaks module injection, can't use controller, and also simply doesn't work in the end), so we disable it
        const configOverrides = require('configOverrides')

        module.exports = async () => {
            configOverrides.tectonicConfigOverrides.push({
                featureSwitches: {
                    directSignInConfig: {
                        isSupported: false
                    }
                }
            })
        }

        return module.exports;
    })(require);

    // --- modules/enable-highres.js ---
    modules['enable-highres'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const functions = require('functions');

        module.exports = () => {
            window.addEventListener('load', async () => {
                console.log('[VacuumTubeUWP] High-res trickery: Zooming out...');

                // Replaces Electron's set-zoom. 
                // 0.1 is roughly equivalent to -10 zoom (very tiny)
                document.body.style.zoom = "0.1";

                // Wait for the video player to actually exist in the DOM
                await functions.waitForSelector('.html5-main-video');

                // Wait a tiny bit more for YouTube's internal resolution logic to trigger
                await new Promise(resolve => setTimeout(resolve, 500));

                // Zoom back to normal (100%)
                document.body.style.zoom = "1.0";
                console.log('[VacuumTubeUWP] High-res trickery: Zoom restored.');
            });
        };

        return module.exports;
    })(require);

    // --- modules/encryption-notice.js ---
    modules['encryption-notice'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const rcMod = require('resolveCommandModifiers')
        const localeProvider = require('localeProvider')

        module.exports = async () => {
            await localeProvider.waitUntilAvailable()

            let locale = localeProvider.getLocale()

            rcMod.addInputModifier((c) => {
                if (c.openPopupAction?.uniqueId === 'unknown-player-error') {
                    return {
                        openPopupAction: {
                            popupType: 'FULLSCREEN_OVERLAY',
                            uniqueId: 'vt-player-error',
                            popup: {
                                overlaySectionRenderer: {
                                    overlay: {
                                        overlayTwoPanelRenderer: {
                                            actionPanel: {
                                                overlayPanelRenderer: {
                                                    header: {
                                                        overlayPanelHeaderRenderer: {
                                                            title: {
                                                                simpleText: locale.general.encryption_error.title
                                                            },
                                                            subtitle: {
                                                                simpleText: locale.general.encryption_error.text
                                                            }
                                                        }
                                                    },
                                                    footer: {
                                                        overlayPanelItemListRenderer: {
                                                            items: [
                                                                {
                                                                    compactLinkRenderer: {
                                                                        title: {
                                                                            simpleText: locale.general.encryption_error.switch_accounts
                                                                        },
                                                                        serviceEndpoint: {
                                                                            commandExecutorCommand: {
                                                                                commands: [
                                                                                    {
                                                                                        clientActionEndpoint: {
                                                                                            action: { actionType: 'OPEN_SIGN_IN_PROMPT' }
                                                                                        }
                                                                                    }
                                                                                ]
                                                                            }
                                                                        }
                                                                    }
                                                                },
                                                                {
                                                                    compactLinkRenderer: {
                                                                        title: {
                                                                            simpleText: locale.general.encryption_error.okay
                                                                        },
                                                                        serviceEndpoint: {
                                                                            commandExecutorCommand: {
                                                                                commands: [
                                                                                    { signalAction: { signal: 'HISTORY_BACK' } },
                                                                                    { signalAction: { signal: 'CLOSE_POPUP' } }
                                                                                ]
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            ]
                                                        }
                                                    }
                                                }
                                            },
                                            backButton: {
                                                buttonRenderer: {
                                                    icon: { iconType: 'DISMISSAL' },
                                                    command: {
                                                        commandExecutorCommand: {
                                                            commands: [
                                                                { signalAction: { signal: 'HISTORY_BACK' } },
                                                                { signalAction: { signal: 'CLOSE_POPUP' } }
                                                            ]
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    dismissalCommand: {
                                        commandExecutorCommand: {
                                            commands: [
                                                { signalAction: { signal: 'HISTORY_BACK' } },
                                                { signalAction: { signal: 'CLOSE_POPUP' } }
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    };
                }

                return c;
            })
        }

        return module.exports;
    })(require);

    // --- modules/fix-exit.js ---
    modules['fix-exit'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //when it sends an EXIT_APP command, youtube bugs out sometimes, and may not exit. this fixes that
        const rcMod = require('resolveCommandModifiers')

        module.exports = () => {
            rcMod.addInputModifier((command) => {
                if (!command.commandExecutorCommand || !command.commandExecutorCommand.commands) return command;

                let exitCommand = command.commandExecutorCommand.commands.find(c => c.signalAction?.signal === 'EXIT_APP')
                if (!exitCommand) return command;

                window.close()
                return false;
            })
        }

        return module.exports;
    })(require);

    // --- modules/fix-reloads.js ---
    modules['fix-reloads'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const rcMod = require('resolveCommandModifiers');

        module.exports = () => {
            rcMod.addInputModifier((command) => {
                // Check if YouTube is trying to trigger a reload
                if (!command.signalAction || !command.signalAction.signal || command.signalAction.signal !== 'RELOAD_PAGE') {
                    return command;
                }

                console.log('[VacuumTubeUWP] Intercepted YouTube reload signal. Forcing hard reload to maintain injection...');

                // Instead of Electron IPC, we use the standard browser reload.
                // location.reload(true) is a hint to the browser to skip the cache/service worker.
                window.location.reload();

                // Return false to tell YouTube's internal engine "Don't handle this, I've got it."
                return false;
            });
        };

        return module.exports;
    })(require);

    // --- modules/fix-voice.js ---
    modules['fix-voice'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //fix voice search
        const configOverrides = require('configOverrides')

        module.exports = () => {
            configOverrides.overrideEnv('env_enableMediaStreams', true)
        }

        return module.exports;
    })(require);

    // --- modules/264ify.js ---
    modules['264ify'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const configManager = require('config');
        const getConfig = () => configManager.get();

        module.exports = () => {
            // LIVE CONFIG CHECK
            if (!getConfig().h264ify) return;

            console.log('[VacuumTubeUWP] h264ify enabled: Blocking VP9/AV1 to force H.264 hardware acceleration.');

            const video = document.createElement('video');
            const canPlayType = video.canPlayType.bind(video);

            // Override the video element's ability to claim it supports certain formats
            video.__proto__.canPlayType = makeModifiedTypeChecker(canPlayType);

            // Override MediaSource (MSE) which YouTube uses for dash streaming
            const mse = window.MediaSource;
            if (mse && mse.isTypeSupported) {
                const isTypeSupported = mse.isTypeSupported.bind(mse);
                mse.isTypeSupported = makeModifiedTypeChecker(isTypeSupported);
            }

            function makeModifiedTypeChecker(originalChecker) {
                return (type) => {
                    if (!type) return '';

                    // List of codecs to block
                    const disallowedTypes = ['webm', 'vp8', 'vp9', 'av01'];

                    for (const disallowedType of disallowedTypes) {
                        if (type.indexOf(disallowedType) !== -1) {
                            return ''; // Tell YouTube "No, I can't play this"
                        }
                    }

                    return originalChecker(type);
                };
            }
        };

        return module.exports;
    })(require);

    // --- modules/h5vcc.js ---
    modules['h5vcc'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const configManager = require('config');

        module.exports = async () => {
            // In UWP, if you want to support deep linking (e.g. opening the app via a URL),
            // you would pass the video ID through your config update mechanism.

            const config = configManager.get();
            let initialDeepLink = config.initial_deeplink || "";

            // Define the global h5vcc object that YouTube looks for
            window.h5vcc = {
                runtime: {
                    initialDeepLink: initialDeepLink
                }
            };

            console.log('[VacuumTubeUWP] H5VCC initialized with DeepLink:', initialDeepLink);
        };

        return module.exports;
    })(require);

    // --- modules/hide-shorts.js ---
    modules['hide-shorts'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        // --- Dependencies ---
        const xhrModifiers = require('xhrModifiers');
        const configManager = require('config');
        const getConfig = () => configManager.get();

        module.exports = () => {
            xhrModifiers.addResponseModifier(async (url, text) => {
                // LIVE CONFIG CHECK
                if (!getConfig().hide_shorts) return;

                // Only care about browse requests (Home, Subscriptions, etc.)
                if (!url.startsWith('/youtubei/v1/browse')) {
                    return;
                }

                try {
                    let json = JSON.parse(text);

                    // Find the section list (works for both initial load and continuations)
                    let sectionList = json.continuationContents?.sectionListContinuation ||
                        json.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer;

                    if (!sectionList || !sectionList.contents) return;

                    // Filter out any shelf (row) where the header title is exactly "Shorts"
                    sectionList.contents = sectionList.contents.filter(i => {
                        const shelfTitle = i?.shelfRenderer?.headerRenderer?.shelfHeaderRenderer?.avatarLockup?.avatarLockupRenderer?.title?.runs?.[0]?.text;

                        // If it's the Shorts shelf, remove it from the array
                        return shelfTitle !== 'Shorts';
                    });

                    return JSON.stringify(json);
                } catch (err) {
                    console.error('[VacuumTubeUWP] Error while hiding shorts:', err);
                    return text; // Return original text if parsing fails to avoid breaking the UI
                }
            });
        };

        return module.exports;
    })(require);

    // --- modules/identification.js ---
    modules['identification'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const xhrModifiers = require('xhrModifiers');
        const configOverrides = require('configOverrides');
        const functions = require('functions');

        // Hardcoded values for UWP/WebView2 environment
        const APP_VERSION = "1.0.0"; // Replace with your VacuumTubeUWP version
        const CHROME_VERSION = "120.0.0.0"; // A modern Chrome version
        const OS_NAME = "Windows";
        const OS_VERSION = "10.0";
        const HOSTNAME = "VacuumTubeUWP-PC";

        module.exports = () => {
            // 1. Patch the global Environment config
            configOverrides.environmentOverrides.push({
                platform: 'DESKTOP',
                platform_detail: '__DELETE__',
                brand: 'VacuumTubeUWP',
                model: APP_VERSION,
                engine: 'WebKit',
                browser_engine: 'WebKit',
                browser_engine_version: '537.36',
                browser: 'Chrome',
                browser_version: CHROME_VERSION,
                os: OS_NAME,
                os_version: OS_VERSION,
                feature_switches: {
                    mdx_device_label: `VacuumTubeUWP on ${HOSTNAME}`
                }
            });

            // 2. Patch ytcfg (YouTube's internal config object)
            configOverrides.ytcfgOverrides.push({
                INNERTUBE_CONTEXT: {
                    client: {
                        platform: 'DESKTOP',
                        platformDetail: '__DELETE__',
                        clientFormFactor: 'UNKNOWN_FORM_FACTOR',
                        deviceMake: 'VacuumTubeUWP',
                        deviceModel: APP_VERSION,
                        browserName: 'Chrome',
                        browserVersion: CHROME_VERSION,
                        osName: OS_NAME,
                        osVersion: OS_VERSION,
                        tvAppInfo: {
                            releaseVehicle: '__DELETE__'
                        }
                    }
                },
                WEB_PLAYER_CONTEXT_CONFIGS: {
                    WEB_PLAYER_CONTEXT_CONFIG_ID_LIVING_ROOM_WATCH: {
                        device: {
                            platform: 'DESKTOP',
                            brand: 'VacuumTubeUWP',
                            model: APP_VERSION,
                            browser: 'Chrome',
                            browserVersion: CHROME_VERSION,
                            os: OS_NAME,
                            cobaltReleaseVehicle: '__DELETE__'
                        }
                    }
                }
            });

            // 3. Request Modifier: Patch the identity in every outgoing API call
            xhrModifiers.addRequestModifier((url, body) => {
                if (!url.includes('/youtubei/')) return body;

                try {
                    let json = JSON.parse(body);
                    if (json?.context?.client) {
                        functions.deepMerge(json.context.client, {
                            platform: 'DESKTOP',
                            platformDetail: '__DELETE__',
                            clientFormFactor: 'UNKNOWN_FORM_FACTOR',
                            deviceMake: 'VacuumTubeUWP',
                            deviceModel: APP_VERSION,
                            browserName: 'Chrome',
                            browserVersion: CHROME_VERSION,
                            osName: OS_NAME,
                            osVersion: OS_VERSION,
                            tvAppInfo: {
                                releaseVehicle: '__DELETE__'
                            }
                        });
                        return JSON.stringify(json);
                    }
                } catch (e) { }
                return body;
            });

            // 4. Response Modifier: Patch the TV config as it arrives
            xhrModifiers.addResponseModifier((url, text) => {
                if (!url.includes('/tv_config')) return text;

                try {
                    let parts = text.split('\n');
                    let lastLine = parts[parts.length - 1];
                    let json = JSON.parse(lastLine);

                    functions.deepMerge(json.webPlayerContextConfig.WEB_PLAYER_CONTEXT_CONFIG_ID_LIVING_ROOM_WATCH.device, {
                        platform: 'DESKTOP',
                        brand: 'VacuumTubeUWP',
                        model: APP_VERSION,
                        browser: 'Chrome',
                        browserVersion: CHROME_VERSION,
                        os: OS_NAME,
                        cobaltReleaseVehicle: '__DELETE__'
                    });

                    parts[parts.length - 1] = JSON.stringify(json);
                    return parts.join('\n');
                } catch (e) {
                    return text;
                }
            });
        };

        return module.exports;
    })(require);

    // --- modules/keybinds.js ---
    modules['keybinds'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const ui = require('ui');
        const patchFunction = require('patchFunction');
        const localeProvider = require('localeProvider');

        module.exports = async () => {
            // Wait for the locale to load so we can show the toast in the correct language
            await localeProvider.waitUntilAvailable();
            const locale = localeProvider.getLocale();

            let shiftHeld = false;
            let enterHeld = false;
            let shiftEnterHeld = false;

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Shift') shiftHeld = true;
                if (e.key === 'Enter') enterHeld = true;
                shiftEnterHeld = shiftHeld && enterHeld;
            }, true);

            document.addEventListener('keyup', (e) => {
                if (e.key === 'Shift') shiftHeld = false;
                if (e.key === 'Enter') enterHeld = false;
                shiftEnterHeld = shiftHeld && enterHeld;
            }, true);

            // Trick YouTube into thinking a "Long Press" happened instantly if Shift+Enter is held
            patchFunction(window, 'setTimeout', function (originalSetTimeout, callback, delay) {
                if (callback && callback.toString().includes('onLongPress') && shiftEnterHeld) {
                    delay = 0; // Trigger the menu immediately
                }

                return originalSetTimeout(function (...args) {
                    callback(...args);
                }, delay);
            });

            // Keybind: Ctrl + Shift + C to copy the current Video/Short URL
            document.addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
                    let url;

                    // Check if we are currently watching a "Short"
                    let shortsPage = document.querySelector('ytlr-shorts-page');
                    let isShort = !!shortsPage?.classList?.contains('zylon-focus');

                    if (isShort) {
                        let focusedThumbnail = document.querySelector('ytlr-thumbnail-details[idomkey="ytLrShortsPageThumbnail"].ytLrThumbnailDetailsFocused');
                        let thumbnailStyle = focusedThumbnail?.style.backgroundImage;
                        let id = thumbnailStyle?.split('/vi/')[1]?.slice(0, 11);
                        if (!id) return;
                        url = `https://youtube.com/shorts/${id}`;
                    } else {
                        // Standard Video
                        let baseUri = window.yt?.player?.utils?.videoElement_?.baseURI;
                        if (!baseUri || !baseUri.includes('/watch?v=')) return;
                        let id = baseUri.split('/watch?v=')[1]?.slice(0, 11);
                        if (!id) return;
                        url = `https://youtu.be/${id}`;
                    }

                    // Copy to clipboard and show the native YouTube TV Toast
                    if (navigator.clipboard && url) {
                        navigator.clipboard.writeText(url).then(() => {
                            ui.toast('VacuumTubeUWP', locale.general.video_copied || 'Video link copied');
                        });
                    }
                }
            });
        };

        return module.exports;
    })(require);

    // --- modules/leanback-settings.js ---
    modules['leanback-settings'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const configManager = require('config');
        const jsonMod = require('jsonModifiers');
        const rcMod = require('resolveCommandModifiers');
        const localeProvider = require('localeProvider');
        const functions = require('functions');

        let config = configManager.get();

        // Helper to create a button in the YouTube settings UI
        function createSettingButtonRenderer(title, summary, button, callback) {
            return {
                settingActionRenderer: {
                    title: { runs: [{ text: title }] },
                    summary: { runs: [{ text: summary }] },
                    actionButton: {
                        buttonRenderer: {
                            text: { runs: [{ text: button }] },
                            navigationEndpoint: {
                                vtConfigOption: 'vt-button',
                                vtConfigValue: callback
                            }
                        }
                    }
                }
            };
        }

        module.exports = async () => {
            await localeProvider.waitUntilAvailable();
            await functions.waitForCondition(() => !!window.ytcfg);

            const isKids = window.ytcfg.data_.INNERTUBE_CLIENT_NAME === 'TVHTML5_FOR_KIDS';
            const locale = localeProvider.getLocale();

            // 1. Handle clicks on our custom buttons
            rcMod.addInputModifier((input) => {
                if (input.vtConfigOption) {
                    if (input.vtConfigOption === 'vt-button') {
                        input.vtConfigValue(); // Run the callback
                        return false; // Stop YouTube from trying to handle this
                    }

                    // Update config if it's a toggle
                    let newConfig = {};
                    newConfig[input.vtConfigOption] = input.vtConfigValue;
                    configManager.set(newConfig);
                    config = configManager.get();

                    return false;
                }
                return input;
            });

            // 2. Inject the VacuumTubeUWP menu into the YouTube settings JSON
            jsonMod.addModifier((json) => {
                // Check if this is the settings page response
                if (json?.items?.[0]?.settingCategoryCollectionRenderer) {

                    // Remove irrelevant "Open Source Licenses" from YouTube (optional cleanup)
                    for (let item of json.items) {
                        let category = item.settingCategoryCollectionRenderer;
                        category.items = category.items.filter(c =>
                            c.settingReadOnlyItemRenderer?.itemId !== 'ABOUT_OPEN_SOURCE_LICENSES'
                        );
                    }

                    if (isKids) return json;

                    // Add a header to the first category so it's not floating
                    json.items[0].settingCategoryCollectionRenderer.title = {
                        runs: [{ text: 'YouTube' }]
                    };

                    // Inject VacuumTubeUWP at the very top (unshift)
                    json.items.unshift({
                        settingCategoryCollectionRenderer: {
                            categoryId: 'SETTINGS_CAT_VacuumTubeUWP_OVERLAY',
                            focused: false,
                            title: { runs: [{ text: 'VacuumTubeUWP' }] },
                            items: [
                                createSettingButtonRenderer(
                                    locale.settings.generic.title,
                                    locale.settings.generic.description,
                                    locale.settings.generic.button_label,
                                    () => {
                                        // This calls the global function that opens your UWP settings overlay
                                        if (window.vtOpenSettingsOverlay) {
                                            window.vtOpenSettingsOverlay();
                                        }
                                    }
                                ),
                                // Example: External Link Button
                                createSettingButtonRenderer(
                                    "Support",
                                    "Visit the project page for updates.",
                                    "Open GitHub",
                                    () => { window.open('https://github.com/TBNRBERRY/VacuumTubeUWP', '_blank'); }
                                )
                            ]
                        }
                    });
                }
                return json;
            });
        };

        return module.exports;
    })(require);

    // --- modules/low-memory-mode.js ---
    modules['low-memory-mode'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const configManager = require('config');
        const configOverrides = require('configOverrides');

        module.exports = () => {
            const config = configManager.get();

            if (config.low_memory_mode) {
                console.log('[VacuumTubeUWP] Low Memory Mode: Enabling RAM optimizations for Xbox.');

                // 1. Feature Switch for the web player
                configOverrides.environmentOverrides.push({
                    feature_switches: {
                        enable_memory_saving_mode: true,
                        // Xbox specific: force high-performance rendering over animations
                        disable_v8_idle_tasks: false
                    }
                });

                // 2. Global InnerTube context override
                // This tells the server to send smaller image payloads
                configOverrides.ytcfgOverrides.push({
                    INNERTUBE_CONTEXT: {
                        client: {
                            configInfo: {
                                // Signals to YouTube that this is a memory-constrained device
                                hardwareClass: 'LIMITED_MEMORY'
                            }
                        }
                    }
                });
            }
        };

        return module.exports;
    })(require);

    // --- modules/mouse.js ---
    modules['mouse'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //various mouse controls to improve desktop usability

        module.exports = () => {
            const ESCAPE_KEYCODE = 27;

            let visible = true;
            let lastUse = 0;

            //block scroll events (enableTouchSupport in touch-support.js adds native scrollbars, which messes with scrollwheel)
            window.addEventListener('wheel', (e) => {
                e.preventDefault()
            }, { passive: false, capture: true })

            //right click to go back
            window.addEventListener('mousedown', (e) => {
                if (e.button === 2) {
                    simulateKeyDown(ESCAPE_KEYCODE)
                    setTimeout(() => simulateKeyUp(ESCAPE_KEYCODE), 50)
                }
            })

            function simulateKeyDown(keyCode) {
                let event = new Event('keydown')
                event.keyCode = keyCode;
                document.dispatchEvent(event)
            }

            function simulateKeyUp(keyCode) {
                let event = new Event('keyup')
                event.keyCode = keyCode;
                document.dispatchEvent(event)
            }

            //make mouse disappear after a bit of no movement
            setInterval(() => {
                if (!visible) return;
                if ((Date.now() - lastUse) >= 3000) {
                    hideCursor()
                }
            }, 20)

            window.addEventListener('mousemove', () => {
                lastUse = Date.now()
                showCursor()
            })

            window.addEventListener('mousedown', () => {
                lastUse = Date.now()
                showCursor()
            })

            function showCursor() {
                document.documentElement.style.cursor = 'default'
                visible = true;
            }

            function hideCursor() {
                document.documentElement.style.cursor = 'none'
                visible = false;
            }
        }

        return module.exports;
    })(require);

    // --- modules/no-f11.js ---
    modules['no-f11'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //block youtube from seeing f11 being pressed so it doesn't impede the user trying to toggle fullscreen
        module.exports = () => {
            document.addEventListener('keydown', (e) => {
                if (e.key === 'F11') {
                    e.stopImmediatePropagation()
                }
            }, true)
        }

        return module.exports;
    })(require);

    // --- modules/prevent-visibilitychange.js ---
    modules['prevent-visibilitychange'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //don't tell youtube when application is minimized, otherwise it'll sometimes stop playback
        module.exports = () => {
            document.addEventListener('visibilitychange', (e) => {
                e.stopImmediatePropagation()
            })

            document.addEventListener('webkitvisibilitychange', (e) => {
                e.stopImmediatePropagation()
            })
        }

        return module.exports;
    })(require);

    // --- modules/remove-super-resolution.js ---
    modules['remove-super-resolution'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const jsonMod = require('jsonModifiers');
        const configManager = require('config');
        const getConfig = () => configManager.get();

        module.exports = () => {
            jsonMod.addModifier((json) => {
                // LIVE CONFIG CHECK
                if (!getConfig().remove_super_resolution) return json;

                // This targets the video metadata where the stream URLs are stored
                if (!json?.streamingData?.adaptiveFormats) return json;

                console.log('[VacuumTubeUWP] Filtering out "Super Resolution" (AI upscale) streams...');

                const originalCount = json.streamingData.adaptiveFormats.length;

                // Filter out streams tagged with the Super Resolution identifier
                json.streamingData.adaptiveFormats = json.streamingData.adaptiveFormats.filter(f =>
                    f.xtags !== 'CgcKAnNyEgEx'
                );

                const newCount = json.streamingData.adaptiveFormats.length;
                if (originalCount !== newCount) {
                    console.log(`[VacuumTubeUWP] Removed ${originalCount - newCount} upscaled stream(s).`);
                }

                return json;
            });
        };

        return module.exports;
    })(require);

    // --- modules/return-youtube-dislike.js ---
    modules['return-youtube-dislike'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        const xhrModifiers = require('xhrModifiers');
        const localeProvider = require('localeProvider');
        const configManager = require('config');
        const getConfig = () => configManager.get();

        async function fetchDislikes(videoId) {
            // Calls the public Return YouTube Dislike API
            let res = await fetch(`https://returnyoutubedislikeapi.com/Votes?videoId=${videoId}`);
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

            let data = await res.json();
            return data;
        }

        module.exports = async () => {
            await localeProvider.waitUntilAvailable();
            const locale = localeProvider.getLocale();

            xhrModifiers.addResponseModifier(async (url, text) => {
                if (!getConfig().dislikes) return;

                // The 'next' endpoint contains the video metadata and description panels
                if (!url.startsWith('/youtubei/v1/next')) {
                    return;
                }

                try {
                    let json = JSON.parse(text);
                    let videoId = json.currentVideoEndpoint?.watchEndpoint?.videoId;
                    if (!videoId) return;

                    // Find the Description panel where the "Factoids" (Likes, Views, Date) live
                    let panel = json.engagementPanels?.find(p =>
                        p.engagementPanelSectionListRenderer?.panelIdentifier === 'video-description-ep-identifier'
                    );

                    if (!panel) return;

                    // Get the dislike data from the external API
                    let votes;
                    try {
                        votes = await fetchDislikes(videoId);
                    } catch (err) {
                        console.error(`[VacuumTubeUWP] Fetching dislikes for ${videoId} failed`, err);
                        return;
                    }

                    let dislikes = votes.dislikes;
                    // Format number nicely (e.g., 1.5K instead of 1500)
                    let abbreviatedDislikes = Intl.NumberFormat(undefined, {
                        notation: 'compact',
                        maximumFractionDigits: 1
                    }).format(dislikes);

                    // Target the header factoids array
                    const headerRenderer = panel.engagementPanelSectionListRenderer.content.structuredDescriptionContentRenderer.items[0].videoDescriptionHeaderRenderer;

                    if (headerRenderer && headerRenderer.factoid) {
                        headerRenderer.factoid.push({
                            factoidRenderer: {
                                value: {
                                    simpleText: abbreviatedDislikes
                                },
                                label: {
                                    simpleText: locale.general.dislikes || "Dislikes"
                                }
                            }
                        });
                    }

                    return JSON.stringify(json);
                } catch (err) {
                    console.error("[VacuumTubeUWP] Dislike injection error:", err);
                    return text;
                }
            });
        };

        return module.exports;
    })(require);

    // --- src/modules/settings.js ---
    modules['settings'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        // Standard VacuumTubeUWP dependencies
        const configManager = require('config');
        const css = require('css');
        const localeProvider = require('localeProvider');
        const functions = require('functions');
        const controller = require('controller');

        // XBOX COMPATIBILITY BRIDGE
        const ipcRenderer = {
            invoke: async (channel, value) => {
                // Sends messages to your MainPage.xaml.cs wrapper
                console.log(`[XBOX_BRIDGE] ${channel}:${value}`);
                if (window.chrome && window.chrome.webview) {
                    window.chrome.webview.postMessage({ type: 'IPC_INVOKE', channel, value });
                }
                if (channel === 'get-userstyles') return [];
                return true;
            },
            send: (channel, value) => {
                if (window.chrome && window.chrome.webview) {
                    window.chrome.webview.postMessage({ type: 'IPC_SEND', channel, value });
                }
            },
            on: (channel, callback) => {
                if (channel === 'config-update') {
                    window.addEventListener('vt-config-replaced', (e) => callback(null, e.detail));
                }
            }
        };

        // Fix for the "process is not defined" error in Webview2
        const process = { platform: 'win32' };

        let overlayVisible = false;
        let currentTabIndex = 0;
        let currentItemIndex = 0;
        let config = configManager.get();

        const scrollOffsets = {};

        const dynamicFunction = {
            fullscreen: (value) => ipcRenderer.invoke('set-fullscreen', value),
            keep_on_top: (value) => ipcRenderer.invoke('set-on-top', value)
        };

        let tabs = [
            { id: 'adblock', localeKey: 'ad_block' },
            { id: 'sponsorblock', localeKey: 'sponsorblock' },
            { id: 'dearrow', localeKey: 'dearrow' },
            { id: 'dislikes', localeKey: 'dislikes' },
            { id: 'remove_super_resolution', localeKey: 'remove_super_resolution' },
            { id: 'hide_shorts', localeKey: 'hide_shorts' },
            { id: 'h264ify', localeKey: 'h264ify' },
            { id: 'hardware_decoding', localeKey: 'hardware_decoding' },
            { id: 'low_memory_mode', localeKey: 'low_memory_mode' },
            { id: 'fullscreen', localeKey: 'fullscreen' },
            { id: 'keep_on_top', localeKey: 'keep_on_top' },
            { id: 'userstyles', localeKey: 'userstyles' },
            { id: 'controller_support', localeKey: 'controller_support' }
        ];

        function el(tag, attrs = {}, children = []) {
            const element = document.createElement(tag);
            for (const [key, value] of Object.entries(attrs)) {
                if (key === 'className') {
                    element.className = value;
                } else if (key === 'textContent') {
                    element.textContent = value;
                } else if (key === 'style' && typeof value === 'object') {
                    Object.assign(element.style, value);
                } else if (key.startsWith('data')) {
                    element.setAttribute(key.replace(/([A-Z])/g, '-$1').toLowerCase(), value);
                } else {
                    element.setAttribute(key, value);
                }
            }
            for (const child of children) {
                if (child) element.appendChild(child);
            }
            return element;
        }

        function createOverlayDOM(locale) {
            const createToggle = (configKey) => {
                return el('div', { className: `vt-toggle ${config[configKey] ? 'vt-toggle-on' : ''}`, dataConfig: configKey }, [
                    el('div', { className: 'vt-toggle-track' }, [
                        el('div', { className: 'vt-toggle-thumb' })
                    ])
                ])
            }

            const createSettingItem = (configKey, title, description, index, focused = false) => {
                return el('div', {
                    className: `vt-setting-item ${focused ? 'vt-item-focused' : ''}`,
                    dataSetting: configKey,
                    dataIndex: String(index)
                }, [
                    el('div', { className: 'vt-setting-info' }, [
                        el('span', { className: 'vt-setting-title', textContent: title }),
                        el('span', { className: 'vt-setting-description', textContent: description })
                    ]),
                    el('div', { className: 'vt-setting-control' }, [
                        createToggle(configKey)
                    ])
                ])
            }

            const createTab = (id, label, index, selected = false) => {
                return el('div', {
                    className: `vt-tab ${selected ? 'vt-tab-selected' : ''}`,
                    dataTab: id,
                    dataIndex: String(index)
                }, [
                    el('span', { className: 'vt-tab-label', textContent: label })
                ])
            }

            // Building the overlay structure
            return el('div', {
                id: 'vt-settings-overlay-root',
                className: 'vt-settings-hidden',
                tabindex: '-1',
                style: {
                    position: 'fixed',
                    top: '0',
                    left: '0',
                    width: '100%',
                    height: '100%',
                    zIndex: '99999',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'opacity 0.2s ease'
                }
            }, [
                el('div', {
                    className: 'vt-settings-backdrop',
                    style: {
                        position: 'absolute',
                        top: '0',
                        left: '0',
                        width: '100%',
                        height: '100%',
                        background: 'rgba(0, 0, 0, 0.85)'
                    }
                }),
                el('div', {
                    className: 'vt-settings-container',
                    style: {
                        position: 'relative',
                        width: '100%',
                        maxWidth: '75vw',
                        height: '100%',
                        maxHeight: '75vh',
                        background: '#212121',
                        borderRadius: '16px',
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
                    }
                }, [
                    el('div', { className: 'vt-settings-header' }, [
                        el('span', { className: 'vt-settings-title', textContent: locale.settings.generic.title }),
                        el('span', { className: 'vt-settings-hint', textContent: locale.settings.generic.hint }),
                        el('div', { className: 'vt-settings-close', dataAction: 'close' }, [
                            el('span', { textContent: '✕' })
                        ])
                    ]),
                    el('div', { className: 'vt-settings-body' }, [
                        el('div', { className: 'vt-tabs-viewport' }, [
                            // Add new settings tabs here
                            el('div', { className: 'vt-settings-tabs', id: 'vt-settings-tabs' }, [
                                createTab('adblock', locale.settings.ad_block.title, 0, true),
                                createTab('sponsorblock', locale.settings.sponsorblock.title, 1, false),
                                createTab('dearrow', locale.settings.dearrow.title, 2, false),
                                createTab('dislikes', locale.settings.dislikes.title, 3, false),
                                createTab('remove_super_resolution', locale.settings.remove_super_resolution.title, 4, false),
                                createTab('hide_shorts', locale.settings.hide_shorts.title, 5, false),
                                createTab('h264ify', locale.settings.h264ify.title, 6, false),
                                createTab('hardware_decoding', locale.settings.hardware_decoding.title, 7, false),
                                createTab('low_memory_mode', locale.settings.low_memory_mode.title, 8, false),
                                createTab('fullscreen', locale.settings.fullscreen.title, 9, false),
                                createTab('keep_on_top', locale.settings.keep_on_top.title, 10, false),
                                createTab('userstyles', locale.settings.userstyles.title, 11, false),
                                createTab('controller_support', locale.settings.controller_support.title, 12, false),
                                process.platform === 'linux' && createTab('wayland_hdr', locale.settings.wayland_hdr.title, 13, false)
                            ]),
                            el('div', { className: 'vt-scrollbar vt-tabs-scrollbar', id: 'vt-tabs-scrollbar' }, [
                                el('div', { className: 'vt-scrollbar-thumb', id: 'vt-tabs-scrollbar-thumb' })
                            ])
                        ]),
                        // Content for settings pages
                        // More advanced example in userstyles section below
                        el('div', { className: 'vt-settings-content' }, [
                            el('div', { className: 'vt-content-panel vt-panel-active', dataPanel: 'adblock' }, [
                                createSettingItem('adblock', locale.settings.ad_block.title, locale.settings.ad_block.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'sponsorblock' }, [
                                createSettingItem('sponsorblock', locale.settings.sponsorblock.title, locale.settings.sponsorblock.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'dearrow' }, [
                                createSettingItem('dearrow', locale.settings.dearrow.title, locale.settings.dearrow.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'dislikes' }, [
                                createSettingItem('dislikes', locale.settings.dislikes.title, locale.settings.dislikes.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'remove_super_resolution' }, [
                                createSettingItem('remove_super_resolution', locale.settings.remove_super_resolution.title, locale.settings.remove_super_resolution.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'hide_shorts' }, [
                                createSettingItem('hide_shorts', locale.settings.hide_shorts.title, locale.settings.hide_shorts.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'h264ify' }, [
                                createSettingItem('h264ify', locale.settings.h264ify.title, locale.settings.h264ify.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'hardware_decoding' }, [
                                createSettingItem('hardware_decoding', locale.settings.hardware_decoding.title, locale.settings.hardware_decoding.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'low_memory_mode' }, [
                                createSettingItem('low_memory_mode', locale.settings.low_memory_mode.title, locale.settings.low_memory_mode.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'fullscreen' }, [
                                createSettingItem('fullscreen', locale.settings.fullscreen.title, locale.settings.fullscreen.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'keep_on_top' }, [
                                createSettingItem('keep_on_top', locale.settings.keep_on_top.title, locale.settings.keep_on_top.description, 0, true)
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'userstyles' }, [
                                el('div', { className: 'vt-userstyles-section' }, [
                                    el('p', { className: 'vt-userstyles-description', textContent: locale.settings.userstyles.description }),
                                    el('div', {
                                        className: 'vt-setting-item',
                                        dataSetting: 'userstyles',
                                        dataIndex: '0'
                                    }, [
                                        el('div', { className: 'vt-setting-info' }, [
                                            el('span', { className: 'vt-setting-title', textContent: locale.settings.userstyles.enable })
                                        ]),
                                        el('div', { className: 'vt-setting-control' }, [
                                            el('div', { className: `vt-toggle ${config.userstyles ? 'vt-toggle-on' : ''}`, dataConfig: 'userstyles' }, [
                                                el('div', { className: 'vt-toggle-track' }, [
                                                    el('div', { className: 'vt-toggle-thumb' })
                                                ])
                                            ])
                                        ])
                                    ]),
                                    // Scrollable viewport - uses transform-based scrolling to bypass Leanback's scroll interception
                                    el('div', { className: 'vt-userstyles-viewport' }, [
                                        el('div', { className: 'vt-userstyles-list', id: 'vt-userstyles-list' }),
                                        el('div', { className: 'vt-scrollbar', id: 'vt-userstyles-scrollbar' }, [
                                            el('div', { className: 'vt-scrollbar-thumb', id: 'vt-userstyles-scrollbar-thumb' })
                                        ])
                                    ]),
                                    el('div', {
                                        className: 'vt-button',
                                        dataAction: 'open-userstyles-folder',
                                        dataIndex: '1'
                                    }, [
                                        el('span', { textContent: locale.settings.userstyles.open_folder })
                                    ])
                                ])
                            ]),
                            el('div', { className: 'vt-content-panel', dataPanel: 'controller_support' }, [
                                createSettingItem('controller_support', locale.settings.controller_support.title, locale.settings.controller_support.description, 0, true)
                            ]),
                            process.platform === 'linux' && el('div', { className: 'vt-content-panel', dataPanel: 'wayland_hdr' }, [
                                createSettingItem('wayland_hdr', locale.settings.wayland_hdr.title, locale.settings.wayland_hdr.description, 0, true)
                            ]),
                        ])
                    ])
                ])
            ])
        }

        async function injectOverlayCSS() {
            // CSS is ours to control here, just make
            // sure to prefix `vt-` for all rules
            const styles = `
        #vt-settings-overlay-root {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            zIndex: 2147483647 !important; /* Force to front */
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 1;
            visibility: visible;
            transition: opacity 0.2s ease;
            background: rgba(0, 0, 0, 0.5); /* Dim the background */
        }

        #vt-settings-overlay-root.vt-settings-hidden {
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
        }

        .vt-settings-backdrop {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
        }

        /* Ensure the container itself is opaque */
        .vt-settings-container {
            zIndex: 2147483648;
            position: relative;
            width: 80%;
            max-width: 1200px;
            height: 70%;
            max-height: 700px;
            background: #212121 !important;
            opacity: 1 !important;
            border-radius: 16px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        }

        .vt-settings-header {
            display: flex;
            align-items: center;
            padding: 24px 32px;
            background: #212121;
        }

        .vt-settings-title {
            font-size: 28px;
            font-weight: 500;
            color: #fff;
        }

        .vt-settings-hint {
            font-size: 14px;
            color: #aaa;
            margin-left: auto;
            margin-right: 24px;
        }

        .vt-settings-close {
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            border-radius: 50%;
            font-size: 20px;
            color: #aaa;
            transition: background 0.15s ease, color 0.15s ease;
        }

        .vt-settings-close:hover,
        .vt-settings-close.vt-close-focused {
            background: #333;
            color: #fff;
            outline: 2px solid #fff;
            outline-offset: 2px;
        }

        .vt-settings-body {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        .vt-tabs-viewport {
            width: 280px;
            height: calc(100% - 50px);
            background: #212121;
            overflow: hidden;
            position: relative;
        }

        .vt-settings-tabs {
            padding: 16px;
            transition: transform 0.15s ease-out;
        }

        .vt-tabs-scrollbar {
            right: 4px;
        }

        .vt-tab {
            display: flex;
            align-items: center;
            padding: 14px 20px;
            cursor: pointer;
            transition: background 0.15s ease, color 0.15s ease;
            border-radius: 8px;
            margin-bottom: 4px;
        }

        .vt-tab:hover {
            background: #333;
        }

        .vt-tab.vt-tab-selected {
            background: #fff;
        }

        .vt-tab.vt-tab-selected .vt-tab-label {
            color: #212121;
        }

        .vt-tab.vt-tab-focused {
            outline: 2px solid #fff;
            outline-offset: 2px;
        }

        .vt-tab-label {
            font-size: 18px;
            color: #fff;
        }

        .vt-settings-content {
            flex: 1;
            padding: 24px 32px;
            overflow: hidden;
            background: #212121;
            display: flex;
            flex-direction: column;
        }

        .vt-content-panel {
            display: none;
        }

        .vt-content-panel.vt-panel-active {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            overflow: hidden;
        }

        .vt-setting-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 20px 24px;
            background: #2a2a2a;
            border-radius: 12px;
            margin-bottom: 12px;
            transition: background 0.15s ease;
            cursor: pointer;
            flex-shrink: 0;
        }

        .vt-setting-item:hover {
            background: #333;
        }

        .vt-setting-item.vt-item-focused {
            background: #3a3a3a;
            outline: 2px solid #fff;
            outline-offset: -2px;
        }

        .vt-setting-info {
            display: flex;
            flex-direction: column;
            flex: 1;
            margin-right: 24px;
        }

        .vt-setting-title {
            font-size: 20px;
            font-weight: 500;
            color: #fff;
            margin-bottom: 8px;
        }

        .vt-setting-description {
            font-size: 14px;
            color: #aaa;
            line-height: 1.4;
        }

        .vt-setting-control {
            flex-shrink: 0;
        }

        .vt-toggle {
            width: 56px;
            height: 32px;
            cursor: pointer;
        }

        .vt-toggle-track {
            width: 100%;
            height: 100%;
            background: #555;
            border-radius: 16px;
            position: relative;
            transition: background 0.2s ease;
        }

        .vt-toggle.vt-toggle-on .vt-toggle-track {
            background: #fff;
        }

        .vt-toggle-thumb {
            position: absolute;
            top: 4px;
            left: 4px;
            width: 24px;
            height: 24px;
            background: #fff;
            border-radius: 50%;
            transition: transform 0.2s ease;
        }

        .vt-toggle.vt-toggle-on .vt-toggle-thumb {
            transform: translateX(24px);
            background: #212121;
        }

        .vt-placeholder {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            min-height: 300px;
        }

        .vt-placeholder-icon {
            font-size: 64px;
            margin-bottom: 24px;
        }

        .vt-placeholder-text {
            font-size: 18px;
            color: #888;
            text-align: center;
        }

        .vt-userstyles-section {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            overflow: hidden;
        }

        .vt-userstyles-description {
            font-size: 14px;
            color: #aaa;
            margin-bottom: 20px;
            line-height: 1.5;
            flex-shrink: 0;
        }

        .vt-userstyles-viewport {
            flex: 1;
            min-height: 0;
            max-height: 280px;
            margin-bottom: 20px;
            overflow: hidden;
            position: relative;
        }

        .vt-userstyles-list {
            transition: transform 0.15s ease-out;
            padding-right: 16px;
        }

        .vt-scrollbar {
            position: absolute;
            top: 0;
            right: 0;
            width: 6px;
            height: 100%;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            opacity: 0;
            transition: opacity 0.2s ease;
        }

        .vt-userstyles-viewport:hover .vt-scrollbar,
        .vt-scrollbar.vt-scrollbar-visible {
            opacity: 1;
        }

        .vt-scrollbar-thumb {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            min-height: 30px;
            background: rgba(255, 255, 255, 0.5);
            border-radius: 3px;
            transition: transform 0.15s ease-out, background 0.15s ease;
        }

        .vt-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.7);
        }

        .vt-userstyle-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            background: #2a2a2a;
            border-radius: 8px;
            margin-bottom: 8px;
            cursor: pointer;
            transition: background 0.15s ease;
        }

        .vt-userstyle-item:hover {
            background: #333;
        }

        .vt-userstyle-item.vt-item-focused {
            background: #3a3a3a;
            outline: 2px solid #fff;
            outline-offset: -2px;
        }

        .vt-userstyle-name {
            font-size: 16px;
            color: #fff;
            flex: 1;
        }

        .vt-userstyle-toggle {
            flex-shrink: 0;
            margin-left: 16px;
        }

        .vt-userstyles-empty {
            font-size: 14px;
            color: #666;
            font-style: italic;
            padding: 12px 0;
        }

        .vt-button {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px 24px;
            background: #2a2a2a;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.15s ease;
            font-size: 16px;
            color: #fff;
            flex-shrink: 0;
        }

        .vt-button:hover {
            background: #333;
        }

        .vt-button.vt-item-focused {
            background: #fff;
            color: #212121;
            outline: 2px solid #fff;
            outline-offset: 2px;
        }
    `

            await css.inject('settings-overlay', styles)
        }

        function getOverlay() {
            return document.getElementById('vt-settings-overlay-root');
        }

        // Cached locale for userstyles refresh
        let cachedLocale = null

        async function refreshUserstylesList() {
            const listContainer = document.getElementById('vt-userstyles-list');
            if (!listContainer) return;

            listContainer.replaceChildren(); // clears children

            try {
                const styles = await ipcRenderer.invoke('get-userstyles');
                const disabledList = config.disabled_userstyles || [];

                // DEFENSIVE: Ensure cachedLocale and sub-properties exist before reading
                const userstyleLocale = cachedLocale?.settings?.userstyles || { warn_empty: 'No styles found', failed_to_load: 'Error loading styles' };

                if (styles.length === 0) {
                    const emptyMsg = el('div', {
                        className: 'vt-userstyles-empty',
                        textContent: userstyleLocale.warn_empty
                    });
                    listContainer.appendChild(emptyMsg);
                } else {
                    styles.forEach(({ filename }, idx) => {
                        const isEnabled = !disabledList.includes(filename);
                        const item = el('div', {
                            className: 'vt-userstyle-item',
                            dataUserstyle: filename,
                            dataIndex: String(idx + 1)
                        }, [
                            el('span', { className: 'vt-userstyle-name', textContent: filename }),
                            el('div', { className: 'vt-userstyle-toggle' }, [
                                el('div', { className: `vt-toggle ${isEnabled ? 'vt-toggle-on' : ''}`, dataUserstyleToggle: filename }, [
                                    el('div', { className: 'vt-toggle-track' }, [
                                        el('div', { className: 'vt-toggle-thumb' })
                                    ])
                                ])
                            ])
                        ]);
                        listContainer.appendChild(item);
                    });
                }

                const button = document.querySelector('.vt-button[data-action="open-userstyles-folder"]');
                if (button) {
                    button.dataset.index = String(styles.length + 1);
                }
            } catch (error) {
                console.error('[VT Settings Overlay] Failed to load userstyles:', error);
                const userstyleLocale = cachedLocale?.settings?.userstyles || { failed_to_load: 'Error loading styles' };
                const errorMsg = el('div', {
                    className: 'vt-userstyles-empty',
                    textContent: userstyleLocale.failed_to_load
                });
                listContainer.appendChild(errorMsg);
            }
        }

        function showOverlay() {
            const overlay = getOverlay();
            if (!overlay) return;

            // CRITICAL: overlayVisible must be a timestamp for the gamepad debounce logic to work
            overlayVisible = Date.now();

            overlay.classList.remove('vt-settings-hidden');
            overlay.style.opacity = '1';
            overlay.style.pointerEvents = 'auto';
            overlay.focus();

            refreshUserstylesList();

            currentTabIndex = 0;
            currentItemIndex = 0;
            updateFocus('content');
        }

        function hideOverlay() {
            const overlay = getOverlay();
            if (!overlay) return;

            overlayVisible = false;
            overlay.classList.add('vt-settings-hidden');
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'none';
            overlay.blur();
        }

        function updateFocus(area) {
            const overlay = getOverlay()
            if (!overlay) return

            overlay.querySelectorAll('.vt-tab-focused, .vt-item-focused, .vt-close-focused').forEach(el => {
                el.classList.remove('vt-tab-focused', 'vt-item-focused', 'vt-close-focused')
            })

            focusArea = area

            if (area === 'tabs') {
                const tab = overlay.querySelector(`.vt-tab[data-index="${currentTabIndex}"]`)
                if (tab) {
                    tab.classList.add('vt-tab-focused')
                    updateViewportScroll('.vt-tabs-viewport', '#vt-settings-tabs', tab, '#vt-tabs-scrollbar-thumb')
                }
            } else if (area === 'content') {
                const panel = overlay.querySelector('.vt-content-panel.vt-panel-active')
                if (panel) {
                    let focusedElement = null

                    const item = panel.querySelector(`.vt-setting-item[data-index="${currentItemIndex}"]`)
                    if (item) {
                        item.classList.add('vt-item-focused')
                        focusedElement = item
                    }

                    if (!focusedElement) {
                        const userstyleItem = panel.querySelector(`.vt-userstyle-item[data-index="${currentItemIndex}"]`)
                        if (userstyleItem) {
                            userstyleItem.classList.add('vt-item-focused')
                            focusedElement = userstyleItem
                        }
                    }

                    if (!focusedElement) {
                        const button = panel.querySelector(`.vt-button[data-index="${currentItemIndex}"]`)
                        if (button) {
                            button.classList.add('vt-item-focused')
                            focusedElement = button
                        }
                    }

                    if (focusedElement && tabs[currentTabIndex]?.id === 'userstyles') {
                        updateViewportScroll('.vt-userstyles-viewport', '#vt-userstyles-list', focusedElement, '#vt-userstyles-scrollbar-thumb')
                    }
                }
            } else if (area === 'close') {
                const closeBtn = overlay.querySelector('.vt-settings-close')
                if (closeBtn) closeBtn.classList.add('vt-close-focused')
            }
        }

        /**
         * Updates transform-based scrolling for a viewport/list pair.
         * Use this instead of native scrolling to bypass Leanback's scroll interception.
         *
         * @param {string} viewportSelector - CSS selector for the viewport (overflow:hidden container)
         * @param {string} listSelector - CSS selector or ID for the scrollable list inside viewport
         * @param {HTMLElement} focusedElement - The element to scroll into view
         * @param {string} [scrollbarThumbSelector] - Optional CSS selector for custom scrollbar thumb
         */
        function updateViewportScroll(viewportSelector, listSelector, focusedElement, scrollbarThumbSelector) {
            const viewport = document.querySelector(viewportSelector)
            const list = document.querySelector(listSelector) || document.getElementById(listSelector.replace('#', ''))
            if (!list || !viewport) return

            const scrollId = listSelector

            if (scrollOffsets[scrollId] === undefined) {
                scrollOffsets[scrollId] = 0
            }

            if (!list.contains(focusedElement)) {
                list.style.transform = 'translateY(0px)'
                scrollOffsets[scrollId] = 0
                updateScrollbar(viewport, list, 0, scrollbarThumbSelector)
                return
            }

            const viewportHeight = viewport.clientHeight
            const itemTop = focusedElement.offsetTop
            const itemHeight = focusedElement.offsetHeight
            const itemBottom = itemTop + itemHeight

            if (itemBottom - scrollOffsets[scrollId] > viewportHeight) {
                scrollOffsets[scrollId] = itemBottom - viewportHeight + 10
            }
            else if (itemTop < scrollOffsets[scrollId]) {
                scrollOffsets[scrollId] = Math.max(0, itemTop - 10)
            }

            list.style.transform = `translateY(-${scrollOffsets[scrollId]}px)`
            updateScrollbar(viewport, list, scrollOffsets[scrollId], scrollbarThumbSelector)
        }

        /**
         * Updates the custom scrollbar thumb position and size.
         */
        function updateScrollbar(viewport, list, scrollOffset, thumbSelector) {
            if (!thumbSelector) return

            const thumb = document.querySelector(thumbSelector) || document.getElementById(thumbSelector.replace('#', ''))
            const scrollbar = thumb?.parentElement
            if (!thumb || !scrollbar) return

            const viewportHeight = viewport.clientHeight
            const listHeight = list.scrollHeight

            // Hide scrollbar if content fits
            if (listHeight <= viewportHeight) {
                scrollbar.classList.remove('vt-scrollbar-visible')
                return
            }

            scrollbar.classList.add('vt-scrollbar-visible')

            // Calculate thumb size (proportional to visible area)
            const thumbHeight = Math.max(30, (viewportHeight / listHeight) * viewportHeight)
            thumb.style.height = `${thumbHeight}px`

            // Calculate thumb position
            const maxScroll = listHeight - viewportHeight
            const scrollPercent = maxScroll > 0 ? scrollOffset / maxScroll : 0
            const maxThumbTop = viewportHeight - thumbHeight
            const thumbTop = scrollPercent * maxThumbTop

            thumb.style.transform = `translateY(${thumbTop}px)`
        }

        /**
         * Touch drag scrolling for a viewport/list pair.
         * Call this once per viewport after the DOM is ready.
         *
         * @param {string} viewportSelector - CSS selector for the viewport container
         * @param {string} listSelector - CSS selector for the scrollable list
         * @param {string} [scrollbarThumbSelector] - Optional CSS selector for scrollbar thumb
         */
        function setupTouchScroll(viewportSelector, listSelector, scrollbarThumbSelector) {
            const viewport = document.querySelector(viewportSelector)
            const list = document.querySelector(listSelector) || document.getElementById(listSelector.replace('#', ''))
            if (!viewport || !list) return

            const scrollId = listSelector
            let touchStartY = 0
            let startScrollOffset = 0
            let isDragging = false

            viewport.addEventListener('touchstart', (e) => {
                if (e.touches.length !== 1) return
                touchStartY = e.touches[0].clientY
                startScrollOffset = scrollOffsets[scrollId] || 0
                isDragging = true
                list.style.transition = 'none'
            }, { passive: true })

            viewport.addEventListener('touchmove', (e) => {
                if (!isDragging || e.touches.length !== 1) return

                const touchY = e.touches[0].clientY
                const deltaY = touchStartY - touchY

                const viewportHeight = viewport.clientHeight
                const listHeight = list.scrollHeight
                const maxScroll = Math.max(0, listHeight - viewportHeight)

                let newOffset = startScrollOffset + deltaY
                newOffset = Math.max(0, Math.min(maxScroll, newOffset))

                scrollOffsets[scrollId] = newOffset
                list.style.transform = `translateY(-${newOffset}px)`
                updateScrollbar(viewport, list, newOffset, scrollbarThumbSelector)
            }, { passive: true })

            const endDrag = () => {
                if (!isDragging) return
                isDragging = false
                list.style.transition = ''
            }

            viewport.addEventListener('touchend', endDrag, { passive: true })
            viewport.addEventListener('touchcancel', endDrag, { passive: true })
        }

        /**
         * Resets the scroll position for a viewport/list pair.
         *
         * @param {string} listSelector - CSS selector or ID for the scrollable list
         * @param {string} [scrollbarThumbSelector] - Optional CSS selector for custom scrollbar thumb
         */
        function resetViewportScroll(listSelector, scrollbarThumbSelector) {
            const list = document.querySelector(listSelector) || document.getElementById(listSelector.replace('#', ''))
            if (list) {
                list.style.transform = 'translateY(0px)'
            }
            scrollOffsets[listSelector] = 0

            // Reset scrollbar thumb position
            if (scrollbarThumbSelector) {
                const thumb = document.querySelector(scrollbarThumbSelector) || document.getElementById(scrollbarThumbSelector.replace('#', ''))
                if (thumb) {
                    thumb.style.transform = 'translateY(0px)'
                }
            }
        }

        function selectTab(index) {
            const overlay = getOverlay()
            if (!overlay) return

            resetViewportScroll('#vt-userstyles-list', '#vt-userstyles-scrollbar-thumb')

            currentTabIndex = index
            currentItemIndex = 0

            overlay.querySelectorAll('.vt-tab').forEach(tab => {
                tab.classList.remove('vt-tab-selected')
            })
            const selectedTab = overlay.querySelector(`.vt-tab[data-index="${index}"]`)
            if (selectedTab) {
                selectedTab.classList.add('vt-tab-selected')
                const tabId = selectedTab.dataset.tab

                overlay.querySelectorAll('.vt-content-panel').forEach(panel => {
                    panel.classList.remove('vt-panel-active')
                })
                const activePanel = overlay.querySelector(`.vt-content-panel[data-panel="${tabId}"]`)
                if (activePanel) activePanel.classList.add('vt-panel-active')
            }
        }

        function toggleSetting(configKey) {
            const newValue = !config[configKey]
            configManager.set({ [configKey]: newValue })
            config = configManager.get()

            const overlay = getOverlay()
            if (overlay) {
                const toggle = overlay.querySelector(`.vt-toggle[data-config="${configKey}"]`)
                if (toggle) {
                    toggle.classList.toggle('vt-toggle-on', newValue)
                }
            }

            if (dynamicFunction[configKey]) {
                dynamicFunction[configKey](newValue)
            }
        }

        function toggleUserstyle(filename) {
            const disabledList = config.disabled_userstyles || []
            const isCurrentlyDisabled = disabledList.includes(filename)

            let newDisabledList
            if (isCurrentlyDisabled) {
                newDisabledList = disabledList.filter(f => f !== filename)
            } else {
                newDisabledList = [...disabledList, filename]
            }

            configManager.set({ disabled_userstyles: newDisabledList })
            config = configManager.get()

            const overlay = getOverlay()
            if (overlay) {
                const toggle = overlay.querySelector(`.vt-toggle[data-userstyle-toggle="${filename}"]`)
                if (toggle) {
                    toggle.classList.toggle('vt-toggle-on', !newDisabledList.includes(filename))
                }
            }

            // Notify userstyles module to update via custom DOM event
            window.dispatchEvent(new CustomEvent('vt-userstyle-toggle', {
                detail: { filename, enabled: isCurrentlyDisabled }
            }))
        }

        function getItemCount() {
            const overlay = getOverlay()
            if (!overlay) return 0
            const panel = overlay.querySelector('.vt-content-panel.vt-panel-active')
            if (!panel) return 0
            // Count setting items, userstyle items, and buttons
            const settingItems = panel.querySelectorAll('.vt-setting-item').length
            const userstyleItems = panel.querySelectorAll('.vt-userstyle-item').length
            const buttons = panel.querySelectorAll('.vt-button').length
            return settingItems + userstyleItems + buttons
        }

        let focusArea = 'content' // 'tabs', 'content', or 'close'

        function handleKeyDown(e) {
            if (!overlayVisible) return;

            const key = e.key;

            // Handle escape/back
            if (key === 'Escape' || key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                hideOverlay();
                return;
            }

            // Handle navigation
            if (key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                if (focusArea === 'tabs') {
                    if (currentTabIndex > 0) {
                        currentTabIndex--;
                        selectTab(currentTabIndex);
                        updateFocus('tabs');
                    }
                } else if (focusArea === 'content') {
                    if (currentItemIndex > 0) {
                        currentItemIndex--;
                        updateFocus('content');
                    } else {
                        focusArea = 'close';
                        updateFocus('close');
                    }
                }
            } else if (key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                if (focusArea === 'close') {
                    focusArea = 'content';
                    currentItemIndex = 0;
                    updateFocus('content');
                } else if (focusArea === 'tabs') {
                    if (currentTabIndex < tabs.length - 1) {
                        currentTabIndex++;
                        selectTab(currentTabIndex);
                        updateFocus('tabs');
                    }
                } else if (focusArea === 'content') {
                    const maxIndex = getItemCount() - 1;
                    if (currentItemIndex < maxIndex) {
                        currentItemIndex++;
                        updateFocus('content');
                    }
                }
            } else if (key === 'ArrowLeft') {
                e.preventDefault();
                e.stopPropagation();
                if (focusArea !== 'close') {
                    focusArea = 'tabs';
                    updateFocus('tabs');
                }
            } else if (key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                if (focusArea === 'tabs') {
                    focusArea = 'content';
                    updateFocus('content');
                } else if (focusArea === 'content') {
                    focusArea = 'close';
                    updateFocus('close');
                }
            } else if (key === 'Enter' || key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                if (focusArea === 'close') {
                    hideOverlay();
                } else if (focusArea === 'tabs') {
                    focusArea = 'content';
                    updateFocus('content');
                } else if (focusArea === 'content') {
                    const overlay = getOverlay();
                    const panel = overlay.querySelector('.vt-content-panel.vt-panel-active');
                    if (panel) {
                        const item = panel.querySelector(`.vt-setting-item[data-index="${currentItemIndex}"]`);
                        if (item) {
                            const configKey = item.dataset.setting;
                            if (configKey) toggleSetting(configKey);
                            return;
                        }

                        const userstyleItem = panel.querySelector(`.vt-userstyle-item[data-index="${currentItemIndex}"]`);
                        if (userstyleItem) {
                            const filename = userstyleItem.dataset.userstyle;
                            if (filename) toggleUserstyle(filename);
                            return;
                        }

                        const button = panel.querySelector(`.vt-button[data-index="${currentItemIndex}"]`);
                        if (button && button.dataset.action === 'open-userstyles-folder') {
                            ipcRenderer.invoke('open-userstyles-folder');
                            return;
                        }
                    }
                }
            }
        }

        const gamepadKeyMap = {
            0: 'Enter',        //a
            1: 'Escape',       //b
            12: 'ArrowUp',     //dpad up
            13: 'ArrowDown',   //dpad down
            14: 'ArrowLeft',   //dpad left
            15: 'ArrowRight',  //dpad right

            1012: 'ArrowUp',   //left stick up
            1014: 'ArrowDown', //left stick down
            1011: 'ArrowLeft', //left stick left
            1013: 'ArrowRight' //left stick right
        }

        function setupEventListeners() {
            // Global hotkey (Ctrl+O)
            document.addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.key.toLowerCase() === 'o' && !overlayVisible) {
                    e.preventDefault();
                    e.stopPropagation();
                    showOverlay();
                }
            }, true);

            // Blocking Input Phase
            document.addEventListener('keydown', (e) => {
                if (overlayVisible) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    handleKeyDown(e);
                }
            }, true);

            document.addEventListener('keyup', (e) => {
                if (overlayVisible) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }
            }, true);

            // Click Handling
            document.addEventListener('click', (e) => {
                if (!overlayVisible) return;
                const overlay = getOverlay();
                if (!overlay) return;

                if (e.target.classList.contains('vt-settings-backdrop') || e.target.closest('.vt-settings-close')) {
                    hideOverlay();
                    return;
                }

                const tab = e.target.closest('.vt-tab');
                if (tab) {
                    selectTab(parseInt(tab.dataset.index));
                    focusArea = 'content';
                    updateFocus('content');
                    return;
                }

                const item = e.target.closest('.vt-setting-item');
                if (item && item.dataset.setting) {
                    toggleSetting(item.dataset.setting);
                    return;
                }

                const userstyleItem = e.target.closest('.vt-userstyle-item');
                if (userstyleItem && userstyleItem.dataset.userstyle) {
                    toggleUserstyle(userstyleItem.dataset.userstyle);
                    return;
                }

                const button = e.target.closest('.vt-button');
                if (button && button.dataset.action === 'open-userstyles-folder') {
                    ipcRenderer.invoke('open-userstyles-folder');
                }
            }, true);

            controller.on('down', (e) => {
                // Debounce check against the timestamp set in showOverlay
                if (overlayVisible && (Date.now() - overlayVisible) < 100) return;

                let key = gamepadKeyMap[e.code];
                if (key) {
                    handleKeyDown({ key, preventDefault: () => { }, stopPropagation: () => { } });
                }
            });
        }

        module.exports = async () => {
            await localeProvider.waitUntilAvailable();

            let locale = localeProvider.getLocale();
            let attempts = 0;
            // RETRY LOOP: Specifically wait for .generic to exist
            while ((!locale || !locale.generic) && attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 50));
                locale = localeProvider.getLocale();
                attempts++;
            }

            if (!locale || !locale.generic) {
                console.warn('[VacuumTubeUWP] Emergency fallback locales used.');
                locale = {
                    generic: { close: 'Close' },
                    tabs: { general: 'General', userstyles: 'Userstyles' },
                    settings: { userstyles: { warn_empty: 'No styles found', failed_to_load: 'Error' } }
                };
            }

            cachedLocale = locale;

            await functions.waitForCondition(() => !!document.body);
            await injectOverlayCSS();

            const overlayElement = createOverlayDOM(locale);
            if (overlayElement) {
                document.body.appendChild(overlayElement);
            }

            setupTouchScroll('.vt-tabs-viewport', '#vt-settings-tabs', '#vt-tabs-scrollbar-thumb');
            setupTouchScroll('.vt-userstyles-viewport', '#vt-userstyles-list', '#vt-userstyles-scrollbar-thumb');

            setupEventListeners();

            ipcRenderer.on('config-update', (event, newConfig) => {
                config = newConfig;
                const overlay = getOverlay();
                if (overlay) {
                    overlay.querySelectorAll('.vt-toggle').forEach(toggle => {
                        const key = toggle.dataset.config;
                        if (key && config[key] !== undefined) {
                            toggle.classList.toggle('vt-toggle-on', config[key]);
                        }
                    });
                }
            });

            window.vtOpenSettingsOverlay = showOverlay;
            window.vtToggleSettingsOverlay = () => overlayVisible ? hideOverlay() : showOverlay();
        };

        return module.exports;
    })(require);

    // --- modules/suport-webp.js ---
    modules['support-webp'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //advertise webp support (disabled by default for ps4 ua)
        const configOverrides = require('configOverrides')

        module.exports = () => {
            configOverrides.ytcfgOverrides.push({
                INNERTUBE_CONTEXT: {
                    client: {
                        webpSupport: true
                    }
                }
            })
        }

        return module.exports;
    })(require);

    // --- modules/touch-support.js ---
    modules['touch-support'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //onscreen touch controls + native scrollbars
        const configOverrides = require('configOverrides')

        module.exports = () => {
            configOverrides.tectonicConfigOverrides.push({
                featureSwitches: {
                    enableTouchSupport: true //native scrollbars
                }
            })

            //fix native scrollbars causing space to jump the page down and break everything
            window.addEventListener('keydown', (e) => {
                if (e.code === 'Space') {
                    e.preventDefault()
                }
            })

            window.addEventListener('load', () => {
                const touchKeyCodeMap = {
                    'back': 27, //escape
                    'select': 13, //enter
                    'up': 38,
                    'down': 40,
                    'left': 37,
                    'right': 39
                }

                function simulateKeyDown(keyCode) {
                    let event = new Event('keydown')
                    event.keyCode = keyCode;
                    document.dispatchEvent(event)
                }

                function simulateKeyUp(keyCode) {
                    let event = new Event('keyup')
                    event.keyCode = keyCode;
                    document.dispatchEvent(event)
                }

                let zIndex = 999;
                let controls = document.createElement('div')

                let bottomLeft = document.createElement('div')
                bottomLeft.style.position = 'absolute'
                bottomLeft.style.bottom = '5vh'
                bottomLeft.style.left = '5vh'
                bottomLeft.style.zIndex = zIndex.toString()
                controls.appendChild(bottomLeft)

                let bottomRight = document.createElement('div')
                bottomRight.style.position = 'absolute'
                bottomRight.style.bottom = '5vh'
                bottomRight.style.right = '5vh'
                bottomRight.style.zIndex = zIndex.toString()
                controls.appendChild(bottomRight)

                function createCircularButton(text, keyCode, margin, ytIcon) {
                    let button = document.createElement('div')
                    button.style.display = 'inline-flex'
                    button.style.justifyContent = 'center'
                    button.style.alignItems = 'center'
                    button.style.width = '10vw'
                    button.style.height = '10vw'
                    button.style.backgroundColor = '#272727'
                    button.style.opacity = '0.9'
                    button.style.borderRadius = '50%'
                    button.style.color = 'white'
                    button.style.fontWeight = 'bold'
                    button.style.userSelect = 'none'
                    button.style.verticalAlign = 'middle'
                    button.style.zIndex = (zIndex + 1).toString()
                    button.textContent = text;

                    button.ontouchstart = () => simulateKeyDown(keyCode)
                    button.ontouchend = () => simulateKeyUp(keyCode)

                    if (margin) {
                        button.style.marginLeft = '1vw'
                    }

                    if (ytIcon) {
                        button.style.fontFamily = 'YouTube Icons Outlined'
                        button.style.fontSize = '5vw'
                    }

                    return button;
                }

                let left = createCircularButton('\ue5de', touchKeyCodeMap.left, true, true)
                bottomLeft.appendChild(left)

                let right = createCircularButton('\ue5df', touchKeyCodeMap.right, true, true)
                bottomLeft.appendChild(right)

                let up = createCircularButton('\ue5de', touchKeyCodeMap.up, true, true)
                up.style.transform = 'rotate(90deg)' //up arrow, youtube icons dont have one
                bottomLeft.appendChild(up)

                let down = createCircularButton('\ue5de', touchKeyCodeMap.down, true, true)
                down.style.transform = 'rotate(-90deg)' //down arrow, youtube icons dont have one
                bottomLeft.appendChild(down)

                let back = createCircularButton('◦', touchKeyCodeMap.back, true)
                back.style.fontSize = '7vw'
                bottomRight.appendChild(back)

                let select = createCircularButton('·', touchKeyCodeMap.select, true)
                select.style.fontSize = '12vw'
                bottomRight.appendChild(select)

                document.body.appendChild(controls)

                let visible = true;
                let lastTouch = 0;

                function hide() {
                    controls.style.display = 'none'
                    visible = false;
                }

                function show() {
                    controls.style.display = ''
                    visible = true;
                }

                hide()

                setInterval(() => {
                    if (!visible) return;
                    if ((Date.now() - lastTouch) >= 3000) {
                        hide()
                    }
                }, 20)

                window.addEventListener('touchstart', (e) => {
                    lastTouch = Date.now()

                    if (!visible) {
                        e.preventDefault()
                        show()
                    }
                })
            })
        }

        return module.exports;
    })(require);

    // --- modules/userstyles.js ---
    modules['userstyles'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        // Standard VacuumTubeUWP dependencies
        const configManager = require('config');
        const functions = require('functions');
        const css = require('css');

        // XBOX COMPATIBILITY: Mocking Electron ipcRenderer
        const ipcRenderer = {
            invoke: async (channel) => {
                console.log(`[VacuumTubeUWP-Userstyles] Bridge: ${channel}`);
                // UWP/Xbox cannot easily read local file directories like Electron
                // We return an empty list to prevent crashes.
                return [];
            },
            on: (channel, callback) => {
                // Mapping internal events to the fake IPC listener
                if (channel === 'config-update') {
                    window.addEventListener('vt-config-replaced', (e) => callback(null, e.detail));
                }
            }
        };

        let config = configManager.get();
        const injected = new Set();

        function injectCSS(filename, text) {
            const id = getId(filename);
            injected.add(id);
            css.inject(id, text);
            console.log(`[Userstyles] Injected: ${id}`);
        }

        function removeCSS(identifier, isFileName) {
            let id = identifier;
            if (isFileName) {
                id = getId(identifier);
            }

            injected.delete(id);
            css.delete(id);
            console.log(`[Userstyles] Removed: ${id}`);
        }

        async function loadUserstyles() {
            if (!config.userstyles) {
                console.log('[Userstyles] Disabled in config');
                return;
            }

            try {
                const styles = await ipcRenderer.invoke('get-userstyles');
                const disabledList = config.disabled_userstyles || [];

                styles.forEach(({ filename, css: styleContent }) => {
                    if (!disabledList.includes(filename)) {
                        injectCSS(filename, styleContent);
                    } else {
                        console.log(`[Userstyles] Skipping disabled: ${filename}`);
                    }
                });

                console.log(`[Userstyles] Loaded ${styles.length - disabledList.length} of ${styles.length} stylesheets`);
            } catch (error) {
                console.error('[Userstyles] Failed to load styles:', error);
            }
        }

        function getId(filename) {
            let filenameNoExt = filename.slice(0, -('.css'.length));
            let cleanFilename = filenameNoExt.replace(/[^a-zA-Z0-9]/g, '-');
            return `userstyle-${cleanFilename}`;
        }

        module.exports = async () => {
            await functions.waitForCondition(() => !!document.head);

            console.log('[Userstyles] Initializing...');

            await loadUserstyles();

            // Standard event listeners for config and toggle updates
            ipcRenderer.on('config-update', (event, newConfig) => {
                const wasEnabled = config.userstyles;
                config = newConfig;

                if (config.userstyles && !wasEnabled) {
                    loadUserstyles();
                } else if (!config.userstyles && wasEnabled) {
                    injected.forEach((id) => {
                        removeCSS(id);
                    });
                }
            });

            // These events would be triggered by your Settings menu or external bridge
            window.addEventListener('vt-userstyle-updated', (event) => {
                const { filename, css: styleContent } = event.detail;
                if (config.userstyles) {
                    injectCSS(filename, styleContent);
                }
            });

            window.addEventListener('vt-userstyle-removed', (event) => {
                const { filename } = event.detail;
                const id = getId(filename);
                removeCSS(id, true);
            });

            window.addEventListener('vt-userstyle-toggle', async (event) => {
                const { filename, enabled } = event.detail;
                if (!config.userstyles) return;

                console.log(`[Userstyles] Toggle ${filename}: ${enabled ? 'enabled' : 'disabled'}`);

                if (enabled) {
                    try {
                        const styles = await ipcRenderer.invoke('get-userstyles');
                        const style = styles.find(s => s.filename === filename);
                        if (style) {
                            injectCSS(style.filename, style.css);
                        }
                    } catch (error) {
                        console.error(`[Userstyles] Failed to load ${filename}:`, error);
                    }
                } else {
                    removeCSS(filename, true);
                }
            });

            console.log('[Userstyles] Initialized');
        };

        return module.exports;
    })(require);

    // --- modules/sponsorblock.js ---
    modules['sponsorblock'] = (function (require) {
        const module = { exports: {} };
        const exports = module.exports;

        //enables a switch that adds a Microphone Access button to settings, and tells the user about the privacy policy when first enabling it
        const configOverrides = require('configOverrides')

        module.exports = () => {
            configOverrides.tectonicConfigOverrides.push({
                featureSwitches: {
                    hasSamsungVoicePrivacyNotice: true
                }
            })
        }

        return module.exports;
    })(require);

    // 5. EXECUTION BOOTSTRAP
    (async () => {
        try {
            console.log('[VacuumTubeUWP] Final Bootstrapping phase...');

            // 1. Core Utilities / Modifiers
            if (modules['adblock']) modules['adblock']();
            if (modules['h264ify']) modules['h264ify']();
            if (modules['remove-super-resolution']) modules['remove-super-resolution']();
            if (modules['hide-shorts']) modules['hide-shorts']();
            if (modules['dearrow']) modules['dearrow']();

            // 2. Load Locales first
            const localeProvider = require('localeProvider');
            if (localeProvider && localeProvider.waitUntilAvailable) {
                await localeProvider.waitUntilAvailable();
            }

            // 3. INITIALIZE CONTROLLER SUPPORT
            console.log('[VacuumTubeUWP] Initializing Controller Support...');
            if (modules['controller-support']) {
                await modules['controller-support']();
            }

            // 4. Initializing Heavy Features
            console.log('[VacuumTubeUWP] Loading userstyles...');
            if (modules['userstyles']) await modules['userstyles']();

            console.log('[VacuumTubeUWP] Loading Return YouTube Dislike...');
            if (modules['return-youtube-dislike']) await modules['return-youtube-dislike']();

            console.log('[VacuumTubeUWP] Loading SponsorBlock...');
            if (modules['sponsorblock']) await modules['sponsorblock']();

            console.log('[VacuumTubeUWP] Loading Settings Overlay...');
            if (modules['settings']) await modules['settings']();

            // 5. Input handling
            if (modules['keybinds']) await modules['keybinds']();

            console.log('%c[VacuumTubeUWP] STARTUP COMPLETE: Xbox Version is live.', 'color: #00ff00; font-weight: bold;');
        } catch (e) {
            console.error('[VacuumTubeUWP] FATAL BOOTSTRAP ERROR:', e);
        }
    })();
})();