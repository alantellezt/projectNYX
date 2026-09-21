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
        constructor(bt) {
            this.bt = bt;
            this.id = bt.id;
            this.driver = null;      // se detecta al conectar
            this.api = null;         // instancia del driver (create())
            this.chars = [];         // características escribibles
            this.char = null;
            this.connected = false;
            this.state = { on: false, r: 255, g: 0, b: 0, brightness: 100, effect: 0, speed: 50 };
            this.chain = Promise.resolve();
            this.timers = {};
            this.logLines = [];

            bt.addEventListener('gattserverdisconnected', () => {
                this.connected = false;
                this.char = null;
                this.log('Desconectado');
                if (devices.includes(this)) { refreshCards(); updateGlobal(); }
                if (modalDev === this) syncModal();
            });
        }

        get name() { return this.bt.name || 'Sin nombre'; }

        log(msg) {
            this.logLines.push(msg);
            if (this.logLines.length > 300) this.logLines.shift();
            if (modalDev === this) appendModalLog(msg);
        }

        async open() {
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

            // Arranque: consulta de estado, encender y aplicar color/brillo actuales
            this.send(this.api.init());
            this.send(this.api.power(true));
            this.state.on = true;
            this.applyColor();
            if (this.api.brightness) this.send(this.api.brightness(this.state.brightness));
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

        throttle(key, fn, ms = 90) {
            clearTimeout(this.timers[key]);
            this.timers[key] = setTimeout(fn, ms);
        }

        // ---- Acciones individuales (las llaman tanto el detalle como los controles globales) ----
        setPower(on) { this.state.on = on; return this.send(this.api.power(on)); }

        applyColor() { const s = this.state; this.send(this.api.color(s.r, s.g, s.b, s.brightness)); }
        setColor(r, g, b) {
            Object.assign(this.state, { r, g, b });
            this.throttle('color', () => this.applyColor());
        }

        setBrightness(v) {
            this.state.brightness = v;
            this.throttle('bri', () => {
                if (this.api.brightness) this.send(this.api.brightness(v));
                else this.applyColor();
            });
        }

        whiteWarm() { this.send(this.api.warm(this.state.brightness)); }
        whiteCold() { this.send(this.api.cold(this.state.brightness)); }

        setEffect(n) {
            this.state.effect = n;
            if (this.api.effect) this.throttle('fx', () => this.send(this.api.effect(n)), 150);
        }
        setSpeed(v) {
            this.state.speed = v;
            if (this.api.speed) this.throttle('spd', () => this.send(this.api.speed(v)), 150);
        }

        remove() {
            try { if (this.bt.gatt.connected) this.bt.gatt.disconnect(); } catch (e) {}
            const i = devices.indexOf(this);
            if (i >= 0) devices.splice(i, 1);
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
            el.querySelector('.dc-sub').textContent = d.connected ? 'Dispositivo conectado' : 'Desconectado';
            el.querySelector('.swatch').style.background = rgbToHex(d.state.r, d.state.g, d.state.b);
            const sw = el.querySelector('input');
            sw.checked = d.state.on;
            sw.disabled = !d.connected;
            el.querySelector('.switch').classList.toggle('hidden', !d.connected);
            el.querySelector('.reconnect').classList.toggle('hidden', d.connected);
        }
    }

    function updateGlobal() {
        const n = live().length;
        $('gpCount').textContent = n + (n === 1 ? ' dispositivo conectado' : ' dispositivos conectados');
        $('gpControls').classList.toggle('disabled', n === 0);
    }

    // ==================================================================
    // CONEXIÓN
    // ==================================================================
    async function connectNew() {
        if (!navigator.bluetooth) {
            toast('Este navegador no soporta Web Bluetooth. Usa Chrome/Edge (Android o escritorio) con HTTPS o localhost.', 6000);
            return;
        }
        const btn = $('btnConnect');
        btn.disabled = true;
        try {
            const bt = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: LED.allServices()
            });

            let dev = devices.find(d => d.id === bt.id);
            if (dev && dev.connected) { toast('Ese dispositivo ya está conectado'); return; }
            const isNew = !dev;
            if (isNew) dev = new LEDDevice(bt);

            btn.textContent = 'Conectando…';
            await dev.open();
            if (isNew) devices.push(dev);
            renderDevices();
            toast('Conectado: ' + dev.name + ' (' + dev.driver.badge + ')');
        } catch (e) {
            if (e.name !== 'NotFoundError') toast('Error al conectar: ' + e.message, 6000);
        } finally {
            btn.disabled = false;
            btn.textContent = '🔗 Conectar dispositivo';
        }
    }

    async function reconnect(dev) {
        try {
            await dev.open();
            toast('Reconectado: ' + dev.name);
        } catch (e) {
            toast('No se pudo reconectar: ' + e.message, 6000);
        }
        refreshCards(); updateGlobal(); syncModal();
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
                    <input type="color" id="mColor">
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
        $('mStatus').textContent = d.connected ? '● Conectado' : '● Desconectado';
        $('mStatus').className = 'status ' + (d.connected ? 'ok' : 'off');
        $('mReconnect').classList.toggle('hidden', d.connected);
        $('modalBody').classList.toggle('offline', !d.connected);
    }

    // ------------------------------------------------------------------
    renderDevices();
})();
