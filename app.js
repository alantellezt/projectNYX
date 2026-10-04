/* =====================================================================
   app.js — Une todos los drivers: conexión BLE, lista de dispositivos,
   controles globales y detalle individual de cada dispositivo.
   ===================================================================== */
(function () {
    'use strict';
    const { $, hex, u8 } = LED;

    const devices = [];        // todos los LEDDevice (conectados o no)
    let modalDev = null;       // dispositivo abierto en el detalle

    // ------------------------------------------------------------------
    // Persistencia: la lista de dispositivos y su último estado se guardan
    // en localStorage y se restauran al abrir la app.
    // ------------------------------------------------------------------
    const STORAGE_KEY = 'led-control:devices:v1';
    let saveTimer = null;

    function saveDevices() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try {
                const data = devices.filter(d => d.driver).map(d => ({
                    id: d.id, name: d.savedName, driver: d.driver.id, state: d.state
                }));
                localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            } catch (e) { /* almacenamiento no disponible */ }
        }, 250);
    }

    function loadSaved() {
        try {
            const a = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            return Array.isArray(a) ? a.filter(x => x && x.id && LED.drivers.some(d => d.id === x.driver)) : [];
        } catch (e) { return []; }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const hexToRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    const live = () => devices.filter(d => d.connected);

    function toast(msg, ms = 3800) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove('show'), ms);
    }

    // ==================================================================
    // DISPOSITIVO: conexión + envío + acciones (usa el driver detectado)
    // ==================================================================
    class LEDDevice {
        // bt puede ser null: dispositivo recordado que aún no se ha autorizado en esta sesión
        constructor(bt, saved) {
            this.bt = null;
            this.id = saved ? saved.id : bt.id;
            this.savedName = saved ? (saved.name || '') : '';
            this.driver = saved ? (LED.drivers.find(d => d.id === saved.driver) || null) : null;
            this.api = null;
            this.chars = [];
            this.char = null;
            this.connected = false;
            this.searching = false;   // esperando / conectando automáticamente
            this.busy = false;
            this.removed = false;
            this.failures = 0;
            this._cancelWait = null;
            this.state = Object.assign({ on: false, r: 255, g: 0, b: 0, brightness: 100, effect: 0, speed: 50 }, saved && saved.state);
            this.chain = Promise.resolve();
            this.timers = {};
            this.lastRun = {};
            this.logLines = [];
            if (bt) this.attach(bt);
        }

        get name() { return (this.bt && this.bt.name) || this.savedName || 'Sin nombre'; }

        attach(bt) {
            this.bt = bt;
            this.id = bt.id;
            if (bt.name) this.savedName = bt.name;
            bt.__ledDev = this;
            if (!bt.__ledBound) {
                bt.__ledBound = true;
                bt.addEventListener('gattserverdisconnected', () => bt.__ledDev && bt.__ledDev._onDrop());
            }
        }

        _onDrop() {
            const was = this.connected;
            this.connected = false;
            this.char = null;
            this.log('Desconectado');
            if (devices.includes(this)) { refreshCards(); updateGlobal(); }
            if (modalDev === this) syncModal();
            // Si se cayó la conexión (apagado, fuera de alcance), reconectar solo
            if (was && devices.includes(this) && !this.removed) { this.failures = 0; autoConnect(this); }
        }

        log(msg) {
            this.logLines.push(msg);
            if (this.logLines.length > 300) this.logLines.shift();
            if (modalDev === this) appendModalLog(msg);
        }

        // Espera a que el dispositivo se anuncie (esté encendido y al alcance).
        // Resuelve 'seen' | 'cancelled' | 'unsupported'
        waitForAdvert() {
            const bt = this.bt;
            if (typeof bt.watchAdvertisements !== 'function') return Promise.resolve('unsupported');
            return new Promise(resolve => {
                const ac = new AbortController();
                const finish = r => {
                    if (!this._cancelWait) return;
                    this._cancelWait = null;
                    bt.removeEventListener('advertisementreceived', onAdv);
                    try { ac.abort(); } catch (e) {}
                    resolve(r);
                };
                const onAdv = () => finish('seen');
                this._cancelWait = () => finish('cancelled');
                bt.addEventListener('advertisementreceived', onAdv);
                bt.watchAdvertisements({ signal: ac.signal }).catch(e => {
                    this.log('watchAdvertisements: ' + e.message);
                    finish('unsupported');
                });
            });
        }
        cancelWait() { if (this._cancelWait) this._cancelWait(); }

        // opts.restore = true → reaplica el último estado guardado (reconexión automática)
        async open(opts = {}) {
            if (!this.bt) throw new Error('Dispositivo sin autorizar');
            this.log('Conectando…');
            const server = await this.bt.gatt.connect();

            let services = [];
            try { services = await server.getPrimaryServices(); }
            catch (e) { this.log('✗ getPrimaryServices: ' + e.message); }

            this.chars = [];
            for (const s of services) {
                this.log('Servicio ' + s.uuid);
                let chars = [];
                try { chars = await s.getCharacteristics(); }
                catch (e) { this.log('  ✗ ' + e.message); continue; }
                for (const c of chars) {
                    const props = Object.keys(c.properties).filter(k => c.properties[k]).join(',');
                    this.log('  Char ' + c.uuid + ' [' + props + ']');
                    if (c.properties.write || c.properties.writeWithoutResponse) {
                        this.chars.push({ char: c, service: s.uuid });
                    }
                    if (c.properties.notify) {
                        try {
                            await c.startNotifications();
                            c.addEventListener('characteristicvaluechanged', ev =>
                                this.log('← ' + c.uuid.slice(4, 8) + ': ' + hex(new Uint8Array(ev.target.value.buffer))));
                        } catch (e) { /* no crítico */ }
                    }
                }
            }

            // Detección del driver por servicio + característica
            const candidates = this.driver ? [this.driver] : LED.drivers;
            let found = null;
            for (const d of candidates) {
                const m = this.chars.find(w => w.service === d.service && w.char.uuid === d.char);
                if (m) { found = { driver: d, match: m }; break; }
            }
            if (!found) {
                try { this.bt.gatt.disconnect(); } catch (e) {}
                const svc = [...new Set(this.chars.map(w => w.service.slice(0, 8)))].join(', ') || 'ninguno';
                throw new Error('Dispositivo no compatible (servicios escribibles: ' + svc + ')');
            }

            this.driver = found.driver;
            this.char = found.match.char;
            this.api = this.driver.create();
            this.connected = true;
            this.log('Protocolo: ' + this.driver.label);

            this.send(this.api.init());
            if (opts.restore) {
                // Reaplica lo último que tenía: color y brillo primero, encendido/apagado al final
                this.applyColor();
                if (this.api.brightness) this.send(this.api.brightness(this.state.brightness));
                this.send(this.api.power(this.state.on));
            } else {
                this.send(this.api.power(true));
                this.state.on = true;
                this.applyColor();
                if (this.api.brightness) this.send(this.api.brightness(this.state.brightness));
            }
            saveDevices();
        }

        async write(bytes) {
            const c = this.char;
            if (!c) { this.log('✗ No hay característica seleccionada'); return; }
            const p = c.properties;
            this.log('→ ' + hex(bytes));
            const attempts = [];
            if (p.write && c.writeValueWithResponse) attempts.push(() => c.writeValueWithResponse(bytes));
            if (p.writeWithoutResponse && c.writeValueWithoutResponse) attempts.push(() => c.writeValueWithoutResponse(bytes));
            if (!attempts.length) attempts.push(() => c.writeValue(bytes));
            for (const fn of attempts) {
                try { await fn(); return; } catch (e) { this.log('  ✗ ' + e.message); }
            }
        }

        send(packets) {
            if (!this.connected) return this.chain;
            const list = Array.isArray(packets) ? packets : [packets];
            for (const b of list) this.chain = this.chain.then(() => this.write(b)).catch(() => {});
            return this.chain;
        }

        // Throttle de verdad (no debounce): ejecuta como máximo una vez cada
        // `ms`, incluso si lo llaman en ráfaga continua sin pausa — el
        // efecto de pantalla con el degradado fino depende de esto, porque
        // lo llama sin parar cada 16ms y necesita que igual salgan comandos
        // a ritmo regular (un debounce, en cambio, nunca llegaría a disparar).
        throttle(key, fn, ms = 90) {
            const now = Date.now();
            const elapsed = now - (this.lastRun[key] || 0);
            clearTimeout(this.timers[key]);
            if (elapsed >= ms) {
                this.lastRun[key] = now;
                fn();
            } else {
                this.timers[key] = setTimeout(() => {
                    this.lastRun[key] = Date.now();
                    fn();
                }, ms - elapsed);
            }
        }

        // ---- Acciones individuales (las llaman tanto el detalle como los controles globales) ----
        setPower(on) {
            if (!this.connected) return;
            this.state.on = on; saveDevices();
            return this.send(this.api.power(on));
        }

        applyColor() { const s = this.state; this.send(this.api.color(s.r, s.g, s.b, s.brightness)); }
        setColor(r, g, b) {
            if (!this.connected) return;
            Object.assign(this.state, { r, g, b }); saveDevices();
            this.throttle('color', () => this.applyColor());
        }

        setBrightness(v) {
            if (!this.connected) return;
            this.state.brightness = v; saveDevices();
            this.throttle('bri', () => {
                if (this.api.brightness) this.send(this.api.brightness(v));
                else this.applyColor();
            });
        }

        whiteWarm() { if (this.connected) this.send(this.api.warm(this.state.brightness)); }
        whiteCold() { if (this.connected) this.send(this.api.cold(this.state.brightness)); }

        setEffect(n) {
            if (!this.connected) return;
            this.state.effect = n; saveDevices();
            if (this.api.effect) this.throttle('fx', () => this.send(this.api.effect(n)), 150);
        }
        setSpeed(v) {
            if (!this.connected) return;
            this.state.speed = v; saveDevices();
            if (this.api.speed) this.throttle('spd', () => this.send(this.api.speed(v)), 150);
        }

        remove() {
            this.removed = true;
            this.cancelWait();
            try { if (this.bt && this.bt.gatt.connected) this.bt.gatt.disconnect(); } catch (e) {}
            const i = devices.indexOf(this);
            if (i >= 0) devices.splice(i, 1);
            saveDevices();
        }
    }

    // ==================================================================
    // TARJETAS DE DISPOSITIVOS (parte inferior)
    // ==================================================================
    function renderDevices() {
        const box = $('devices');
        box.innerHTML = '';
        if (!devices.length) {
            box.innerHTML = '<div class="empty">Aún no hay dispositivos.<br>Pulsa <b>Conectar dispositivo</b> para agregar el primero.</div>';
            updateGlobal();
            return;
        }
        for (const d of devices) {
            const el = document.createElement('div');
            el.className = 'device-card';
            el.dataset.id = d.id;
            el.innerHTML = `
                <div class="dc-top"><span class="dot"></span><span class="badge">${esc(d.driver.badge)}</span></div>
                <div class="dc-name">${esc(d.name)}</div>
                <div class="dc-sub"></div>
                <div class="dc-bottom">
                    <span class="swatch"></span>
                    <label class="switch"><input type="checkbox"><span class="track"></span></label>
                    <button class="btn btn-outline btn-small reconnect">Reconectar</button>
                </div>`;
            el.addEventListener('click', () => openModal(d));
            el.querySelector('.switch').addEventListener('click', e => e.stopPropagation());
            el.querySelector('input').addEventListener('change', e => {
                d.setPower(e.target.checked);
                syncModal();
            });
            el.querySelector('.reconnect').addEventListener('click', e => { e.stopPropagation(); reconnect(d); });
            box.appendChild(el);
        }
        refreshCards();
        updateGlobal();
    }

    function refreshCards() {
        for (const el of document.querySelectorAll('.device-card')) {
            const d = devices.find(x => x.id === el.dataset.id);
            if (!d) continue;
            el.classList.toggle('offline', !d.connected);
            el.querySelector('.dot').classList.toggle('on', d.connected);
            el.querySelector('.dot').classList.toggle('wait', !d.connected && d.searching);
            el.querySelector('.dc-sub').textContent = statusText(d);
            el.querySelector('.reconnect').textContent = reconnectLabel(d);
            el.querySelector('.swatch').style.background = rgbToHex(d.state.r, d.state.g, d.state.b);
            const sw = el.querySelector('input');
            sw.checked = d.state.on;
            sw.disabled = !d.connected;
            el.querySelector('.switch').classList.toggle('hidden', !d.connected);
            el.querySelector('.reconnect').classList.toggle('hidden', d.connected);
        }
    }

    function statusText(d) {
        if (d.connected) return 'Dispositivo conectado';
        if (d.searching) return 'Buscando…';
        if (!d.bt) return 'Guardado · falta autorizar';
        return 'Desconectado';
    }
    function reconnectLabel(d) {
        if (!d.bt) return 'Autorizar';
        return d.searching ? 'Conectar ahora' : 'Reconectar';
    }

    function updateGlobal() {
        const n = live().length;
        $('gpCount').textContent = n + (n === 1 ? ' dispositivo conectado' : ' dispositivos conectados');
        $('gpControls').classList.toggle('disabled', n === 0);
        // Si se desconectan todos los dispositivos, no tiene caso seguir capturando la pantalla
        if (n === 0 && ambientOn) {
            LED.screenAmbient.stop();
            ambientAnimator.reset();
            setAmbientUI(false);
            toast('Efecto de pantalla detenido: no quedan dispositivos conectados');
        }
    }

    // ==================================================================
    // CONEXIÓN
    // ==================================================================
    // Mensaje cuando Web Bluetooth no está disponible o está desactivado (Brave lo desactiva de fábrica)
    async function disabledMessage() {
        let brave = false;
        try { brave = !!(navigator.brave && await navigator.brave.isBrave()); } catch (e) {}
        return brave
            ? 'Brave trae Web Bluetooth desactivado. Abre brave://flags, busca "Web Bluetooth", ponlo en Enabled y reinicia el navegador.'
            : 'Este navegador no soporta Web Bluetooth (o está desactivado). Usa Chrome o Edge, con HTTPS o localhost.';
    }

    // Errores de Bluetooth: ignora "cancelar el selector" pero avisa si está desactivado
    async function btErrorToast(e, prefix) {
        if (e && /disabled/i.test(e.message || '')) { toast(await disabledMessage(), 10000); return; }
        if (e && e.name === 'NotFoundError') return;   // el usuario canceló el selector
        toast(prefix + e.message, 6000);
    }

    async function connectNew() {
        if (!navigator.bluetooth) { toast(await disabledMessage(), 10000); return; }
        const btn = $('btnConnect');
        btn.disabled = true;
        try {
            const bt = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: LED.allServices()
            });

            // ¿Ya lo conocemos? (mismo id, o uno guardado sin autorizar con el mismo nombre)
            let dev = devices.find(d => d.id === bt.id)
                   || devices.find(d => !d.bt && d.savedName && d.savedName === bt.name);
            if (dev && dev.connected) { toast('Ese dispositivo ya está conectado'); return; }
            const isNew = !dev;
            if (isNew) dev = new LEDDevice(bt);
            else { dev.cancelWait(); dev.attach(bt); }

            btn.textContent = 'Conectando…';
            await dev.open({ restore: !isNew });
            if (isNew) devices.push(dev);
            renderDevices();
            saveDevices();
            toast('Conectado: ' + dev.name + ' (' + dev.driver.badge + ')');
        } catch (e) {
            await btErrorToast(e, 'Error al conectar: ');
        } finally {
            btn.disabled = false;
            btn.textContent = '🔗 Conectar dispositivo';
        }
    }

    // Dispositivo recordado pero sin permiso en esta sesión: hay que elegirlo una vez en el selector
    async function pairSaved(dev) {
        const base = { optionalServices: LED.allServices() };
        const bt = await navigator.bluetooth.requestDevice(
            dev.savedName ? { ...base, filters: [{ name: dev.savedName }] } : { ...base, acceptAllDevices: true });
        dev.attach(bt);
    }

    async function reconnect(dev) {
        try {
            dev.cancelWait();
            if (!dev.bt) {
                if (!navigator.bluetooth) { toast(await disabledMessage(), 10000); return; }
                await pairSaved(dev);
            }
            dev.searching = true; refreshCards(); syncModal();
            await dev.open({ restore: true });
            dev.failures = 0;
            toast('Reconectado: ' + dev.name);
        } catch (e) {
            await btErrorToast(e, 'No se pudo reconectar: ');
        } finally {
            dev.searching = false;
            refreshCards(); updateGlobal(); syncModal();
        }
    }

    // Reconexión automática: espera a que el dispositivo se anuncie y se conecta solo
    async function autoConnect(dev) {
        if (dev.busy || dev.connected || !dev.bt || dev.removed) return;
        dev.busy = true; dev.searching = true;
        refreshCards(); syncModal();
        let retry = false;
        try {
            const r = await dev.waitForAdvert();
            if (r === 'cancelled') return;
            await dev.open({ restore: true });
            dev.failures = 0;
            toast('Conectado: ' + dev.name);
        } catch (e) {
            dev.failures++;
            dev.log('✗ Auto-conexión: ' + e.message);
            retry = dev.failures < 3;
        } finally {
            dev.busy = false; dev.searching = false;
            refreshCards(); updateGlobal(); syncModal();
        }
        if (retry && !dev.connected && !dev.removed && devices.includes(dev)) setTimeout(() => autoConnect(dev), 2500);
    }

    // Al abrir la app: recupera la lista guardada e intenta reconectar los que ya tienen permiso
    async function restoreDevices() {
        const saved = loadSaved();
        if (!saved.length) return;
        saved.forEach(s => devices.push(new LEDDevice(null, s)));
        renderDevices();

        if (!(navigator.bluetooth && navigator.bluetooth.getDevices)) {
            toast(navigator.bluetooth
                ? 'Este navegador no permite reconectar solo. Pulsa "Autorizar" en cada tarjeta.'
                : await disabledMessage(), 8000);
            return;
        }
        let perm = [];
        try { perm = await navigator.bluetooth.getDevices(); } catch (e) { /* sin permisos guardados */ }
        let n = 0;
        for (const d of devices) {
            const bt = perm.find(p => p.id === d.id);
            if (bt) { d.attach(bt); autoConnect(d); n++; }
        }
        refreshCards();
        if (n) toast('Buscando ' + n + (n === 1 ? ' dispositivo guardado…' : ' dispositivos guardados…'));
        else toast('Dispositivos recordados: pulsa "Autorizar" para reconectarlos.', 6000);
    }

    // ==================================================================
    // CONTROLES GLOBALES (panel superior)
    // ==================================================================
    function globalDo(fn) {
        const l = live();
        if (!l.length) { toast('No hay dispositivos conectados'); return; }
        l.forEach(fn);
        refreshCards();
        syncModal();
    }

    LED.mountColorPicker($('gColor'), '#ff0000');

    $('btnConnect').addEventListener('click', connectNew);
    $('gOn').addEventListener('click', () => globalDo(d => d.setPower(true)));
    $('gOff').addEventListener('click', () => globalDo(d => d.setPower(false)));
    $('gColor').addEventListener('input', e => {
        $('gColorVal').textContent = e.target.value;
        const [r, g, b] = hexToRgb(e.target.value);
        globalDo(d => d.setColor(r, g, b));
    });
    $('gBri').addEventListener('input', e => {
        $('gBriVal').textContent = e.target.value;
        globalDo(d => d.setBrightness(+e.target.value));
    });
    $('gWarm').addEventListener('click', () => globalDo(d => d.whiteWarm()));
    $('gCold').addEventListener('click', () => globalDo(d => d.whiteCold()));

    // ==================================================================
    // EFECTO DE PANTALLA (screen-ambient.js hace la captura y el cálculo
    // de color; aquí solo se reparte ese color a los dispositivos conectados)
    // ==================================================================
    let ambientOn = false;

    // Cada color que llega de la captura es solo un nuevo "objetivo": en
    // vez de aplicarlo de una vez, se da un paso hacia él (el resto queda
    // para después), así se ve como un degradado en vez de un salto. Por
    // defecto no hay temporizador propio: el paso ocurre sobre el mismo
    // reloj de la captura (cada 200ms), para no sumar un segundo
    // temporizador que el navegador pueda frenar aparte en segundo plano.
    // Si se abre la ventana flotante "Mantener encima" (ver más abajo), un
    // segundo reloj —seguro mientras esa ventana esté abierta— da pasos
    // mucho más seguidos (cada 16ms) para que el degradado se vea más fino.
    const ambientAnimator = LED.makeColorAnimator({ alpha: 0.3 });
    let ambientTarget = null;    // último color pedido por la captura
    let pipTimer = null;         // reloj rápido de 16ms, solo mientras la ventana flotante está abierta

    function ambientStep() {
        if (!ambientTarget) return;
        const [r, g, b] = ambientAnimator.step(ambientTarget.r, ambientTarget.g, ambientTarget.b);
        const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
        $('gColor').value = hex;          // refleja el color en curso, sin disparar 'input'
        $('gColorVal').textContent = hex;
        for (const d of live()) d.setColor(r, g, b);
        refreshCards();
    }

    function ambientTick(color) {
        ambientTarget = color;
        ambientStep();   // siempre da el paso "de base" al llegar cada captura
    }

    function startFastStepping() { if (!pipTimer) pipTimer = setInterval(ambientStep, 16); }
    function stopFastStepping() { clearInterval(pipTimer); pipTimer = null; }

    function setAmbientUI(on) {
        ambientOn = on;
        $('btnAmbient').textContent = on ? '⏹ Detener' : '🖥️ Activar';
        $('btnAmbient').classList.toggle('btn-primary', on);
        $('btnAmbient').classList.toggle('btn-outline', !on);
        $('gColor').classList.toggle('rgbp-disabled', on);
        $('ambientMode').disabled = on;
        if (on) {
            if (pipOpen()) startFastStepping();
        } else {
            ambientTarget = null;
            ambientAnimator.reset();   // para que la próxima vez empiece sin arrastrar el color anterior
            stopFastStepping();
        }
    }

    // Opciones vigentes para la captura: modo (promedio/dominante) y si se
    // estira el color al máximo contraste posible ("Maximizar").
    function ambientOpts() {
        return {
            mode: $('ambientMode').value,
            maximize: $('btnMaximize').classList.contains('active'),
            interval: 200,
            onEnded: () => setAmbientUI(false)   // el usuario detuvo la captura desde el navegador
        };
    }

    async function toggleAmbient() {
        if (ambientOn) { LED.screenAmbient.stop(); setAmbientUI(false); return; }
        if (!live().length) { toast('No hay dispositivos conectados'); return; }
        if (!LED.screenAmbient.supported()) {
            toast('Tu navegador no soporta capturar la pantalla (getDisplayMedia). Usa Chrome o Edge, con HTTPS o localhost.', 7000);
            return;
        }
        const btn = $('btnAmbient');
        btn.disabled = true;
        try {
            await LED.screenAmbient.start(ambientTick, ambientOpts());
            setAmbientUI(true);
        } catch (e) {
            if (e.name !== 'NotAllowedError') toast('No se pudo iniciar la captura: ' + e.message, 6000);
        } finally {
            btn.disabled = false;
        }
    }

    // Si la captura ya está corriendo, reinicia con las opciones actuales
    // (se usa al cambiar de modo o al activar/desactivar "Maximizar").
    function restartAmbientIfRunning() {
        if (!ambientOn) return;
        LED.screenAmbient.stop();
        LED.screenAmbient.start(ambientTick, ambientOpts());
    }

    $('btnAmbient').addEventListener('click', toggleAmbient);
    $('ambientMode').addEventListener('change', restartAmbientIfRunning);
    $('btnMaximize').addEventListener('click', () => {
        $('btnMaximize').classList.toggle('active');
        restartAmbientIfRunning();
    });

    // ------------------------------------------------------------------
    // "Mantener encima": abre una ventanita flotante (Document
    // Picture-in-Picture) que el navegador mantiene siempre visible. Esto
    // evita el frenado de temporizadores que aplica a una pestaña en
    // segundo plano, así que mientras esté abierta es seguro correr el
    // degradado en su propio reloj rápido (16ms) sin arriesgarse a que se
    // quede pegado. Requiere Chrome/Edge recientes y un origen seguro
    // (HTTPS o localhost) — no funciona abriendo el archivo con file://.
    const pipOpen = () => !!(window.documentPictureInPicture && window.documentPictureInPicture.window);

    function setPipUI(on) {
        $('btnPip').classList.toggle('active', on);
        $('btnPip').textContent = on ? '📌 Encima (activo)' : '📌 Mantener encima';
    }

    async function togglePip() {
        if (!('documentPictureInPicture' in window)) {
            toast('Tu navegador no soporta ventanas "siempre encima" (Document Picture-in-Picture). Hace falta Chrome o Edge recientes, en HTTPS o localhost — no funciona abriendo el archivo directo.', 8000);
            return;
        }
        if (pipOpen()) { window.documentPictureInPicture.window.close(); return; }   // el cierre dispara 'pagehide' y limpia solo

        try {
            // Lo más chico que deja el navegador y sin nada dibujado adentro:
            // solo necesitamos que la ventana exista y esté visible, no que
            // muestre contenido. El propio navegador le pone un marco mínimo
            // (eso no se puede quitar: es justo lo que la mantiene exenta del
            // frenado de pestañas en segundo plano), pero así molesta lo
            // menos posible.
            const pipWin = await window.documentPictureInPicture.requestWindow({ width: 1, height: 1, disallowReturnToOpener: true });
            pipWin.document.title = 'Efecto activo';
            pipWin.document.body.style.cssText = 'margin:0;background:transparent;';

            pipWin.addEventListener('pagehide', () => {
                stopFastStepping();
                setPipUI(false);
            });

            setPipUI(true);
            if (ambientOn) startFastStepping();
        } catch (e) {
            if (e.name !== 'NotAllowedError') toast('No se pudo abrir la ventana flotante: ' + e.message, 6000);
        }
    }

    $('btnPip').addEventListener('click', togglePip);

    // ==================================================================
    // DETALLE INDIVIDUAL (modal) — se construye según lo que soporta el driver
    // ==================================================================
    function openModal(dev) {
        modalDev = dev;
        buildModal(dev);
        $('modal').classList.add('open');
    }
    function closeModal() {
        modalDev = null;
        $('modal').classList.remove('open');
    }
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    function buildModal(dev) {
        const caps = dev.driver.caps;
        const whites = caps.whites === 'separate'
            ? `<div class="btn-row">
                   <button class="btn btn-warm btn-small" id="mWarm">Blanco cálido</button>
                   <button class="btn btn-cold btn-small" id="mCold">Blanco frío</button>
               </div>`
            : `<div class="control-group"><button class="btn btn-white btn-small" id="mWhite">Blanco</button></div>`;

        const effects = caps.effects
            ? `<div class="control-group">
                   <label class="lbl">Efecto <span id="mEffVal">0</span></label>
                   <input type="range" id="mEff" min="0" max="${caps.effects.max}" value="0">
               </div>
               <div class="control-group">
                   <label class="lbl">Velocidad <span><span id="mSpdVal">50</span>%</span></label>
                   <input type="range" id="mSpd" min="0" max="100" value="50">
                   <p class="hint">Mueve el slider de efecto para activarlo. Para volver a un color fijo, elige un color o "Blanco".</p>
               </div>`
            : '';

        $('modalBody').innerHTML = `
            <div class="m-head">
                <div>
                    <h2>${esc(dev.name)}</h2>
                    <div class="m-meta"><span class="badge">${esc(dev.driver.badge)}</span><span id="mStatus" class="status"></span></div>
                </div>
                <button class="icon-btn" id="mClose">✕</button>
            </div>

            <div class="m-controls">
                <div class="btn-row">
                    <button class="btn btn-primary" id="mOn">Encender</button>
                    <button class="btn btn-outline" id="mOff">Apagar</button>
                </div>
                <div class="control-group">
                    <label class="lbl">Color <span id="mColorVal"></span></label>
                    <div id="mColor"></div>
                </div>
                <div class="control-group">
                    <label class="lbl">Brillo <span><span id="mBriVal"></span>%</span></label>
                    <input type="range" id="mBri" min="1" max="100">
                </div>
                ${whites}
                ${effects}
            </div>

            <details>
                <summary>Diagnóstico y comandos manuales</summary>
                <span class="field-label">Característica de escritura</span>
                <select id="mChar">${dev.chars.map((w, i) => `<option value="${i}">${w.service.slice(0, 8)} / ${w.char.uuid.slice(0, 8)}</option>`).join('')}</select>
                <div class="row">
                    <input type="text" id="mHex" placeholder="HEX manual, ej: 55 01 02 01">
                    <button class="btn btn-outline btn-small" id="mSend">Enviar</button>
                </div>
                <div class="log" id="mLog"></div>
                <div class="row">
                    <button class="btn btn-outline btn-small" id="mCopy" style="flex:1">Copiar log</button>
                    <button class="btn btn-outline btn-small" id="mClear" style="flex:1">Limpiar</button>
                </div>
            </details>

            <div class="btn-row" style="margin-bottom:0">
                <button class="btn btn-outline" id="mReconnect">Reconectar</button>
                <button class="btn btn-danger" id="mRemove">Desconectar y quitar</button>
            </div>`;

        const m = id => $(id);
        LED.mountColorPicker(m('mColor'));
        m('mLog').textContent = dev.logLines.join('\n');

        m('mClose').onclick = closeModal;
        m('mOn').onclick  = () => { dev.setPower(true);  refreshCards(); syncModal(); };
        m('mOff').onclick = () => { dev.setPower(false); refreshCards(); syncModal(); };

        m('mColor').oninput = e => {
            const [r, g, b] = hexToRgb(e.target.value);
            m('mColorVal').textContent = e.target.value;
            dev.setColor(r, g, b);
            refreshCards();
        };
        m('mBri').oninput = e => { m('mBriVal').textContent = e.target.value; dev.setBrightness(+e.target.value); };

        if (m('mWarm'))  m('mWarm').onclick  = () => dev.whiteWarm();
        if (m('mCold'))  m('mCold').onclick  = () => dev.whiteCold();
        if (m('mWhite')) m('mWhite').onclick = () => dev.whiteWarm();
        if (m('mEff')) m('mEff').oninput = e => { m('mEffVal').textContent = e.target.value; dev.setEffect(+e.target.value); };
        if (m('mSpd')) m('mSpd').oninput = e => { m('mSpdVal').textContent = e.target.value; dev.setSpeed(+e.target.value); };

        m('mChar').onchange = e => {
            dev.char = dev.chars[+e.target.value].char;
            dev.log('Característica → ' + dev.char.uuid);
        };
        m('mSend').onclick = () => {
            const txt = m('mHex').value.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, ' ').trim();
            if (!txt || !dev.connected) return;
            dev.send(dev.api.manual(u8(txt.split(/\s+/).map(h => parseInt(h, 16)))));
        };
        m('mCopy').onclick  = () => navigator.clipboard && navigator.clipboard.writeText(m('mLog').textContent);
        m('mClear').onclick = () => { dev.logLines = []; m('mLog').textContent = ''; };

        m('mReconnect').onclick = () => reconnect(dev);
        m('mRemove').onclick = () => { dev.remove(); closeModal(); renderDevices(); toast('Dispositivo quitado'); };

        syncModal();
    }

    function appendModalLog(msg) {
        const el = $('mLog');
        if (!el) return;
        el.textContent += (el.textContent ? '\n' : '') + msg;
        el.scrollTop = el.scrollHeight;
    }

    // Refleja el estado actual del dispositivo en los controles del detalle
    function syncModal() {
        const d = modalDev;
        if (!d || !$('mColor')) return;
        const s = d.state;
        $('mColor').value = rgbToHex(s.r, s.g, s.b);
        $('mColorVal').textContent = rgbToHex(s.r, s.g, s.b);
        $('mBri').value = s.brightness;
        $('mBriVal').textContent = s.brightness;
        if ($('mEff')) { $('mEff').value = s.effect; $('mEffVal').textContent = s.effect; }
        if ($('mSpd')) { $('mSpd').value = s.speed;  $('mSpdVal').textContent = s.speed; }
        $('mStatus').textContent = d.connected ? '● Conectado' : (d.searching ? '● Buscando…' : '● Desconectado');
        $('mStatus').className = 'status ' + (d.connected ? 'ok' : 'off');
        $('mReconnect').classList.toggle('hidden', d.connected);
        $('mReconnect').textContent = reconnectLabel(d);
        $('modalBody').classList.toggle('offline', !d.connected);
    }

    // ------------------------------------------------------------------
    renderDevices();
    restoreDevices();
})();