/* =====================================================================
   Archivo de compatibilidad con los dispositivos
   Lotus Lantern
   ===================================================================== */
(function () {
    'use strict';
    const { u8, clamp, short } = LED;

    LED.register({
        id: 'elk',
        label: 'Lotus Lantern / ELK-BLEDOM',
        badge: 'Lotus Lantern',
        service: short('fff0'),
        char: short('fff3'),
        caps: { nativeBrightness: true, whites: 'rgb', effects: { max: 28 } },

        create() {
            const color = (r, g, b) => u8([0x7E, 0x07, 0x05, 0x03, r, g, b, 0x10, 0xEF]);

            return {
                init:  () => [],
                power: on => { const v = on ? 1 : 0; return u8([0x7E, 0x04, 0x04, v, 0x00, v, 0xFF, 0x00, 0xEF]); },
                color,
                brightness: pct => u8([0x7E, 0x04, 0x01, clamp(pct, 0, 100), 0xFF, 0xFF, 0xFF, 0x00, 0xEF]),
                warm: () => color(255, 70, 25),
                cold: () => color(255, 255, 255),
                effect: n => u8([0x7E, 0x05, 0x03, (n + 128) & 0xFF, 0x03, 0xFF, 0xFF, 0x00, 0xEF]),
                speed:  pct => u8([0x7E, 0x04, 0x02, clamp(pct, 0, 100), 0xFF, 0xFF, 0xFF, 0x00, 0xEF]),
                manual: bytes => bytes,
            };
        }
    });
})();
