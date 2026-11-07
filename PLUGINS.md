# Writing a plugin

Everything interactive on top of the city (music, weather, transit, ships, planes, games) is a plugin: an ES
module in `public/plugins/<name>/` whose default export receives the `city` object.

```js
// public/plugins/hello/index.js
export default function hello(city) {
  const { THREE } = city
  const marker = new THREE.Mesh(new THREE.ConeGeometry(4, 12, 4), new THREE.MeshLambertMaterial({ color: 0xff6040 }))
  marker.position.copy(city.world.fromLatLon(49.2827, -123.1207)) // on the ground at that spot
  marker.position.y += 6
  city.scene.add(marker)
  city.requestRender()
  return { dispose() { city.scene.remove(marker); city.requestRender() } }
}
```

Turn it on by adding its path to `public/plugins/index.json`, or try it locally with
`http://localhost:PORT/?plugin=plugins/hello/index.js` (same-origin paths only).

## Rules of the road

- **The page renders on demand.** Nothing is drawn unless something changed. After you change the scene call
  `city.requestRender()`. For animation call `const stop = city.animate()` and `stop()` when you are done (for
  example when your objects are off screen or too small to see); while any plugin animates, every frame is drawn
  and `city.on('frame', (dt, t) => …)` fires each frame.
- **Stay fast.** The target is 60 fps on a mid laptop and a phone. Use one `InstancedMesh` (or one merged
  geometry) per kind of thing, not thousands of meshes. Heavy simulation goes in a Web Worker. Pause work when
  `city.view.zoom` says your things are smaller than a pixel, and when `document.hidden`.
- **Don't fight the style.** Flat-shaded Lambert materials, the ink outline pass and the shared sun do the look.
  Objects in `city.scene` get outlines and shadows; `city.overlay` is drawn last without them (particles,
  labels, glows).
- **Clean up** in `dispose()`.
- **Credit data** you use (in a comment and, for user-visible data, in your UI).

## The `city` object

| | |
|---|---|
| `city.version` | API version (1) |
| `city.THREE` | the three.js module the page uses (r170) |
| `city.scene` | the world; x east, y up, z south, 1 unit = 1 metre |
| `city.overlay` | drawn after everything, no outlines or shadows |
| `city.camera` | orthographic camera looking north, 30° down; `camera.zoom` is CSS px per drawing px |
| `city.renderer`, `city.canvas`, `city.controls` | three.js renderer, its canvas, the MapControls |
| `city.world.fromLatLon(lat, lon)` | `THREE.Vector3` on the ground at that point |
| `city.world.toLatLon(x, z)` | `{ lat, lon }` |
| `city.world.heightAt(x, z)` | ground height in metres |
| `city.view.zoom`, `.center`, `.metresPerPixel`, `.bounds` | what is on screen (`bounds`: `{x0, z0, x1, z1}`) |
| `city.light.sun`, `city.light.hemi` | the `DirectionalLight` (casts the shadows) and `HemisphereLight` |
| `city.light.setSunDirection(v)` | move the sun (a `Vector3` pointing towards it); shadows follow |
| `city.post.uniforms.tint` / `.desat` | grade of the final image: multiply (`Vector3`, 1 = none) and desaturate (0–1) |
| `city.data.roads` | the drivable road graph: `{ nNodes, meta: Int32Array(7 per piece: from, to, class, oneway, lanes, first point, points), pts: Float32Array(x, north, z per point) }` |
| `city.on(event, fn)` | `'frame'` `(dt, t)`, `'view'` `(view)`; returns an unsubscribe function |
| `city.requestRender()`, `city.animate()` | see above |
| `city.ui.addButton({ label, title, icon, onClick, panel })` | a toolbar button at the top right; with `panel: true`, `.panel` is a popover element you fill |
| `city.ui.toast(text)` | a short message |

`window.city` is the same object, handy from the browser console.
