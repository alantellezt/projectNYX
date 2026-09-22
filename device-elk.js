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
    // Vértices calibrados (normalizados 0-1) del cubo RGB virtual -> real
    // Orden: índice = r*4 + g*2 + b  (r,g,b ∈ {0,1})
    const CAL = [
        [0.000, 0.000, 0.000], // 000
        [0.000, 0.000, 1.000], // 001
        [0.000, 1.000, 0.000], // 010
        [0.667, 1.000, 0.784], // 011
        [1.000, 0.000, 0.000], // 100
        [1.000, 0.000, 0.294], // 101
        [1.000, 0.333, 0.000], // 110
        [1.000, 0.373, 0.333], // 111
    ];

    // Interpolación trilineal sobre el cubo calibrado
    function calibrate(r, g, b) {
        const fr = r / 255, fg = g / 255, fb = b / 255;
        const out = [0, 0, 0];
        for (let i = 0; i < 8; i++) {
            const cr = (i >> 2) & 1, cg = (i >> 1) & 1, cb = i & 1;
            const w = (cr ? fr : 1 - fr) * (cg ? fg : 1 - fg) * (cb ? fb : 1 - fb);
            out[0] += w * CAL[i][0];
            out[1] += w * CAL[i][1];
            out[2] += w * CAL[i][2];
        }
        return out.map(v => Math.round(clamp(v * 255, 0, 255)));
    }

    const color = (r, g, b) => {
        const [cr, cg, cb] = calibrate(r, g, b);
        return u8([0x7E, 0x07, 0x05, 0x03, cr, cg, cb, 0x10, 0xEF]);
    };

    return {
        init:  () => [],
        power: on => { const v = on ? 1 : 0; return u8([0x7E, 0x04, 0x04, v, 0x00, v, 0xFF, 0x00, 0xEF]); },
        color,
        brightness: pct => u8([0x7E, 0x04, 0x01, clamp(pct, 0, 100), 0xFF, 0xFF, 0xFF, 0x00, 0xEF]),
        warm: () => color(255, 140, 50),
        cold: () => color(255, 255, 255),
        effect: n => u8([0x7E, 0x05, 0x03, (n + 128) & 0xFF, 0x03, 0xFF, 0xFF, 0x00, 0xEF]),
        speed:  pct => u8([0x7E, 0x04, 0x02, clamp(pct, 0, 100), 0xFF, 0xFF, 0xFF, 0x00, 0xEF]),
        manual: bytes => bytes,
    };
}
    });
})();
