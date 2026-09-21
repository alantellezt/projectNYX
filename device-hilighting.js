/* =====================================================================
   Archivo de compatibilidad con los dispositivos
   Hilithing
   ===================================================================== */
(function () {
    'use strict';
    const { u8, clamp } = LED;

    LED.register({
        id: 'hilighting',
        label: 'HiLighting',
        badge: 'HiLighting',
        service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
        char:    '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
        caps: { nativeBrightness: true, whites: 'rgb', effects: { max: 9 } },

        create() {
            const color = (r, g, b) => u8([0x55, 0x07, 0x01, r, g, b]);
            const cwarm = () => color(255, 40, 20);
            const ccold = () => color(255, 255, 255);

            return {
                init:  () => [],
                power: on => u8([0x55, 0x01, 0x02, on ? 0x01 : 0x00]),
                color,
                // Solo hay 15 niveles reales; el mínimo observado por la comunidad es 2
                brightness: pct => u8([0x55, 0x03, 0x01, 0xFF, clamp(Math.round(2 + pct / 100 * 13), 2, 15)]),
                warm: cwarm,
                cold: ccold,
                effect: n => u8([0x55, 0x04, 0x01, n]),
                speed:  pct => u8([0x55, 0x04, 0x04, clamp(Math.round(pct * 2.55), 0, 255)]),
                manual: bytes => bytes,   // sin transporte: se envía tal cual
            };
        }
    });
})();
