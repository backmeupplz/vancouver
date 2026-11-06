// Runs isoworld's own traffic.js (simulation + car drawing) off the main thread. It was written
// for OpenSeadragon on the page, so the few DOM and viewer bits it touches are shimmed here, and
// each frame it draws goes back to the page as an ImageBitmap tagged with the view it was drawn for.
let view = { vx: 0, vy: 0, s: 0.05, cw: 1, ch: 1, dpr: 1 }
let main = null, mainCtx = null, drew = false, sentEmpty = true

class Img {   // new Image() for the occlusion masks: decoded here with createImageBitmap
  complete = false; naturalWidth = 0; bmp = null
  set src(url) {
    fetch(url).then((r) => r.blob()).then(createImageBitmap)
      .then((b) => { this.bmp = b; this.naturalWidth = b.width; this.complete = true })
      .catch(() => { this.complete = true })
  }
}
const drawImage = OffscreenCanvasRenderingContext2D.prototype.drawImage
OffscreenCanvasRenderingContext2D.prototype.drawImage = function (im, ...a) {
  if (this === mainCtx) drew = true
  return drawImage.call(this, im instanceof Img ? im.bmp : im, ...a)
}

const raf = self.requestAnimationFrame?.bind(self) ?? ((cb) => setTimeout(() => cb(performance.now()), 16))
self.requestAnimationFrame = (cb) => raf((now) => {
  drew = false
  const v = view
  cb(now)
  if (drew) {
    const bmp = main.transferToImageBitmap()
    postMessage({ bmp, ...v }, [bmp]); sentEmpty = false
  } else if (!sentEmpty) { postMessage({ empty: true }); sentEmpty = true }
})

// Cars are drawn at image resolution at most (their own rule), so zoomed in the canvas only needs
// one pixel per image pixel; the page scales it up without smoothing, as traffic.js did.
const dprFor = (v) => (v.s * v.dpr > 1 ? 1 / v.s : v.dpr)

onmessage = async ({ data }) => {
  if (data.view) { view = data.view; self.devicePixelRatio = dprFor(view); return }
  if ('enabled' in data) { self.api?.setEnabled(data.enabled); return }
  // init
  self.window = self
  self.devicePixelRatio = 1
  self.matchMedia = () => ({ matches: data.phone })
  self.Image = Img
  self.OpenSeadragon = { Point: class { constructor(x, y) { this.x = x; this.y = y } } }
  self.document = {
    createElement: () => Object.defineProperties(Object.assign(new OffscreenCanvas(1, 1), { style: {} }), {
      clientWidth: { get: () => view.cw }, clientHeight: { get: () => view.ch },
    }),
  }
  const viewer = {
    canvas: { appendChild: (c) => { main = c; mainCtx = c.getContext('2d') } },
    addHandler() {},   // the page redraws the last frame where the view now is; no extra draws here
  }
  const item = {
    imageToViewerElementCoordinates: (p) => ({ x: (p.x - view.vx) * view.s, y: (p.y - view.vy) * view.s }),
  }
  try {
    const { startTraffic } = await import(data.origin + 'traffic.js')
    self.api = await startTraffic(viewer, data.origin + data.base, item)
  } catch (e) { postMessage({ error: String(e) }) }
}
