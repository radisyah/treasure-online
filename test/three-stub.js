/* Pengganti three.js untuk tes e2e tanpa internet/GPU: semua kelas THREE menjadi objek "apa saja" yang tidak melakukan apa-apa.
   Hanya untuk menguji alur online (lobi, polling, sinyal, hasil); BUKAN untuk tampilan 3D. */
(function () {
  const cache = new WeakMap();
  function any() {
    const f = function () { };
    const store = {};
    const p = new Proxy(f, {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => 0;
        if (k === 'then') return undefined;
        if (k === Symbol.iterator) return function* () { };
        if (k === 'length') return 0;
        if (k === 'array') return store.array || (store.array = new Float32Array(4096));
        if (k in store) return store[k];
        if (k === 'children' || k === 'attributes') return (store[k] = []);
        return (store[k] = any());
      },
      set(t, k, v) { store[k] = v; return true; },
      apply() { return any(); },
      construct() { return any(); },
      has() { return true; }
    });
    return p;
  }
  window.THREE = new Proxy({}, {
    get(t, k) {
      if (k === 'sRGBEncoding' || k === 'PCFSoftShadowMap' || k === 'NoToneMapping' || k === 'NearestFilter' || k === 'LuminanceFormat' || k === 'BackSide' || k === 'AdditiveBlending') return 1;
      if (k === 'JS' || k === 'REVISION') return 128;
      return function () { return any(); };
    }
  });
})();
