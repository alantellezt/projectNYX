/* =====================================================================
   utils.js — utilidades compartidas y registro de drivers
   Cada archivo device-*.js llama a LED.register(driver).
   app.js usa LED.drivers para detectar qué protocolo habla cada foco/tira.
   ===================================================================== */
(function () {
    'use strict';
    const LED = window.LED = {};

    LED.$ = id => document.getElementById(id);
    LED.u8 = arr => new Uint8Array(arr);
    LED.hex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');
    LED.withSum = arr => LED.u8([...arr, arr.reduce((s, x) => s + x, 0) & 0xFF]);
    LED.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    LED.short = u => '0000' + u + '-0000-1000-8000-00805f9b34fb';

    // Estira el contraste de un color al máximo posible conservando el matiz:
    // el canal más bajo queda en 0 y el más alto en 255 (o lo más cerca posible).
    // Un gris puro (r===g===b) no tiene matiz que conservar, así que se deja igual.
    LED.stretchColor = (r, g, b) => {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx === mn) return [r, g, b];
        const k = 255 / (mx - mn);
        return [Math.round((r - mn) * k), Math.round((g - mn) * k), Math.round((b - mn) * k)];
    };

    // Suaviza una serie de colores que van llegando (por ejemplo, del efecto
    // de pantalla) para que el cambio se vea como un degradado en vez de un
    // salto brusco. A propósito NO tiene su propio temporizador: cada vez
    // que llega un color nuevo, da un solo paso hacia él (un porcentaje de
    // la distancia que falta) y ya. Así todo el degradado corre sobre el
    // mismo reloj que entrega los colores (p. ej. la captura de pantalla),
    // en vez de sumar un segundo temporizador independiente — los
    // navegadores frenan mucho los temporizadores de una pestaña en segundo
    // plano, y tener dos relojes sueltos (en vez de uno) aumenta el riesgo
    // de que alguno se quede pegado ahí. Si llega un color nuevo antes de
    // terminar de acercarse al anterior, simplemente cambia de rumbo desde
    // donde va — nunca hay un salto ni se "hace fila".
    //   opts.alpha: qué fracción de la distancia restante se recorre en
    //     cada llamada (0-1; por defecto 0.5).
    LED.makeColorAnimator = (opts = {}) => {
        const alpha = opts.alpha != null ? opts.alpha : 0.5;
        let cur = null;

        return {
            // Da un paso hacia (r,g,b) y devuelve el color intermedio
            // resultante como [r,g,b] (ya redondeado). Llamar de nuevo con
            // un color distinto antes de llegar simplemente redirige.
            step(r, g, b) {
                if (!cur) { cur = { r, g, b }; return [r, g, b]; }   // primer color: sin degradado
                cur.r += (r - cur.r) * alpha;
                cur.g += (g - cur.g) * alpha;
                cur.b += (b - cur.b) * alpha;
                if (Math.abs(cur.r - r) < 0.5 && Math.abs(cur.g - g) < 0.5 && Math.abs(cur.b - b) < 0.5) {
                    cur = { r, g, b };
                }
                return [Math.round(cur.r), Math.round(cur.g), Math.round(cur.b)];
            },
            // Olvida el color actual, para que la próxima vez empiece de
            // cero (sin arrastrar un color viejo).
            reset() { cur = null; },
        };
    };

    /*  Un driver es:
        {
          id, label, badge,
          service, char,               // servicio GATT y característica de escritura
          caps: {
            nativeBrightness: bool,    // true = el protocolo tiene comando de brillo propio
            whites: 'separate'|'rgb',  // blanco cálido/frío separados, o blanco mezclando RGB
            effects: null | { max }    // efectos numerados 0..max
          },
          create() -> instancia con: init(), power(on), color(r,g,b,brillo%),
                      warm(brillo%), cold(brillo%), manual(bytes)
                      y opcionalmente: brightness(%), effect(n), speed(%)
        } */
    LED.drivers = [];
    LED.register = d => { LED.drivers.push(d); };

    // Servicios que hay que declarar al pedir el dispositivo (Chrome bloquea el resto)
    LED.allServices = () => [...new Set([
        ...LED.drivers.map(d => d.service),
        LED.short('fe00'), LED.short('1800'), LED.short('180a')
    ])];
})();