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
            // --- Vértices calibrados del cubo (normalizados 0-1) ---
            // índice = r*4 + g*2 + b
            const CAL = [
                [0.000, 0.000, 0.000], // 000
                [0.000, 0.000, 1.000], // 001
                [0.000, 1.000, 0.000], // 010  → ya NO es identidad
                [0.667, 1.000, 0.784], // 011
                [1.000, 0.000, 0.000], // 100
                [1.000, 0.000, 0.294], // 101
                [1.000, 0.333, 0.000], // 110
                [1.000, 0.373, 0.333], // 111
            ];
            // NOTA: el vértice 010 se corrige más abajo con (0,255,0)->(170,255,0)

            // --- Correcciones puntuales adicionales (puntos interiores) ---
            // Cada entrada: [r,g,b, r',g',b'] normalizados 0-1
            const FIXES = [
                // (0,255,0) -> (170,255,0)  [corrige el vértice 010]
                { v: [0, 1, 0],   o: [170/255, 1, 0] },
                // (255,255,127) -> (255,85,10)
                { v: [1, 1, 127/255], o: [1, 85/255, 10/255] },
                // (255,127,255) -> (255,16,75)
                { v: [1, 127/255, 1], o: [1, 16/255, 75/255] },
                // (127,255,255) -> (255,255,200)
                { v: [127/255, 1, 1], o: [1, 1, 200/255] },
            ];

            // Peso de la corrección: 1 en el punto exacto, decae con la distancia
            function fixWeight(dist) {
                // kernel gaussiano estrecho, suficiente para no distorsionar el resto
                const s = 0.28;
                return Math.exp(-(dist * dist) / (2 * s * s));
            }

            // Interpolación trilineal base
            function trilinear(r, g, b) {
                const out = [0, 0, 0];
                for (let i = 0; i < 8; i++) {
                    const cr = (i >> 2) & 1, cg = (i >> 1) & 1, cb = i & 1;
                    const w = (cr ? r : 1 - r) * (cg ? g : 1 - g) * (cb ? b : 1 - b);
                    out[0] += w * CAL[i][0];
                    out[1] += w * CAL[i][1];
                    out[2] += w * CAL[i][2];
                }
                return out;
            }

            // Calibración completa
            function calibrate(r255, g255, b255) {
                const r = r255 / 255, g = g255 / 255, b = b255 / 255;
                let base = trilinear(r, g, b);

                // Aplicar correcciones puntuales
                let totalW = 0;
                const corr = [0, 0, 0];
                for (const f of FIXES) {
                    const dr = r - f.v[0], dg = g - f.v[1], db = b - f.v[2];
                    const dist = Math.sqrt(dr*dr + dg*dg + db*db);
                    const w = fixWeight(dist);
                    if (w < 1e-4) continue;
                    // delta = (valor deseado) - (valor base en ese punto)
                    const baseAt = trilinear(f.v[0], f.v[1], f.v[2]);
                    const delta = [
                        f.o[0] - baseAt[0],
                        f.o[1] - baseAt[1],
                        f.o[2] - baseAt[2],
                    ];
                    corr[0] += w * delta[0];
                    corr[1] += w * delta[1];
                    corr[2] += w * delta[2];
                    totalW += w;
                }
                if (totalW > 0) {
                    base = [
                        base[0] + corr[0] / Math.max(1, totalW),
                        base[1] + corr[1] / Math.max(1, totalW),
                        base[2] + corr[2] / Math.max(1, totalW),
                    ];
                }

                return base.map(v => Math.round(clamp(v * 255, 0, 255)));
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
                warm: () => color(255, 70, 25),
                cold: () => color(255, 255, 255),
                effect: n => u8([0x7E, 0x05, 0x03, (n + 128) & 0xFF, 0x03, 0xFF, 0xFF, 0x00, 0xEF]),
                speed:  pct => u8([0x7E, 0x04, 0x02, clamp(pct, 0, 100), 0xFF, 0xFF, 0xFF, 0x00, 0xEF]),
                manual: bytes => bytes,
            };
        }
    });
})();