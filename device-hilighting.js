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
            // Vértices calibrados (normalizados 0-1): índice = r*4 + g*2 + b
            const CAL = [
                [0.000, 0.000, 0.000], // 000
                [0.000, 0.000, 1.000], // 001
                [0.000, 1.000, 0.000], // 010
                [0.392, 1.000, 0.902], // 011  (0,255,255) -> (100,255,230)
                [1.000, 0.000, 0.000], // 100
                [1.000, 0.000, 0.196], // 101  (255,0,255) -> (255,0,50)
                [1.000, 0.235, 0.000], // 110  (255,255,0) -> (255,60,0)
                [1.000, 0.275, 0.255], // 111  (255,255,255) -> (255,70,65)
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
                return u8([0x55, 0x07, 0x01, cr, cg, cb]);
            };
            const cwarm = () => color(255, 120, 60);
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
                manual: bytes => bytes,
            };
        }
    });
})();
