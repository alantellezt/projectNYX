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
