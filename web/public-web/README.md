# Files only the web build ships (`npm run build:web`)

- `coi-serviceworker.js`: [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) 0.1.7 from
  npm, unmodified (MIT, `coi-serviceworker.LICENSE`). GitHub Pages cannot send the COOP/COEP headers the
  engine's shared memory needs; this service worker adds them (the first visit reloads once).
  sha256 `d12bd536e27e39a773d7dc7adb1a1167d24002293e97ac81c995fb00cf8d4d5a`
  (LICENSE `3ee2c88cec9f3036fd4b0cba94e94485bb8b4673be7b8e0f3b1496c5baff75cb`)
