/* =====================================================================
   color-picker.js — selector de color RGB propio (sin <input type="color">),
   para que se vea igual en todos los navegadores: una tarjeta cuyo fondo
   es el color resultante, con tres barras verticales (roja, verde, azul)
   que se arrastran para ajustar cada canal.
   ===================================================================== */
(function () {
    'use strict';
    const { clamp } = LED;

    const CHANNELS = [
        { key: 'r', color: '#ef4444' },
        { key: 'g', color: '#22c55e' },
        { key: 'b', color: '#3b82f6' },
    ];

    // Convierte `el` (un <div> vacío) en un selector de color RGB.
    // Igual que un <input type="color">: expone `.value` como hex
    // "#rrggbb" y dispara un evento 'input' en el propio elemento cada
    // vez que el usuario mueve una barra (asignar .value NO dispara el
    // evento, para poder usarlo también para reflejar estado sin bucles).
    LED.mountColorPicker = function (el, initialHex) {
        el.classList.add('rgbp');
        el.innerHTML = CHANNELS.map(c => `
            <div class="rgbp-bar" data-ch="${c.key}" style="--ch-color:${c.color}">
                <div class="rgbp-track">
                    <div class="rgbp-fill"></div>
                    <div class="rgbp-thumb"></div>
                </div>
                <span class="rgbp-label">${c.key.toUpperCase()}</span>
            </div>`).join('');

        const state = { r: 255, g: 0, b: 0 };
        const bars = {};
        for (const c of CHANNELS) {
            const bar = el.querySelector(`[data-ch="${c.key}"]`);
            bars[c.key] = { track: bar.querySelector('.rgbp-track'), fill: bar.querySelector('.rgbp-fill'), thumb: bar.querySelector('.rgbp-thumb') };
        }

        function paint() {
            el.style.background = `rgb(${state.r}, ${state.g}, ${state.b})`;
            for (const c of CHANNELS) {
                const pct = state[c.key] / 255 * 100;
                bars[c.key].fill.style.height = pct + '%';
                bars[c.key].thumb.style.bottom = pct + '%';
            }
        }

        function setFromClientY(ch, clientY, track) {
            const rect = track.getBoundingClientRect();
            const pct = rect.height ? clamp((rect.bottom - clientY) / rect.height, 0, 1) : state[ch] / 255;
            state[ch] = Math.round(pct * 255);
            paint();
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }

        for (const c of CHANNELS) {
            const { track } = bars[c.key];
            let dragging = false;
            const onMove = e => { if (dragging) setFromClientY(c.key, e.clientY, track); };
            const onUp = () => {
                dragging = false;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            track.addEventListener('pointerdown', e => {
                dragging = true;
                if (track.setPointerCapture) { try { track.setPointerCapture(e.pointerId); } catch (err) {} }
                setFromClientY(c.key, e.clientY, track);
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
                e.preventDefault();
            });
        }

        Object.defineProperty(el, 'value', {
            get() {
                return '#' + [state.r, state.g, state.b].map(v => v.toString(16).padStart(2, '0')).join('');
            },
            set(hex) {
                state.r = parseInt(hex.slice(1, 3), 16) || 0;
                state.g = parseInt(hex.slice(3, 5), 16) || 0;
                state.b = parseInt(hex.slice(5, 7), 16) || 0;
                paint();
            }
        });

        el.value = initialHex || '#ff0000';
        return el;
    };
})();
