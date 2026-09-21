/* =====================================================================
   Archivo de compatibilidad con los dispositivos
   MagicHome - Surplife
   ===================================================================== */
(function () {
    'use strict';
    const { u8, withSum, short } = LED;

    LED.register({
        id: 'lednetwf',
        label: 'LEDnetWF / Zengge',
        badge: 'LEDnetWF',
        service: short('ffff'),
        char: short('ff01'),
        caps: { nativeBrightness: false, whites: 'separate', effects: null },

        create() {
            let seq = 0;   // contador de secuencia propio de cada dispositivo

            // Transporte: [0x00, seq, 0x80, 0x00, lenHi, lenLo, len+1, cmdId, ...comando]
            const wrap = (cmd, expectResponse = false) => {
                const n = cmd.length;
                return u8([0x00, (seq++) & 0xFF, 0x80, 0x00, (n >> 8) & 0xFF, n & 0xFF,
                           (n + 1) & 0xFF, expectResponse ? 0x0A : 0x0B, ...cmd]);
            };
            const level = bri => Math.max(1, Math.round(255 * bri / 100));

            return {
                init:  () => [wrap(u8([0x81, 0x8A, 0x8B, 0x40]), true)],   // consulta de estado
                power: on => wrap(withSum([0x71, on ? 0x23 : 0x24, 0x0F])),
                color: (r, g, b, bri) => {
                    const k = bri / 100;
                    return wrap(withSum([0x31, Math.round(r * k), Math.round(g * k), Math.round(b * k), 0x00, 0x00, 0xF0, 0x0F]));
                },
                warm:  bri => wrap(withSum([0x31, 0, 0, 0, level(bri), 0x00, 0x0F, 0x0F])),  // canal WW
                cold:  bri => wrap(withSum([0x31, 0, 0, 0, 0x00, level(bri), 0x0F, 0x0F])),  // canal CW
                manual: bytes => wrap(bytes),
            };
        }
    });
})();
