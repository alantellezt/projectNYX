/* =====================================================================
   screen-ambient.js — efecto de pantalla ("ambilight"): captura la
   pantalla del usuario, calcula un color de muestra y lo entrega
   periódicamente mediante un callback. No sabe nada de dispositivos
   Bluetooth; app.js es quien conecta ese color con los LEDs.
   ===================================================================== */
(function () {
    'use strict';

    let stream = null, video = null, canvas = null, ctx = null, timer = null;

    function cleanup() {
        clearTimeout(timer); timer = null;
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        if (video) { video.srcObject = null; video = null; }
        canvas = null; ctx = null;
    }

    function averageColor(data) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
        return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
    }

    // Pondera hacia los píxeles más saturados para que el efecto no se
    // vea siempre grisáceo (el promedio simple tiende a lavarse).
    function dominantColor(data) {
        let wr = 0, wg = 0, wb = 0, wsum = 0;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const sat = max === 0 ? 0 : (max - min) / max;
            const w = 0.15 + sat * sat;   // los píxeles vívidos pesan más
            wr += r * w; wg += g * w; wb += b * w; wsum += w;
        }
        if (!wsum) return { r: 0, g: 0, b: 0 };
        return { r: Math.round(wr / wsum), g: Math.round(wg / wsum), b: Math.round(wb / wsum) };
    }

    const W = 16, H = 9;   // rejilla pequeña: barata de leer y de sobra para un color promedio

    LED.screenAmbient = {
        supported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
        running: () => !!stream,

        // onColor({r,g,b}) se llama con cada muestra.
        // opts.onEnded() se llama solo si el usuario detiene la captura
        // desde el propio panel del navegador (no al llamar stop() aquí).
        async start(onColor, opts = {}) {
            if (stream) return;
            const mode = opts.mode || 'average';
            const interval = opts.interval || 200;
            // Intensidad de "Maximizar" (0-1). Puede ser un número fijo o una
            // función que se consulta en cada captura (así la barra se puede
            // mover en vivo sin reiniciar la captura). Por defecto, 1.
            const getMaximize = typeof opts.maximize === 'function' ? opts.maximize
                : () => (opts.maximize === false ? 0 : typeof opts.maximize === 'number' ? opts.maximize : 1);

            stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 8 }, audio: false });
            video = document.createElement('video');
            video.muted = true;
            video.srcObject = stream;
            await video.play();

            canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            ctx = canvas.getContext('2d', { willReadFrequently: true });

            stream.getVideoTracks()[0].addEventListener('ended', () => {
                cleanup();
                opts.onEnded && opts.onEnded();
            });

            const tick = () => {
                if (!stream) return;
                try {
                    ctx.drawImage(video, 0, 0, W, H);
                    const { data } = ctx.getImageData(0, 0, W, H);
                    const c = mode === 'dominant' ? dominantColor(data) : averageColor(data);
                    // "Maximizar" estira el color al máximo contraste posible (ver
                    // LED.stretchColor en utils.js): el canal más alto queda cerca de
                    // 255 y el más bajo cerca de 0, para que el efecto no se vea
                    // apagado o grisáceo. La barra regula cuánto: 0 = sin estirar,
                    // 1 = estirado por completo.
                    const [r, g, b] = LED.stretchColor(c.r, c.g, c.b, getMaximize());
                    onColor({ r, g, b });
                } catch (e) { /* el primer cuadro puede no estar listo aún; se corrige solo */ }
                timer = setTimeout(tick, interval);
            };
            tick();
        },

        stop: cleanup,
    };
})();
